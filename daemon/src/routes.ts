// ---------------------------------------------------------------------------
// PRism daemon — Route handlers (WORK12, WORK14)
//
// Logging policy (WORK14): handlers never log full patch content, tokens,
// or request bodies. Only identifiers (prId, jobId, filePath, patchHash)
// and error messages are logged.
//
// Implements the six localhost API endpoints (DESIGN.md §11.2):
//   GET  /v1/health              — handled directly in index.ts
//   POST /v1/pr/register         — handleRegisterPR
//   POST /v1/annotations/query   — handleAnnotationsQuery
//   POST /v1/analysis/jobs       — handleCreateJob
//   GET  /v1/analysis/jobs/:jobId — handleGetJob
//   GET  /v1/annotations          — handleGetAnnotations
//
// Job processing runs in-memory; WORK13 will add persistence behind the
// store interfaces.
// ---------------------------------------------------------------------------

import type http from "node:http";
import type {
  RegisterPRResponse,
  QueryAnnotationsResponse,
  CreateJobResponse,
  GetJobResponse,
  GetAnnotationsResponse,
  ChatResponse,
  ApiErrorResponse,
  PRKey,
  HunkRef,
  ChatMessage,
  AnalysisJob,
  Annotation,
} from "@prism/shared";
import { randomUUID } from "node:crypto";
import {
  GitHubError,
  fetchPRMetadata,
  fetchPRFiles,
} from "./github.js";
import { parseAllPatches, type CanonicalHunk } from "./hunk-canonicalizer.js";
import type { SummaryPipeline, PRContext } from "./analysis/index.js";
import type {
  PRRegistry,
  AnnotationStore,
  JobStore,
  RegisteredPR,
} from "./store.js";
import {
  validatePRKey,
  validatePRKeyWithSha,
  validateVisibleHunks,
  validateHunkTargets,
} from "./validation.js";
import { runChat } from "./chat-handler.js";

// ---- Route context (injected from index.ts) ---------------------------------

export interface RouteContext {
  prs: PRRegistry;
  annotations: AnnotationStore;
  jobs: JobStore;
  pipeline: SummaryPipeline;
}

// ---- Shared helpers ---------------------------------------------------------

