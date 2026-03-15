// ---------------------------------------------------------------------------
// PRism — Content Script
//
// Injected into GitHub PR Changes pages (manifest: matches github.com/*/pull/*/files*).
// Responsibilities:
//   1. Detect PR Changes pages and survive SPA (Turbo/PJAX) navigation
//   2. Extract PR context (owner / repo / pullNumber / baseSha / headSha)
//   3. Send PR_CONTEXT_UPDATED to background when context changes
//   4. Extract diff hunks and track visibility via IntersectionObserver
//   5. Render inline annotation cards next to hunks
// ---------------------------------------------------------------------------

import type { PRKey, HunkRef, Annotation, PrismMessage, DaemonErrorKind } from "@prism/shared";
import {
  isGitHubPRChangesPage,
  extractPRContext,
  prContextEqual,
} from "./pr-context.js";
import { extractHunks, resetAnchorCounter } from "./hunk-extractor.js";
import {
  injectPrismStyles,
  renderCard,
  removeAllCards,
  type CardState,
} from "./annotation-card.js";

// ---- State -----------------------------------------------------------------

/** Current PR context, or null if not on a PR Changes page. */
let currentContext: PRKey | null = null;

/** Cleanup function for the navigation monitor (kept for future teardown). */
let cleanupNavMonitor: (() => void) | null = null;

/** All hunks extracted from the current page. */
let extractedHunks: HunkRef[] = [];

/** Set of domAnchorIds currently visible in the viewport. */
let visibleHunkIds = new Set<string>();

/** IntersectionObserver tracking hunk visibility. */
let hunkObserver: IntersectionObserver | null = null;

/** MutationObserver watching for new file containers (lazy loading). */
let diffMutationObserver: MutationObserver | null = null;

/** Timer for debounced re-extraction after DOM mutations. */
let reExtractTimer: ReturnType<typeof setTimeout> | null = null;

// ---- Messaging -------------------------------------------------------------

/** Send a typed message to the background service worker. */
function sendToBackground(message: PrismMessage): void {
  chrome.runtime.sendMessage(message);
}

// ---- Hunk visibility tracking -----------------------------------------------

/**
 * Send the current set of visible hunks to the background.
 * Called (debounced) whenever IntersectionObserver reports changes.
 */
function notifyVisibleHunks(): void {
  if (!currentContext) return;

  const visible = extractedHunks.filter(
    (h) => h.domAnchorId && visibleHunkIds.has(h.domAnchorId),
  );

  sendToBackground({
    type: "REQUEST_VISIBLE_ANNOTATIONS",
    pr: currentContext,
    visibleHunks: visible,
  });
}

/**
 * Set up an IntersectionObserver on all extracted hunk header rows.
 *
 * Uses a 200px root margin to start tracking hunks slightly before they
 * scroll into view, giving the daemon a head start on annotation queries.
 */
function setupHunkObserver(): void {
  hunkObserver?.disconnect();

  const debouncedNotify = debounce(notifyVisibleHunks, 300);

  hunkObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).getAttribute(
          "data-prism-hunk-id",
        );
        if (!id) continue;

        if (entry.isIntersecting) {
          visibleHunkIds.add(id);
        } else {
          visibleHunkIds.delete(id);
        }

        // Update the HunkRef in place
        const hunk = extractedHunks.find((h) => h.domAnchorId === id);
        if (hunk) hunk.isVisible = entry.isIntersecting;
      }

      debouncedNotify();
    },
    {
      threshold: 0,
      rootMargin: "200px 0px", // preload annotations before visible
    },
  );

  for (const hunk of extractedHunks) {
    if (!hunk.domAnchorId) continue;
    const el = document.querySelector(
      `[data-prism-hunk-id="${CSS.escape(hunk.domAnchorId)}"]`,
    );
    if (el) hunkObserver.observe(el);
  }
}

/**
 * Watch for new file containers appearing in the DOM (GitHub lazy-loads
 * diffs for large PRs). When new containers appear, re-extract hunks
 * and update the IntersectionObserver.
 *
 * [MODERATE] Selectors for the main diff area.
 */
