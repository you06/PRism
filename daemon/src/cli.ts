#!/usr/bin/env node
// ---------------------------------------------------------------------------
// PRism CLI — `prism review <pr>` / `prism server`
//
// WORK18: CLI entry point for launching the daemon and triggering PR analysis.
// WORK22: Agent-based analysis integration with gh pr checkout.
// ---------------------------------------------------------------------------

import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { PRKey, Annotation } from "@prism/shared";
import { createDaemon, startDaemon, shutdownDaemon } from "./server.js";
import { ensureRegistered } from "./routes.js";
import { AgentAnalyzer } from "./analysis/agent-analyzer.js";
import type { AgentType } from "./analysis/agent-analyzer.js";
import {
  isReviewLanguageCode,
  resolveReviewLanguageName,
  type ReviewLanguageCode,
} from "./analysis/review-language.js";
import type { PRAnalysisInput, PRFragment } from "./analysis/types.js";
import type { CanonicalHunk } from "./hunk-canonicalizer.js";

// ---- Git helpers -----------------------------------------------------------

function isInsideGitRepo(): boolean {
  try {
    const result = execSync("git rev-parse --is-inside-work-tree", {
      encoding: "utf-8",
      timeout: 5_000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return result === "true";
  } catch {
    return false;
  }
}

function inferOwnerRepo(): { owner: string; repo: string } {
  let url: string;
  try {
    url = execSync("git remote get-url origin", {
      encoding: "utf-8",
      timeout: 5_000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    console.error("Error: could not detect git remote 'origin'. Are you in a git repo?");
    process.exit(1);
  }

  // SSH: git@github.com:owner/repo.git
  const sshMatch = url.match(/github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/);
  if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };

  // HTTPS: https://github.com/owner/repo.git
  const httpsMatch = url.match(/github\.com\/([^/]+)\/([^/.]+?)(?:\.git)?$/);
  if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };

  console.error(`Error: could not parse GitHub owner/repo from remote URL: ${url}`);
  process.exit(1);
}

// ---- Browser opening -------------------------------------------------------

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : "xdg-open";
  try {
    execSync(`${cmd} ${JSON.stringify(url)}`, {
      stdio: "ignore",
      timeout: 5_000,
    });
  } catch {
    console.log(`  open in browser: ${url}`);
  }
}

// ---- Argument parsing ------------------------------------------------------

function printUsage(): void {
  console.log("Usage:");
  console.log(
    "  prism review <pr_number> [--agent codex|claude] [--model <model>] [--lang en|cn|jp]",
  );
  process.exit(1);
}

interface ReviewArgs {
  owner: string;
  repo: string;
  pullNumber: number;
  agent: AgentType;
  model?: string;
  language: ReviewLanguageCode;
}

function parseReviewTarget(target: string): { owner: string; repo: string; pullNumber: number } {
  // owner/repo#123
  const explicitMatch = target.match(/^([^/]+)\/([^#]+)#(\d+)$/);
  if (explicitMatch) {
    return {
      owner: explicitMatch[1],
      repo: explicitMatch[2],
      pullNumber: parseInt(explicitMatch[3], 10),
    };
  }

  // plain number
  const num = parseInt(target, 10);
  if (!isNaN(num) && num > 0 && String(num) === target) {
    const { owner, repo } = inferOwnerRepo();
    return { owner, repo, pullNumber: num };
  }

  console.error(`Error: invalid PR target "${target}". Use a number or owner/repo#number.`);
  process.exit(1);
}

function parseReviewArgs(args: string[]): ReviewArgs {
  if (!args[0]) {
    console.error("Error: missing PR number.");
    printUsage();
    process.exit(1); // unreachable but satisfies TS
  }

  const { owner, repo, pullNumber } = parseReviewTarget(args[0]);
  let agent: AgentType = "codex";
  let model: string | undefined;
  let language: ReviewLanguageCode = "en";

  // Parse optional flags from args[1..]
  let i = 1;
  while (i < args.length) {
    if (args[i] === "--agent" && i + 1 < args.length) {
      const val = args[i + 1];
      if (val !== "codex" && val !== "claude") {
        console.error(`Error: --agent must be "codex" or "claude", got "${val}".`);
        process.exit(1);
      }
      agent = val;
      i += 2;
    } else if (args[i] === "--model" && i + 1 < args.length) {
      model = args[i + 1];
      i += 2;
    } else if (args[i] === "--lang" && i + 1 < args.length) {
      const val = args[i + 1];
      if (!isReviewLanguageCode(val)) {
        console.error(`Error: --lang must be "en", "cn", or "jp", got "${val}".`);
        process.exit(1);
      }
      language = val;
      i += 2;
    } else {
      console.error(`Error: unknown flag "${args[i]}".`);
      printUsage();
    }
  }

  return { owner, repo, pullNumber, agent, model, language };
}

// ---- Hunk → fragment conversion --------------------------------------------

function buildFragments(hunks: CanonicalHunk[]): PRFragment[] {
  return hunks.map((hunk, idx) => {
    // Reconstruct patch text from normalized lines
    const patchLines = hunk.lines.map((line) => {
      const prefix = line.type === "add" ? "+" : line.type === "delete" ? "-" : " ";
      return prefix + line.content;
    });
    return {
      index: String(idx + 1),
      filePath: hunk.filePath,
      hunkHeader: hunk.hunkHeader,
      patch: patchLines.join("\n"),
    };
  });
}

// ---- Main ------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    printUsage();
  }

  const command = args[0];

  if (command === "server") {
    const daemon = createDaemon();
    await startDaemon(daemon);
    const shutdown = async () => {
      await shutdownDaemon(daemon);
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return;
  }

  if (command === "review") {
    const reviewArgs = parseReviewArgs(args.slice(1));
    const { owner, repo, pullNumber, agent, model, language } = reviewArgs;

    // Step a: Check we're in a git repo
    if (!isInsideGitRepo()) {
      console.error("Error: not inside a git repository.");
      process.exit(1);
    }

    // Step c: Checkout PR
    console.log(`Checking out PR #${pullNumber}...`);
    try {
      execSync(`gh pr checkout ${pullNumber}`, {
        encoding: "utf-8",
        timeout: 30_000,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      console.error(`Error: failed to checkout PR #${pullNumber}.`);
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    // Step d: Start daemon
    const daemon = createDaemon();
    await startDaemon(daemon);
    const shutdown = async () => {
      await shutdownDaemon(daemon);
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    // Step e: Pre-register PR (fetches metadata + canonical hunks)
    const prKey: PRKey = {
      host: "github.com",
      owner,
      repo,
      pullNumber,
      baseSha: "",
      headSha: "",
    };

    console.log("  fetching PR data from GitHub...");
    const registered = await ensureRegistered(prKey, daemon.ctx);
    console.log(`  registered: ${registered.prId} (${registered.fileCount} files)`);

    const hunks = registered.canonicalHunks;
    const prUrl = `https://github.com/${owner}/${repo}/pull/${pullNumber}/files`;

    if (hunks.length === 0) {
      console.log("  no hunks to analyze.");
      console.log("Opening browser...");
      openBrowser(prUrl);
      console.log("\nReview is ready. Press Ctrl+C to exit.");
      return;
    }

    // Step f: Build PRAnalysisInput from canonical hunks
    const fragments = buildFragments(hunks);
    const input: PRAnalysisInput = {
      prTitle: registered.metadata.title,
      prDescription: registered.metadata.body,
      fragments,
    };

    // Step g: Run agent analysis
    console.log(`Analyzing ${hunks.length} hunks with ${agent}...`);
    const analyzer = new AgentAnalyzer({
      agent,
      model,
      language: resolveReviewLanguageName(language),
    });
    const result = await analyzer.analyzePR(input);

    if (result.ok) {
      // Step h: Convert output to Annotations and store
      let annotated = 0;
      for (const fragment of fragments) {
        const summary = result.output[fragment.index];
        if (!summary) continue;

        const hunk = hunks[parseInt(fragment.index, 10) - 1];
        const annotation: Annotation = {
          annotationId: "ann_" + randomUUID(),
          prKey: registered.prKey,
          filePath: hunk.filePath,
          patchHash: hunk.patchHash,
          summary: summary.summary,
          impact: summary.impact,
          risk: summary.risk,
          confidence: summary.confidence,
          model: result.model,
          status: "ready",
          generatedAt: new Date().toISOString(),
        };

        daemon.ctx.annotations.set(registered.prKey.headSha, annotation);
        annotated++;
      }

      console.log(`Analysis complete: ${annotated}/${hunks.length} hunks annotated.`);
    } else {
      // Step k: Degraded mode
      console.warn(`Warning: agent analysis failed: ${result.error}`);
      console.warn("Starting in degraded mode — annotations will be generated on demand.");
    }

    // Step j: Open browser
    console.log("Opening browser...");
    openBrowser(prUrl);

    // Keep daemon running so the extension can fetch annotations.
    // User presses Ctrl+C to exit.
    console.log("\nReview is ready. Press Ctrl+C to exit.");
    return;
  }

  console.error(`Error: unknown command "${command}".`);
  printUsage();
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
