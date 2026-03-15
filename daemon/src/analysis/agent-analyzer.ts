// ---------------------------------------------------------------------------
// PRism daemon — Agent-based PR analyzer (WORK21)
//
// Invokes codex or claude CLI to analyze an entire PR in one shot.
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process";
import type {
  PRAnalyzer,
  PRAnalysisInput,
  PRAnalysisResult,
  PRAnalysisOutput,
  SummaryOutput,
} from "./types.js";
import { buildPRReviewPrompt } from "./prompt.js";

// ---- Public types -----------------------------------------------------------

export type AgentType = "codex" | "claude";

export interface AgentAnalyzerOptions {
  agent: AgentType;
  /** Model override. If omitted, each CLI uses its default. */
  model?: string;
  /** Timeout in milliseconds (default: 120 000). */
  timeoutMs?: number;
  /** Language for summaries (default: "English"). */
  language?: string;
}

// ---- Helpers ----------------------------------------------------------------

/** Check whether a binary is available on PATH. */
async function binaryExists(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("which", [bin], { stdio: "ignore" });
    proc.on("close", (code) => resolve(code === 0));
    proc.on("error", () => resolve(false));
  });
}

/** Run a CLI command, pipe `stdin` data, collect stdout/stderr. */
function runCLI(
  cmd: string,
  args: string[],
  stdinData: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: timeoutMs,
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    proc.stdout.on("data", (d: Buffer) => stdout.push(d));
    proc.stderr.on("data", (d: Buffer) => stderr.push(d));

    proc.on("error", (err) => reject(err));
    proc.on("close", (code) =>
      resolve({
        stdout: Buffer.concat(stdout).toString("utf-8"),
        stderr: Buffer.concat(stderr).toString("utf-8"),
        code: code ?? 1,
      }),
    );

    proc.stdin.write(stdinData);
    proc.stdin.end();
  });
}

/** Strip leading/trailing markdown code fences if present. */
function stripFences(raw: string): string {
  let s = raw.trim();
  // ```json ... ``` or ``` ... ```
  if (s.startsWith("```")) {
    const firstNewline = s.indexOf("\n");
    if (firstNewline !== -1) {
      s = s.slice(firstNewline + 1);
    }
    if (s.endsWith("```")) {
      s = s.slice(0, -3);
    }
    s = s.trim();
  }
  return s;
}

const VALID_RISKS = new Set(["low", "medium", "high"]);

/** Validate that a parsed object matches SummaryOutput schema. */
function isValidSummary(v: unknown): v is SummaryOutput {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.summary === "string" &&
    typeof o.impact === "string" &&
    typeof o.risk === "string" &&
    VALID_RISKS.has(o.risk) &&
    typeof o.confidence === "number" &&
    o.confidence >= 0 &&
    o.confidence <= 1
  );
}

/** Validate the full batch output. */
function validateBatchOutput(
  parsed: unknown,
  expectedKeys: string[],
): PRAnalysisOutput | null {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return null;
  const obj = parsed as Record<string, unknown>;
  for (const key of expectedKeys) {
    if (!(key in obj) || !isValidSummary(obj[key])) return null;
  }
  return obj as unknown as PRAnalysisOutput;
}

// ---- AgentAnalyzer ----------------------------------------------------------

export class AgentAnalyzer implements PRAnalyzer {
  readonly name: string;
  private agent: AgentType;
  private model: string | undefined;
  private timeoutMs: number;
  private language: string;

  constructor(opts: AgentAnalyzerOptions) {
    this.agent = opts.agent;
    this.model = opts.model;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.language = opts.language ?? "English";
    this.name = `agent-${opts.agent}${opts.model ? `:${opts.model}` : ""}`;
  }

  async analyzePR(input: PRAnalysisInput): Promise<PRAnalysisResult> {
    const modelLabel = this.model ?? `${this.agent}-default`;

    // Check binary availability
    const bin = this.agent === "codex" ? "codex" : "claude";
    if (!(await binaryExists(bin))) {
      return {
        ok: false,
        error: `CLI binary '${bin}' not found on PATH. Please install it first.`,
        model: modelLabel,
      };
    }

    const { system, user } = buildPRReviewPrompt(input, this.language);
    const fullPrompt = `${system}\n\n${user}`;
    const expectedKeys = input.fragments.map((f) => f.index);

    // Try up to 2 times (initial + 1 retry on invalid JSON)
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await this.invoke(fullPrompt);
      if (!result.ok) {
        return { ok: false, error: result.error, model: modelLabel };
      }

      const cleaned = stripFences(result.stdout);
      let parsed: unknown;
      try {
        parsed = JSON.parse(cleaned);
      } catch {
        if (attempt === 0) continue; // retry once
        return {
          ok: false,
          error: `Invalid JSON from ${bin}: ${cleaned.slice(0, 200)}`,
          model: modelLabel,
        };
      }

      const validated = validateBatchOutput(parsed, expectedKeys);
      if (validated) {
        return { ok: true, output: validated, model: modelLabel };
      }

      if (attempt === 0) continue; // retry once
      return {
        ok: false,
        error: `Output validation failed: missing keys or invalid schema. Got: ${cleaned.slice(0, 200)}`,
        model: modelLabel,
      };
    }

    // Unreachable, but TypeScript needs it
    return { ok: false, error: "Unexpected retry exhaustion", model: modelLabel };
  }

  private async invoke(
    prompt: string,
  ): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
    try {
      const { cmd, args } = this.buildCommand();
      const { stdout, stderr, code } = await runCLI(
        cmd,
        args,
        prompt,
        this.timeoutMs,
      );

      if (code !== 0) {
        return {
          ok: false,
          error: `${cmd} exited with code ${code}: ${stderr.slice(0, 500)}`,
        };
      }
      return { ok: true, stdout };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("TIMEOUT") || msg.includes("timed out")) {
        return {
          ok: false,
          error: `${this.agent} timed out after ${this.timeoutMs}ms`,
        };
      }
      return { ok: false, error: `${this.agent} error: ${msg}` };
    }
  }

  private buildCommand(): { cmd: string; args: string[] } {
    if (this.agent === "codex") {
      const args = ["exec", "--sandbox", "read-only"];
      if (this.model) args.push("-m", this.model);
      args.push("-q", "-");
      return { cmd: "codex", args };
    }

    // claude
    const args = ["--print", "--permission-mode", "plan"];
    if (this.model) args.push("--model", this.model);
    args.push("-"); // read from stdin
    return { cmd: "claude", args };
  }
}
