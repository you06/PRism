// ---------------------------------------------------------------------------
// PRism daemon — Analysis pipeline types (WORK11)
//
// Defines the pluggable analyzer abstraction and structured I/O contracts
// for hunk-level summary analysis (DESIGN.md §13.1).
// ---------------------------------------------------------------------------

import type { RiskLevel } from "@prism/shared";

// ---- Analyzer input ---------------------------------------------------------

/** Everything the analyzer needs to produce a hunk summary. */
export interface AnalysisInput {
  /** File path of the changed file. */
  filePath: string;
  /** Raw unified-diff patch text for this hunk. */
  hunkPatch: string;
  /** The @@ header line. */
  hunkHeader: string;
  /** PR title (may be empty). */
  prTitle: string;
  /** PR description / body (may be empty). */
  prDescription: string;
  /** Small surrounding-context snippet from the base file, if available. */
  contextSnippet?: string;
}

// ---- Analyzer output --------------------------------------------------------

/** Structured JSON output for summary mode (DESIGN.md §13.1). */
export interface SummaryOutput {
  /** One-sentence plain-language summary of what this hunk does. */
  summary: string;
  /** Downstream impact description (what could break, what depends on this). */
  impact: string;
  /** Risk level: low / medium / high. */
  risk: RiskLevel;
  /** Model's self-assessed confidence, 0..1. */
  confidence: number;
}

// ---- Analyzer abstraction ---------------------------------------------------

/**
 * Result wrapper returned by a HunkAnalyzer.
 *
 * `ok: true`  → output is a validated SummaryOutput.
 * `ok: false` → analysis failed; `error` explains why.
 */
export type AnalyzerResult =
  | { ok: true; output: SummaryOutput; model: string }
  | { ok: false; error: string; model: string };

/**
 * Pluggable analyzer interface.
 *
 * Implementations may call an LLM, run local heuristics, or delegate to
 * an external service. The pipeline doesn't care — it only sees this
 * contract.
 *
 * To swap providers, implement this interface and pass it to
 * `createSummaryAnalyzer()`.
 */
export interface HunkAnalyzer {
  /** Human-readable name shown in logs and annotation metadata. */
  readonly name: string;

  /**
   * Analyze a single hunk and return a structured summary.
   *
   * Implementations MUST return within a reasonable timeout (caller may
   * enforce its own via AbortSignal in the future).
   */
  analyze(input: AnalysisInput): Promise<AnalyzerResult>;
}
