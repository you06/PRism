// ---------------------------------------------------------------------------
// PRism — DOM Hunk Extractor
//
// Extracts structured HunkRef objects from the GitHub PR Changes page DOM.
// Handles the fragile DOM parsing needed to identify file containers,
// diff hunks, and their content.
//
// DOM Assumptions (GitHub.com, 2026-Q1):
//   - File containers: div.file[data-tagsearch-path] or copilot-diff-entry
//   - Diff tables: table.diff-table inside .js-file-content
//   - Hunk headers: td.blob-code-hunk containing @@ ... @@
//   - Diff lines: td.blob-code-{addition,deletion,context}
//   - Line content: .blob-code-inner spans within blob-code cells
//
// Each selector is documented with a fragility level:
//   [STABLE]   — semantic attribute unlikely to change
//   [MODERATE] — class name GitHub has used consistently for years
//   [FRAGILE]  — structure that may change between GitHub deploys
//
// Known limitations (V1):
//   - Split diff view: only extracts from the unified-style cells.
//     In split view, some hunks may have incomplete line extraction.
//   - Rich diff view (e.g., rendered Markdown): skipped entirely.
//   - Binary files / "Large diff not rendered": skipped.
// ---------------------------------------------------------------------------

import type { HunkRef } from "./shared.js";

const DEBUG = false;
function debugLog(...args: unknown[]): void {
  if (DEBUG) console.log("[PRism]", ...args);
}
import {
  normalizeLine,
  computePatchHash,
  type DiffLineType,
  type NormalizedLine,
} from "./patch-hash.js";

/** Counter for generating unique domAnchorIds within a page session. */
let anchorCounter = 0;

/** Reset anchor counter (called on context change / page transition). */
export function resetAnchorCounter(): void {
  anchorCounter = 0;
}

// ---- File Container Discovery -----------------------------------------------

/**
 * Selectors for file containers, tried in order (first match wins).
 *
 * [STABLE]   data-tagsearch-path is a semantic attribute for file search.
 * [MODERATE] copilot-diff-entry is the newer custom element wrapper.
 * [MODERATE] div.file is the classic container class.
 */
const FILE_CONTAINER_SELECTORS = [
  'table[aria-label^="Diff for:"]',
  "div.file[data-tagsearch-path]",
  "copilot-diff-entry",
  "div.file",
] as const;

/** Find all file diff containers on the page. */
function findFileContainers(): HTMLElement[] {
  for (const selector of FILE_CONTAINER_SELECTORS) {
    const elements = document.querySelectorAll<HTMLElement>(selector);
    if (elements.length > 0) {
      return Array.from(elements);
    }
  }
  return [];
}

// ---- File Path Extraction ---------------------------------------------------

/**
 * Extract the file path from a file container element.
 *
 * Strategies (priority order):
 *   1. [STABLE]   data-tagsearch-path attribute
 *   2. [STABLE]   data-file-path attribute (copilot-diff-entry)
 *   3. [MODERATE] file-header link title
 *   4. [MODERATE] file-info link text
 *   5. [FRAGILE]  clipboard-copy value in file header
 */
function extractFilePath(container: HTMLElement): string | null {
  // Strategy 0: aria-label on GitHub's newer /changes diff tables
  const ariaLabel = container.getAttribute("aria-label");
  if (ariaLabel?.startsWith("Diff for:")) {
    return ariaLabel.slice("Diff for:".length).trim();
  }

  // Strategy 1: data-tagsearch-path
  const tagSearchPath = container.getAttribute("data-tagsearch-path");
  if (tagSearchPath) return tagSearchPath;

  // Strategy 2: data-file-path (newer rendering)
  const dataFilePath = container.getAttribute("data-file-path");
  if (dataFilePath) return dataFilePath;

  // Strategy 3: file header link title
  const headerLink = container.querySelector<HTMLAnchorElement>(
    ".file-header a[title], .file-header a.Link--primary",
  );
  if (headerLink?.title) return headerLink.title;
  if (headerLink?.textContent?.trim()) return headerLink.textContent.trim();

  // Strategy 4: file-info link
  const fileInfoLink = container.querySelector<HTMLAnchorElement>(
    ".file-info a, .file-info .Link--primary",
  );
  if (fileInfoLink?.textContent?.trim()) return fileInfoLink.textContent.trim();

  // Strategy 5: clipboard-copy in file header
  const clipboardCopy = container.querySelector<HTMLElement>(
    ".file-header clipboard-copy[value]",
  );
  if (clipboardCopy) {
    const value = clipboardCopy.getAttribute("value");
    if (value) return value;
  }

  return null;
}

// ---- Hunk Header Parsing ----------------------------------------------------

/** Parses: @@ -oldStart,oldLines +newStart,newLines @@ optional context */
const HUNK_HEADER_RE = /@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

