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

import type { PRKey, HunkRef, Annotation, PrismMessage, DaemonErrorKind, ChatMessage } from "./shared.js";
import {
  isGitHubPRChangesPage,
  extractPRContext,
  prContextEqual,
} from "./pr-context.js";
import { extractHunks, resetAnchorCounter } from "./hunk-extractor.js";
import {
  injectPrismStyles,
  renderCard,
  removeCard,
  removeAllCards,
  toggleChatPanel,
  appendChatMessage,
  setChatLoading,
  getChatInput,
  appendStreamingChunk,
  finalizeStreamingBubble,
  type CardState,
} from "./annotation-card.js";

// ---- Debug -----------------------------------------------------------------

const DEBUG = false;
function debugLog(...args: unknown[]): void {
  if (DEBUG) console.log("[PRism]", ...args);
}

// ---- State -----------------------------------------------------------------

/** Current PR context, or null if not on a PR Changes page. */
let currentContext: PRKey | null = null;

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

/** Per-hunk chat history, keyed by patchHash. */
const chatHistories = new Map<string, ChatMessage[]>();

/**
 * Maps DOM patchHash → canonical (daemon) patchHash.
 * Populated when annotations are fuzzy-matched so chat sends the correct hash.
 */
const canonicalPatchHashMap = new Map<string, string>();

/** Whether chat panel was open for a given domAnchorId. */
const chatPanelOpenState = new Map<string, boolean>();

/** Hunks with an in-flight chat stream (keyed by canonical patchHash). */
const chatInFlight = new Set<string>();

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

  const visible = visibleHunkIds.size > 0
    ? extractedHunks.filter(
        (h) => h.domAnchorId && visibleHunkIds.has(h.domAnchorId),
      )
    : extractedHunks.filter((h) => Boolean(h.domAnchorId));

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

  // Check if anything actually changed — compare both count and content
  if (newHunks.length === extractedHunks.length) {
    const oldHashes = new Set(extractedHunks.map((h) => h.patchHash));
    const changed = newHunks.some((h) => !oldHashes.has(h.patchHash));
    if (!changed) return;
  }

  debugLog(
    `Re-extraction: ${extractedHunks.length} → ${newHunks.length} hunks`,
  );

  extractedHunks = newHunks;
  setupHunkObserver();
  notifyVisibleHunks();
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
    // Set up mutation observer immediately — it will catch lazy-loaded diffs
    setupDiffMutationObserver();

    // Retry with increasing delays (1s, 2s, 4s)
    const retryDelays = [1000, 2000, 4000];
    let retryIndex = 0;

    const retry = () => {
      if (!currentContext || extractedHunks.length > 0) return;
      if (retryIndex >= retryDelays.length) {
        console.warn('[PRism] No hunks found after all retries');
        return;
      }

      extractedHunks = extractHunks();
      if (extractedHunks.length > 0) {
        debugLog('Found', extractedHunks.length, 'hunks on retry', retryIndex + 1);
        setupHunkObserver();
        notifyVisibleHunks();
        return;
      }

      retryIndex++;
      if (retryIndex < retryDelays.length) {
        setTimeout(retry, retryDelays[retryIndex]);
      } else {
        console.warn('[PRism] No hunks found after all retries');
      }
    };

    setTimeout(retry, retryDelays[0]);
    return;
  }

  setupHunkObserver();
  setupDiffMutationObserver();
  notifyVisibleHunks();
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
  chatHistories.clear();
  canonicalPatchHashMap.clear();
  chatPanelOpenState.clear();
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

    debugLog("PR context updated:", {
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
      debugLog("Bootstrapping on PR Changes page");
    } else if (previousContext.headSha && newContext.headSha &&
               previousContext.headSha !== newContext.headSha) {
      debugLog("headSha changed — new commits or force push detected");
    }

    // Bootstrap hunk extraction after DOM settles.
    // GitHub may still be rendering diff tables when checkPage fires.
    setTimeout(() => {
      if (prContextEqual(currentContext, newContext)) {
        bootstrapHunkTracking();
      }
    }, 800);
  } else if (previousContext) {
    debugLog("Left PR Changes page — PRism inactive");
  }
}

// ---- Annotation card rendering ----------------------------------------------

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

/** Remove all PRism cards except those showing ready annotations. */
function removeNonReadyCards(): void {
  document.querySelectorAll("tr[data-prism-card-for]").forEach((el) => {
    if (!el.querySelector(".prism-card--ready")) {
      el.remove();
    }
  });
}

/**
 * Handle DAEMON_ERROR from the background.
 * Silently removes cards so the extension is invisible when degraded,
 * without wiping unrelated ready cards from successful batches.
 */
