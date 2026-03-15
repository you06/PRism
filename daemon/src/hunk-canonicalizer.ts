// ---------------------------------------------------------------------------
// PRism daemon — Hunk Canonicalizer (WORK10)
//
// Parses GitHub API patch text (from the PR files endpoint) into individual
// hunks and generates canonical patchHash values using the same shared
// normalize + FNV-1a algorithm that the extension uses on DOM-extracted hunks.
//
// This ensures that the same hunk produces an identical patchHash regardless
// of whether it was extracted from the GitHub DOM or the API response.
// ---------------------------------------------------------------------------

import {
  normalizeLine,
  computePatchHash,
  type DiffLineType,
  type NormalizedLine,
} from "@prism/shared";

// ---- Types ------------------------------------------------------------------

/** A single canonical hunk parsed from GitHub API patch text. */
export interface CanonicalHunk {
  filePath: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  hunkHeader: string;   // full "@@ ... @@" line
  patchHash: string;    // "fnv:<8hex>"
  lines: NormalizedLine[];
}

// ---- Hunk header parsing ----------------------------------------------------

const HUNK_HEADER_RE = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)$/;

interface ParsedHeader {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  fullHeader: string;
}

function parseHunkHeader(line: string): ParsedHeader | null {
  const m = line.match(HUNK_HEADER_RE);
  if (!m) return null;
  return {
    oldStart: parseInt(m[1], 10),
    oldLines: m[2] !== undefined ? parseInt(m[2], 10) : 1,
    newStart: parseInt(m[3], 10),
    newLines: m[4] !== undefined ? parseInt(m[4], 10) : 1,
    fullHeader: line.trim(),
  };
}

// ---- Diff line classification -----------------------------------------------

function classifyPatchLine(line: string): { type: DiffLineType; content: string } | null {
  if (line.length === 0) {
    // Empty line in patch text = context line with empty content
    return { type: "context", content: "" };
  }
  const prefix = line[0];
  const rest = line.slice(1);
  switch (prefix) {
    case "+": return { type: "add", content: rest };
    case "-": return { type: "delete", content: rest };
    case " ": return { type: "context", content: rest };
    case "\\": return null; // "\ No newline at end of file" — skip
    default:  return { type: "context", content: line }; // fallback: treat as context
  }
}

// ---- Public API -------------------------------------------------------------

/**
 * Parse a GitHub API patch string for a single file into CanonicalHunk[].
 *
 * The GitHub PR files endpoint returns a `patch` field per file containing
 * all hunks concatenated. This function splits them, normalizes each line
 * using the shared algorithm, and computes a patchHash per hunk.
 *
 * @param filePath - The file path this patch belongs to (from PRChangedFile.filename)
 * @param patchText - The raw patch text from the GitHub API (PRChangedFile.patch)
 * @returns Array of canonical hunks with stable patchHash values.
 */
export function parseFilePatch(filePath: string, patchText: string): CanonicalHunk[] {
  if (!patchText) return [];

  const rawLines = patchText.split("\n");
  const hunks: CanonicalHunk[] = [];
  let currentHeader: ParsedHeader | null = null;
  let currentLines: NormalizedLine[] = [];

  function finalizeHunk() {
    if (currentHeader && currentLines.length > 0) {
      hunks.push({
        filePath,
        oldStart: currentHeader.oldStart,
        oldLines: currentHeader.oldLines,
        newStart: currentHeader.newStart,
        newLines: currentHeader.newLines,
        hunkHeader: currentHeader.fullHeader,
        patchHash: computePatchHash(currentLines),
        lines: currentLines,
      });
    }
  }

  for (const raw of rawLines) {
    // Check if this is a new hunk header
    const header = parseHunkHeader(raw);
    if (header) {
      finalizeHunk();
      currentHeader = header;
      currentLines = [];
      continue;
    }

    // Skip lines before the first hunk header
    if (!currentHeader) continue;

    const classified = classifyPatchLine(raw);
    if (!classified) continue; // skip "\ No newline..." lines

    currentLines.push(normalizeLine(classified.content, classified.type));
  }

  // Finalize the last hunk
  finalizeHunk();

  return hunks;
}

/**
 * Parse all changed files from a PR into a flat list of canonical hunks.
 *
 * Convenience wrapper over parseFilePatch for batch processing.
 */
export function parseAllPatches(
  files: Array<{ filename: string; patch?: string }>,
): CanonicalHunk[] {
  const all: CanonicalHunk[] = [];
  for (const f of files) {
    if (f.patch) {
      all.push(...parseFilePatch(f.filename, f.patch));
    }
  }
  return all;
}
