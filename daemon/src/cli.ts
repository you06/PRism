#!/usr/bin/env node
// ---------------------------------------------------------------------------
// PRism CLI — `prism review <pr>` / `prism server`
//
// WORK18: CLI entry point for launching the daemon and triggering PR analysis.
// ---------------------------------------------------------------------------

import { execSync } from "node:child_process";
import type { PRKey } from "@prism/shared";
import { createDaemon, startDaemon } from "./server.js";
import { ensureRegistered, createAndStartJob } from "./routes.js";

// ---- Git remote parsing ----------------------------------------------------

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
  console.log("  prism review <pr_number>              — review PR from current git repo");
  console.log("  prism review owner/repo#<pr_number>   — review PR from specified repo");
  console.log("  prism server                          — start daemon only");
  process.exit(1);
}

interface ReviewArgs {
  owner: string;
  repo: string;
  pullNumber: number;
}

function parseReviewTarget(target: string): ReviewArgs {
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
    return;
  }

  if (command === "review") {
    if (!args[1]) {
      console.error("Error: missing PR number.");
      printUsage();
      return; // unreachable but satisfies TS
    }

    const { owner, repo, pullNumber } = parseReviewTarget(args[1]);
    console.log(`Reviewing ${owner}/${repo}#${pullNumber}...`);

    // Start daemon
    const daemon = createDaemon();
    await startDaemon(daemon);

    // Preregister PR via internal function calls (same process)
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

    // Trigger full analysis (scope: "all")
    const targets = registered.canonicalHunks.map((h) => ({
      filePath: h.filePath,
      patchHash: h.patchHash,
    }));

    if (targets.length > 0) {
      console.log(`  starting analysis of ${targets.length} hunks...`);
      await createAndStartJob(
        registered.prKey,
        "all",
        targets,
        daemon.ctx,
        false,
      );
    }

    // Open browser to PR files page
    const prUrl = `https://github.com/${owner}/${repo}/pull/${pullNumber}/files`;
    console.log(`  opening ${prUrl}`);
    openBrowser(prUrl);

    return;
  }

  console.error(`Error: unknown command "${command}".`);
  printUsage();
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
