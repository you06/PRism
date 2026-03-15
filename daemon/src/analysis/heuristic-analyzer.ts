// ---------------------------------------------------------------------------
// PRism daemon — Heuristic analyzer (WORK11)
//
// Deterministic, zero-cost HunkAnalyzer implementation that produces
// plausible summaries by inspecting diff structure, file extension, and
// keyword signals.
//
// This is the default analyzer until a real LLM provider is wired in.
// It intentionally lives behind the same HunkAnalyzer interface so that
// swapping to an LLM requires zero pipeline changes.
// ---------------------------------------------------------------------------

import type { RiskLevel } from "@prism/shared";
import type {
  AnalysisInput,
  AnalyzerResult,
  HunkAnalyzer,
  SummaryOutput,
} from "./types.js";

// ---- Keyword / pattern tables -----------------------------------------------

const HIGH_RISK_PATTERNS = [
  /\bpassword\b/i,
  /\bsecret\b/i,
  /\btoken\b/i,
  /\bprivate.?key\b/i,
  /\bauth\b/i,
  /\bcredential/i,
  /\bencrypt/i,
  /\bdecrypt/i,
  /\bunsafe\b/i,
  /\bexec\b/,
  /\beval\b/,
  /\bDROP\s+TABLE\b/i,
  /\bALTER\s+TABLE\b/i,
  /\bMIGRAT/i,
  /\bconcurren/i,
  /\bmutex\b/i,
  /\block\b/i,
  /\brace\b/i,
];

const MEDIUM_RISK_PATTERNS = [
  /\berror\b/i,
  /\bpanic\b/i,
  /\bthrow\b/i,
  /\bretry\b/i,
  /\btimeout\b/i,
  /\bdelete\b/i,
  /\bremove\b/i,
  /\bconfig\b/i,
  /\benv\b/i,
  /\bapi\b/i,
  /\bexport\b/i,
  /\bpublic\b/i,
];

const TEST_FILE_PATTERNS = [
  /\.test\.[jt]sx?$/,
  /\.spec\.[jt]sx?$/,
  /_test\.go$/,
  /_test\.rs$/,
  /test_.*\.py$/,
  /\/tests?\//,
  /\/__tests__\//,
];

const DOC_FILE_PATTERNS = [
  /\.md$/i,
  /\.mdx$/i,
  /\.txt$/i,
  /\.rst$/i,
  /LICENSE/i,
  /CHANGELOG/i,
  /README/i,
];

const CONFIG_FILE_PATTERNS = [
  /\.ya?ml$/,
  /\.toml$/,
  /\.json$/,
  /\.ini$/,
  /\.env/,
  /Dockerfile/i,
  /docker-compose/i,
  /\.gitignore$/,
  /\.eslint/,
  /tsconfig/,
  /package\.json$/,
];

// ---- Diff analysis helpers --------------------------------------------------

interface DiffStats {
  additions: number;
  deletions: number;
  contextLines: number;
  addedContent: string[];
  deletedContent: string[];
}

