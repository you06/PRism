// ---------------------------------------------------------------------------
// PRism — Background API Client (WORK14)
//
// The ONLY module that talks to the localhost daemon over HTTP.
// All other extension code must go through the background service worker.
//
// Security model:
//   - All daemon requests are limited to localhost.
//   - GET /v1/health is used for connectivity checks.
//   - Errors are classified into PrismApiError kinds so the UI can show
//     distinct states for offline / rate_limited / github_error.
// ---------------------------------------------------------------------------

import type {
  HealthResponse,
  QueryAnnotationsResponse,
  RegisterPRResponse,
  CreateJobResponse,
  GetJobResponse,
  ChatResponse,
  ChatMessage,
} from "./shared.js";
import type { HunkRef, PRKey } from "./shared.js";
import { DAEMON_BASE_URL } from "./shared.js";

// ---- Typed API errors (WORK14) ----------------------------------------------

export type ApiErrorKind =
  | "offline"
  | "rate_limited"
  | "github_error";

/**
 * Typed error thrown by API methods so callers can distinguish failure modes
 * and show the appropriate UI state.
 */
export class PrismApiError extends Error {
  constructor(
    public readonly kind: ApiErrorKind,
    message: string,
    public readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = "PrismApiError";
  }
}

// ---- Shared fetch wrapper ---------------------------------------------------

/**
 * Low-level fetch to the daemon. Classifies failures into PrismApiError.
 *
 * - Network error / connection refused → "offline"
 * - HTTP 429                           → "rate_limited"
 * - HTTP 4xx/5xx with GITHUB_* code    → "github_error"
 */
async function daemonFetch(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-PRism-Client": "extension",
  };

  let res: Response;
  try {
    res = await fetch(`${DAEMON_BASE_URL}${path}`, {
      ...options,
      headers: {
        ...headers,
        ...((options.headers as Record<string, string>) || {}),
      },
    });
  } catch {
    throw new PrismApiError(
      "offline",
      "PRism daemon is not running. Start the daemon and retry.",
    );
  }

  if (res.status === 429) {
    const retryHeader = res.headers.get("Retry-After");
    const retryAfterSec = retryHeader ? parseInt(retryHeader, 10) : undefined;
    throw new PrismApiError(
      "rate_limited",
      retryAfterSec != null
        ? `GitHub rate limit exceeded. Resets in ${retryAfterSec}s.`
        : "GitHub rate limit exceeded. Try again later.",
      retryAfterSec,
    );
  }

  // GitHub-originated errors forwarded by the daemon (4xx/5xx)
  if (!res.ok) {
    let errorMsg = `Daemon returned HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string; code?: string };
      if (body.code?.startsWith("GITHUB_")) {
        throw new PrismApiError(
          "github_error",
          body.error || errorMsg,
        );
      }
      errorMsg = body.error || errorMsg;
    } catch (e) {
      if (e instanceof PrismApiError) throw e;
    }
    throw new PrismApiError("github_error", errorMsg);
  }

  return res;
}

// ---- API methods ------------------------------------------------------------

/**
 * GET /v1/health — unauthenticated.
 * Returns HealthResponse on success, null if daemon is unreachable.
 */
export async function checkHealth(): Promise<HealthResponse | null> {
  try {
    const res = await fetch(`${DAEMON_BASE_URL}/v1/health`);
    if (!res.ok) return null;
    return (await res.json()) as HealthResponse;
  } catch {
    return null;
  }
}

/**
 * POST /v1/pr/register
 * Registers a PR with the daemon for tracking and GitHub data fetching.
 */
export async function registerPR(
  pr: PRKey,
): Promise<RegisterPRResponse | null> {
  const res = await daemonFetch("/v1/pr/register", {
    method: "POST",
    body: JSON.stringify({ pr }),
  });
  return (await res.json()) as RegisterPRResponse;
}

/**
 * POST /v1/annotations/query
 * Query annotations for visible hunks. Returns cached results + missing list.
 * Automatically enqueues missing hunks for background analysis.
 */
export async function queryAnnotations(
  pr: PRKey,
  hunks: HunkRef[],
): Promise<QueryAnnotationsResponse> {
  const res = await daemonFetch("/v1/annotations/query", {
    method: "POST",
    body: JSON.stringify({ pr, visibleHunks: hunks, enqueueMissing: true }),
  });
  return (await res.json()) as QueryAnnotationsResponse;
}

/**
 * POST /v1/analysis/jobs
 * Create a new analysis job for specific targets.
 */
export async function createJob(
  pr: PRKey,
  targets: Array<{ filePath: string; patchHash: string }>,
): Promise<CreateJobResponse> {
  const res = await daemonFetch("/v1/analysis/jobs", {
    method: "POST",
    body: JSON.stringify({ pr, scope: "visible", targets }),
  });
  return (await res.json()) as CreateJobResponse;
}

/**
 * GET /v1/analysis/jobs/:jobId
 * Poll job status.
 */
export async function getJobStatus(
  jobId: string,
): Promise<GetJobResponse> {
  const res = await daemonFetch(`/v1/analysis/jobs/${encodeURIComponent(jobId)}`);
  return (await res.json()) as GetJobResponse;
}

/**
 * POST /v1/chat
 * Send a chat message about a specific hunk and get an AI reply.
 */
export async function sendChatMessage(
  pr: PRKey,
  filePath: string,
  patchHash: string,
  messages: ChatMessage[],
): Promise<ChatResponse> {
  const res = await daemonFetch("/v1/chat", {
    method: "POST",
    body: JSON.stringify({ pr, filePath, patchHash, messages }),
  });
  return (await res.json()) as ChatResponse;
}

/**
 * POST /v1/chat/stream
 * Stream a chat response. Calls onChunk with text as it arrives,
 * onDone when complete, onError on failure.
 */
export async function sendChatMessageStream(
  pr: PRKey,
  filePath: string,
  patchHash: string,
  messages: ChatMessage[],
  onChunk: (text: string) => void,
  onDone: (model: string) => void,
  onError: (error: string) => void,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${DAEMON_BASE_URL}/v1/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-PRism-Client": "extension" },
      body: JSON.stringify({ pr, filePath, patchHash, messages }),
    });
  } catch {
    onError("PRism daemon is not running.");
    return;
  }

  if (!res.ok || !res.body) {
    let errorMsg = `Daemon returned HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      errorMsg = body.error || errorMsg;
    } catch { /* ignore */ }
    onError(errorMsg);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  let terminated = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Parse SSE events: "data: {...}\n\n"
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";

    for (const event of events) {
      const line = event.trim();
      if (!line.startsWith("data: ")) continue;
      const jsonStr = line.slice(6);
      try {
        const data = JSON.parse(jsonStr) as {
          chunk?: string;
          done?: boolean;
          model?: string;
          error?: string;
        };
        if (data.error) {
          onError(data.error);
          terminated = true;
          return;
        }
        if (data.chunk) {
          onChunk(data.chunk);
        }
        if (data.done && data.model) {
          onDone(data.model);
          terminated = true;
          return;
        }
      } catch { /* skip malformed */ }
    }
  }

  // Stream ended without a done or error event — treat as error
  if (!terminated) {
    onError("Stream ended unexpectedly without a response.");
  }
}
