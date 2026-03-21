// ---------------------------------------------------------------------------
// PRism daemon — Chat prompt builder
//
// Builds the system prompt for hunk-level chat conversations.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface ChatPromptInput {
  prTitle: string;
  prDescription: string;
  filePath: string;
  patch: string;
  /** Existing annotation summary (if available). */
  annotation?: {
    summary: string;
    impact: string;
    risk: string;
  };
  language: string;
}

// Inline fallback in case the template file cannot be read at runtime.
const INLINE_CHAT_TEMPLATE = `# PRism Chat Prompt

## System

You are PRism, a code-review assistant. The user is asking questions about a
specific code change (diff hunk) in a GitHub pull request.

### Context

PR title: {{prTitle}}
PR description: {{prDescription}}

File: {{filePath}}

Diff hunk:
\`\`\`diff
{{patch}}
\`\`\`

{{annotation}}

### Rules

- Answer the user's question about this specific code change.
- Be concise and helpful. Keep answers focused on the diff hunk above.
- Respond in {{language}}.
- Use markdown formatting when it improves readability.
- If the user asks about code outside this hunk, say so and answer to the best
  of your ability based on context.`;

function loadChatTemplate(): string {
  try {
    const dir = dirname(fileURLToPath(import.meta.url));
    const templatePath = resolve(dir, "../../prompts/chat.md");
    return readFileSync(templatePath, "utf-8");
  } catch {
    return INLINE_CHAT_TEMPLATE;
  }
}

const chatTemplate = loadChatTemplate();

/**
 * Build the system prompt for a hunk chat conversation.
 */
export function buildChatSystemPrompt(input: ChatPromptInput): string {
  const sysIdx = chatTemplate.indexOf("\n## System");
  const systemRaw =
    sysIdx === -1 ? chatTemplate : chatTemplate.slice(sysIdx + "\n## System".length);

  let annotationBlock = "";
  if (input.annotation) {
    annotationBlock =
      `PRism's analysis of this hunk:\n` +
      `- Summary: ${input.annotation.summary}\n` +
      `- Impact: ${input.annotation.impact}\n` +
      `- Risk: ${input.annotation.risk}`;
  }

  return systemRaw
    .trim()
    .replace("{{prTitle}}", input.prTitle || "(no title)")
    .replace(
      "{{prDescription}}",
      input.prDescription
        ? input.prDescription.length > 2000
          ? input.prDescription.slice(0, 2000) + "…"
          : input.prDescription
        : "(no description)",
    )
    .replace("{{filePath}}", input.filePath)
    .replace("{{patch}}", input.patch)
    .replace("{{annotation}}", annotationBlock)
    .replaceAll("{{language}}", input.language);
}
