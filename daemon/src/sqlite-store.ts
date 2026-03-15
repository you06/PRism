// ---------------------------------------------------------------------------
// PRism daemon — SQLite-backed stores (WORK13)
//
// Persistent implementations of PRRegistry, AnnotationStore, and JobStore.
// Uses Node.js built-in node:sqlite (DatabaseSync) — no native addons needed.
//
// Invalidation rules (DESIGN.md §14):
//   - headSha change → entire PR namespace invalidated (old annotations cleared)
//   - Same headSha + changed patchHash → single hunk invalidated (natural: new key)
//
// Tables: pull_requests, hunks, annotations, analysis_jobs
// ---------------------------------------------------------------------------

import { DatabaseSync } from "node:sqlite";
import type { Annotation, AnalysisJob, PRKey } from "@prism/shared";
import type { PRMetadata } from "./github.js";
import type { CanonicalHunk } from "./hunk-canonicalizer.js";
import type {
  PRRegistry,
  AnnotationStore,
  JobStore,
  RegisteredPR,
} from "./store.js";

// ---- Schema bootstrap -------------------------------------------------------

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS pull_requests (
  pr_id         TEXT PRIMARY KEY,
  host          TEXT NOT NULL,
  owner         TEXT NOT NULL,
  repo          TEXT NOT NULL,
  pull_number   INTEGER NOT NULL,
  base_sha      TEXT NOT NULL,
  head_sha      TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  file_count    INTEGER NOT NULL,
  registered_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pr_lookup
  ON pull_requests (owner, repo, pull_number, head_sha);

CREATE TABLE IF NOT EXISTS hunks (
  pr_id       TEXT NOT NULL,
  file_path   TEXT NOT NULL,
  patch_hash  TEXT NOT NULL,
  old_start   INTEGER NOT NULL,
  old_lines   INTEGER NOT NULL,
  new_start   INTEGER NOT NULL,
  new_lines   INTEGER NOT NULL,
  hunk_header TEXT NOT NULL,
  lines_json  TEXT NOT NULL,
  PRIMARY KEY (pr_id, file_path, patch_hash)
);

CREATE TABLE IF NOT EXISTS annotations (
  annotation_id TEXT PRIMARY KEY,
  head_sha      TEXT NOT NULL,
  host          TEXT NOT NULL,
  owner         TEXT NOT NULL,
  repo          TEXT NOT NULL,
  pull_number   INTEGER NOT NULL,
  base_sha      TEXT NOT NULL,
  file_path     TEXT NOT NULL,
  patch_hash    TEXT NOT NULL,
  summary       TEXT NOT NULL,
  impact        TEXT NOT NULL,
  risk          TEXT NOT NULL,
  confidence    REAL NOT NULL,
  status        TEXT NOT NULL,
  generated_at  TEXT NOT NULL,
  model         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ann_lookup
  ON annotations (head_sha, file_path, patch_hash);

CREATE INDEX IF NOT EXISTS idx_ann_pr
  ON annotations (owner, repo, pull_number, head_sha);

CREATE TABLE IF NOT EXISTS analysis_jobs (
  job_id      TEXT PRIMARY KEY,
  host        TEXT NOT NULL,
  owner       TEXT NOT NULL,
  repo        TEXT NOT NULL,
  pull_number INTEGER NOT NULL,
  base_sha    TEXT NOT NULL,
  head_sha    TEXT NOT NULL,
  scope       TEXT NOT NULL,
  status      TEXT NOT NULL,
  completed   INTEGER NOT NULL DEFAULT 0,
  total       INTEGER NOT NULL DEFAULT 0,
  failed      INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_job_pr
  ON analysis_jobs (owner, repo, pull_number, head_sha, status);
`;

// ---- Database initialization ------------------------------------------------

export function openDatabase(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=OFF");
  db.exec(SCHEMA_SQL);
  return db;
}

// ---- Helper: row → object (strip null prototype) ----------------------------

function row<T>(r: unknown): T {
  return Object.assign({}, r) as T;
}

// ---- SQLite PRRegistry ------------------------------------------------------

interface PRRow {
  pr_id: string;
  host: string;
  owner: string;
  repo: string;
  pull_number: number;
  base_sha: string;
  head_sha: string;
  metadata_json: string;
  file_count: number;
  registered_at: string;
}

interface HunkRow {
  pr_id: string;
  file_path: string;
  patch_hash: string;
  old_start: number;
  old_lines: number;
  new_start: number;
  new_lines: number;
  hunk_header: string;
  lines_json: string;
}

export class SqlitePRRegistry implements PRRegistry {
  private stmtUpsertPR;
  private stmtUpsertHunk;
  private stmtGetPR;
  private stmtGetHunks;
  private stmtFindPR;
  private stmtDeleteOldPRs;
  private stmtDeleteOldHunks;
  private stmtDeleteOldAnnotations;

  constructor(private db: DatabaseSync) {
    this.stmtUpsertPR = db.prepare(`
      INSERT OR REPLACE INTO pull_requests
        (pr_id, host, owner, repo, pull_number, base_sha, head_sha, metadata_json, file_count, registered_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.stmtUpsertHunk = db.prepare(`
      INSERT OR REPLACE INTO hunks
        (pr_id, file_path, patch_hash, old_start, old_lines, new_start, new_lines, hunk_header, lines_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.stmtGetPR = db.prepare(`SELECT * FROM pull_requests WHERE pr_id = ?`);
    this.stmtGetHunks = db.prepare(`SELECT * FROM hunks WHERE pr_id = ?`);
    this.stmtFindPR = db.prepare(`
      SELECT * FROM pull_requests
      WHERE owner = ? AND repo = ? AND pull_number = ? AND head_sha = ?
      LIMIT 1
    `);
    this.stmtDeleteOldPRs = db.prepare(`
      DELETE FROM pull_requests
      WHERE owner = ? AND repo = ? AND pull_number = ? AND head_sha != ?
    `);
    this.stmtDeleteOldHunks = db.prepare(`
      DELETE FROM hunks WHERE pr_id IN (
        SELECT pr_id FROM pull_requests
        WHERE owner = ? AND repo = ? AND pull_number = ? AND head_sha != ?
      )
    `);
    this.stmtDeleteOldAnnotations = db.prepare(`
      DELETE FROM annotations
      WHERE owner = ? AND repo = ? AND pull_number = ? AND head_sha != ?
    `);
  }

  register(prId: string, data: RegisteredPR): void {
    const { prKey, metadata, canonicalHunks, fileCount, registeredAt } = data;

    // Invalidation: headSha change → clear old PR namespace
    // Delete old annotations first (before old hunks/PRs, since we reference owner/repo/pull)
    this.stmtDeleteOldAnnotations.run(
      prKey.owner,
      prKey.repo,
      prKey.pullNumber,
      prKey.headSha,
    );
    // Delete old hunks (via subquery on old PRs for same owner/repo/pull)
    this.stmtDeleteOldHunks.run(
      prKey.owner,
      prKey.repo,
      prKey.pullNumber,
      prKey.headSha,
    );
    // Delete old PR rows
    this.stmtDeleteOldPRs.run(
      prKey.owner,
      prKey.repo,
      prKey.pullNumber,
      prKey.headSha,
    );

    // Insert/replace the PR
    this.stmtUpsertPR.run(
      prId,
      prKey.host,
      prKey.owner,
      prKey.repo,
      prKey.pullNumber,
      prKey.baseSha,
      prKey.headSha,
      JSON.stringify(metadata),
      fileCount,
      registeredAt,
    );

    // Insert hunks
    for (const h of canonicalHunks) {
      this.stmtUpsertHunk.run(
        prId,
        h.filePath,
        h.patchHash,
        h.oldStart,
        h.oldLines,
        h.newStart,
        h.newLines,
        h.hunkHeader,
        JSON.stringify(h.lines),
      );
    }
  }

  get(prId: string): RegisteredPR | undefined {
    const prRow = this.stmtGetPR.get(prId) as PRRow | undefined;
    if (!prRow) return undefined;
    return this.hydrateRegisteredPR(row<PRRow>(prRow));
  }

  findByPR(
    owner: string,
    repo: string,
    pullNumber: number,
    headSha: string,
  ): RegisteredPR | undefined {
    const prRow = this.stmtFindPR.get(owner, repo, pullNumber, headSha) as
      | PRRow
      | undefined;
    if (!prRow) return undefined;
    return this.hydrateRegisteredPR(row<PRRow>(prRow));
  }

  private hydrateRegisteredPR(r: PRRow): RegisteredPR {
    const metadata: PRMetadata = JSON.parse(r.metadata_json);
    const hunkRows = this.stmtGetHunks.all(r.pr_id) as unknown as HunkRow[];
    const canonicalHunks: CanonicalHunk[] = hunkRows.map((h) => {
      const hr = row<HunkRow>(h);
      return {
        filePath: hr.file_path,
        oldStart: hr.old_start,
        oldLines: hr.old_lines,
        newStart: hr.new_start,
        newLines: hr.new_lines,
        hunkHeader: hr.hunk_header,
        patchHash: hr.patch_hash,
        lines: JSON.parse(hr.lines_json),
      };
    });

    return {
      prId: r.pr_id,
      prKey: {
        host: r.host,
        owner: r.owner,
        repo: r.repo,
        pullNumber: r.pull_number,
        baseSha: r.base_sha,
        headSha: r.head_sha,
      },
      metadata,
      canonicalHunks,
      fileCount: r.file_count,
      registeredAt: r.registered_at,
    };
  }
}

// ---- SQLite AnnotationStore -------------------------------------------------

interface AnnotationRow {
  annotation_id: string;
  head_sha: string;
  host: string;
  owner: string;
  repo: string;
  pull_number: number;
  base_sha: string;
  file_path: string;
  patch_hash: string;
  summary: string;
  impact: string;
  risk: string;
  confidence: number;
  status: string;
  generated_at: string;
  model: string;
}

export class SqliteAnnotationStore implements AnnotationStore {
  private stmtGet;
  private stmtUpsert;
  private stmtQueryAll;
  private stmtQueryByFile;
  private stmtQueryByHash;
  private stmtQueryByFileAndHash;

  constructor(private db: DatabaseSync) {
    this.stmtGet = db.prepare(`
      SELECT * FROM annotations
      WHERE head_sha = ? AND file_path = ? AND patch_hash = ?
      LIMIT 1
    `);
    this.stmtUpsert = db.prepare(`
      INSERT OR REPLACE INTO annotations
        (annotation_id, head_sha, host, owner, repo, pull_number, base_sha,
         file_path, patch_hash, summary, impact, risk, confidence, status,
         generated_at, model)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.stmtQueryAll = db.prepare(`
      SELECT * FROM annotations WHERE head_sha = ?
    `);
    this.stmtQueryByFile = db.prepare(`
      SELECT * FROM annotations WHERE head_sha = ? AND file_path = ?
    `);
    this.stmtQueryByHash = db.prepare(`
      SELECT * FROM annotations WHERE head_sha = ? AND patch_hash = ?
    `);
    this.stmtQueryByFileAndHash = db.prepare(`
      SELECT * FROM annotations
      WHERE head_sha = ? AND file_path = ? AND patch_hash = ?
    `);
  }

  get(
    headSha: string,
    filePath: string,
    patchHash: string,
  ): Annotation | undefined {
    const r = this.stmtGet.get(headSha, filePath, patchHash) as
      | AnnotationRow
      | undefined;
    if (!r) return undefined;
    return this.hydrateAnnotation(row<AnnotationRow>(r));
  }

  set(headSha: string, annotation: Annotation): void {
    const a = annotation;
    this.stmtUpsert.run(
      a.annotationId,
      headSha,
      a.prKey.host,
      a.prKey.owner,
      a.prKey.repo,
      a.prKey.pullNumber,
      a.prKey.baseSha,
      a.filePath,
      a.patchHash,
      a.summary,
      a.impact,
      a.risk,
      a.confidence,
      a.status,
      a.generatedAt,
      a.model,
    );
  }

  query(
    headSha: string,
    filters?: { filePath?: string; patchHash?: string },
  ): Annotation[] {
    let rows: AnnotationRow[];
    if (filters?.filePath && filters?.patchHash) {
      rows = this.stmtQueryByFileAndHash.all(
        headSha,
        filters.filePath,
        filters.patchHash,
      ) as unknown as AnnotationRow[];
    } else if (filters?.filePath) {
      rows = this.stmtQueryByFile.all(headSha, filters.filePath) as unknown as AnnotationRow[];
    } else if (filters?.patchHash) {
      rows = this.stmtQueryByHash.all(headSha, filters.patchHash) as unknown as AnnotationRow[];
    } else {
      rows = this.stmtQueryAll.all(headSha) as unknown as AnnotationRow[];
    }
    return rows.map((r) => this.hydrateAnnotation(row<AnnotationRow>(r)));
  }

  private hydrateAnnotation(r: AnnotationRow): Annotation {
    return {
      annotationId: r.annotation_id,
      prKey: {
        host: r.host,
        owner: r.owner,
        repo: r.repo,
        pullNumber: r.pull_number,
        baseSha: r.base_sha,
        headSha: r.head_sha,
      },
      filePath: r.file_path,
      patchHash: r.patch_hash,
      summary: r.summary,
      impact: r.impact,
      risk: r.risk as Annotation["risk"],
      confidence: r.confidence,
      status: r.status as Annotation["status"],
      generatedAt: r.generated_at,
      model: r.model,
    };
  }
}

// ---- SQLite JobStore --------------------------------------------------------

interface JobRow {
  job_id: string;
  host: string;
  owner: string;
  repo: string;
  pull_number: number;
  base_sha: string;
  head_sha: string;
  scope: string;
  status: string;
  completed: number;
  total: number;
  failed: number;
  created_at: string;
}

export class SqliteJobStore implements JobStore {
  private stmtInsert;
  private stmtGet;
  private stmtUpdateStatus;
  private stmtUpdateCompleted;
  private stmtUpdateFailed;
  private stmtFindActive;

  constructor(private db: DatabaseSync) {
    this.stmtInsert = db.prepare(`
      INSERT INTO analysis_jobs
        (job_id, host, owner, repo, pull_number, base_sha, head_sha,
         scope, status, completed, total, failed, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.stmtGet = db.prepare(`SELECT * FROM analysis_jobs WHERE job_id = ?`);
    this.stmtUpdateStatus = db.prepare(`
      UPDATE analysis_jobs SET status = ? WHERE job_id = ?
    `);
    this.stmtUpdateCompleted = db.prepare(`
      UPDATE analysis_jobs SET completed = ? WHERE job_id = ?
    `);
    this.stmtUpdateFailed = db.prepare(`
      UPDATE analysis_jobs SET failed = ? WHERE job_id = ?
    `);
    this.stmtFindActive = db.prepare(`
      SELECT * FROM analysis_jobs
      WHERE owner = ? AND repo = ? AND pull_number = ? AND head_sha = ?
        AND status IN ('queued', 'running')
      LIMIT 1
    `);
  }

  create(job: AnalysisJob): void {
    this.stmtInsert.run(
      job.jobId,
      job.prKey.host,
      job.prKey.owner,
      job.prKey.repo,
      job.prKey.pullNumber,
      job.prKey.baseSha,
      job.prKey.headSha,
      job.scope,
      job.status,
      job.completed,
      job.total,
      job.failed,
      job.createdAt,
    );
  }

  get(jobId: string): AnalysisJob | undefined {
    const r = this.stmtGet.get(jobId) as JobRow | undefined;
    if (!r) return undefined;
    return this.hydrateJob(row<JobRow>(r));
  }

  update(
    jobId: string,
    updates: Partial<Pick<AnalysisJob, "status" | "completed" | "failed">>,
  ): void {
    if (updates.status !== undefined) {
      this.stmtUpdateStatus.run(updates.status, jobId);
    }
    if (updates.completed !== undefined) {
      this.stmtUpdateCompleted.run(updates.completed, jobId);
    }
    if (updates.failed !== undefined) {
      this.stmtUpdateFailed.run(updates.failed, jobId);
    }
  }

  /** Find an active (queued/running) job for the given PR. */
  findActive(
    owner: string,
    repo: string,
    pullNumber: number,
    headSha: string,
  ): AnalysisJob | undefined {
    const r = this.stmtFindActive.get(owner, repo, pullNumber, headSha) as
      | JobRow
      | undefined;
    if (!r) return undefined;
    return this.hydrateJob(row<JobRow>(r));
  }

  private hydrateJob(r: JobRow): AnalysisJob {
    return {
      jobId: r.job_id,
      prKey: {
        host: r.host,
        owner: r.owner,
        repo: r.repo,
        pullNumber: r.pull_number,
        baseSha: r.base_sha,
        headSha: r.head_sha,
      },
      scope: r.scope as AnalysisJob["scope"],
      status: r.status as AnalysisJob["status"],
      completed: r.completed,
      total: r.total,
      failed: r.failed,
      createdAt: r.created_at,
    };
  }
}
