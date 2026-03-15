// ---------------------------------------------------------------------------
// PRism daemon — server factory
//
// Extracts the daemon setup into an importable function so both index.ts
// (standalone daemon) and cli.ts (CLI entry point) can reuse it.
// ---------------------------------------------------------------------------

import type { HealthResponse } from "@prism/shared";
import http from "node:http";
import { createSummaryPipeline } from "./analysis/index.js";
import { loadConfig, type DaemonConfig } from "./config.js";
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
  InMemoryPRRegistry,
  InMemoryAnnotationStore,
  InMemoryJobStore,
} from "./store.js";

const VERSION = "0.1.0";

export interface DaemonInstance {
  server: http.Server;
  ctx: RouteContext;
  config: DaemonConfig;
  pairingSecret: string;
}

function isLoopback(addr: string): boolean {
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

/** Create the daemon server and stores without starting to listen. */
export function createDaemon(): DaemonInstance {
  const config = loadConfig();
  const pairingSecret = ensurePairingSecret(config.configDir);

  const ctx: RouteContext = {
    prs: new InMemoryPRRegistry(),
    annotations: new InMemoryAnnotationStore(),
    jobs: new InMemoryJobStore(),
    pipeline: createSummaryPipeline(),
  };

  const server = http.createServer((req, res) => {
    const url = req.url ?? "";
    const method = req.method ?? "";

    const remoteAddr = req.socket.remoteAddress;
    if (remoteAddr && !isLoopback(remoteAddr)) {
      return json(res, 403, { error: "Forbidden: non-loopback connection.", code: "FORBIDDEN" });
    }

    if (method === "GET" && url === "/v1/health") {
      const body: HealthResponse = {
        ok: true,
        version: VERSION,
        capabilities: ["query", "jobs", "cache"],
      };
      return json(res, 200, body);
    }

    const token = req.headers["x-prism-token"];
    if (token !== pairingSecret) {
      return json(res, 401, { error: "unauthorized", code: "UNAUTHORIZED" });
    }

    if (method === "POST" && url === "/v1/pr/register") {
      handleRegisterPR(req, res, ctx).catch(() => {
        if (!res.headersSent)
          json(res, 500, { error: "Internal server error.", code: "INTERNAL_ERROR" });
      });
      return;
    }

    if (method === "POST" && url === "/v1/annotations/query") {
      handleAnnotationsQuery(req, res, ctx).catch(() => {
        if (!res.headersSent)
          json(res, 500, { error: "Internal server error.", code: "INTERNAL_ERROR" });
      });
      return;
    }

    if (method === "POST" && url === "/v1/analysis/jobs") {
      handleCreateJob(req, res, ctx).catch(() => {
        if (!res.headersSent)
          json(res, 500, { error: "Internal server error.", code: "INTERNAL_ERROR" });
      });
      return;
    }

    const jobMatch = url.match(/^\/v1\/analysis\/jobs\/([^/?]+)/);
    if (method === "GET" && jobMatch) {
      handleGetJob(res, ctx, jobMatch[1]);
      return;
    }

    if (method === "GET" && url.startsWith("/v1/annotations")) {
      handleGetAnnotations(req, res, ctx);
      return;
    }

    json(res, 404, { error: "not found", code: "NOT_FOUND" });
  });

  return { server, ctx, config, pairingSecret };
}

/** Start the daemon server and return a promise that resolves when it's listening. */
export function startDaemon(daemon: DaemonInstance): Promise<void> {
  const { server, config } = daemon;

  if (config.host !== "127.0.0.1" && config.host !== "::1" && config.host !== "localhost") {
    console.warn("WARNING: PRism daemon host is not loopback — this exposes the API to the network.");
    console.warn("  Set PRISM_HOST=127.0.0.1 or remove the host override from config.json.");
  }

  return new Promise((resolve) => {
    server.listen(config.port, config.host, () => {
      console.log(`PRism daemon v${VERSION}`);
      console.log(`  listening on http://${config.host}:${config.port}`);
      console.log(`  config dir:  ${config.configDir}`);
      console.log(`  store:       in-memory`);
      console.log(`  pairing secret: configured`);
      resolve();
    });
  });
}