export function json(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function apiError(
  res: http.ServerResponse,
  status: number,
  code: string,
  error: string,
  details?: unknown,
): void {
  const body: ApiErrorResponse = { error, code };
  if (details !== undefined) body.details = details;
  json(res, status, body);
}

function parseJsonBody(
  raw: string,
): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

function makePrId(pr: PRKey): string {
  return `${pr.host || "github.com"}/${pr.owner}/${pr.repo}#${pr.pullNumber}@${pr.headSha.slice(0, 7)}`;
}

function makeJobId(): string {
  return `job_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

async function runWithConcurrency<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = [];
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < tasks.length) {
      const i = nextIndex++;
      results[i] = await tasks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()));
  return results;
}

function resolveCanonicalHunk(
  registered: RegisteredPR,
  hunk: HunkRef,
): CanonicalHunk | undefined {
  const exact = registered.canonicalHunks.find(
    (candidate) =>
      candidate.filePath === hunk.filePath &&
      candidate.patchHash === hunk.patchHash,
  );
  if (exact) return exact;

  return registered.canonicalHunks.find(
    (candidate) =>
      candidate.filePath === hunk.filePath &&
      candidate.oldStart === hunk.oldStart &&
      candidate.oldLines === hunk.oldLines &&
      candidate.newStart === hunk.newStart &&
      candidate.newLines === hunk.newLines,
  );
}

// ---- Ensure PR is registered (lazy fetch from GitHub) -----------------------

export async function ensureRegistered(
  pr: PRKey,
  ctx: RouteContext,
): Promise<RegisteredPR> {
  const existing = ctx.prs.findByPR(
    pr.owner,
    pr.repo,
    pr.pullNumber,
    pr.headSha,
  );
  if (existing) return existing;

  const [metadata, files] = await Promise.all([
    fetchPRMetadata(pr.owner, pr.repo, pr.pullNumber),
    fetchPRFiles(pr.owner, pr.repo, pr.pullNumber),
  ]);

  const canonicalHunks = parseAllPatches(files);
  const prKey: PRKey = {
    host: pr.host || "github.com",
    owner: pr.owner,
    repo: pr.repo,
    pullNumber: pr.pullNumber,
    baseSha: metadata.baseSha,
    headSha: metadata.headSha,
  };
  const prId = makePrId(prKey);

  const registered: RegisteredPR = {
    prId,
    prKey,
    metadata,
    canonicalHunks,
    fileCount: files.length,
    registeredAt: new Date().toISOString(),
  };

  ctx.prs.register(prId, registered);
  return registered;
}

// ---- POST /v1/pr/register ---------------------------------------------------

export async function handleRegisterPR(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const raw = await readBody(req);
  const parsed = parseJsonBody(raw);
  if (!parsed.ok) {
    return apiError(res, 400, "BAD_REQUEST", "Invalid JSON body.");
  }
  const body = parsed.value as Record<string, unknown>;

  const err = validatePRKey(body["pr"]);
  if (err) {
    return apiError(res, 400, "BAD_REQUEST", `${err.field}: ${err.message}`);
  }

  const pr = body["pr"] as PRKey;

  try {
    const registered = await ensureRegistered(pr, ctx);
    const response: RegisterPRResponse = {
      prId: registered.prId,
      status: "fetched",
      title: registered.metadata.title,
      baseSha: registered.prKey.baseSha,
      headSha: registered.prKey.headSha,
      fileCount: registered.fileCount,
    };
    return json(res, 200, response);
  } catch (err) {
    return handleGitHubError(res, err);
  }
}

// ---- POST /v1/annotations/query ---------------------------------------------

export async function handleAnnotationsQuery(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const raw = await readBody(req);
  const parsed = parseJsonBody(raw);
  if (!parsed.ok) {
    return apiError(res, 400, "BAD_REQUEST", "Invalid JSON body.");
  }
  const body = parsed.value as Record<string, unknown>;

  const prErr = validatePRKeyWithSha(body["pr"]);
  if (prErr) {
    return apiError(
      res,
      400,
      "BAD_REQUEST",
      `${prErr.field}: ${prErr.message}`,
    );
  }
  const hunksErr = validateVisibleHunks(body["visibleHunks"]);
  if (hunksErr) {
    return apiError(
      res,
      400,
      "BAD_REQUEST",
      `${hunksErr.field}: ${hunksErr.message}`,
    );
  }

  const pr = body["pr"] as PRKey;
  const visibleHunks = body["visibleHunks"] as HunkRef[];
  const enqueueMissing = body["enqueueMissing"] === true;
  const registered = await ensureRegistered(pr, ctx);

  // Look up cached annotations for each visible hunk
  const found: Annotation[] = [];
  const missing: Array<{ filePath: string; patchHash: string }> = [];

  for (const hunk of visibleHunks) {
    const canonical = resolveCanonicalHunk(registered, hunk);
    const patchHash = canonical?.patchHash ?? hunk.patchHash;
    const filePath = canonical?.filePath ?? hunk.filePath;
    const ann = ctx.annotations.get(
      registered.prKey.headSha,
      filePath,
      patchHash,
    );
    if (ann && ann.status === "ready") {
      found.push({
        ...ann,
        filePath: hunk.filePath,
        patchHash: hunk.patchHash,
      });
    } else {
      missing.push({ filePath, patchHash });
    }
  }

  const response: QueryAnnotationsResponse = {
    annotations: found,
    missing,
  };

  // Optionally enqueue missing hunks for background analysis
  if (enqueueMissing && missing.length > 0) {
    try {
      const job = await createAndStartJob(pr, "visible", missing, ctx, false);
      response.job = { jobId: job.jobId, status: job.status };
    } catch (err) {
      // Don't fail the query if job creation fails — return what we have
      console.error("Failed to enqueue missing hunks:", err);
    }
  }

  return json(res, 200, response);
}

// ---- POST /v1/analysis/jobs -------------------------------------------------

export async function handleCreateJob(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const raw = await readBody(req);
  const parsed = parseJsonBody(raw);
  if (!parsed.ok) {
    return apiError(res, 400, "BAD_REQUEST", "Invalid JSON body.");
  }
  const body = parsed.value as Record<string, unknown>;

  const prErr = validatePRKeyWithSha(body["pr"]);
  if (prErr) {
    return apiError(
      res,
      400,
      "BAD_REQUEST",
      `${prErr.field}: ${prErr.message}`,
    );
  }
  const targetsErr = validateHunkTargets(body["targets"]);
  if (targetsErr) {
    return apiError(
      res,
      400,
      "BAD_REQUEST",
      `${targetsErr.field}: ${targetsErr.message}`,
    );
  }

  const pr = body["pr"] as PRKey;
  const targets = body["targets"] as Array<{
    filePath: string;
    patchHash: string;
  }>;
  const scope = (body["scope"] as string) || "visible";
  const force = body["force"] === true;

  try {
    const job = await createAndStartJob(pr, scope, targets, ctx, force);
    const response: CreateJobResponse = {
      jobId: job.jobId,
      status: job.status,
    };
    return json(res, 200, response);
  } catch (err) {
    return handleGitHubError(res, err);
  }
}

// ---- GET /v1/analysis/jobs/:jobId -------------------------------------------

export function handleGetJob(
  res: http.ServerResponse,
  ctx: RouteContext,
  jobId: string,
): void {
  const job = ctx.jobs.get(jobId);
  if (!job) {
    return apiError(res, 404, "NOT_FOUND", `Job not found: ${jobId}`);
  }

  const response: GetJobResponse = {
    jobId: job.jobId,
    status: job.status,
    completed: job.completed,
    total: job.total,
    failed: job.failed,
  };
  return json(res, 200, response);
}

// ---- GET /v1/annotations ----------------------------------------------------

export function handleGetAnnotations(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: RouteContext,
): void {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const params = url.searchParams;

  const owner = params.get("owner");
  const repo = params.get("repo");
  const pullNumber = params.get("pullNumber");
  const headSha = params.get("headSha");

  if (!owner || !repo || !pullNumber || !headSha) {
    return apiError(
      res,
      400,
      "BAD_REQUEST",
      "Required query params: owner, repo, pullNumber, headSha",
    );
  }

  const pullNum = parseInt(pullNumber, 10);
  if (isNaN(pullNum)) {
    return apiError(res, 400, "BAD_REQUEST", "pullNumber must be a number");
  }

  const filePath = params.get("filePath") ?? undefined;
  const patchHash = params.get("patchHash") ?? undefined;

  const annotations = ctx.annotations.query(headSha, { filePath, patchHash });

  // Filter by owner/repo/pullNumber to avoid headSha collisions
  const filtered = annotations.filter(
    (a) =>
      a.prKey.owner === owner &&
      a.prKey.repo === repo &&
      a.prKey.pullNumber === pullNum,
  );

  const response: GetAnnotationsResponse = { annotations: filtered };
  return json(res, 200, response);
}

// ---- Job creation & background processing -----------------------------------

export async function createAndStartJob(
  pr: PRKey,
  scope: string,
  targets: Array<{ filePath: string; patchHash: string }>,
  ctx: RouteContext,
  force: boolean,
): Promise<AnalysisJob> {
  const jobId = makeJobId();
  const job: AnalysisJob = {
    jobId,
    prKey: pr,
    scope: scope === "all" ? "all" : "visible",
    status: "queued",
    completed: 0,
    total: targets.length,
    failed: 0,
    createdAt: new Date().toISOString(),
  };

  ctx.jobs.create(job);

  // Fire-and-forget background processing
  processJob(jobId, pr, targets, ctx, force).catch((err) => {
    console.error(`Job ${jobId} failed unexpectedly:`, err);
    ctx.jobs.update(jobId, { status: "failed" });
  });

  return job;
}

async function processJob(
  jobId: string,
  pr: PRKey,
  targets: Array<{ filePath: string; patchHash: string }>,
  ctx: RouteContext,
  force: boolean,
): Promise<void> {
  ctx.jobs.update(jobId, { status: "running" });

  // Ensure PR data is available (fetches from GitHub if needed)
  let registered: RegisteredPR;
  try {
    registered = await ensureRegistered(pr, ctx);
  } catch (err) {
    console.error(`Job ${jobId}: failed to fetch PR data:`, err);
    ctx.jobs.update(jobId, { status: "failed" });
    return;
  }

  const prContext: PRContext = {
    prKey: registered.prKey,
    title: registered.metadata.title,
    description: registered.metadata.body,
  };

  // Build lookup for canonical hunks
  const canonicalByKey = new Map<string, CanonicalHunk>();
  for (const ch of registered.canonicalHunks) {
    canonicalByKey.set(`${ch.filePath}\0${ch.patchHash}`, ch);
  }

  let completed = 0;
  let failed = 0;

  const tasks = targets.map((target) => async () => {
    // Skip if we already have a ready annotation (unless force)
    if (!force) {
      const existing = ctx.annotations.get(
        registered.prKey.headSha,
        target.filePath,
        target.patchHash,
      );
      if (existing && existing.status === "ready") {
        completed++;
        ctx.jobs.update(jobId, { completed });
        return;
      }
    }

    // Find the canonical hunk for this target
    const canonical = canonicalByKey.get(
      `${target.filePath}\0${target.patchHash}`,
    );
    if (!canonical) {
      failed++;
      ctx.jobs.update(jobId, { failed });
      return;
    }

    try {
      const annotation = await ctx.pipeline.analyzeHunk(
        canonical,
        prContext,
      );
      // Ensure the annotation carries the correct prKey
      annotation.prKey = registered.prKey;
      ctx.annotations.set(registered.prKey.headSha, annotation);
      completed++;
    } catch (err) {
      console.error(
        `Job ${jobId}: analysis failed for ${target.filePath}:${target.patchHash}:`,
        err,
      );
      failed++;
    }

    ctx.jobs.update(jobId, { completed, failed });
  });

  await runWithConcurrency(tasks, 5);

  ctx.jobs.update(jobId, {
    status: failed === targets.length ? "failed" : "completed",
  });
}

// ---- POST /v1/chat ----------------------------------------------------------

export async function handleChat(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const raw = await readBody(req);
  const parsed = parseJsonBody(raw);
  if (!parsed.ok) {
    return apiError(res, 400, "BAD_REQUEST", "Invalid JSON body.");
  }
  const body = parsed.value as Record<string, unknown>;

  // Validate required fields
  const prErr = validatePRKeyWithSha(body["pr"]);
  if (prErr) {
    return apiError(res, 400, "BAD_REQUEST", `${prErr.field}: ${prErr.message}`);
  }
  if (typeof body["filePath"] !== "string" || !body["filePath"]) {
    return apiError(res, 400, "BAD_REQUEST", "filePath: required string");
  }
  if (typeof body["patchHash"] !== "string" || !body["patchHash"]) {
    return apiError(res, 400, "BAD_REQUEST", "patchHash: required string");
  }
  if (!Array.isArray(body["messages"]) || body["messages"].length === 0) {
    return apiError(res, 400, "BAD_REQUEST", "messages: required non-empty array");
  }

  const pr = body["pr"] as PRKey;
  const filePath = body["filePath"] as string;
  const patchHash = body["patchHash"] as string;
  const messages = body["messages"] as ChatMessage[];
  const agent = (body["agent"] as "codex" | "claude") || "codex";
  const model = body["model"] as string | undefined;
  const language = (body["language"] as string) || "English";

  // Look up the PR and hunk context
  let registered;
  try {
    registered = await ensureRegistered(pr, ctx);
  } catch (err) {
    return handleGitHubError(res, err);
  }

  const hunk = registered.canonicalHunks.find(
    (h) => h.filePath === filePath && h.patchHash === patchHash,
  );

  if (!hunk) {
    return apiError(
      res,
      404,
      "HUNK_NOT_FOUND",
      `No hunk found for ${filePath} with patchHash ${patchHash}`,
    );
  }

  const patch = hunk.lines
    .map((line) => {
      const prefix = line.type === "add" ? "+" : line.type === "delete" ? "-" : " ";
      return prefix + line.content;
    })
    .join("\n");

  // Look up existing annotation for extra context
  const existingAnnotation = ctx.annotations.get(
    registered.prKey.headSha,
    filePath,
    patchHash,
  );

  const result = await runChat({
    promptInput: {
      prTitle: registered.metadata.title,
      prDescription: registered.metadata.body,
      filePath,
      patch,
      annotation: existingAnnotation
        ? {
            summary: existingAnnotation.summary,
            impact: existingAnnotation.impact,
            risk: existingAnnotation.risk,
          }
        : undefined,
      language,
    },
    messages,
    agent,
    model,
  });

  if (result.ok) {
    const response: ChatResponse = {
      reply: result.reply,
      model: result.model,
    };
    return json(res, 200, response);
  }

  return apiError(res, 500, "CHAT_FAILED", result.error);
}

// ---- GitHub error → HTTP response (WORK14: consistent error format) ---------

function handleGitHubError(
  res: http.ServerResponse,
  err: unknown,
): void {
  if (err instanceof GitHubError) {
    const statusCode =
      err.kind === "token_missing" || err.kind === "token_expired"
        ? 401
        : err.kind === "not_found"
          ? 404
          : err.kind === "rate_limited"
            ? 429
            : 502;

    // Pass Retry-After header so the extension can show a countdown
    if (err.kind === "rate_limited" && err.retryAfter != null) {
      res.setHeader("Retry-After", String(err.retryAfter));
    }

    const details =
      err.kind === "rate_limited" && err.retryAfter != null
        ? { retryAfterSec: err.retryAfter }
        : undefined;

    const code =
      err.kind === "token_missing"
        ? "GITHUB_AUTH_MISSING"
        : err.kind === "token_expired"
          ? "GITHUB_AUTH_EXPIRED"
          : `GITHUB_${err.kind.toUpperCase()}`;

    return apiError(
      res,
      statusCode,
      code,
      err.message,
      details,
    );
  }

  // Log generic errors without full detail (avoid leaking patch/token content)
  console.error("Unhandled route error:", err instanceof Error ? err.message : "(unknown)");
  return apiError(res, 500, "INTERNAL_ERROR", "Internal server error.");
}
