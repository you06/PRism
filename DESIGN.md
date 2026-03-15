# PRism V1 Design

## 1. Product Goal
PRism is a GitHub code review assistant built for **personal use**.
It runs on the GitHub PR Changes page, placing AI-generated **natural language change summaries** near diff hunks to help reviewers build understanding faster.

V1 design principles:
- **Private by default**: never writes comments / reviews / checks to GitHub
- **Overlay, not replace**: preserves the native GitHub review flow; only adds UI enhancements
- **Local-first**: analysis results are stored locally first
- **Hunk-first**: start with hunk-level summaries, then decide whether to dig deeper

## 2. V1 Scope
### In scope
- Chrome / Chromium extension
- GitHub PR Changes page (`/pull/<n>/files` / changes diff page)
- Natural language summaries for visible hunks
- Localhost daemon providing analysis / cache API
- In-memory cache + job queue
- Manual retry, refresh, expand details

### Out of scope
- GitHub comments / reviews / checks
- Multi-user result sharing
- Line-level suggestion / auto-fix patch
- Long-term indexing of entire repos
- GitHub Enterprise multi-instance support (V1 targets github.com only)
- Firefox / Safari

## 3. Why Extension + Localhost
This combination best fits a "for your eyes only" review workflow:
- The extension handles **rendering close to the GitHub UI**
- The localhost daemon handles **GitHub API calls, LLM/agent invocations, caching, and token custody**
- The coding agent does not need to be directly exposed to the page; the page only consumes structured results

## 4. MVP Architecture Diagram
```text
┌────────────────────────── GitHub PR Changes Page ──────────────────────────┐
│  GitHub DOM                                                                │
│   └─ Content Script                                                        │
│       ├─ parse PR context / visible hunks                                  │
│       ├─ render loading / summary cards                                    │
│       └─ send messages to background                                       │
└─────────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
                       ┌─────────────────────────┐
                       │ Extension Background    │
                       │ Service Worker          │
                       │ - network gateway       │
                       │ - local cache           │
                       │ - job polling           │
                       └────────────┬────────────┘
                                    │ HTTP (127.0.0.1 only)
                                    ▼
                    ┌───────────────────────────────────┐
                    │ PRism Local Daemon               │
                    │ - request auth / pairing         │
                    │ - GitHub fetcher                 │
                    │ - hunk canonicalizer             │
                    │ - analysis scheduler             │
                    │ - result store (in-memory)       │
                    └────────────┬──────────────────────┘
                                 │
                ┌────────────────┴─────────────────┐
                ▼                                  ▼
       ┌──────────────────┐               ┌────────────────────┐
       │ GitHub API / diff│               │ LLM / coding agent │
       │ - PR metadata    │               │ - summary JSON     │
       │ - files / patches│               │ - risk/confidence  │
       └──────────────────┘               └────────────────────┘
```

## 5. Suggested Directory Layout
```text
PRism/
  DESIGN.md
  .gitignore
  extension/
  daemon/
  shared/
  work/
```
V1 starts by locking down the design and work breakdown; during implementation, `shared/` holds contracts and types to prevent extension / daemon drift.

## 6. Core Component Responsibilities
### 6.1 Content Script
- Detect whether the current page is a GitHub PR Changes page
- Extract `owner / repo / pullNumber / baseSha / headSha`
- Extract visible files / hunks / anchors / line ranges from the DOM
- Render PRism summary cards near hunks
- Handle user actions: refresh, retry, expand details

### 6.2 Background Service Worker
- Serves as the extension's sole network gateway
- Communicates with the localhost daemon
- Maintains tab-level request deduplication
- Caches the most recent query's annotation results
- Handles polling / SSE (V1 uses polling only)

### 6.3 Local Daemon
- Binds only to `127.0.0.1`
- Relies on an authenticated `gh` CLI (reads credentials via `gh auth token`)
- Fetches PR files / patches / raw diff / file contents
- Canonicalizes hunk keys
- Schedules LLM / coding agent analysis
- Stores results in memory (cleared on daemon restart)

### 6.4 Analysis Engine
V1 uses a two-tier approach:
- **Default path**: standard LLM for fast hunk-level summary generation
- **Upgrade path**: heavier coding agent invoked only when the user clicks "Explain deeper"

This keeps cost, latency, and complexity manageable.

## 7. Data Model
### 7.1 PRKey
```json
{
  "host": "github.com",
  "owner": "tikv",
  "repo": "tikv",
  "pullNumber": 19338,
  "baseSha": "abc123",
  "headSha": "def456"
}
```

### 7.2 HunkRef
```json
{
  "filePath": "src/storage/mod.rs",
  "oldStart": 120,
  "oldLines": 8,
  "newStart": 120,
  "newLines": 14,
  "hunkHeader": "@@ -120,8 +120,14 @@ fn ...",
  "patchHash": "sha1:3b7d...",
  "domAnchorId": "prism-hunk-12",
  "isVisible": true
}
```

