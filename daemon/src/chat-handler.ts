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
 *
 * Builds a full prompt with system context + conversation history,
 * sends it to the agent, and returns the raw text reply.
 */
export async function runChat(
  input: ChatInput,
): Promise<ChatResult | ChatError> {
  const { agent, model, messages, promptInput } = input;
  const modelLabel = model ?? `${agent}-default`;

  const bin = agent === "codex" ? "codex" : "claude";
  if (!(await binaryExists(bin))) {
    return {
      ok: false,
      error: `CLI binary '${bin}' not found on PATH. Please install it first.`,
      model: modelLabel,
    };
  }

  // Build full prompt: system context + conversation
  const systemPrompt = buildChatSystemPrompt(promptInput);

  const parts: string[] = [systemPrompt, ""];
  for (const msg of messages) {
    const prefix = msg.role === "user" ? "User" : "Assistant";
    parts.push(`${prefix}: ${msg.content}`);
  }
  // Add final instruction for the assistant to respond
  parts.push("Assistant:");

  const fullPrompt = parts.join("\n\n");

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
