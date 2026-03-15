// ---------------------------------------------------------------------------
// PRism — Background Service Worker (Gateway)
//
// Single network boundary between content scripts and the localhost daemon.
// Content scripts never make network requests directly; all daemon
// communication is funnelled through this service worker.
//
// Responsibilities:
//   1. Message routing (content ↔ background)
//   2. Request coalescing — batches rapid visible-hunk requests per tab
//   3. Deduplication — skips hunks already in-flight
//   4. Short-lived cache — avoids re-querying recently fetched annotations
//   5. Job polling — tracks queued/running jobs and pushes updates
// ---------------------------------------------------------------------------

import type { PrismMessage, DaemonErrorKind } from "@prism/shared";
import type { PRKey, HunkRef, Annotation } from "@prism/shared";
import { AnnotationCache, cacheKey } from "./background-cache.js";
import * as api from "./background-api.js";
import { PrismApiError } from "./background-api.js";

// ---- Cache -----------------------------------------------------------------

const cache = new AnnotationCache(30_000); // 30s TTL

// ---- Per-tab state ---------------------------------------------------------

interface TabState {
  /** Current PR context for this tab. */
  pr: PRKey | null;
  /** Hunks accumulated during the coalescing window, keyed by patchHash. */
  pendingHunks: Map<string, HunkRef>;
  /** Timer for the coalescing window. */
  coalesceTimer: ReturnType<typeof setTimeout> | null;
  /** patchHashes currently being fetched (in-flight). */
  inFlight: Set<string>;
}

const tabs = new Map<number, TabState>();

function getTab(tabId: number): TabState {
  let state = tabs.get(tabId);
  if (!state) {
    state = {
      pr: null,
      pendingHunks: new Map(),
      coalesceTimer: null,
      inFlight: new Set(),
    };
    tabs.set(tabId, state);
  }
  return state;
}

function clearTab(tabId: number): void {
  const state = tabs.get(tabId);
  if (state?.coalesceTimer) clearTimeout(state.coalesceTimer);
  tabs.delete(tabId);
}

// Clean up when tabs close
chrome.tabs.onRemoved.addListener((tabId) => {
  clearTab(tabId);
  stopJobPollingForTab(tabId);
});

// ---- Request coalescing ----------------------------------------------------

/** Coalescing window in ms. Collects hunks before firing one batch. */
const COALESCE_WINDOW_MS = 150;

/**
 * Enqueue visible hunks for a tab. Hunks accumulate during the coalescing
 * window; duplicates (same patchHash) and already in-flight hunks are dropped.
 */
function enqueueHunks(tabId: number, pr: PRKey, hunks: HunkRef[]): void {
  const state = getTab(tabId);
  state.pr = pr;

  for (const hunk of hunks) {
    // Skip if already being fetched
    if (state.inFlight.has(hunk.patchHash)) continue;
    // Accumulate (Map deduplicates by patchHash)
    state.pendingHunks.set(hunk.patchHash, hunk);
  }

  // Reset the coalescing timer
  if (state.coalesceTimer) clearTimeout(state.coalesceTimer);
  state.coalesceTimer = setTimeout(() => {
    state.coalesceTimer = null;
    flushBatch(tabId);
  }, COALESCE_WINDOW_MS);
}

/**
 * Flush the accumulated hunk batch for a tab.
 * Checks cache first, then requests uncached hunks from the daemon API.
 */
async function flushBatch(tabId: number): Promise<void> {
  const state = tabs.get(tabId);
  if (!state?.pr || state.pendingHunks.size === 0) return;

  const pr = state.pr;
  const hunks = [...state.pendingHunks.values()];
  state.pendingHunks.clear();

  // --- Cache lookup ---
  const cached: Annotation[] = [];
  const uncached: HunkRef[] = [];

  for (const hunk of hunks) {
    const key = cacheKey(pr, hunk.patchHash);
    const hit = cache.get(key);
    if (hit) {
      cached.push(hit);
    } else {
      uncached.push(hunk);
    }
  }

  // Send cached annotations immediately
  if (cached.length > 0) {
    sendToTab(tabId, { type: "ANNOTATIONS_UPDATED", annotations: cached });
  }

  if (uncached.length === 0) return;

  // --- Mark in-flight ---
  for (const hunk of uncached) {
    state.inFlight.add(hunk.patchHash);
  }

  try {
    const response = await api.queryAnnotations(pr, uncached);

    // Cache the results
    for (const ann of response.annotations) {
      cache.set(cacheKey(pr, ann.patchHash), ann);
    }

    // Clear in-flight
    for (const hunk of uncached) {
      state.inFlight.delete(hunk.patchHash);
    }

    // Send annotations to tab
    if (response.annotations.length > 0) {
      sendToTab(tabId, {
        type: "ANNOTATIONS_UPDATED",
        annotations: response.annotations,
      });
    }

    // If daemon reported a job, start polling
    if (response.job) {
      startJobPolling(tabId, pr, response.job.jobId);
    }
  } catch (err) {
    // Clear in-flight on error so hunks can be retried
    for (const hunk of uncached) {
      state.inFlight.delete(hunk.patchHash);
    }

    // WORK14: classify error and notify content script with distinct error kind
    if (err instanceof PrismApiError) {
      sendToTab(tabId, {
        type: "DAEMON_ERROR",
        errorKind: err.kind,
        message: err.message,
        retryAfterSec: err.retryAfterSec,
        affectedPatchHashes: uncached.map((h) => h.patchHash),
      });
    }
    console.error("[PRism:bg] Batch request failed:", err instanceof Error ? err.message : err);
  }
}

