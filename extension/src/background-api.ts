// ---------------------------------------------------------------------------
// PRism — Background API Client (WORK14)
//
// The ONLY module that talks to the localhost daemon over HTTP.
// All other extension code must go through the background service worker.
//
// Security model:
//   - All authenticated requests include X-PRism-Token (pairing secret).
//   - Token is read from chrome.storage.local ("pairingToken") and cached.
//   - GET /v1/health is unauthenticated (used for connectivity checks).
//   - Errors are classified into PrismApiError kinds so the UI can show
//     distinct states for offline / auth_failed / rate_limited / github_error.
// ---------------------------------------------------------------------------

import type {
  HealthResponse,
  QueryAnnotationsResponse,
  RegisterPRResponse,
  CreateJobResponse,
  GetJobResponse,
} from "@prism/shared";
import type { HunkRef, PRKey } from "@prism/shared";
import { DAEMON_BASE_URL } from "@prism/shared";

// ---- Typed API errors (WORK14) ----------------------------------------------

export type ApiErrorKind =
  | "offline"
  | "auth_failed"
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

// ---- Pairing token management -----------------------------------------------

let cachedToken: string | null = null;

async function getPairingToken(): Promise<string | null> {
  if (cachedToken != null) return cachedToken;
  try {
    const result = await chrome.storage.local.get("pairingToken");
    cachedToken = (result.pairingToken as string) ?? null;
    return cachedToken;
  } catch {
    return null;
  }
}

// Invalidate cache when the user updates the token in extension settings.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes["pairingToken"]) {
    cachedToken = (changes["pairingToken"].newValue as string) ?? null;
  }
});

// ---- Shared fetch wrapper ---------------------------------------------------

/**
 * Low-level fetch to the daemon. Classifies failures into PrismApiError.
 *
 * - Network error / connection refused → "offline"
 * - HTTP 401                           → "auth_failed"
 * - HTTP 429                           → "rate_limited"
 * - HTTP 4xx/5xx with GITHUB_* code    → "github_error"
 */
async function daemonFetch(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const token = await getPairingToken();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-PRism-Client": "extension",
  };
  if (token) {
    headers["X-PRism-Token"] = token;
  }

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

  if (res.status === 401) {
    throw new PrismApiError(
      "auth_failed",
      "Pairing token not configured or invalid. Check extension settings.",
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