function handleDaemonError(
  errorKind: DaemonErrorKind,
  _message: string,
  _retryAfterSec?: number,
  affectedPatchHashes?: string[],
): void {
  debugLog(`Daemon error (${errorKind}) — hiding affected cards`);

  if (errorKind === "offline") {
    // Daemon went offline — keep already-ready cards (data is still valid),
    // remove everything else (loading, error, etc.)
    removeNonReadyCards();
    return;
  }

  // For partial errors, only remove cards for the affected hunks
  if (affectedPatchHashes) {
    for (const hunk of extractedHunks) {
      if (hunk.domAnchorId && affectedPatchHashes.includes(hunk.patchHash)) {
        removeCard(hunk.domAnchorId);
      }
    }
  } else {
    removeNonReadyCards();
  }
}

// ---- Annotation card rendering ----------------------------------------------

/**
 * Handle ANNOTATIONS_UPDATED from the background.
 * Matches annotations to hunks by patchHash and updates the cards.
 */
function handleAnnotationsUpdated(annotations: Annotation[]): void {
  const matchedHunkIds = new Set<string>();

  for (const ann of annotations) {
    // Tier 1: exact patchHash match
    let hunk = extractedHunks.find((h) => h.patchHash === ann.patchHash);

    // Tier 2: same file, unmatched hunk (fuzzy fallback)
    if (!hunk) {
      hunk = extractedHunks.find(
        (h) => h.filePath === ann.filePath && h.domAnchorId && !matchedHunkIds.has(h.domAnchorId)
      );
      if (hunk) {
        console.warn('[PRism] patchHash mismatch, fuzzy matched:', ann.filePath,
          'dom:', hunk.patchHash, 'api:', ann.patchHash);
        // Record the canonical patchHash so chat uses the daemon's hash
        canonicalPatchHashMap.set(hunk.patchHash, ann.patchHash);
      }
    }

    if (!hunk?.domAnchorId) {
      console.warn('[PRism] No hunk found for annotation:', ann.filePath, ann.patchHash);
      continue;
    }

    matchedHunkIds.add(hunk.domAnchorId);

    // For pending/running annotations, only update cards that already exist
    // (e.g. replacing a stale ready/error card with loading during re-analysis).
    // Don't create new loading cards — the extension should stay invisible
    // when the daemon hasn't produced results for this PR yet.
    if (ann.status !== "ready" && ann.status !== "error") {
      const existingCard = document.querySelector(
        `tr[data-prism-card-for="${CSS.escape(hunk.domAnchorId)}"]`,
      );
      if (!existingCard) continue;
    }

    // Save chat panel open state before re-render destroys DOM
    const canonicalHash = canonicalPatchHashMap.get(hunk.patchHash) ?? hunk.patchHash;
    const existingPanel = document.querySelector(
      `tr[data-prism-card-for="${CSS.escape(hunk.domAnchorId)}"] .prism-chat-panel`,
    ) as HTMLElement | null;
    if (existingPanel && existingPanel.style.display !== "none") {
      chatPanelOpenState.set(hunk.domAnchorId, true);
    }

    const state = annotationToCardState(ann);
    renderCard(hunk.domAnchorId, state);

    // Restore chat history and panel state after re-render
    const history = chatHistories.get(canonicalHash);
    if (history && history.length > 0) {
      for (const msg of history) {
        appendChatMessage(hunk.domAnchorId, msg.role, msg.content);
      }
      // Reopen panel if it was open before re-render
      if (chatPanelOpenState.get(hunk.domAnchorId)) {
        toggleChatPanel(hunk.domAnchorId);
      }
    }
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
          debugLog(
            `Job ${message.jobId}: ${message.status} (${message.completed}/${message.total})`,
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

        case "CHAT_REPLY":
          handleChatReply(message.patchHash, message.reply);
          break;

        case "CHAT_REPLY_CHUNK":
          handleChatChunk(message.patchHash, message.chunk);
          break;

        case "CHAT_REPLY_DONE":
          handleChatDone(message.patchHash);
          break;

        case "CHAT_ERROR":
          handleChatError(message.patchHash, message.error);
          break;
      }
    } catch (err) {
      console.error("[PRism] Message handler error (non-fatal):", err);
    }
    return false;
  },
);

// ---- Chat handling ----------------------------------------------------------

/** Find hunk by patchHash, checking both direct and reverse canonical mapping. */
function findHunkByCanonicalHash(canonicalHash: string): HunkRef | undefined {
  // Direct match
  const direct = extractedHunks.find((h) => h.patchHash === canonicalHash);
  if (direct) return direct;

  // Reverse lookup: find DOM hash that maps to this canonical hash
  for (const [domHash, canonical] of canonicalPatchHashMap) {
    if (canonical === canonicalHash) {
      return extractedHunks.find((h) => h.patchHash === domHash);
    }
  }
  return undefined;
}

