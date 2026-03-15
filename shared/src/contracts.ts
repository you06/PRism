// ---------------------------------------------------------------------------
// PRism shared contracts — API requests/responses & extension messages
// (DESIGN.md §10, §11)
// ---------------------------------------------------------------------------

import type {
  PRKey,
  HunkRef,
  Annotation,
  AnalysisJob,
  JobStatus,
} from "./models.js";

// ---- Consistent API error format --------------------------------------------

/** Consistent error response returned by all daemon endpoints on failure. */
export interface ApiErrorResponse {
  error: string;
  code: string;
  details?: unknown;
}

// ---- Daemon HTTP API (§11.2) ------------------------------------------------

/** GET /v1/health */
export interface HealthResponse {
  ok: boolean;
  version: string;
  capabilities: string[];
}

/** POST /v1/pr/register */
export interface RegisterPRRequest {
  pr: PRKey & { url?: string };
}
export interface RegisterPRResponse {
  prId: string;
  status: string;
  title: string;
  baseSha: string;
  headSha: string;
  fileCount: number;
}

/** POST /v1/annotations/query */
export interface QueryAnnotationsRequest {
  pr: PRKey;
  visibleHunks: HunkRef[];
  enqueueMissing?: boolean;
}
export interface QueryAnnotationsResponse {
  annotations: Annotation[];
  missing: Array<{ filePath: string; patchHash: string }>;
  job?: { jobId: string; status: JobStatus };
}

/** POST /v1/analysis/jobs */
export type AnalysisDepth = "summary" | "deep";
export type AnalysisPriority = "interactive" | "background";

export interface CreateJobRequest {
  pr: PRKey;
  scope: "visible" | "all";
  targets: Array<{ filePath: string; patchHash: string }>;
  priority: AnalysisPriority;
  force?: boolean;
  depth?: AnalysisDepth;
}
export interface CreateJobResponse {
  jobId: string;
  status: JobStatus;
}

/** GET /v1/analysis/jobs/:jobId */
export type GetJobResponse = Pick<
  AnalysisJob,
  "jobId" | "status" | "completed" | "total" | "failed"
>;

/** GET /v1/annotations */
export interface GetAnnotationsQuery {
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  filePath?: string;
  patchHash?: string;
}
export interface GetAnnotationsResponse {
  annotations: Annotation[];
}

// ---- Extension internal messages (§10) --------------------------------------

/** Error kinds surfaced by the daemon or API layer to the extension UI. */
export type DaemonErrorKind =
  | "offline"
  | "auth_failed"
  | "rate_limited"
  | "github_error";

export type PrismMessage =
  | { type: "PR_CONTEXT_UPDATED"; pr: PRKey; visibleHunks: HunkRef[] }
  | { type: "REQUEST_VISIBLE_ANNOTATIONS"; pr: PRKey; visibleHunks: HunkRef[] }
  | { type: "ANNOTATIONS_UPDATED"; annotations: Annotation[] }
  | {
      type: "JOB_STATUS_UPDATED";
      jobId: string;
      status: JobStatus;
      completed: number;
      total: number;
    }
  | { type: "RETRY_HUNK"; pr: PRKey; hunk: HunkRef }
  | {
      /** Sent by background to content when a daemon/API call fails. */
      type: "DAEMON_ERROR";
      errorKind: DaemonErrorKind;
      message: string;
      retryAfterSec?: number;
      /** patchHashes of hunks affected by this error. Undefined = all hunks. */
      affectedPatchHashes?: string[];
    };

// ---- Daemon connection defaults ---------------------------------------------

export const DAEMON_DEFAULT_PORT = 19280;
export const DAEMON_BASE_URL = `http://127.0.0.1:${DAEMON_DEFAULT_PORT}`;