interface ParsedHunkHeader {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  fullHeader: string;
}

/**
 * Parse a hunk header string into structured line range data.
 * When the line count is omitted (e.g., "@@ -1 +1 @@"), it means 1.
 */
function parseHunkHeader(text: string): ParsedHunkHeader | null {
  const match = text.match(HUNK_HEADER_RE);
  if (!match) return null;

  return {
    oldStart: parseInt(match[1], 10),
    oldLines: match[2] !== undefined ? parseInt(match[2], 10) : 1,
    newStart: parseInt(match[3], 10),
    newLines: match[4] !== undefined ? parseInt(match[4], 10) : 1,
    fullHeader: text.trim(),
  };
}

// ---- Diff Line Extraction ---------------------------------------------------

/**
 * Determine the diff line type from a blob-code cell's CSS classes.
 *
 * [MODERATE] These class names have been stable across GitHub versions.
 */
function classifyDiffCell(cell: HTMLElement): DiffLineType | null {
  const side = cell.getAttribute("data-diff-side") ?? "";
  const numberCell = cell.parentElement?.querySelector<HTMLElement>(
    `td[data-diff-side="${CSS.escape(side)}"]:not(.diff-text-cell)`,
  );
  const attrsText = [
    cell.className,
    cell.getAttribute("style") ?? "",
    numberCell?.className ?? "",
    numberCell?.getAttribute("style") ?? "",
  ].join(" ");

  if (
    attrsText.includes("blob-code-addition") ||
    attrsText.includes("addition")
  ) {
    return "add";
  }
  if (
    attrsText.includes("blob-code-deletion") ||
    attrsText.includes("deletion")
  ) {
    return "delete";
  }
  if (
    attrsText.includes("blob-code-context") ||
    attrsText.includes("neutral") ||
    attrsText.includes("context") ||
    cell.classList.contains("diff-text-cell")
  ) {
    return "context";
  }
  return null;
}

/**
 * Extract the text content of a diff line cell, stripping GitHub UI elements.
 *
 * GitHub renders code inside .blob-code-inner spans and adds marker elements
 * (±signs), empty-line indicators, and expansion controls that must be
 * ignored for content hashing.
 *
 * [MODERATE] .blob-code-inner is the stable inner content wrapper.
 */
function extractCellContent(cell: HTMLElement): string {
  const newUiContent = cell.querySelector<HTMLElement>(
    '[data-testid="diff-line-content"], .react-code-text, .react-code-cell',
  );
  if (newUiContent?.textContent) {
    return newUiContent.textContent;
  }

  const inner = cell.querySelector<HTMLElement>(".blob-code-inner");
  return (inner ?? cell).textContent ?? "";
}

function findDiffContentCell(row: HTMLTableRowElement): HTMLElement | null {
  const diffTextCells = Array.from(
    row.querySelectorAll<HTMLElement>("td.diff-text-cell"),
  );

  let contextCell: HTMLElement | null = null;
  for (const cell of diffTextCells) {
    const lineType = classifyDiffCell(cell);
    if (lineType === "add" || lineType === "delete") {
      return cell;
    }
    if (!contextCell && lineType === "context") {
      contextCell = cell;
    }
  }

  if (contextCell) return contextCell;

  const cells = Array.from(row.cells) as HTMLElement[];
  for (let i = cells.length - 1; i >= 0; i--) {
    const cell = cells[i];
    if (!cell.hasAttribute("data-line-number")) {
      return cell;
    }
  }

  return null;
}

// ---- Hunk Extraction (per file) ---------------------------------------------

/**
 * Selectors for diff tables within a file container.
 *
 * [MODERATE] table.diff-table is the primary diff table class.
 * [MODERATE] .js-file-content table catches wrapped tables.
 * [FRAGILE]  bare table is a last-resort fallback.
 */
const DIFF_TABLE_SELECTORS = [
  "table.diff-table",
  ".js-file-content table",
  "table.d-table",
  "table",
] as const;

/**
 * Selectors for hunk header cells.
 *
 * [MODERATE] td.blob-code-hunk is the unified diff hunk header cell.
 */
const HUNK_HEADER_CELL_SELECTORS = [
  "td.diff-hunk-cell",
  "td.blob-code-hunk",
  "td.blob-code.blob-code-hunk",
] as const;

/** Intermediate representation of a hunk before conversion to HunkRef. */
interface RawHunk {
  headerRow: HTMLTableRowElement;
  header: ParsedHunkHeader;
  lines: NormalizedLine[];
}

/**
 * Extract all hunks from a single file's diff table.
 *
 * Walks table rows sequentially. Hunk boundaries are identified by rows
 * containing cells with the blob-code-hunk class. Lines between consecutive
 * hunk headers belong to the preceding hunk.
 */
