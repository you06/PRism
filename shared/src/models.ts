// ---------------------------------------------------------------------------
// PRism core data models (DESIGN.md §7)
// ---------------------------------------------------------------------------

/** Uniquely identifies a PR at a specific revision. */
export interface PRKey {
  host: string; // e.g. "github.com"
  owner: string;
  repo: string;
  pullNumber: number;
  baseSha: string;
  headSha: string;
}

/** Reference to a single diff hunk on a PR Changes page. */
export interface HunkRef {
  filePath: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  hunkHeader: string; // e.g. "@@ -120,8 +120,14 @@ fn ..."
  patchHash: string; // e.g. "sha1:3b7d..."
  domAnchorId?: string; // set by content script
  isVisible?: boolean;
}

/** Risk level assigned to a hunk annotation. */
export type RiskLevel = "low" | "medium" | "high";

/** Status of an annotation result. */
export type AnnotationStatus = "pending" | "running" | "ready" | "error";

/** AI-generated annotation for a single hunk. */
export interface Annotation {
  annotationId: string;
  prKey: PRKey;
  filePath: string;
  patchHash: string;
  summary: string;
  impact: string;
  risk: RiskLevel;
  confidence: number; // 0..1
  status: AnnotationStatus;
  generatedAt: string; // ISO-8601
  model: string;
}

/** Status of an analysis job. */
export type JobStatus = "queued" | "running" | "completed" | "failed";

/** A batch analysis job tracked by the daemon. */
export interface AnalysisJob {
  jobId: string;
  prKey: PRKey;
  scope: "visible" | "all";
  status: JobStatus;
  completed: number;
  total: number;
  failed: number;
  createdAt: string; // ISO-8601
}
