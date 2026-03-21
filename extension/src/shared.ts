// ---------------------------------------------------------------------------
// PRism extension-local shared models/contracts
//
// The extension runs in a browser environment and cannot resolve workspace
// package specifiers like "@prism/shared" at runtime. Keep the browser-facing
// subset local so emitted JS only uses relative imports.
// ---------------------------------------------------------------------------

export interface PRKey {
  host: string;
  owner: string;
  repo: string;
  pullNumber: number;
  baseSha: string;
  headSha: string;
}

export interface HunkRef {
  filePath: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  hunkHeader: string;
  patchHash: string;
  domAnchorId?: string;
  isVisible?: boolean;
}

export type RiskLevel = "low" | "medium" | "high";
export type AnnotationStatus = "pending" | "running" | "ready" | "error";

export interface Annotation {
  annotationId: string;
  prKey: PRKey;
  filePath: string;
  patchHash: string;
  summary: string;
  impact: string;
  risk: RiskLevel;
  confidence: number;
  status: AnnotationStatus;
  generatedAt: string;
  model: string;
}

export type JobStatus = "queued" | "running" | "completed" | "failed";

export interface AnalysisJob {
  jobId: string;
  prKey: PRKey;
  scope: "visible" | "all";
  status: JobStatus;
  completed: number;
  total: number;
  failed: number;
  createdAt: string;
}

export interface HealthResponse {
  ok: boolean;
  version: string;
  capabilities: string[];
}

export interface RegisterPRResponse {
  prId: string;
  status: string;
  title: string;
  baseSha: string;
  headSha: string;
  fileCount: number;
}

export interface QueryAnnotationsResponse {
  annotations: Annotation[];
  missing: Array<{ filePath: string; patchHash: string }>;
  job?: { jobId: string; status: JobStatus };
}

export interface CreateJobResponse {
  jobId: string;
  status: JobStatus;
}

export type GetJobResponse = Pick<
  AnalysisJob,
  "jobId" | "status" | "completed" | "total" | "failed"
>;

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatResponse {
  reply: string;
  model: string;
}

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
      type: "DAEMON_ERROR";
      errorKind: DaemonErrorKind;
      message: string;
      retryAfterSec?: number;
      affectedPatchHashes?: string[];
    }
  | {
      type: "CHAT_SEND";
      pr: PRKey;
      filePath: string;
      patchHash: string;
      messages: ChatMessage[];
    }
  | {
      type: "CHAT_REPLY";
      patchHash: string;
      reply: string;
      model: string;
    }
  | {
      /** Streamed chunk of a chat reply. */
      type: "CHAT_REPLY_CHUNK";
      patchHash: string;
      chunk: string;
    }
  | {
      /** Streamed chat response is complete. */
      type: "CHAT_REPLY_DONE";
      patchHash: string;
      model: string;
    }
  | {
      type: "CHAT_ERROR";
      patchHash: string;
      error: string;
    };

export const DAEMON_DEFAULT_PORT = 19280;
export const DAEMON_BASE_URL = `http://127.0.0.1:${DAEMON_DEFAULT_PORT}`;