function setupDiffMutationObserver(): void {
  diffMutationObserver?.disconnect();

  const diffContainer = document.querySelector<HTMLElement>(
    "#diff, .js-diff-progressive-container, .pull-request-tab-content",
  );
  if (!diffContainer) return;

  diffMutationObserver = new MutationObserver(() => {
    if (reExtractTimer) clearTimeout(reExtractTimer);
    reExtractTimer = setTimeout(() => {
      reExtractTimer = null;
      reExtractHunks();
    }, 500);
  });

  diffMutationObserver.observe(diffContainer, {
    childList: true,
    subtree: true,
  });
}

/**
 * Re-extract hunks after DOM mutation (e.g., lazy-loaded file appeared).
 * Only updates if the hunk count changed to avoid unnecessary churn.
 * Inserts loading cards for any newly discovered hunks.
 */
function reExtractHunks(): void {
  const newHunks = extractHunks();
  if (newHunks.length === extractedHunks.length) return;

  console.log(
    `[PRism] Re-extraction: ${extractedHunks.length} → ${newHunks.length} hunks`,
  );

  // Insert loading cards for hunks that are new in this extraction
  const existingIds = new Set(extractedHunks.map((h) => h.domAnchorId));
  for (const hunk of newHunks) {
    if (hunk.domAnchorId && !existingIds.has(hunk.domAnchorId)) {
      renderCard(hunk.domAnchorId, { kind: "loading" });
    }
  }

  extractedHunks = newHunks;
  setupHunkObserver();
}

/**
 * Bootstrap hunk extraction and visibility tracking.
 * Called after PR context is detected and DOM has settled.
 * Injects styles and inserts loading cards for all discovered hunks.
 */
function bootstrapHunkTracking(): void {
  injectPrismStyles();
  extractedHunks = extractHunks();

  if (extractedHunks.length === 0) {
    // DOM may not be fully rendered yet — retry shortly
    setTimeout(() => {
      if (currentContext && extractedHunks.length === 0) {
        extractedHunks = extractHunks();
        if (extractedHunks.length > 0) {
          insertLoadingCards(extractedHunks);
          setupHunkObserver();
          setupDiffMutationObserver();
        }
      }
    }, 2_000);
    return;
  }

  insertLoadingCards(extractedHunks);
  setupHunkObserver();
  setupDiffMutationObserver();
}

/** Tear down all hunk tracking state and remove annotation cards. */
function teardownHunkTracking(): void {
  hunkObserver?.disconnect();
  hunkObserver = null;
  diffMutationObserver?.disconnect();
  diffMutationObserver = null;
  if (reExtractTimer) {
    clearTimeout(reExtractTimer);
    reExtractTimer = null;
  }
  removeAllCards();
  extractedHunks = [];
  visibleHunkIds.clear();
  resetAnchorCounter();
}

// ---- Context change handling -----------------------------------------------

/**
 * Called whenever the page context may have changed (initial load,
 * SPA navigation, DOM mutation, periodic recheck).
 *
 * Extracts the current PR context and compares it to the previous one.
 * If changed, notifies the background script.
 */
function checkPage(): void {
  const newContext = isGitHubPRChangesPage() ? extractPRContext() : null;

  if (prContextEqual(currentContext, newContext)) return;

  const previousContext = currentContext;
  currentContext = newContext;

  // Tear down previous hunk tracking on any context change
  teardownHunkTracking();

  if (newContext) {
    const shortSha = (sha: string) =>
      sha ? sha.slice(0, 8) + "..." : "(pending)";

    console.log("[PRism] PR context updated:", {
      owner: newContext.owner,
      repo: newContext.repo,
      pullNumber: newContext.pullNumber,
      headSha: shortSha(newContext.headSha),
      baseSha: shortSha(newContext.baseSha),
    });

    // Notify background immediately (visible hunks will follow once extracted)
    sendToBackground({
      type: "PR_CONTEXT_UPDATED",
      pr: newContext,
      visibleHunks: [],
    });

    if (!previousContext) {
      console.log("[PRism] Bootstrapping on PR Changes page");
    } else if (previousContext.headSha && newContext.headSha &&
               previousContext.headSha !== newContext.headSha) {
      console.log("[PRism] headSha changed — new commits or force push detected");
    }

    // Bootstrap hunk extraction after DOM settles.
    // GitHub may still be rendering diff tables when checkPage fires.
    setTimeout(() => {
      if (prContextEqual(currentContext, newContext)) {
        bootstrapHunkTracking();
      }
    }, 800);
  } else if (previousContext) {
    console.log("[PRism] Left PR Changes page — PRism inactive");
  }
}

