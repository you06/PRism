// ---------------------------------------------------------------------------
// PRism — Patch Normalization & Hashing (shared)
//
// Canonical normalize + hash logic used by both the extension (DOM-side) and
// the daemon (GitHub API-side) to produce identical patchHash values for the
// same hunk content.
//
// Hash algorithm: FNV-1a 32-bit — fast, synchronous, non-cryptographic.
// Hash format: "fnv:<8-hex-chars>", e.g. "fnv:3b7d1a2f"
// ---------------------------------------------------------------------------

/** Type of a single diff line. */
export type DiffLineType = "add" | "delete" | "context";

/** A single normalized patch line. */
export interface NormalizedLine {
  type: DiffLineType;
  content: string;
}

/**
 * Normalize a raw patch line.
 *
 * Strips decoration that may differ between DOM extraction and API text:
 *   - Non-breaking spaces (\u00a0) → regular spaces
 *   - Carriage returns → removed
 *   - Trailing whitespace → trimmed
 *
 * Preserves leading indentation (semantically meaningful in code).
 */
export function normalizeLine(
  raw: string,
  type: DiffLineType,
): NormalizedLine {
  const content = raw
    .replace(/\u00a0/g, " ") // NBSP → space
    .replace(/\r/g, "")      // strip CR
    .trimEnd();               // trailing whitespace

  return { type, content };
}

/**
 * Build a canonical string from normalized patch lines.
 *
 * Format: each line prefixed with its type character (+/-/space),
 * followed by content, separated by newlines.
 *
 * Two hunks with identical canonical forms are the same hunk.
 */
export function canonicalizePatch(lines: NormalizedLine[]): string {
  const prefixMap: Record<DiffLineType, string> = {
    add: "+",
    delete: "-",
    context: " ",
  };

  return lines
    .map((line) => `${prefixMap[line.type]}${line.content}`)
    .join("\n");
}

/**
 * FNV-1a 32-bit hash.
 *
 * Deterministic, fast, synchronous. Suitable for content scripts
 * (no crypto.subtle needed) and server-side alike.
 *
 * Reference: http://www.isthe.com/chongo/tech/comp/fnv/
 */
export function fnv1a32(input: string): number {
  const FNV_OFFSET = 0x811c9dc5;
  const FNV_PRIME = 0x01000193;

  let hash = FNV_OFFSET;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }

  return hash >>> 0; // force unsigned 32-bit
}

/**
 * Compute a stable patch hash from normalized patch lines.
 *
 * Returns "fnv:<8-hex-chars>".
 *
 * Stability: same hunk content → same hash regardless of whether
 * it was extracted from the DOM or from GitHub API patch text.
 */
export function computePatchHash(lines: NormalizedLine[]): string {
  const canonical = canonicalizePatch(lines);
  const hash = fnv1a32(canonical);
  return `fnv:${hash.toString(16).padStart(8, "0")}`;
}