function extractHunksFromTable(table: HTMLTableElement): RawHunk[] {
  const hunks: RawHunk[] = [];
  let currentHunk: RawHunk | null = null;

  const rows = table.querySelectorAll<HTMLTableRowElement>("tr");

  for (const row of rows) {
    // Check if this row contains a hunk header
    let hunkHeaderCell: HTMLElement | null = null;
    for (const selector of HUNK_HEADER_CELL_SELECTORS) {
      hunkHeaderCell = row.querySelector<HTMLElement>(selector);
      if (hunkHeaderCell) break;
    }

    if (hunkHeaderCell) {
      const headerText = hunkHeaderCell.textContent ?? "";
      const parsed = parseHunkHeader(headerText);

      if (parsed) {
        // Finalize previous hunk
        if (currentHunk && currentHunk.lines.length > 0) {
          hunks.push(currentHunk);
        }

        currentHunk = {
          headerRow: row,
          header: parsed,
          lines: [],
        };
      }
      continue;
    }

    // Not a hunk header — try to extract diff content
    if (!currentHunk) continue;

    const codeCells = row.querySelectorAll<HTMLElement>("td.blob-code");
    if (codeCells.length > 0) {
      for (const cell of codeCells) {
        const lineType = classifyDiffCell(cell);
        if (lineType === null) continue;

        const content = extractCellContent(cell);
        currentHunk.lines.push(normalizeLine(content, lineType));
        // In unified view there is one relevant code cell per row.
        // Break after the first classified cell to avoid double-counting
        // in split view (where both sides appear in the same row).
        break;
      }
      continue;
    }

    const contentCell = findDiffContentCell(row);
    if (contentCell) {
      const lineType = classifyDiffCell(contentCell);
      if (lineType !== null) {
        const content = extractCellContent(contentCell);
        currentHunk.lines.push(normalizeLine(content, lineType));
      }
    }
  }

  // Finalize last hunk
  if (currentHunk && currentHunk.lines.length > 0) {
    hunks.push(currentHunk);
  }

  return hunks;
}

// ---- Deduplication ----------------------------------------------------------

/**
 * Check if an element already has a PRism anchor ID from a previous extraction.
 * Returns the existing ID, or null if none.
 */
function existingAnchorId(el: HTMLElement): string | null {
  return el.getAttribute("data-prism-hunk-id");
}

// ---- Main Entry Point -------------------------------------------------------

/**
 * Extract all HunkRef objects from the current GitHub PR Changes page.
 *
 * Scans the DOM for file containers, finds diff tables within each,
 * and extracts structured hunk information including stable patch hashes.
 *
 * Each hunk is assigned a unique domAnchorId (stored as a data-prism-hunk-id
 * attribute on the hunk header row). If a row already has an anchor from a
 * previous extraction, the existing ID is reused to maintain stability.
 *
 * @returns Array of HunkRef objects for all hunks found on the page.
 */
export function extractHunks(): HunkRef[] {
  const results: HunkRef[] = [];
  const fileContainers = findFileContainers();

  for (const container of fileContainers) {
    const filePath = extractFilePath(container);
    if (!filePath) {
      debugLog("Could not extract file path from container:", container);
      continue;
    }

    // Find the diff table
    let diffTable: HTMLTableElement | null = null;
    if (container instanceof HTMLTableElement) {
      diffTable = container;
    }
    for (const selector of DIFF_TABLE_SELECTORS) {
      if (diffTable) break;
      diffTable = container.querySelector<HTMLTableElement>(selector);
      if (diffTable) break;
    }

    if (!diffTable) {
      // No diff table — binary file, collapsed diff, or "Load diff" placeholder
      continue;
    }

    const rawHunks = extractHunksFromTable(diffTable);

    for (const raw of rawHunks) {
      // Reuse existing anchor ID if present (stability across re-extractions)
      const anchorId =
        existingAnchorId(raw.headerRow) ?? `prism-hunk-${anchorCounter++}`;
      raw.headerRow.setAttribute("data-prism-hunk-id", anchorId);

      results.push({
        filePath,
        oldStart: raw.header.oldStart,
        oldLines: raw.header.oldLines,
        newStart: raw.header.newStart,
        newLines: raw.header.newLines,
        hunkHeader: raw.header.fullHeader,
        patchHash: computePatchHash(raw.lines),
        domAnchorId: anchorId,
        isVisible: false,
      });
    }
  }

  if (results.length > 0) {
    debugLog(`Extracted ${results.length} hunks from ${fileContainers.length} files`);
  }

  return results;
}

/**
 * Get the DOM element for a hunk by its domAnchorId.
 * Used by rendering code to locate where to insert summary cards.
 */
export function getHunkElement(domAnchorId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `[data-prism-hunk-id="${CSS.escape(domAnchorId)}"]`,
  );
}
