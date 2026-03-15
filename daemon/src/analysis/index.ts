// ---------------------------------------------------------------------------
// PRism daemon — Analysis module public API (WORK11)
// ---------------------------------------------------------------------------

// Types & interfaces
export type {
  AnalysisInput,
  AnalyzerResult,
  HunkAnalyzer,
  SummaryOutput,
  PRFragment,
  PRAnalysisInput,
  PRAnalysisOutput,
  PRAnalysisResult,
  PRAnalyzer,
} from "./types.js";

// Prompt templates
export { SYSTEM_PROMPT, buildUserPrompt, buildPRReviewPrompt } from "./prompt.js";

// Heuristic analyzer (default)
export { HeuristicAnalyzer, HEURISTIC_MODEL_NAME } from "./heuristic-analyzer.js";

// Agent-based analyzer (codex / claude CLI)
export { AgentAnalyzer } from "./agent-analyzer.js";
export type { AgentType, AgentAnalyzerOptions } from "./agent-analyzer.js";

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
