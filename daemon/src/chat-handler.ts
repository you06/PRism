// ---------------------------------------------------------------------------
// PRism daemon — Chat handler
//
// Handles hunk-level chat conversations by invoking codex/claude CLI.
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process";
import type { ChatMessage } from "@prism/shared";
import { buildChatSystemPrompt, type ChatPromptInput } from "./analysis/chat-prompt.js";

type AgentType = "codex" | "claude";

const CHAT_TIMEOUT_MS = 60_000;

// ---- CLI helpers (same pattern as agent-analyzer) ---------------------------

function binaryExists(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("which", [bin], { stdio: "ignore" });
    proc.on("close", (code) => resolve(code === 0));
    proc.on("error", () => resolve(false));
  });
}

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

function buildCommand(
  agent: AgentType,
  model?: string,
): { cmd: string; args: string[] } {
  if (agent === "codex") {
    const args = ["exec", "--sandbox", "read-only", "--color", "never"];
    if (model) args.push("-m", model);
    args.push("-");
    return { cmd: "codex", args };
  }
  // claude
  const args = ["--print", "--permission-mode", "plan"];
  if (model) args.push("--model", model);
  args.push("-"); // read from stdin
  return { cmd: "claude", args };
}

// ---- Prompt builder ---------------------------------------------------------

function buildFullPrompt(input: ChatInput): string {
  const systemPrompt = buildChatSystemPrompt(input.promptInput);
  const parts: string[] = [systemPrompt, ""];
  for (const msg of input.messages) {
    const prefix = msg.role === "user" ? "User" : "Assistant";
    parts.push(`${prefix}: ${msg.content}`);
  }
  parts.push("Assistant:");
  return parts.join("\n\n");
}

// ---- Chat invocation --------------------------------------------------------

export interface ChatInput {
  promptInput: ChatPromptInput;
  messages: ChatMessage[];
  agent: AgentType;
  model?: string;
}

export interface ChatResult {
  ok: true;
  reply: string;
  model: string;
}

export interface ChatError {
  ok: false;
  error: string;
  model: string;
}

/**
 * Run a chat conversation about a specific hunk via the CLI agent.
 * Returns the full reply after the CLI process exits.
 */
export async function runChat(
  input: ChatInput,
): Promise<ChatResult | ChatError> {
  const { agent, model } = input;
  const modelLabel = model ?? `${agent}-default`;

  const bin = agent === "codex" ? "codex" : "claude";
  if (!(await binaryExists(bin))) {
    return {
      ok: false,
      error: `CLI binary '${bin}' not found on PATH. Please install it first.`,
      model: modelLabel,
    };
  }

  const fullPrompt = buildFullPrompt(input);

  try {
    const { cmd, args } = buildCommand(agent, model);
    const { stdout, stderr, code } = await runCLI(cmd, args, fullPrompt, CHAT_TIMEOUT_MS);

    if (code !== 0) {
      return {
        ok: false,
        error: `${cmd} exited with code ${code}: ${stderr.slice(0, 500)}`,
        model: modelLabel,
      };
    }

    return { ok: true, reply: stdout.trim(), model: modelLabel };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("TIMEOUT") || msg.includes("timed out")) {
      return { ok: false, error: `${agent} timed out`, model: modelLabel };
    }
    return { ok: false, error: `${agent} error: ${msg}`, model: modelLabel };
  }
}

/**
 * Run a streaming chat — invokes the CLI and calls `onChunk` with each
 * stdout chunk as it arrives. Calls `onDone` when the process exits.
 */
export async function runChatStream(
  input: ChatInput,
  onChunk: (text: string) => void,
  onDone: (model: string) => void,
  onError: (error: string, model: string) => void,
): Promise<void> {
  const { agent, model } = input;
  const modelLabel = model ?? `${agent}-default`;

  const bin = agent === "codex" ? "codex" : "claude";
  if (!(await binaryExists(bin))) {
    onError(`CLI binary '${bin}' not found on PATH.`, modelLabel);
    return;
  }

  const fullPrompt = buildFullPrompt(input);
  const { cmd, args } = buildCommand(agent, model);

  const proc = spawn(cmd, args, {
    stdio: ["pipe", "pipe", "pipe"],
    timeout: CHAT_TIMEOUT_MS,
  });

  const stderr: Buffer[] = [];

  proc.stdout.on("data", (d: Buffer) => {
    onChunk(d.toString("utf-8"));
  });
  proc.stderr.on("data", (d: Buffer) => stderr.push(d));

  proc.on("error", (err) => {
    const msg = err.message;
    if (msg.includes("TIMEOUT") || msg.includes("timed out")) {
      onError(`${agent} timed out`, modelLabel);
    } else {
      onError(`${agent} error: ${msg}`, modelLabel);
    }
  });

  proc.on("close", (code) => {
    if (code !== 0) {
      const stderrText = Buffer.concat(stderr).toString("utf-8");
      onError(`${cmd} exited with code ${code}: ${stderrText.slice(0, 500)}`, modelLabel);
    } else {
      onDone(modelLabel);
    }
  });

  proc.stdin.write(fullPrompt);
  proc.stdin.end();
}
