// ---------------------------------------------------------------------------
// PRism daemon — In-memory store (WORK12)
//
// Provides interfaces + in-memory implementations for:
//   - PR registry   (registered PRs with canonical hunks)
//   - Annotation store (hunk-level annotations keyed by headSha+file+hash)
//   - Job store     (analysis jobs with progress tracking)
//
// Interfaces are the persistence boundary — WORK13 will swap in SQLite
// behind them without touching route handlers or job processing.
// ---------------------------------------------------------------------------

import type { Annotation, AnalysisJob, PRKey } from "@prism/shared";
import type { PRMetadata } from "./github.js";
import type { CanonicalHunk } from "./hunk-canonicalizer.js";

// ---- Stored PR data --------------------------------------------------------

/** A PR that has been registered (GitHub data fetched + hunks parsed). */
export interface RegisteredPR {
  prId: string;
  prKey: PRKey;
  metadata: PRMetadata;
  canonicalHunks: CanonicalHunk[];
  fileCount: number;
  registeredAt: string;
}

// ---- Store interfaces (WORK13 persistence boundary) ------------------------

export interface PRRegistry {
  register(prId: string, data: RegisteredPR): void;
  get(prId: string): RegisteredPR | undefined;
  findByPR(
    owner: string,
    repo: string,
    pullNumber: number,
    headSha: string,
  ): RegisteredPR | undefined;
}

export interface AnnotationStore {
  get(
    headSha: string,
    filePath: string,
    patchHash: string,
  ): Annotation | undefined;
  set(headSha: string, annotation: Annotation): void;
  query(
    headSha: string,
    filters?: { filePath?: string; patchHash?: string },
  ): Annotation[];
}

export interface JobStore {
  create(job: AnalysisJob): void;
  get(jobId: string): AnalysisJob | undefined;
  update(
    jobId: string,
    updates: Partial<Pick<AnalysisJob, "status" | "completed" | "failed">>,
  ): void;
  failAllRunning(): number;
}

// ---- In-memory implementations ---------------------------------------------

export class InMemoryPRRegistry implements PRRegistry {
  private store = new Map<string, RegisteredPR>();
  private lookupIndex = new Map<string, RegisteredPR>();

  private lookupKey(owner: string, repo: string, pullNumber: number, headSha: string): string {
    return `${owner}/${repo}#${pullNumber}@${headSha}`;
  }

  register(prId: string, data: RegisteredPR): void {
    this.store.set(prId, data);
    this.lookupIndex.set(
      this.lookupKey(data.prKey.owner, data.prKey.repo, data.prKey.pullNumber, data.prKey.headSha),
      data,
    );
  }

  get(prId: string): RegisteredPR | undefined {
    return this.store.get(prId);
  }

  findByPR(
    owner: string,
    repo: string,
    pullNumber: number,
    headSha: string,
  ): RegisteredPR | undefined {
    return this.lookupIndex.get(this.lookupKey(owner, repo, pullNumber, headSha));
  }
}

export class InMemoryAnnotationStore implements AnnotationStore {
  private store = new Map<string, Annotation>();

  private key(headSha: string, filePath: string, patchHash: string): string {
    return `${headSha}\0${filePath}\0${patchHash}`;
  }

  get(
    headSha: string,
    filePath: string,
    patchHash: string,
  ): Annotation | undefined {
    return this.store.get(this.key(headSha, filePath, patchHash));
  }

  set(headSha: string, annotation: Annotation): void {
    this.store.set(
      this.key(headSha, annotation.filePath, annotation.patchHash),
      annotation,
    );
  }

  query(
    headSha: string,
    filters?: { filePath?: string; patchHash?: string },
  ): Annotation[] {
    const results: Annotation[] = [];
    const prefix = headSha + "\0";
    for (const [key, ann] of this.store) {
      if (!key.startsWith(prefix)) continue;
      if (filters?.filePath && ann.filePath !== filters.filePath) continue;
      if (filters?.patchHash && ann.patchHash !== filters.patchHash) continue;
      results.push(ann);
    }
    return results;
  }
}

export class InMemoryJobStore implements JobStore {
  private store = new Map<string, AnalysisJob>();

  create(job: AnalysisJob): void {
    this.store.set(job.jobId, { ...job });
  }

  get(jobId: string): AnalysisJob | undefined {
    return this.store.get(jobId);
  }

  update(
    jobId: string,
    updates: Partial<Pick<AnalysisJob, "status" | "completed" | "failed">>,
  ): void {
    const job = this.store.get(jobId);
    if (!job) return;
    if (updates.status !== undefined) job.status = updates.status;
    if (updates.completed !== undefined) job.completed = updates.completed;
    if (updates.failed !== undefined) job.failed = updates.failed;
  }

  failAllRunning(): number {
    let count = 0;
    for (const job of this.store.values()) {
      if (job.status === "running" || job.status === "queued") {
        job.status = "failed";
        count++;
      }
    }
    return count;
  }
}