function parseDiffStats(patch: string): DiffStats {
  const lines = patch.split("\n");
  const stats: DiffStats = {
    additions: 0,
    deletions: 0,
    contextLines: 0,
    addedContent: [],
    deletedContent: [],
  };

  for (const line of lines) {
    if (line.startsWith("@@")) continue;
    if (line.startsWith("+")) {
      stats.additions++;
      stats.addedContent.push(line.slice(1));
    } else if (line.startsWith("-")) {
      stats.deletions++;
      stats.deletedContent.push(line.slice(1));
    } else {
      stats.contextLines++;
    }
  }

  return stats;
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

function fileCategory(
  filePath: string,
): "test" | "doc" | "config" | "code" {
  if (TEST_FILE_PATTERNS.some((p) => p.test(filePath))) return "test";
  if (DOC_FILE_PATTERNS.some((p) => p.test(filePath))) return "doc";
  if (CONFIG_FILE_PATTERNS.some((p) => p.test(filePath))) return "config";
  return "code";
}

// ---- Change-type detection --------------------------------------------------

function detectChangeType(
  stats: DiffStats,
  filePath: string,
): string {
  const cat = fileCategory(filePath);
  if (cat === "test") return "test";
  if (cat === "doc") return "documentation";
  if (cat === "config") return "configuration";

  // Pure addition (no deletions)
  if (stats.deletions === 0 && stats.additions > 0) return "addition";
  // Pure deletion
  if (stats.additions === 0 && stats.deletions > 0) return "removal";
  // Roughly equal adds/deletes → likely refactor or rename
  if (
    stats.additions > 0 &&
    stats.deletions > 0 &&
    Math.abs(stats.additions - stats.deletions) <=
      Math.max(stats.additions, stats.deletions) * 0.3
  ) {
    return "refactor";
  }
  return "modification";
}

// ---- Summary generation -----------------------------------------------------

function generateSummary(
  changeType: string,
  stats: DiffStats,
  filePath: string,
): string {
  const fileName = filePath.split("/").pop() ?? filePath;
  const net = stats.additions - stats.deletions;
  const netLabel = net > 0 ? `+${net}` : `${net}`;

  switch (changeType) {
    case "test":
      return `Updates test code in ${fileName} (${netLabel} net lines).`;
    case "documentation":
      return `Updates documentation in ${fileName}.`;
    case "configuration":
      return `Modifies configuration in ${fileName}.`;
    case "addition":
      return `Adds ${stats.additions} new line${stats.additions === 1 ? "" : "s"} to ${fileName}.`;
    case "removal":
      return `Removes ${stats.deletions} line${stats.deletions === 1 ? "" : "s"} from ${fileName}.`;
    case "refactor":
      return `Refactors code in ${fileName} (${stats.additions} added, ${stats.deletions} removed).`;
    default:
      return `Modifies ${fileName} (${stats.additions} added, ${stats.deletions} removed).`;
  }
}

function generateImpact(
  changeType: string,
  stats: DiffStats,
  filePath: string,
): string {
  const allContent = [
    ...stats.addedContent,
    ...stats.deletedContent,
  ].join("\n");

  if (changeType === "test") return "Test coverage affected; no production impact.";
  if (changeType === "documentation") return "No runtime impact.";

  if (matchesAny(allContent, [/\bexport\b/, /\bpublic\b/, /\bapi\b/i])) {
    return "May affect downstream consumers of this module's public API.";
  }
  if (matchesAny(allContent, [/\bimport\b/, /\brequire\b/])) {
    return "Dependency changes; verify imports resolve correctly.";
  }
  if (changeType === "configuration") {
    return "Configuration change; verify environment-specific behavior.";
  }
  if (stats.deletions > stats.additions * 2) {
    return "Significant code removal; verify no remaining callers depend on deleted code.";
  }
  if (stats.additions > 50) {
    return "Large addition; review for completeness and integration with existing code.";
  }
  return "Localized change with limited blast radius.";
}

function assessRisk(
  changeType: string,
  stats: DiffStats,
  _filePath: string,
): RiskLevel {
  if (changeType === "documentation") return "low";
  if (changeType === "test") return "low";

  const allContent = [
    ...stats.addedContent,
    ...stats.deletedContent,
  ].join("\n");

  if (matchesAny(allContent, HIGH_RISK_PATTERNS)) return "high";
  if (matchesAny(allContent, MEDIUM_RISK_PATTERNS)) return "medium";

  // Large changes are riskier
  const totalChanged = stats.additions + stats.deletions;
  if (totalChanged > 100) return "medium";
  if (changeType === "configuration") return "medium";

  return "low";
}

function assessConfidence(
  changeType: string,
  stats: DiffStats,
): number {
  // Heuristic analyzer is always honest about its limitations
  let base = 0.4; // low baseline — we're not an LLM

  // Simple changes → higher confidence
  if (changeType === "documentation" || changeType === "test") base = 0.6;
  if (changeType === "configuration") base = 0.5;

  // Smaller hunks are easier to classify
  const totalChanged = stats.additions + stats.deletions;
  if (totalChanged <= 5) base += 0.1;
  if (totalChanged > 50) base -= 0.1;

  return Math.max(0.1, Math.min(0.7, base)); // cap at 0.7 — heuristic never fully confident
}

// ---- HunkAnalyzer implementation --------------------------------------------

export const HEURISTIC_MODEL_NAME = "prism-heuristic/v1";

/**
 * Deterministic heuristic analyzer.
 *
 * Produces plausible summaries by inspecting diff structure, file type,
 * and keyword signals. Confidence is intentionally capped at 0.7 to
 * signal that results are heuristic, not model-generated.
 */
export class HeuristicAnalyzer implements HunkAnalyzer {
  readonly name = HEURISTIC_MODEL_NAME;

  async analyze(input: AnalysisInput): Promise<AnalyzerResult> {
    const stats = parseDiffStats(input.hunkPatch);
    const changeType = detectChangeType(stats, input.filePath);

    const output: SummaryOutput = {
      summary: generateSummary(changeType, stats, input.filePath),
      impact: generateImpact(changeType, stats, input.filePath),
      risk: assessRisk(changeType, stats, input.filePath),
      confidence: assessConfidence(changeType, stats),
    };

    return { ok: true, output, model: this.name };
  }
}
