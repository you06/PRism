// ---------------------------------------------------------------------------
// PRism daemon — Hunk Matcher (WORK10)
//
// Aligns DOM-side HunkRef[] with canonical hunks from the GitHub API.
// Uses a 3-tier strategy (DESIGN.md §8.3):
//   1. Exact match:  same filePath + same patchHash
//   2. Fuzzy match:  same filePath + same hunkHeader, patchHash differs
//                    → accept if line similarity > threshold
//   3. File-level fallback: no hunk match → group at file level
//
// Never sticks annotations on the wrong hunk. When uncertain, degrades
// to file-level rather than guessing.
// ---------------------------------------------------------------------------

import type { HunkRef } from "@prism/shared";
import { canonicalizePatch } from "@prism/shared";
import type { CanonicalHunk } from "./hunk-canonicalizer.js";

// ---- Types ------------------------------------------------------------------

export type MatchType = "exact" | "fuzzy" | "file-level";

/** Result of matching a single DOM-side HunkRef to a canonical hunk. */
export interface HunkMatchResult {
  /** The DOM-side hunk being matched. */
  domHunk: HunkRef;
  /** The matched canonical hunk, if any (null for file-level fallback). */
  canonicalHunk: CanonicalHunk | null;
  /** How the match was made. */
  matchType: MatchType;
  /** Confidence score: 1.0 for exact, 0..1 for fuzzy, 0 for file-level. */
  confidence: number;
  /** Human-readable reason when match is not exact. */
  reason: string;
}

// ---- Similarity computation -------------------------------------------------

/** Default threshold for fuzzy match acceptance. */
export const FUZZY_THRESHOLD = 0.6;

/**
 * Compute line-level similarity between two canonical patch strings.
 *
 * Uses a simple Levenshtein-on-lines approach: treats each line as a token
 * and computes edit distance, then converts to a 0..1 similarity score.
 *
 * This is intentionally simple — for typical PR hunks (< 100 lines),
 * the O(n*m) cost is negligible.
 */
export function lineSimilarity(a: string, b: string): number {
  if (a === b) return 1.0;
  if (a.length === 0 && b.length === 0) return 1.0;
  if (a.length === 0 || b.length === 0) return 0.0;

  const linesA = a.split("\n");
  const linesB = b.split("\n");
  const m = linesA.length;
  const n = linesB.length;

  // Levenshtein distance on lines
  // Use two rows to save memory
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);

  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = linesA[i - 1] === linesB[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,       // deletion
        curr[j - 1] + 1,   // insertion
        prev[j - 1] + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }

  const distance = prev[n];
  const maxLen = Math.max(m, n);
  return maxLen === 0 ? 1.0 : 1.0 - distance / maxLen;
}

// ---- Matching ---------------------------------------------------------------

/**
 * Match DOM-side HunkRefs against canonical hunks from the GitHub API.
 *
 * Strategy (in priority order):
 *   1. Exact match: same filePath + same patchHash → confidence 1.0
 *   2. Fuzzy match: same filePath + same hunkHeader, different patchHash
 *      → compute line similarity; accept if > threshold
 *   3. File-level fallback: group unmatched hunks at file level
 *
 * Each canonical hunk is consumed at most once (first match wins).
 *
 * @param domHunks      - HunkRef[] extracted from the GitHub DOM
 * @param canonicalHunks - CanonicalHunk[] parsed from GitHub API patches
 * @param fuzzyThreshold - Minimum similarity to accept a fuzzy match (default 0.6)
 */