// ---- Annotation card rendering ----------------------------------------------

/** Insert loading cards for a batch of hunks. */
function insertLoadingCards(hunks: HunkRef[]): void {
  for (const hunk of hunks) {
    if (hunk.domAnchorId) {
      renderCard(hunk.domAnchorId, { kind: "loading" });
    }
  }
}

/**
 * Convert an Annotation to a CardState for rendering.
 */
function annotationToCardState(ann: Annotation): CardState {
  switch (ann.status) {
    case "ready":
      return {
        kind: "ready",
        data: {
          summary: ann.summary,
          impact: ann.impact || undefined,
          risk: ann.risk,
        },
      };
    case "error":
      return { kind: "error", message: "Analysis failed" };
    case "pending":
    case "running":
    default:
      return { kind: "loading" };
  }
}

// ---- Degraded-state handling (WORK14) ----------------------------------------

/**
 * Handle DAEMON_ERROR from the background.
 * Shows the appropriate degraded-state card for affected hunks.
 * If affectedPatchHashes is undefined, updates all loading/error hunks.
 */
function handleDaemonError(
  errorKind: DaemonErrorKind,
  _message: string,
  retryAfterSec?: number,
  affectedPatchHashes?: string[],
): void {
  const hunksToUpdate = affectedPatchHashes
    ? extractedHunks.filter((h) => affectedPatchHashes.includes(h.patchHash))
    : extractedHunks;

  for (const hunk of hunksToUpdate) {
    if (!hunk.domAnchorId) continue;

    let state: CardState;
    switch (errorKind) {
      case "offline":
        state = { kind: "offline" };
        break;
      case "auth_failed":
        state = { kind: "auth_error" };
        break;
      case "rate_limited":
        state = { kind: "rate_limited", retryAfterSec };
        break;
      default:
        state = { kind: "error", message: "GitHub API error" };
        break;
    }

    renderCard(hunk.domAnchorId, state);
  }
}

// ---- Annotation card rendering ----------------------------------------------

/**
 * Handle ANNOTATIONS_UPDATED from the background.
 * Matches annotations to hunks by patchHash and updates the cards.
 */
function handleAnnotationsUpdated(annotations: Annotation[]): void {
  for (const ann of annotations) {
    // Find the hunk this annotation belongs to
    const hunk = extractedHunks.find((h) => h.patchHash === ann.patchHash);
    if (!hunk?.domAnchorId) continue;

    const state = annotationToCardState(ann);
    renderCard(hunk.domAnchorId, state);
  }
}

// ---- Incoming message listener ----------------------------------------------

/**
 * Listen for messages from the background service worker.
 * Currently handles ANNOTATIONS_UPDATED to render annotation cards.
 */
chrome.runtime.onMessage.addListener(
  (message: PrismMessage, _sender, _sendResponse) => {
    // WORK14: wrap handler in try/catch — extension failures must never
    // break normal GitHub diff reading.
    try {
      switch (message.type) {
        case "ANNOTATIONS_UPDATED":
          handleAnnotationsUpdated(message.annotations);
          break;
        case "JOB_STATUS_UPDATED":
          console.log(
            `[PRism] Job ${message.jobId}: ${message.status} (${message.completed}/${message.total})`,
          );
          if (message.status === "completed") {
            // Job finished — re-request visible hunks to pick up fresh annotations
            notifyVisibleHunks();
          }
          break;
        case "DAEMON_ERROR":
          handleDaemonError(
            message.errorKind,
            message.message,
            message.retryAfterSec,
            message.affectedPatchHashes,
          );
          break;
      }
    } catch (err) {
      console.error("[PRism] Message handler error (non-fatal):", err);
    }
    return false;
  },
);

// ---- SPA navigation monitoring ---------------------------------------------

/**
 * Debounce: collapses rapid-fire calls into one invocation after `delayMs`.
 * Returns the wrapped function. Pending invocations are cancelled on each call.
 */
function debounce(fn: () => void, delayMs: number): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn();
    }, delayMs);
  };
}

