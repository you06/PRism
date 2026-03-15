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

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AnalysisInput, PRAnalysisInput } from "./types.js";

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

// ---- Batch PR review prompt (WORK20) ----------------------------------------

// Inline fallback in case the template file cannot be read at runtime
// (e.g. when bundled via bun compile).
const INLINE_REVIEW_TEMPLATE = `# PRism Batch Review Prompt

## System

You are PRism, a code-review assistant. You will receive an entire pull request
consisting of multiple code change fragments, each identified by an index number.

Analyze ALL fragments and return a single JSON object where each key is the
fragment index (as a string) and each value follows the schema below.

### Output schema (per fragment)

\`\`\`json
{
  "summary":    "<one sentence: what this fragment does>",
  "impact":     "<what could break or what depends on this change>",
  "risk":       "<low | medium | high>",
  "confidence": <0.0 to 1.0, your self-assessed certainty>
}
\`\`\`

### Rules

- Reply with ONLY a JSON object. No markdown fences, no commentary, no extra keys.
- "summary" must be one concise sentence in {{language}}.
- "impact" describes downstream effects: what could break, what depends on the
  changed code, or "none" if the change is purely cosmetic. Write in {{language}}.
- "risk" is one of: "low", "medium", "high".
  - low    = cosmetic / docs / test-only / trivial rename
  - medium = logic change with limited blast radius
  - high   = security-sensitive, concurrency, data migration, public API change
- "confidence" is your self-assessed certainty from 0.0 to 1.0.
- Consider the PR title and description for context when assessing each fragment.
- Evaluate each fragment independently but be aware of cross-fragment relationships.

### Example output

\`\`\`json
{
  "1": { "summary": "Add null check before accessing user.email", "impact": "Prevents crash when user profile is incomplete", "risk": "medium", "confidence": 0.9 },
  "2": { "summary": "Update test fixture to include optional fields", "impact": "none", "risk": "low", "confidence": 0.95 }
}
\`\`\`

## User

PR title: {{prTitle}}
PR description: {{prDescription}}

Code change fragments:

{{fragments}}`;

/** Load the review template, falling back to inline copy. */
function loadReviewTemplate(): string {
  try {
    const dir = dirname(fileURLToPath(import.meta.url));
    const templatePath = resolve(dir, "../../prompts/review.md");
    return readFileSync(templatePath, "utf-8");
  } catch {
    return INLINE_REVIEW_TEMPLATE;
  }
}

const reviewTemplate = loadReviewTemplate();

/**
 * Parse the review.md template into system and user sections.
 * Splits on the `## User` heading.
 */
function parseTemplate(template: string): { system: string; user: string } {
  const userIdx = template.indexOf("\n## User");
  if (userIdx === -1) {
    return { system: template, user: "" };
  }
  // System = everything between "## System" and "## User"
  const sysStart = template.indexOf("\n## System");
  const systemRaw =
    sysStart === -1
      ? template.slice(0, userIdx)
      : template.slice(sysStart + "\n## System".length, userIdx);
  const userRaw = template.slice(userIdx + "\n## User".length);
  return { system: systemRaw.trim(), user: userRaw.trim() };
}

/** Format all fragments into numbered blocks. */
function formatFragments(input: PRAnalysisInput): string {
  return input.fragments
    .map(
      (f) =>
        `### Fragment ${f.index}\nFile: ${f.filePath}\nHunk: ${f.hunkHeader}\n\`\`\`diff\n${f.patch}\n\`\`\``,
    )
    .join("\n\n");
}

/**
 * Build system and user prompts for batch PR review.
 *
 * @param input  All PR fragments to analyze.
 * @param language  Language for summaries (default: "English").
 * @returns `{ system, user }` ready to send to an LLM.
 */
export function buildPRReviewPrompt(
  input: PRAnalysisInput,
  language = "English",
): { system: string; user: string } {
  const { system, user } = parseTemplate(reviewTemplate);

  const systemPrompt = system.replaceAll("{{language}}", language);

  const userPrompt = user
    .replace("{{prTitle}}", input.prTitle || "(no title)")
    .replace(
      "{{prDescription}}",
      input.prDescription
        ? input.prDescription.length > 2000
          ? input.prDescription.slice(0, 2000) + "…"
          : input.prDescription
        : "(no description)",
    )
    .replace("{{fragments}}", formatFragments(input));

  return { system: systemPrompt, user: userPrompt };
}
