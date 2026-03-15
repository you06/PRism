// ---------------------------------------------------------------------------
// PRism daemon — Analysis module public API (WORK11)
// ---------------------------------------------------------------------------

// Types & interfaces
export type {
  AnalysisInput,
  AnalyzerResult,
  HunkAnalyzer,
  SummaryOutput,
} from "./types.js";

// Prompt template
export { SYSTEM_PROMPT, buildUserPrompt } from "./prompt.js";

// Heuristic analyzer (default)
export { HeuristicAnalyzer, HEURISTIC_MODEL_NAME } from "./heuristic-analyzer.js";

// Pipeline orchestrator
export {
  createSummaryPipeline,
  parseSummaryJSON,
  validateSummaryOutput,
} from "./summary-analyzer.js";
export type {
  PRContext,
  SummaryPipeline,
  SummaryPipelineOptions,
} from "./summary-analyzer.js";