### 7.3 Annotation
```json
{
  "annotationId": "ann_01...",
  "prKey": "...",
  "filePath": "src/storage/mod.rs",
  "patchHash": "sha1:3b7d...",
  "summary": "This change moves the retry decision closer to the write path and adds a fast-return branch for empty batches.",
  "impact": "Makes error handling easier to follow during review.",
  "risk": "medium",
  "confidence": 0.86,
  "status": "ready",
  "generatedAt": "2026-03-15T03:00:00Z",
  "model": "gpt-4.1-mini"
}
```

### 7.4 AnalysisJob
```json
{
  "jobId": "job_01...",
  "prKey": "...",
  "scope": "visible",
  "status": "running",
  "completed": 4,
  "total": 11,
  "createdAt": "2026-03-15T03:00:00Z"
}
```

## 8. Hunk Alignment Strategy (Most Critical for V1)
The real challenge is not "calling the model" but "reliably placing results back onto the correct hunk."

V1 uses the following key:
`headSha + filePath + normalizedHunkHeader + normalizedPatchHash`

### 8.1 DOM-Side Extraction
The content script extracts from the page:
- file path
- hunk header
- patch lines (current hunk only)
- GitHub line numbers / anchors
- the hunk's container node in the page

### 8.2 Canonicalization
Normalize patch lines:
- Strip GitHub UI decoration characters
- Preserve `+ / - / context` line types
- Unify line endings and whitespace
- Generate `patchHash`

### 8.3 Server-Side Alignment
The daemon performs a second pass using the canonical patch from the GitHub API:
1. Patch hash matches exactly → direct hit
2. Same `filePath + hunkHeader` but slight hash difference → fuzzy match
3. Both fail → fall back to file-level summary (never mis-attach to the wrong hunk)

## 9. Page Workflow
1. User opens a GitHub PR Changes page
2. Content script identifies the current PR and listens for DOM updates
3. Collects visible hunks via `IntersectionObserver`
4. Background calls `POST /v1/annotations/query`
5. Daemon returns:
   - Cached annotations
   - Missing hunks
   - Whether a job has been created
6. Content script renders available results first; missing items show a loading placeholder
7. Background polls job status
8. After the job completes, annotations are re-fetched and the UI is updated

## 10. Extension Internal Message Design
```ts
type PrismMessage =
  | { type: "PR_CONTEXT_UPDATED"; pr: PRKey; visibleHunks: HunkRef[] }
  | { type: "REQUEST_VISIBLE_ANNOTATIONS"; pr: PRKey; visibleHunks: HunkRef[] }
  | { type: "ANNOTATIONS_UPDATED"; annotations: Annotation[] }
  | { type: "JOB_STATUS_UPDATED"; jobId: string; status: string; completed: number; total: number }
  | { type: "RETRY_HUNK"; pr: PRKey; hunk: HunkRef };
```

## 11. Localhost API Design
### 11.1 Transport / Auth
- Daemon listens only on `127.0.0.1:<port>`
- Extension requests include headers:
  - `X-PRism-Client: extension`
  - `X-PRism-Token: <pairing-secret>`
- The pairing secret is generated by the daemon on first run and manually pasted into extension settings (simple and reliable for V1)

### 11.2 Endpoints
#### `GET /v1/health`
Used by the extension at startup to probe whether the daemon is online.

**Response**
```json
{
  "ok": true,
  "version": "0.1.0",
  "capabilities": ["query", "jobs", "cache"]
}
```

#### `POST /v1/pr/register`
Registers the current PR context so the daemon can use `headSha` as a cache namespace.

**Request**
```json
{
  "pr": {
    "host": "github.com",
    "owner": "tikv",
    "repo": "tikv",
    "pullNumber": 19338,
    "baseSha": "abc123",
    "headSha": "def456",
    "url": "https://github.com/tikv/tikv/pull/19338/files"
  }
}
```

**Response**
```json
{
  "prId": "github.com/tikv/tikv#19338@def456",
  "status": "ready"
}
```

#### `POST /v1/annotations/query`
Batch-queries annotations for visible hunks; the server may also enqueue missing items.

**Request**
```json
{
  "pr": { "host": "github.com", "owner": "tikv", "repo": "tikv", "pullNumber": 19338, "baseSha": "abc123", "headSha": "def456" },
  "visibleHunks": [
    {
      "filePath": "src/storage/mod.rs",
      "oldStart": 120,
      "oldLines": 8,
      "newStart": 120,
      "newLines": 14,
      "hunkHeader": "@@ -120,8 +120,14 @@ fn ...",
      "patchHash": "sha1:3b7d...",
      "domAnchorId": "prism-hunk-12"
    }
  ],
  "enqueueMissing": true
}
```

**Response**
```json
{
  "annotations": [
    {
      "filePath": "src/storage/mod.rs",
      "patchHash": "sha1:3b7d...",
      "summary": "...",
      "impact": "...",
      "risk": "medium",
      "confidence": 0.86,
      "status": "ready"
    }
  ],
  "missing": [
    {
      "filePath": "src/storage/mod.rs",
      "patchHash": "sha1:9af2..."
    }
  ],
  "job": {
    "jobId": "job_01...",
    "status": "queued"
  }
}
```

#### `POST /v1/analysis/jobs`
Explicitly creates an analysis job. Used for "analyze visible / retry / explain deeper."