// ---- Job polling -----------------------------------------------------------

interface PollingJob {
  jobId: string;
  tabId: number;
  pr: PRKey;
  timer: ReturnType<typeof setInterval>;
  pollCount: number;
}

const activeJobs = new Map<string, PollingJob>();

/** How often to poll job status (ms). */
const JOB_POLL_INTERVAL_MS = 3_000;

/** Max polls before giving up. */
const JOB_MAX_POLLS = 60;

function startJobPolling(tabId: number, pr: PRKey, jobId: string): void {
  // Don't double-poll the same job
  if (activeJobs.has(jobId)) return;

  const job: PollingJob = {
    jobId,
    tabId,
    pr,
    pollCount: 0,
    timer: setInterval(() => pollJob(jobId), JOB_POLL_INTERVAL_MS),
  };
  activeJobs.set(jobId, job);
  console.log(`[PRism:bg] Started polling job ${jobId}`);
}

async function pollJob(jobId: string): Promise<void> {
  const job = activeJobs.get(jobId);
  if (!job) return;

  job.pollCount++;
  if (job.pollCount > JOB_MAX_POLLS) {
    console.warn(`[PRism:bg] Job ${jobId} exceeded max polls, stopping`);
    stopJobPolling(jobId);
    return;
  }

  try {
    const status = await api.getJobStatus(jobId);

    // Push status update to tab
    sendToTab(job.tabId, {
      type: "JOB_STATUS_UPDATED",
      jobId: status.jobId,
      status: status.status,
      completed: status.completed,
      total: status.total,
    });

    // Terminal state — stop polling
    if (status.status === "completed" || status.status === "failed") {
      console.log(`[PRism:bg] Job ${jobId} finished: ${status.status}`);

      if (status.status === "completed") {
        // Invalidate cache so the content script's re-query gets fresh data
        cache.clearForPR(job.pr);
      }

      stopJobPolling(jobId);
    }
  } catch (err) {
    // WORK14: if daemon went offline mid-poll, stop polling and notify
    if (err instanceof PrismApiError && err.kind === "offline") {
      sendToTab(job.tabId, {
        type: "DAEMON_ERROR",
        errorKind: "offline",
        message: err.message,
      });
      stopJobPolling(jobId);
      return;
    }
    console.error(`[PRism:bg] Failed to poll job ${jobId}:`, err instanceof Error ? err.message : err);
  }
}

function stopJobPolling(jobId: string): void {
  const job = activeJobs.get(jobId);
  if (!job) return;
  clearInterval(job.timer);
  activeJobs.delete(jobId);
}

function stopJobPollingForTab(tabId: number): void {
  for (const [jobId, job] of activeJobs) {
    if (job.tabId === tabId) {
      stopJobPolling(jobId);
    }
  }
}

// ---- Message helpers -------------------------------------------------------

function sendToTab(tabId: number, message: PrismMessage): void {
  chrome.tabs.sendMessage(tabId, message).catch(() => {
    // Tab may have navigated away or been closed; ignore
  });
}

// ---- Message routing -------------------------------------------------------

chrome.runtime.onMessage.addListener(
  (message: PrismMessage, sender, _sendResponse) => {
    const tabId = sender.tab?.id;
    if (tabId == null) return false;

    switch (message.type) {
      case "PR_CONTEXT_UPDATED":
        handlePRContextUpdated(tabId, message.pr);
        break;

      case "REQUEST_VISIBLE_ANNOTATIONS":
        handleRequestVisibleAnnotations(tabId, message.pr, message.visibleHunks);
        break;

      case "RETRY_HUNK":
        handleRetryHunk(tabId, message.pr, message.hunk);
        break;
    }

    return false;
  },
);

// ---- Message handlers ------------------------------------------------------

function handlePRContextUpdated(tabId: number, pr: PRKey): void {
  console.log(
    `[PRism:bg] PR context updated tab=${tabId}:`,
    `${pr.owner}/${pr.repo}#${pr.pullNumber}`,
  );

  // Clear previous state for this tab
  clearTab(tabId);
  stopJobPollingForTab(tabId);

  // Initialize fresh tab state
  const state = getTab(tabId);
  state.pr = pr;

  // Register PR with daemon (fire-and-forget, WORK14: surface errors to tab)
  api.registerPR(pr).catch((err) => {
    if (err instanceof PrismApiError) {
      sendToTab(tabId, {
        type: "DAEMON_ERROR",
        errorKind: err.kind,
        message: err.message,
        retryAfterSec: err.retryAfterSec,
      });
    }
    console.error("[PRism:bg] Failed to register PR:", err instanceof Error ? err.message : err);
  });
}

function handleRequestVisibleAnnotations(
  tabId: number,
  pr: PRKey,
  hunks: HunkRef[],
): void {
  if (hunks.length === 0) return;
  enqueueHunks(tabId, pr, hunks);
}

function handleRetryHunk(tabId: number, pr: PRKey, hunk: HunkRef): void {
  // Invalidate cache for this hunk so it gets re-fetched
  cache.invalidate(cacheKey(pr, hunk.patchHash));

  // Clear from in-flight if stuck
  const state = tabs.get(tabId);
  if (state) {
    state.inFlight.delete(hunk.patchHash);
  }

  // Re-enqueue as a single-hunk request
  enqueueHunks(tabId, pr, [hunk]);
}
