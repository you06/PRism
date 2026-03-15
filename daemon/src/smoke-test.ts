#!/usr/bin/env tsx
// ---------------------------------------------------------------------------
// PRism daemon — smoke test
//
// Exercises the daemon HTTP API end-to-end against a real public GitHub PR.
// Requires a running daemon instance with a valid GITHUB_TOKEN configured.
//
// Usage:
//   pnpm --filter @prism/daemon smoke-test
//
// Environment overrides:
//   PRISM_SMOKE_OWNER   — GitHub owner (default: "cli")
//   PRISM_SMOKE_REPO    — GitHub repo  (default: "cli")
//   PRISM_SMOKE_PR      — PR number    (default: "9530")
//   PRISM_URL           — Daemon URL   (default: "http://127.0.0.1:19280")
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ---- Configuration ---------------------------------------------------------

const BASE_URL = process.env["PRISM_URL"] || "http://127.0.0.1:19280";
const TEST_OWNER = process.env["PRISM_SMOKE_OWNER"] || "cli";
const TEST_REPO = process.env["PRISM_SMOKE_REPO"] || "cli";
const TEST_PR = parseInt(process.env["PRISM_SMOKE_PR"] || "9530", 10);

// ---- Pairing secret --------------------------------------------------------

function readPairingSecret(): string {
  const secretPath = path.join(os.homedir(), ".config", "prism", "pairing-secret");
  try {
    return fs.readFileSync(secretPath, "utf-8").trim();
  } catch {
    console.error(`Cannot read pairing secret at ${secretPath}`);
    console.error("Start the daemon at least once to generate it.");
    process.exit(1);
  }
}

// ---- HTTP helpers ----------------------------------------------------------

interface FetchResult {
  status: number;
  body: Record<string, unknown>;
}

async function api(
  method: string,
  urlPath: string,
  body?: unknown,
  auth = true,
): Promise<FetchResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (auth) {
    headers["X-PRism-Token"] = pairingSecret;
  }

  const res = await fetch(`${BASE_URL}${urlPath}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text);
  } catch {
    json = { _raw: text };
  }
  return { status: res.status, body: json };
}

// ---- Test runner -----------------------------------------------------------

interface StepResult {
  name: string;
  passed: boolean;
  detail: string;
}

const results: StepResult[] = [];

function pass(name: string, detail: string): void {
  results.push({ name, passed: true, detail });
  console.log(`  ✓ ${name}: ${detail}`);
}

function fail(name: string, detail: string): void {
  results.push({ name, passed: false, detail });
  console.log(`  ✗ ${name}: ${detail}`);
}

// ---- Sleep helper ----------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- Test steps ------------------------------------------------------------

async function stepHealth(): Promise<boolean> {
  const name = "GET /v1/health";
  try {
    const res = await api("GET", "/v1/health", undefined, false);
    if (res.status === 200 && res.body["ok"] === true) {
      const caps = res.body["capabilities"] as string[];
      pass(name, `v${res.body["version"]} capabilities=[${caps.join(",")}]`);
      return true;
    }
    fail(name, `status=${res.status} body=${JSON.stringify(res.body)}`);
    return false;
  } catch (err) {
    fail(name, `Daemon unreachable at ${BASE_URL} — ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

async function stepRegisterPR(): Promise<{
  ok: boolean;
  headSha: string;
  baseSha: string;
  fileCount: number;
}> {
  const name = "POST /v1/pr/register";
  const nullResult = { ok: false, headSha: "", baseSha: "", fileCount: 0 };
  try {
    const res = await api("POST", "/v1/pr/register", {
      pr: {
        host: "github.com",
        owner: TEST_OWNER,
        repo: TEST_REPO,
        pullNumber: TEST_PR,
        headSha: "",
        baseSha: "",
      },
    });

    if (res.status === 200 && res.body["prId"]) {
      const headSha = res.body["headSha"] as string;
      const baseSha = res.body["baseSha"] as string;
      const fileCount = res.body["fileCount"] as number;
      pass(
        name,
        `prId=${res.body["prId"]} files=${fileCount} head=${headSha.slice(0, 8)}`,
      );
      return { ok: true, headSha, baseSha, fileCount };
    }

    fail(name, `status=${res.status} error=${res.body["error"] || JSON.stringify(res.body)}`);
    return nullResult;
  } catch (err) {
    fail(name, `${err instanceof Error ? err.message : err}`);
    return nullResult;
  }
}

async function stepQueryAnnotations(
  headSha: string,
  baseSha: string,
): Promise<boolean> {
  const name = "POST /v1/annotations/query";
  try {
    const res = await api("POST", "/v1/annotations/query", {
      pr: {
        host: "github.com",
        owner: TEST_OWNER,
        repo: TEST_REPO,
        pullNumber: TEST_PR,
        headSha,
        baseSha,
      },
      visibleHunks: [],
      enqueueMissing: false,
    });

    if (res.status === 200) {
      const annotations = res.body["annotations"] as unknown[];
      const missing = res.body["missing"] as unknown[];
      pass(
        name,
        `annotations=${annotations.length} missing=${missing.length}`,
      );
      return true;
    }

    fail(name, `status=${res.status} error=${res.body["error"]}`);
    return false;
  } catch (err) {
    fail(name, `${err instanceof Error ? err.message : err}`);
    return false;
  }
}

async function stepCreateJob(
  headSha: string,
  baseSha: string,
): Promise<{ ok: boolean; jobId: string }> {
  const name = "POST /v1/analysis/jobs";
  try {
    const res = await api("POST", "/v1/analysis/jobs", {
      pr: {
        host: "github.com",
        owner: TEST_OWNER,
        repo: TEST_REPO,
        pullNumber: TEST_PR,
        headSha,
        baseSha,
      },
      scope: "visible",
      targets: [{ filePath: "__smoke_test__", patchHash: "smoke_test_hash" }],
      priority: "background",
    });

    if (res.status === 200 && res.body["jobId"]) {
      const jobId = res.body["jobId"] as string;
      pass(name, `jobId=${jobId} status=${res.body["status"]}`);
      return { ok: true, jobId };
    }

    fail(name, `status=${res.status} error=${res.body["error"]}`);
    return { ok: false, jobId: "" };
  } catch (err) {
    fail(name, `${err instanceof Error ? err.message : err}`);
    return { ok: false, jobId: "" };
  }
}

async function stepPollJob(jobId: string): Promise<boolean> {
  const name = "GET /v1/analysis/jobs/:jobId (poll)";
  const maxAttempts = 15;
  const intervalMs = 1_000;

  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await api("GET", `/v1/analysis/jobs/${jobId}`);
      if (res.status !== 200) {
        fail(name, `status=${res.status} on poll ${i + 1}`);
        return false;
      }

      const status = res.body["status"] as string;
      if (status === "completed" || status === "failed") {
        pass(
          name,
          `terminal state="${status}" completed=${res.body["completed"]}/${res.body["total"]} failed=${res.body["failed"]} (${i + 1} polls)`,
        );
        return true;
      }
    } catch (err) {
      fail(name, `poll ${i + 1}: ${err instanceof Error ? err.message : err}`);
      return false;
    }

    await sleep(intervalMs);
  }

  fail(name, `job did not reach terminal state after ${maxAttempts} polls`);
  return false;
}