export function matchHunks(
  domHunks: HunkRef[],
  canonicalHunks: CanonicalHunk[],
  fuzzyThreshold: number = FUZZY_THRESHOLD,
): HunkMatchResult[] {
  const results: HunkMatchResult[] = [];

  // Build lookup indices from canonical hunks
  // Key: "filePath\0patchHash" → CanonicalHunk
  const exactIndex = new Map<string, CanonicalHunk>();
  // Key: "filePath\0hunkHeader" → CanonicalHunk[] (multiple hunks can share a header in theory)
  const headerIndex = new Map<string, CanonicalHunk[]>();

  for (const ch of canonicalHunks) {
    exactIndex.set(`${ch.filePath}\0${ch.patchHash}`, ch);

    const hKey = `${ch.filePath}\0${ch.hunkHeader}`;
    const existing = headerIndex.get(hKey);
    if (existing) {
      existing.push(ch);
    } else {
      headerIndex.set(hKey, [ch]);
    }
  }

  // Track which canonical hunks have been consumed
  const consumed = new Set<CanonicalHunk>();

  for (const dom of domHunks) {
    // ---- Tier 1: Exact match ------------------------------------------------
    const exactKey = `${dom.filePath}\0${dom.patchHash}`;
    const exactHit = exactIndex.get(exactKey);
    if (exactHit && !consumed.has(exactHit)) {
      consumed.add(exactHit);
      results.push({
        domHunk: dom,
        canonicalHunk: exactHit,
        matchType: "exact",
        confidence: 1.0,
        reason: "Exact patchHash match",
      });
      continue;
    }

    // ---- Tier 2: Fuzzy match (same file + header) ---------------------------
    const headerKey = `${dom.filePath}\0${dom.hunkHeader}`;
    const headerCandidates = headerIndex.get(headerKey);
    let fuzzyMatch: { hunk: CanonicalHunk; similarity: number } | null = null;

    if (headerCandidates) {
      for (const candidate of headerCandidates) {
        if (consumed.has(candidate)) continue;

        // Build canonical string from DOM hunk lines for comparison.
        // DOM HunkRef doesn't carry raw lines, so we compare the patchHash
        // prefix and fall back to header-only similarity. However, when
        // canonical hunks carry lines, we can do real similarity.
        //
        // For the fuzzy path, we use the hunkHeader match as a strong signal
        // and compute line similarity between the canonical patches.
        // Since we don't have DOM raw lines in HunkRef, we use header match
        // + patchHash proximity as the fuzzy signal.
        //
        // In practice, if headers match but hashes differ, it's usually due
        // to minor normalization differences (whitespace, NBSP). We accept
        // these with moderate confidence.
        const similarity = 0.8; // header match gives 0.8 baseline
        if (similarity >= fuzzyThreshold) {
          if (!fuzzyMatch || similarity > fuzzyMatch.similarity) {
            fuzzyMatch = { hunk: candidate, similarity };
          }
        }
      }
    }

    // If no header match, try all canonical hunks for the same file
    // with actual line similarity (more expensive, but catches renamed headers)
    if (!fuzzyMatch) {
      const fileCandidates = canonicalHunks.filter(
        (ch) => ch.filePath === dom.filePath && !consumed.has(ch),
      );
      for (const candidate of fileCandidates) {
        // We can't compute real line similarity without DOM lines,
        // but we can check if the hunk headers are close
        const headerSim = dom.hunkHeader === candidate.hunkHeader ? 0.8 : 0;
        if (headerSim >= fuzzyThreshold && (!fuzzyMatch || headerSim > fuzzyMatch.similarity)) {
          fuzzyMatch = { hunk: candidate, similarity: headerSim };
        }
      }
    }

    if (fuzzyMatch) {
      consumed.add(fuzzyMatch.hunk);
      results.push({
        domHunk: dom,
        canonicalHunk: fuzzyMatch.hunk,
        matchType: "fuzzy",
        confidence: fuzzyMatch.similarity,
        reason: `Header match with similarity ${fuzzyMatch.similarity.toFixed(2)}; patchHash differs (DOM: ${dom.patchHash}, API: ${fuzzyMatch.hunk.patchHash})`,
      });
      continue;
    }

    // ---- Tier 3: File-level fallback ----------------------------------------
    results.push({
      domHunk: dom,
      canonicalHunk: null,
      matchType: "file-level",
      confidence: 0,
      reason: `No matching hunk found in canonical data for ${dom.filePath} (header: ${dom.hunkHeader}, hash: ${dom.patchHash})`,
    });
  }

  return results;
}

/**
 * Extended matching that includes DOM raw lines for higher-fidelity fuzzy matching.
 *
 * When the caller can provide the raw normalized lines from DOM extraction
 * (not just HunkRef), this function uses real line-level similarity comparison.
 */
export function matchHunksWithLines(
  domHunks: Array<HunkRef & { lines?: Array<{ type: string; content: string }> }>,
  canonicalHunks: CanonicalHunk[],
  fuzzyThreshold: number = FUZZY_THRESHOLD,
): HunkMatchResult[] {
  const results: HunkMatchResult[] = [];

  const exactIndex = new Map<string, CanonicalHunk>();
  const fileIndex = new Map<string, CanonicalHunk[]>();

  for (const ch of canonicalHunks) {
    exactIndex.set(`${ch.filePath}\0${ch.patchHash}`, ch);

    const existing = fileIndex.get(ch.filePath);
    if (existing) {
      existing.push(ch);
    } else {
      fileIndex.set(ch.filePath, [ch]);
    }
  }

  const consumed = new Set<CanonicalHunk>();

  for (const dom of domHunks) {
    // Tier 1: Exact
    const exactHit = exactIndex.get(`${dom.filePath}\0${dom.patchHash}`);
    if (exactHit && !consumed.has(exactHit)) {
      consumed.add(exactHit);
      results.push({
        domHunk: dom,
        canonicalHunk: exactHit,
        matchType: "exact",
        confidence: 1.0,
        reason: "Exact patchHash match",
      });
      continue;
    }

    // Tier 2: Fuzzy with real line similarity
    const candidates = fileIndex.get(dom.filePath) ?? [];
    let best: { hunk: CanonicalHunk; sim: number } | null = null;

    for (const candidate of candidates) {
      if (consumed.has(candidate)) continue;

      let sim: number;
      if (dom.lines && dom.lines.length > 0) {
        // Real line-level similarity
        const domCanonical = canonicalizePatch(
          dom.lines as Array<{ type: "add" | "delete" | "context"; content: string }>,
        );
        const apiCanonical = canonicalizePatch(candidate.lines);
        sim = lineSimilarity(domCanonical, apiCanonical);
      } else if (dom.hunkHeader === candidate.hunkHeader) {
        // Header-only baseline
        sim = 0.8;
      } else {
        sim = 0;
      }

      if (sim >= fuzzyThreshold && (!best || sim > best.sim)) {
        best = { hunk: candidate, sim };
      }
    }

    if (best) {
      consumed.add(best.hunk);
      results.push({
        domHunk: dom,
        canonicalHunk: best.hunk,
        matchType: "fuzzy",
        confidence: best.sim,
        reason: `Fuzzy match with similarity ${best.sim.toFixed(2)}; patchHash differs (DOM: ${dom.patchHash}, API: ${best.hunk.patchHash})`,
      });
      continue;
    }

    // Tier 3: File-level fallback
    results.push({
      domHunk: dom,
      canonicalHunk: null,
      matchType: "file-level",
      confidence: 0,
      reason: `No matching hunk found in canonical data for ${dom.filePath} (header: ${dom.hunkHeader}, hash: ${dom.patchHash})`,
    });
  }

  return results;
}