function handleChatReply(patchHash: string, reply: string): void {
  const hunk = findHunkByCanonicalHash(patchHash);
  if (!hunk?.domAnchorId) return;

  // Store assistant reply in history (keyed by canonical hash)
  const history = chatHistories.get(patchHash) ?? [];
  history.push({ role: "assistant", content: reply });
  chatHistories.set(patchHash, history);

  setChatLoading(hunk.domAnchorId, false);
  appendChatMessage(hunk.domAnchorId, "assistant", reply);
}

function handleChatChunk(patchHash: string, chunk: string): void {
  const hunk = findHunkByCanonicalHash(patchHash);
  if (!hunk?.domAnchorId) return;

  appendStreamingChunk(hunk.domAnchorId, chunk);
}

function handleChatDone(patchHash: string): void {
  chatInFlight.delete(patchHash);

  const hunk = findHunkByCanonicalHash(patchHash);
  if (!hunk?.domAnchorId) return;

  const fullText = finalizeStreamingBubble(hunk.domAnchorId);

  // Store complete assistant reply in history
  const history = chatHistories.get(patchHash) ?? [];
  history.push({ role: "assistant", content: fullText });
  chatHistories.set(patchHash, history);
}

function handleChatError(patchHash: string, error: string): void {
  chatInFlight.delete(patchHash);

  const hunk = findHunkByCanonicalHash(patchHash);
  if (!hunk?.domAnchorId) return;

  setChatLoading(hunk.domAnchorId, false);
  // Finalize any partial streaming bubble
  finalizeStreamingBubble(hunk.domAnchorId);
  appendChatMessage(hunk.domAnchorId, "assistant", `Error: ${error}`);
}

function sendChatMessage(domAnchorId: string): void {
  if (!currentContext) return;

  const hunk = extractedHunks.find((h) => h.domAnchorId === domAnchorId);
  if (!hunk) return;

  const text = getChatInput(domAnchorId);
  if (!text) return;

  // Use canonical patchHash if available (fuzzy-matched hunks)
  const canonicalHash = canonicalPatchHashMap.get(hunk.patchHash) ?? hunk.patchHash;

  // Prevent concurrent streams for the same hunk
  if (chatInFlight.has(canonicalHash)) return;
  chatInFlight.add(canonicalHash);

  // Store user message in history (keyed by canonical hash)
  const history = chatHistories.get(canonicalHash) ?? [];
  history.push({ role: "user", content: text });
  chatHistories.set(canonicalHash, history);

  // Render user bubble and show loading
  appendChatMessage(domAnchorId, "user", text);
  setChatLoading(domAnchorId, true);

  // Send to background with canonical patchHash
  sendToBackground({
    type: "CHAT_SEND",
    pr: currentContext,
    filePath: hunk.filePath,
    patchHash: canonicalHash,
    messages: history,
  });
}

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

    case "chat": {
      const isNowOpen = toggleChatPanel(domAnchorId);
      chatPanelOpenState.set(domAnchorId, isNowOpen);
      break;
    }

    case "chat-send":
      sendChatMessage(domAnchorId);
      break;

    case "chat-suggest": {
      const suggestionText = btn.textContent?.trim();
      if (!suggestionText) break;
      // Set the input value and send
      const input = cardRow.querySelector<HTMLInputElement>(".prism-chat-panel__input");
      if (input) input.value = suggestionText;
      sendChatMessage(domAnchorId);
      break;
    }
  }
});

// Handle Enter key in chat input fields
document.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  const input = event.target as HTMLElement;
  if (!input.classList?.contains("prism-chat-panel__input")) return;

  const cardRow = input.closest<HTMLElement>("tr[data-prism-card-for]");
  if (!cardRow) return;

  const domAnchorId = cardRow.getAttribute("data-prism-card-for");
  if (!domAnchorId) return;

  event.preventDefault();
  sendChatMessage(domAnchorId);
});

// ---- Bootstrap --------------------------------------------------------------

function bootstrap(): void {
  debugLog("Content script loaded");

  // Initial page check
  checkPage();

  // If SHAs weren't extracted on first try, retry shortly — the page
  // may still be loading dynamic content (React hydration, etc.).
  if (currentContext && !currentContext.headSha) {
    setTimeout(checkPage, 2_000);
    setTimeout(checkPage, 5_000);
  }

  // Monitor SPA navigation for the lifetime of this content script.
  setupNavigationMonitor(checkPage);
}

// WORK14: panic-free bootstrap — extension errors must never break GitHub pages.
try {
  bootstrap();
} catch (err) {
  console.error("[PRism] Bootstrap failed (non-fatal):", err);
}