async function stepGetAnnotations(headSha: string): Promise<boolean> {
  const name = "GET /v1/annotations";
  try {
    const qs = new URLSearchParams({
      owner: TEST_OWNER,
      repo: TEST_REPO,
      pullNumber: String(TEST_PR),
      headSha,
    });
    const res = await api("GET", `/v1/annotations?${qs}`);

    if (res.status === 200) {
      const annotations = res.body["annotations"] as unknown[];
      pass(name, `${annotations.length} annotations returned`);
      return true;
    }

    fail(name, `status=${res.status} error=${res.body["error"]}`);
    return false;
  } catch (err) {
    fail(name, `${err instanceof Error ? err.message : err}`);
    return false;
  }
}

// ---- Main ------------------------------------------------------------------

const pairingSecret = readPairingSecret();

async function main(): Promise<void> {
  console.log("PRism smoke test");
  console.log(`  daemon:  ${BASE_URL}`);
  console.log(`  PR:      ${TEST_OWNER}/${TEST_REPO}#${TEST_PR}`);
  console.log("");

  // Step 1: Health check
  const healthy = await stepHealth();
  if (!healthy) {
    console.log("\nDaemon is not reachable. Start it first:");
    console.log("  pnpm --filter @prism/daemon dev");
    printSummary();
    return;
  }

  // Step 2: Register PR
  const reg = await stepRegisterPR();
  if (!reg.ok) {
    console.log("\nPR registration failed. Check GITHUB_TOKEN and PR accessibility.");
    printSummary();
    return;
  }

  // Step 3: Query annotations (empty expected — no analysis yet)
  await stepQueryAnnotations(reg.headSha, reg.baseSha);

  // Step 4: Create analysis job
  const job = await stepCreateJob(reg.headSha, reg.baseSha);

  // Step 5: Poll job status
  if (job.ok) {
    await stepPollJob(job.jobId);
  }

  // Step 6: Fetch annotations
  await stepGetAnnotations(reg.headSha);

  printSummary();
}

function printSummary(): void {
  console.log("\n─── Summary ───");
  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  console.log(`${passed}/${total} steps passed\n`);

  for (const r of results) {
    console.log(`  ${r.passed ? "PASS" : "FAIL"}  ${r.name}`);
  }

  console.log("");
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(2);
});
