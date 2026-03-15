// ---------------------------------------------------------------------------
// PRism daemon — Summary prompt template (WORK11)
//
// Generates the prompt sent to an LLM (or consumed by the heuristic
// analyzer) for hunk-level summary analysis (DESIGN.md §13.1).
//
// The prompt is structured so that:
//   1. The model knows it must return **only** valid JSON.
//   2. The output schema is explicit and strict.
//   3. PR-level context is optional — the prompt degrades gracefully.
// ---------------------------------------------------------------------------

import type { AnalysisInput } from "./types.js";

// ---- Output schema description (embedded in prompt) -------------------------

const OUTPUT_SCHEMA = `\
{
  "summary":    "<one sentence: what this hunk does>",
  "impact":     "<what could break or what depends on this change>",
  "risk":       "<low | medium | high>",
  "confidence": <0.0 to 1.0, your self-assessed certainty>
}`;

// ---- System prompt ----------------------------------------------------------

export const SYSTEM_PROMPT = `\
You are PRism, a code-review assistant. Your job is to summarize a single
diff hunk in a pull request.

Rules:
- Reply with ONLY a JSON object matching the schema below. No markdown fences,
  no commentary, no extra keys.
- "summary" must be one concise sentence in plain English.
- "impact" describes downstream effects: what could break, what depends on the
  changed code, or "none" if the change is purely cosmetic.
- "risk" is one of: "low", "medium", "high".
  low    = cosmetic / docs / test-only / trivial rename
  medium = logic change with limited blast radius
  high   = security-sensitive, concurrency, data migration, public API change
- "confidence" is your self-assessed certainty from 0.0 to 1.0.

Output schema:
${OUTPUT_SCHEMA}`;

// ---- User prompt builder ----------------------------------------------------

/**
 * Build the user-portion of the prompt from an AnalysisInput.
 *
 * Layout:
 *   [PR title + description, if present]
 *   File: <path>
 *   [Context snippet, if present]
 *   Hunk:
 *   <patch>
 */
export function buildUserPrompt(input: AnalysisInput): string {
  const parts: string[] = [];

  // PR-level context (optional)
  if (input.prTitle) {
    parts.push(`PR title: ${input.prTitle}`);
  }
  if (input.prDescription) {
    // Truncate long descriptions to keep prompt focused
    const desc =
      input.prDescription.length > 500
        ? input.prDescription.slice(0, 500) + "…"
        : input.prDescription;
    parts.push(`PR description: ${desc}`);
  }

  // File path (always present)
  parts.push(`File: ${input.filePath}`);

  // Context snippet (optional — surrounding code from base)
  if (input.contextSnippet) {
    parts.push(`Context (surrounding code from base revision):\n${input.contextSnippet}`);
  }

  // The hunk itself (always present)
  parts.push(`Hunk (${input.hunkHeader}):\n${input.hunkPatch}`);

  return parts.join("\n\n");
}
