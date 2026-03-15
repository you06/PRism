// ---------------------------------------------------------------------------
// PRism daemon — Summary analysis pipeline orchestrator (WORK11)
//
// Ties together:
//   CanonicalHunk  →  AnalysisInput  →  HunkAnalyzer  →  validated Annotation
//
// The pipeline:
//   1. Builds AnalysisInput from a canonical hunk + optional PR context
//   2. Delegates to the configured HunkAnalyzer
//   3. Validates the output schema
//   4. Returns a fully-formed Annotation (ready for cache / API response)
//
// DESIGN.md §6.4, §13.1
// ---------------------------------------------------------------------------

import type { Annotation, PRKey, RiskLevel } from "@prism/shared";
import { randomUUID } from "node:crypto";
import type { CanonicalHunk } from "../hunk-canonicalizer.js";
import { HeuristicAnalyzer } from "./heuristic-analyzer.js";
import type {
  AnalysisInput,
  AnalyzerResult,
  HunkAnalyzer,
  SummaryOutput,
} from "./types.js";

// ---- Output validation ------------------------------------------------------

const VALID_RISK: Set<string> = new Set(["low", "medium", "high"]);

/**
 * Validate and coerce raw analyzer output into a strict SummaryOutput.
 *
 * Returns `null` if the output is irrecoverably malformed.
 */
export function validateSummaryOutput(raw: unknown): SummaryOutput | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  const summary = typeof obj["summary"] === "string" ? obj["summary"] : null;
  const impact = typeof obj["impact"] === "string" ? obj["impact"] : null;
  const risk = typeof obj["risk"] === "string" && VALID_RISK.has(obj["risk"])
    ? (obj["risk"] as RiskLevel)
    : null;

  let confidence: number | null = null;
  if (typeof obj["confidence"] === "number") {
    confidence = Math.max(0, Math.min(1, obj["confidence"]));
  }

  if (summary === null || impact === null || risk === null || confidence === null) {
    return null;
  }

  return { summary, impact, risk, confidence };
}

/**
 * Parse a JSON string into a validated SummaryOutput.
 *
 * Strips markdown fences and leading/trailing whitespace before parsing.
 * Returns `null` on any parse or validation failure.
 */
export function parseSummaryJSON(text: string): SummaryOutput | null {
  let cleaned = text.trim();

  // Strip common markdown code fences that LLMs love to add
  if (cleaned.startsWith("```")) {
    const firstNewline = cleaned.indexOf("\n");
    if (firstNewline !== -1) cleaned = cleaned.slice(firstNewline + 1);
    if (cleaned.endsWith("```")) cleaned = cleaned.slice(0, -3);
    cleaned = cleaned.trim();
  }

  try {
    const parsed: unknown = JSON.parse(cleaned);
    return validateSummaryOutput(parsed);
  } catch {
    return null;
  }
}

// ---- PR context helper ------------------------------------------------------

/** Optional PR-level context passed into the pipeline. */
export interface PRContext {
  prKey: PRKey;
  title: string;
  description: string;
}

// ---- Pipeline ---------------------------------------------------------------

/** Options for creating a SummaryPipeline. */
export interface SummaryPipelineOptions {
  /** Analyzer to use. Defaults to HeuristicAnalyzer. */
  analyzer?: HunkAnalyzer;
}

/**
 * Orchestrates hunk-level summary analysis.
 *
 * Usage:
 * ```ts
 * const pipeline = createSummaryPipeline();
 * const annotation = await pipeline.analyzeHunk(hunk, prContext);
 * ```
 */
export interface SummaryPipeline {
  /** The underlying analyzer (for inspection / logging). */
  readonly analyzer: HunkAnalyzer;

  /**
   * Analyze a single canonical hunk and produce an Annotation.
   *
   * @param hunk     - Canonical hunk from the GitHub API
   * @param context  - Optional PR-level context (title, description)
   * @param contextSnippet - Optional surrounding code from the base file
   */
  analyzeHunk(
    hunk: CanonicalHunk,
    context?: PRContext,
    contextSnippet?: string,
  ): Promise<Annotation>;
}

/**
 * Build an AnalysisInput from a CanonicalHunk and optional context.
 */
function buildInput(
  hunk: CanonicalHunk,
  context?: PRContext,
  contextSnippet?: string,
): AnalysisInput {
  // Reconstruct patch text from normalized lines
  const patchLines = hunk.lines.map((l) => {
    const prefix =
      l.type === "add" ? "+" : l.type === "delete" ? "-" : " ";
    return `${prefix}${l.content}`;
  });

  return {
    filePath: hunk.filePath,
    hunkPatch: patchLines.join("\n"),
    hunkHeader: hunk.hunkHeader,
    prTitle: context?.title ?? "",
    prDescription: context?.description ?? "",
    contextSnippet,
  };
}

/**
 * Convert an AnalyzerResult into an Annotation.
 *
 * On failure, produces an error-status annotation so the caller always
 * gets a consistent shape.
 */
function resultToAnnotation(
  result: AnalyzerResult,
  hunk: CanonicalHunk,
  prKey?: PRKey,
): Annotation {
  const base: Pick<Annotation, "annotationId" | "prKey" | "filePath" | "patchHash" | "generatedAt" | "model"> = {
    annotationId: `ann_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
    prKey: prKey ?? { host: "", owner: "", repo: "", pullNumber: 0, baseSha: "", headSha: "" },
    filePath: hunk.filePath,
    patchHash: hunk.patchHash,
    generatedAt: new Date().toISOString(),
    model: result.model,
  };

  if (result.ok) {
    return {
      ...base,
      summary: result.output.summary,
      impact: result.output.impact,
      risk: result.output.risk,
      confidence: result.output.confidence,
      status: "ready",
    };
  }

  return {
    ...base,
    summary: "",
    impact: "",
    risk: "low",
    confidence: 0,
    status: "error",
  };
}

// ---- Factory ----------------------------------------------------------------

/**
 * Create a SummaryPipeline with the given options.
 *
 * Default analyzer: HeuristicAnalyzer (deterministic, zero-cost).
 * To use an LLM, pass `{ analyzer: new YourLLMAnalyzer() }`.
 */
export function createSummaryPipeline(
  opts?: SummaryPipelineOptions,
): SummaryPipeline {
  const analyzer = opts?.analyzer ?? new HeuristicAnalyzer();

  return {
    analyzer,

    async analyzeHunk(
      hunk: CanonicalHunk,
      context?: PRContext,
      contextSnippet?: string,
    ): Promise<Annotation> {
      const input = buildInput(hunk, context, contextSnippet);
      const result = await analyzer.analyze(input);
      return resultToAnnotation(result, hunk, context?.prKey);
    },
  };
}