**Request**
```json
{
  "pr": { "host": "github.com", "owner": "tikv", "repo": "tikv", "pullNumber": 19338, "baseSha": "abc123", "headSha": "def456" },
  "scope": "visible",
  "targets": [
    {
      "filePath": "src/storage/mod.rs",
      "patchHash": "sha1:3b7d..."
    }
  ],
  "priority": "interactive",
  "force": false,
  "depth": "summary"
}
```

**Response**
```json
{
  "jobId": "job_01...",
  "status": "queued"
}
```

#### `GET /v1/analysis/jobs/:jobId`
Queries job progress.

**Response**
```json
{
  "jobId": "job_01...",
  "status": "running",
  "completed": 4,
  "total": 11,
  "failed": 0
}
```

#### `GET /v1/annotations`
Fetches the latest results by PR / file / patchHash, used for refreshing after job completion.

**Query**
- `owner`
- `repo`
- `pullNumber`
- `headSha`
- `filePath` (optional)
- `patchHash` (optional)

**Response**
```json
{
  "annotations": [
    {
      "annotationId": "ann_01...",
      "filePath": "src/storage/mod.rs",
      "patchHash": "sha1:3b7d...",
      "summary": "...",
      "impact": "...",
      "risk": "medium",
      "confidence": 0.86,
      "status": "ready"
    }
  ]
}
```

## 12. GitHub Data Fetching Strategy
V1 does not require a local repo checkout.
The daemon fetches directly via the GitHub API / raw diff:
- PR metadata
- Changed files
- Patch text
- Base / head file content (when needed)

This way the extension only handles UI; the GitHub token stays in the daemon.

If deeper repo-aware analysis is needed later, an optional `repo binding` (GitHub repo → local path) can be added.

## 13. Analysis Pipeline
### 13.1 Summary Mode (default)
Input:
- PR title / description (optional)
- File path
- Hunk patch
- Context snippet

Output as fixed JSON:
- `summary`
- `impact`
- `risk`
- `confidence`

### 13.2 Deep Mode (deferred)
Triggered only when the user clicks "Explain deeper":
- Allows longer context
- Allows coding agent / tool-use
- Results are displayed in an expanded details panel, not overlaid on the short summary

## 14. Cache Design
The daemon uses in-memory Maps keyed by logical collections:
- `pull_requests`
- `hunks`
- `annotations`
- `analysis_jobs`

Primary lookup keys:
- `(owner, repo, pull_number, head_sha)`
- `(file_path, patch_hash)`
- `(job_id)`

Invalidation rules:
- `headSha` changes → the entire PR namespace is invalidated
- Same `headSha` but patch hash changes → that single hunk is invalidated

Note: all cached data is ephemeral and cleared on daemon restart.

## 15. Security & Privacy
- Daemon listens only on `127.0.0.1`
- Tokens never enter the content script / page context
- Extension accesses the daemon exclusively through the background service worker
- V1 writes no data to GitHub
- Logs do not persist full patches by default, minimizing the local attack surface

## 16. Why This V1 Approach Makes Sense
Compared to a GitHub comment / check approach:
- Zero disruption to others
- Better fit for a personal review flow
- Can evolve incrementally without being blocked by GitHub's UI / permission model

Compared to a standalone web app:
- User never leaves GitHub
- Diff and explanation are naturally co-located
- Minimal interaction cost

## 17. V1 Acceptance Criteria
- Can identify visible hunks on a GitHub PR Changes page
- Can retrieve structured annotations from the localhost daemon
- Can display summary cards near hunks
- Does not mis-attach stale results after a PR update (`headSha` change)
- Degrades gracefully with a user-visible notice when the daemon is offline

## 18. Engineering Structure & Entry Points

### 18.1 Repo Structure
```text
PRism/
  DESIGN.md
  README.md
  extension/
  daemon/
  shared/
  work/
```

| Path | Purpose |
|------|---------|
| `extension/` | Chrome/Chromium extension: content script, background service worker, inline UI |
| `daemon/` | Localhost HTTP daemon: GitHub fetch, analysis pipeline, in-memory cache |
| `shared/` | Contracts, models, and hash logic shared between extension and daemon |
| `work/` | Planning, fixtures, QA checklists, task breakdowns |

### 18.2 Entry Points
| File | Role | Description |
|------|------|-------------|
| `extension/manifest.json` | Extension manifest | Defines content script, background, and permission boundaries |
| `extension/src/content.ts` | Page-side entry point | PR page detection, hunk extraction, card rendering |
| `extension/src/background.ts` | Extension backend entry point | Localhost API gateway, request dedup, caching, job polling |
| `daemon/src/index.ts` | Daemon entry point | HTTP server, auth, route assembly, store initialization |
| `daemon/src/smoke-test.ts` | Operational verification entry point | Runs a smoke test of daemon APIs against a real public PR |

### 18.3 Runtime Files
PRism runtime files are stored under a unified path:
- `~/.config/prism/config.json`
- `~/.config/prism/pairing-secret`

Where:
- `config.json` holds daemon configuration overrides
- `pairing-secret` is used for extension → daemon authentication
