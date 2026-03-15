// ---------------------------------------------------------------------------
// PRism Local Daemon — entry point
//
// Responsibilities (from DESIGN.md §6.3):
//   - Bind to 127.0.0.1 only
//   - Manage GitHub token / gh auth
//   - Fetch PR files, patches, raw diffs
//   - Canonicalize hunk keys
//   - Schedule LLM / coding agent analysis
//   - Persist results to SQLite (WORK13)
//
// Security model (WORK14, DESIGN.md §15):
//   - Daemon listens on 127.0.0.1 ONLY — no external network exposure.
//   - All routes except GET /v1/health require a pairing token
//     (X-PRism-Token header) matching the auto-generated secret stored at
//     <configDir>/pairing-secret (mode 0600).
//   - Defense-in-depth: incoming requests are validated to originate from
//     loopback addresses even though binding to 127.0.0.1 prevents
//     non-loopback connections at the OS level.
//   - Logs never include full patch content, tokens, or secrets.
//
// WORK08 — startup skeleton, config, pairing secret, GET /v1/health
// WORK09 — GitHub adapter, POST /v1/pr/register
// WORK12 — full API surface (query, jobs, annotations)
// WORK13 — SQLite-backed persistent stores
// WORK14 — security hardening, error standardization, failure UX
// ---------------------------------------------------------------------------

import type { HealthResponse } from "@prism/shared";
import http from "node:http";
import path from "node:path";
import { createSummaryPipeline } from "./analysis/index.js";
import { loadConfig } from "./config.js";
import {
  handleRegisterPR,
  handleAnnotationsQuery,
  handleCreateJob,
  handleGetJob,
  handleGetAnnotations,
  json,
  type RouteContext,
} from "./routes.js";
import { ensurePairingSecret } from "./secret.js";
import {
  openDatabase,
  SqlitePRRegistry,
  SqliteAnnotationStore,
  SqliteJobStore,
} from "./sqlite-store.js";

const VERSION = "0.1.0";

// ---- Bootstrap --------------------------------------------------------------

const config = loadConfig();
const pairingSecret = ensurePairingSecret(config.configDir);

// ---- SQLite-backed stores (WORK13) ------------------------------------------

const dbPath = path.join(config.configDir, "prism.db");
const db = openDatabase(dbPath);

const ctx: RouteContext = {
  prs: new SqlitePRRegistry(db),
  annotations: new SqliteAnnotationStore(db),
  jobs: new SqliteJobStore(db),
  pipeline: createSummaryPipeline(),
};

// ---- HTTP server ------------------------------------------------------------

// ---- Loopback validation (WORK14 defense-in-depth) --------------------------

function isLoopback(addr: string): boolean {
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

// ---- HTTP server ------------------------------------------------------------

const server = http.createServer((req, res) => {
  const url = req.url ?? "";
  const method = req.method ?? "";

  // Defense-in-depth: reject non-loopback connections.
  // Should never trigger when bound to 127.0.0.1, but guards misconfiguration.
  const remoteAddr = req.socket.remoteAddress;
  if (remoteAddr && !isLoopback(remoteAddr)) {
    return json(res, 403, { error: "Forbidden: non-loopback connection.", code: "FORBIDDEN" });
  }

  // GET /v1/health — unauthenticated, used by extension to detect daemon
  if (method === "GET" && url === "/v1/health") {
    const body: HealthResponse = {
      ok: true,
      version: VERSION,
      capabilities: ["query", "jobs", "cache"],
    };
    return json(res, 200, body);
  }

  // All other routes require the pairing secret
  const token = req.headers["x-prism-token"];
  if (token !== pairingSecret) {
    return json(res, 401, { error: "unauthorized", code: "UNAUTHORIZED" });
  }

  // POST /v1/pr/register
  if (method === "POST" && url === "/v1/pr/register") {
    handleRegisterPR(req, res, ctx).catch(() => {
      if (!res.headersSent)
        json(res, 500, { error: "Internal server error.", code: "INTERNAL_ERROR" });
    });
    return;
  }

  // POST /v1/annotations/query
  if (method === "POST" && url === "/v1/annotations/query") {
    handleAnnotationsQuery(req, res, ctx).catch(() => {
      if (!res.headersSent)
        json(res, 500, { error: "Internal server error.", code: "INTERNAL_ERROR" });
    });
    return;
  }

  // POST /v1/analysis/jobs
  if (method === "POST" && url === "/v1/analysis/jobs") {
    handleCreateJob(req, res, ctx).catch(() => {
      if (!res.headersSent)
        json(res, 500, { error: "Internal server error.", code: "INTERNAL_ERROR" });
    });
    return;
  }

  // GET /v1/analysis/jobs/:jobId
  const jobMatch = url.match(/^\/v1\/analysis\/jobs\/([^/?]+)/);
  if (method === "GET" && jobMatch) {
    handleGetJob(res, ctx, jobMatch[1]);
    return;
  }

  // GET /v1/annotations?owner=...&repo=...&pullNumber=...&headSha=...
  if (method === "GET" && url.startsWith("/v1/annotations")) {
    handleGetAnnotations(req, res, ctx);
    return;
  }

  // No match
  json(res, 404, { error: "not found", code: "NOT_FOUND" });
});

// ---- Host safety check (WORK14) ---------------------------------------------

if (config.host !== "127.0.0.1" && config.host !== "::1" && config.host !== "localhost") {
  console.warn("WARNING: PRism daemon host is not loopback — this exposes the API to the network.");
  console.warn("  Set PRISM_HOST=127.0.0.1 or remove the host override from config.json.");
}

server.listen(config.port, config.host, () => {
  console.log(`PRism daemon v${VERSION}`);
  console.log(`  listening on http://${config.host}:${config.port}`);
  console.log(`  config dir:  ${config.configDir}`);
  console.log(`  database:    ${dbPath}`);
  // Don't log the secret value or full path — just confirm it exists.
  console.log(`  pairing secret: configured`);
});
