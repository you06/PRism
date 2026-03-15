// ---------------------------------------------------------------------------
// PRism — PR Context Extraction
//
// Extracts PR metadata from the current GitHub page:
//   - owner / repo / pullNumber from the URL
//   - baseSha / headSha from the page DOM (with fallback strategies)
//
// This module is intentionally free of side-effects. All DOM access
// is contained in pure functions that can be called repeatedly during
// SPA navigation.
// ---------------------------------------------------------------------------

import type { PRKey } from "@prism/shared";

// ---- URL matching -----------------------------------------------------------

/** Matches: /owner/repo/pull/123/files and variants (/files/, /files?w=1, etc.) */
const PR_FILES_RE = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/files\b/;

/** True when the given pathname looks like a GitHub PR Changes page. */
export function isGitHubPRChangesPage(
  pathname = window.location.pathname,
): boolean {
  return PR_FILES_RE.test(pathname);
}

/** Extract owner / repo / pullNumber from a URL pathname. */
export function parsePRFromUrl(
  pathname = window.location.pathname,
  host = window.location.hostname,
): Pick<PRKey, "host" | "owner" | "repo" | "pullNumber"> | null {
  const match = pathname.match(PR_FILES_RE);
  if (!match) return null;
  return {
    host,
    owner: match[1],
    repo: match[2],
    pullNumber: Number(match[3]),
  };
}

// ---- SHA extraction (multi-strategy) ----------------------------------------

const SHA_RE = /^[0-9a-f]{40}$/;

interface ShaResult {
  baseSha: string;
  headSha: string;
}

/**
 * Try to extract baseSha and headSha from the page DOM.
 *
 * GitHub's DOM structure changes over time, so we try multiple strategies
 * in priority order and fall back gracefully.
 *
 * Known fragility:
 *   - Embedded JSON structure may change between GitHub deploys
 *   - Commit link selectors depend on GitHub's class naming conventions
 *   - These strategies are tested against github.com as of 2026-Q1
 *
 * Fallback: if all strategies fail, returns empty strings.
 * The daemon should fill SHAs via GitHub API (GET /repos/:owner/:repo/pulls/:number).
 */
export function extractShas(): ShaResult {
  return (
    tryEmbeddedJsonData() ??
    tryCommitElements() ??
    { baseSha: "", headSha: "" }
  );
}

// ---- Strategy 1: Embedded JSON data -----------------------------------------
//
// GitHub embeds React hydration data in <script type="application/json"> tags.
// These contain full PR metadata including baseRefOid / headRefOid.
// This is the most reliable strategy when available.

function tryEmbeddedJsonData(): ShaResult | null {
  const scripts = document.querySelectorAll<HTMLScriptElement>(
    'script[type="application/json"][data-target*="embeddedData"],' +
    'script[type="application/json"][data-target*="props"]',
  );

  for (const script of scripts) {
    const text = script.textContent;
    if (!text) continue;

    // Quick filter: skip JSON blobs that don't mention SHA-related keys.
    if (
      !text.includes("baseRefOid") &&
      !text.includes("headRefOid") &&
      !text.includes("baseCommitOid") &&
      !text.includes("headCommitOid")
    ) {
      continue;
    }

    try {
      const data: unknown = JSON.parse(text);
      const result = deepSearchForShas(data);
      if (result) return result;
    } catch {
      // Malformed JSON or unexpected structure — try next script tag.
    }
  }

  return null;
}

/**
 * Recursively search a JSON object for base/head SHA pairs.
 *
 * Looks for known GitHub key names (baseRefOid, headRefOid, etc.)
 * containing 40-char hex SHA strings.
 */
function deepSearchForShas(
  obj: unknown,
  depth = 0,
): ShaResult | null {
  if (depth > 20 || !obj || typeof obj !== "object") return null;

  const record = obj as Record<string, unknown>;

  // Known GitHub JSON key patterns for base/head SHAs
  const baseKeys = ["baseRefOid", "base_sha", "baseCommitOid"] as const;
  const headKeys = ["headRefOid", "head_sha", "headCommitOid"] as const;

  for (const bk of baseKeys) {
    for (const hk of headKeys) {
      const base = record[bk];
      const head = record[hk];
      if (
        typeof base === "string" && SHA_RE.test(base) &&
        typeof head === "string" && SHA_RE.test(head)
      ) {
        return { baseSha: base, headSha: head };
      }
    }
  }

  // Recurse into nested objects and arrays
  for (const value of Object.values(record)) {
    if (typeof value === "object" && value !== null) {
      const result = deepSearchForShas(value, depth + 1);
      if (result) return result;
    }
  }

  return null;
}

// ---- Strategy 2: Commit elements in the DOM ---------------------------------
//
// GitHub renders commit SHAs in clipboard-copy elements and commit links.
// This can extract at least the headSha; baseSha is rarely visible on
// the files page, so it may remain empty.

function tryCommitElements(): ShaResult | null {
  // clipboard-copy elements contain full commit SHAs for one-click copy.
  const copyElements = document.querySelectorAll<HTMLElement>(
    "clipboard-copy[value]",
  );
  for (const el of copyElements) {
    const value = el.getAttribute("value") ?? "";
    if (SHA_RE.test(value)) {
      return { baseSha: "", headSha: value };
    }
  }

  // Commit links in diff headers or PR metadata areas.
  const commitLinks = document.querySelectorAll<HTMLAnchorElement>(
    'a[href*="/commit/"]',
  );
  for (const link of commitLinks) {
    const href = link.getAttribute("href") ?? "";
    const shaMatch = href.match(/\/commit\/([0-9a-f]{40})/);
    if (shaMatch) {
      return { baseSha: "", headSha: shaMatch[1] };
    }
  }

  return null;
}

// ---- Full context extraction ------------------------------------------------

/**
 * Extract the complete PR context from the current page.
 *
 * Returns null if the current page is not a PR Changes page.
 * baseSha / headSha may be empty strings if DOM extraction fails —
 * the daemon should fill them via GitHub API as a fallback.
 */
export function extractPRContext(): PRKey | null {
  const urlContext = parsePRFromUrl();
  if (!urlContext) return null;

  const shas = extractShas();
  return {
    ...urlContext,
    ...shas,
  };
}

// ---- Context comparison -----------------------------------------------------

/** True if two PRKey values represent the same PR at the same revision. */
export function prContextEqual(
  a: PRKey | null,
  b: PRKey | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.host === b.host &&
    a.owner === b.owner &&
    a.repo === b.repo &&
    a.pullNumber === b.pullNumber &&
    a.baseSha === b.baseSha &&
    a.headSha === b.headSha
  );
}
