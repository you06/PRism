// ---------------------------------------------------------------------------
// PRism — Hunk Matching Tests (WORK10)
//
// Run with: npx tsx daemon/src/hunk-matcher.test.ts
// ---------------------------------------------------------------------------

import { normalizeLine, computePatchHash, type NormalizedLine } from "@prism/shared";
import { parseFilePatch, type CanonicalHunk } from "./hunk-canonicalizer.js";
import {
  matchHunks,
  matchHunksWithLines,
  lineSimilarity,
  type HunkMatchResult,
} from "./hunk-matcher.js";
import type { HunkRef } from "@prism/shared";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${message}`);
  }
}

// ---- Helper: build a HunkRef from raw lines (simulating DOM extraction) -----

function makeHunkRef(
  filePath: string,
  hunkHeader: string,
  rawLines: Array<{ type: "add" | "delete" | "context"; content: string }>,
): HunkRef {
  const normalized: NormalizedLine[] = rawLines.map((l) =>
    normalizeLine(l.content, l.type),
  );
  return {
    filePath,
    oldStart: 10,
    oldLines: 3,
    newStart: 10,
    newLines: 5,
    hunkHeader,
    patchHash: computePatchHash(normalized),
    domAnchorId: "prism-hunk-0",
    isVisible: true,
  };
}

// =============================================================================
// Test 1: Exact Match
// =============================================================================
console.log("\n--- Test 1: Exact Match ---");
{
  // Simulate a GitHub API patch for a file
  const apiPatch = [
    "@@ -10,3 +10,5 @@ function hello() {",
    " const a = 1;",
    "-const b = 2;",
    "+const b = 3;",
    "+const c = 4;",
    " return a + b;",
  ].join("\n");

  // Parse the API patch into canonical hunks
  const canonical = parseFilePatch("src/main.ts", apiPatch);
  assert(canonical.length === 1, "API patch produces 1 canonical hunk");

  // Simulate DOM extraction with identical content
  const domHunk = makeHunkRef(
    "src/main.ts",
    "@@ -10,3 +10,5 @@ function hello() {",
    [
      { type: "context", content: "const a = 1;" },
      { type: "delete", content: "const b = 2;" },
      { type: "add", content: "const b = 3;" },
      { type: "add", content: "const c = 4;" },
      { type: "context", content: "return a + b;" },
    ],
  );

  assert(
    domHunk.patchHash === canonical[0].patchHash,
    `patchHash matches: DOM=${domHunk.patchHash} API=${canonical[0].patchHash}`,
  );

  const results = matchHunks([domHunk], canonical);
  assert(results.length === 1, "1 match result");
  assert(results[0].matchType === "exact", "match type is exact");
  assert(results[0].confidence === 1.0, "confidence is 1.0");
  assert(results[0].canonicalHunk !== null, "canonical hunk is set");
}

// =============================================================================
// Test 2: Fuzzy Match — minor whitespace difference
// =============================================================================
console.log("\n--- Test 2: Fuzzy Match (whitespace diff) ---");
{
  // API patch: normal content
  const apiPatch = [
    "@@ -20,2 +20,3 @@ class Foo {",
    " let x = 10;",
    "+let y = 20;",
    " return x;",
  ].join("\n");

  const canonical = parseFilePatch("src/foo.ts", apiPatch);
  assert(canonical.length === 1, "API patch produces 1 canonical hunk");

  // DOM extraction: same logical content but with trailing NBSP (decoration)
  // that produces a *slightly different* hash because of an extra space
  // We simulate this by adding a trailing space that normalization doesn't catch
  // (e.g., a tab character that DOM renders differently)
  const domLines: NormalizedLine[] = [
    { type: "context", content: "let x = 10;" },
    { type: "add", content: "let y = 20; " }, // extra trailing space (pre-normalize)
    { type: "context", content: "return x;" },
  ];
  // Note: normalizeLine would trimEnd, so to simulate a post-normalize diff,
  // we directly build with a tab in content
  const domLinesWithDiff: NormalizedLine[] = [
    { type: "context", content: "let x = 10;" },
    { type: "add", content: "let y =  20;" }, // double space (normalize doesn't collapse)
    { type: "context", content: "return x;" },
  ];
  const domHash = computePatchHash(domLinesWithDiff);

  const domHunk: HunkRef = {
    filePath: "src/foo.ts",
    oldStart: 20,
    oldLines: 2,
    newStart: 20,
    newLines: 3,
    hunkHeader: "@@ -20,2 +20,3 @@ class Foo {",
    patchHash: domHash, // different from canonical
    domAnchorId: "prism-hunk-1",
    isVisible: true,
  };

  assert(
    domHunk.patchHash !== canonical[0].patchHash,
    `patchHash differs: DOM=${domHunk.patchHash} API=${canonical[0].patchHash}`,
  );

  // matchHunks uses header-based fuzzy match
  const results = matchHunks([domHunk], canonical);
  assert(results.length === 1, "1 match result");
  assert(results[0].matchType === "fuzzy", "match type is fuzzy");
  assert(results[0].confidence > 0, "confidence > 0");
  assert(results[0].canonicalHunk !== null, "canonical hunk found via fuzzy");
  assert(
    results[0].canonicalHunk!.filePath === "src/foo.ts",
    "matched to correct file",
  );

  // Also test matchHunksWithLines for real line-level similarity
  const domHunkWithLines = {
    ...domHunk,
    lines: domLinesWithDiff,
  };
  const results2 = matchHunksWithLines([domHunkWithLines], canonical);
  assert(results2[0].matchType === "fuzzy", "matchHunksWithLines: fuzzy match");
  assert(results2[0].confidence > 0.6, `matchHunksWithLines: similarity ${results2[0].confidence.toFixed(2)} > 0.6`);
}

// =============================================================================
// Test 3: File-level Fallback
// =============================================================================
console.log("\n--- Test 3: File-level Fallback ---");
{
  // API has hunks for a file
  const apiPatch = [
    "@@ -1,3 +1,4 @@",
    " line1",
    "+line2",
    " line3",
    " line4",
  ].join("\n");

  const canonical = parseFilePatch("src/utils.ts", apiPatch);

  // DOM has a completely different hunk for the same file
  // (different header, different content — structure mismatch)
  const domHunk: HunkRef = {
    filePath: "src/utils.ts",
    oldStart: 100,
    oldLines: 5,
    newStart: 100,
    newLines: 8,
    hunkHeader: "@@ -100,5 +100,8 @@ function other() {",
    patchHash: "fnv:deadbeef",
    domAnchorId: "prism-hunk-2",
    isVisible: true,
  };

  const results = matchHunks([domHunk], canonical);
  assert(results.length === 1, "1 match result");
  assert(results[0].matchType === "file-level", "match type is file-level");
  assert(results[0].confidence === 0, "confidence is 0");
  assert(results[0].canonicalHunk === null, "no canonical hunk assigned");
  assert(
    results[0].reason.includes("No matching hunk"),
    "reason explains failure",
  );
}

// =============================================================================
// Test 4: lineSimilarity function
// =============================================================================
console.log("\n--- Test 4: lineSimilarity ---");
{
  assert(lineSimilarity("a\nb\nc", "a\nb\nc") === 1.0, "identical → 1.0");
  assert(lineSimilarity("", "") === 1.0, "both empty → 1.0");
  assert(lineSimilarity("a\nb\nc", "") === 0.0, "one empty → 0.0");

  const sim = lineSimilarity("a\nb\nc\nd", "a\nb\nX\nd");
  assert(sim === 0.75, `one line changed in 4 → ${sim} (expected 0.75)`);

  const sim2 = lineSimilarity("a\nb", "a\nb\nc");
  assert(sim2 > 0.5, `minor addition → ${sim2.toFixed(2)} > 0.5`);
}

// =============================================================================
// Test 5: Multi-hunk file parsing
// =============================================================================
console.log("\n--- Test 5: Multi-hunk parsing ---");
{
  const apiPatch = [
    "@@ -1,3 +1,4 @@",
    " line1",
    "+line2",
    " line3",
    " line4",
    "@@ -50,2 +51,3 @@ function mid() {",
    " midLine1",
    "+midLine2",
    " midLine3",
  ].join("\n");

  const hunks = parseFilePatch("src/multi.ts", apiPatch);
  assert(hunks.length === 2, "2 hunks parsed from multi-hunk patch");
  assert(hunks[0].oldStart === 1, "first hunk starts at line 1");
  assert(hunks[1].oldStart === 50, "second hunk starts at line 50");
  assert(hunks[0].patchHash !== hunks[1].patchHash, "different hunks → different hashes");
}

// =============================================================================
// Summary
// =============================================================================
console.log(`\n${"=".repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log("All tests passed!");
}