/**
 * Set up listeners for GitHub SPA navigation events.
 *
 * GitHub uses Hotwire Turbo for SPA navigation. When the user clicks
 * internal links, Turbo replaces the page content without a full reload.
 * We detect these transitions to re-extract the PR context.
 *
 * Monitored events:
 *   - turbo:load     — Turbo finished loading a new page
 *   - turbo:render   — Turbo rendered new content
 *   - pjax:end       — legacy PJAX navigation (older GitHub code paths)
 *   - popstate       — browser back/forward navigation
 *   - MutationObserver on <title> — catches URL changes that bypass
 *     Turbo/PJAX events (e.g. React-driven route transitions)
 *   - 30s interval   — catches in-place DOM updates like force pushes
 *     where GitHub updates the diff without a navigation event
 *
 * Returns a cleanup function to tear down all listeners.
 */
function setupNavigationMonitor(callback: () => void): () => void {
  const debouncedCheck = debounce(callback, 150);

  // --- Turbo events ---
  document.addEventListener("turbo:load", debouncedCheck);
  document.addEventListener("turbo:render", debouncedCheck);

  // --- Legacy PJAX ---
  document.addEventListener("pjax:end", debouncedCheck);

  // --- Browser history navigation ---
  window.addEventListener("popstate", debouncedCheck);

  // --- URL change observer (fallback) ---
  // Catches navigations that don't fire Turbo/PJAX events.
  let lastHref = window.location.href;
  const titleObserver = new MutationObserver(() => {
    if (window.location.href !== lastHref) {
      lastHref = window.location.href;
      debouncedCheck();
    }
  });
  const titleEl = document.querySelector("title");
  if (titleEl) {
    titleObserver.observe(titleEl, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  // --- Periodic SHA recheck ---
  // Even without navigation, page content can update in-place (e.g., after
  // a force push GitHub updates the diff). A lightweight periodic check
  // catches headSha changes that don't trigger any DOM event we listen to.
  const shaCheckInterval = setInterval(callback, 30_000);

  return () => {
    document.removeEventListener("turbo:load", debouncedCheck);
    document.removeEventListener("turbo:render", debouncedCheck);
    document.removeEventListener("pjax:end", debouncedCheck);
    window.removeEventListener("popstate", debouncedCheck);
    titleObserver.disconnect();
    clearInterval(shaCheckInterval);
  };
}

// ---- Card action button handler ---------------------------------------------

/**
 * Delegated click handler for annotation card buttons (retry, refresh, etc.).
 * Maps button clicks to background messages so the content script never
 * contacts the daemon directly.
 */
document.addEventListener("click", (event) => {
  const btn = (event.target as HTMLElement).closest<HTMLElement>(
    "[data-prism-action]",
  );
  if (!btn) return;

  const action = btn.dataset.prismAction;
  const cardRow = btn.closest<HTMLElement>("tr[data-prism-card-for]");
  if (!cardRow) return;

  const domAnchorId = cardRow.getAttribute("data-prism-card-for");
  if (!domAnchorId || !currentContext) return;

  const hunk = extractedHunks.find((h) => h.domAnchorId === domAnchorId);
  if (!hunk) return;

  switch (action) {
    case "retry":
    case "refresh":
      renderCard(domAnchorId, { kind: "loading" });
      sendToBackground({ type: "RETRY_HUNK", pr: currentContext, hunk });
      break;
  }
});

// ---- Bootstrap --------------------------------------------------------------

function bootstrap(): void {
  console.log("[PRism] Content script loaded");

  // Initial page check
  checkPage();

  // If SHAs weren't extracted on first try, retry shortly — the page
  // may still be loading dynamic content (React hydration, etc.).
  if (currentContext && !currentContext.headSha) {
    setTimeout(checkPage, 2_000);
    setTimeout(checkPage, 5_000);
  }

  // Monitor SPA navigation for the lifetime of this content script.
  cleanupNavMonitor = setupNavigationMonitor(checkPage);

  // Prevent unused-variable warning; cleanup is kept for future teardown.
  void cleanupNavMonitor;
}

// WORK14: panic-free bootstrap — extension errors must never break GitHub pages.
try {
  bootstrap();
} catch (err) {
  console.error("[PRism] Bootstrap failed (non-fatal):", err);
}
