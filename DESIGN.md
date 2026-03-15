# PRism V1 Design

## 1. 产品目标
PRism 是一个给 **自己** 用的 GitHub code review 助手。
它运行在 GitHub PR Changes 页面，把 AI 生成的 **自然语言 change summary** 贴在 diff hunk 附近，帮助 reviewer 更快建立理解。

V1 的设计原则：
- **Private by default**：不向 GitHub 写 comment / review / check
- **Overlay, not replace**：保留 GitHub 原生 review 流程，只做 UI 增强
- **Local-first**：分析结果优先保存在本机
- **Hunk-first**：先做 hunk-level summary，再决定是否深挖

## 2. V1 范围
### In scope
- Chrome / Chromium extension
- GitHub PR Changes 页面（`/pull/<n>/files` / changes diff 页面）
- visible hunks 的自然语言 summary
- localhost daemon 提供 analysis / cache API
- 本地缓存 + job queue
- 手动 retry、refresh、expand details

### Out of scope
- GitHub comments / reviews / checks
- 多人共享结果
- 行级 suggestion / auto-fix patch
- 对整个 repo 做长期 indexing
- GitHub Enterprise 多实例支持（V1 先只做 github.com）
- Firefox / Safari

## 3. 为什么选 extension + localhost
这个组合最适合“只给自己看”的 review workflow：
- extension 负责 **贴近 GitHub UI 渲染**
- localhost daemon 负责 **GitHub API、LLM/agent 调用、缓存、token 保管**
- coding agent 不需要直接暴露给页面；页面只消费结构化结果

## 4. MVP 架构图
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
                    │ - result store (SQLite)          │
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

## 5. 目录建议
```text
PRism/
  DESIGN.md
  .gitignore
  extension/
  daemon/
  shared/
  work/
```
V1 先把设计和 work breakdown 定下来；真正实现时，`shared/` 放 contract 和 types，避免 extension / daemon drift。

## 6. 核心组件职责
### 6.1 Content Script
- 识别当前是不是 GitHub PR Changes 页面
- 提取 `owner / repo / pullNumber / baseSha / headSha`
- 从 DOM 提取 visible files / hunks / anchors / line ranges
- 在 hunk 附近渲染 PRism summary card
- 处理用户动作：refresh、retry、expand details

### 6.2 Background Service Worker
- 作为 extension 内部唯一网络出口
- 和 localhost daemon 通信
- 维护 tab 级别的 request 去重
- 缓存最近一次 query 的 annotation 结果
- 负责 polling / SSE（V1 先 polling 即可）

### 6.3 Local Daemon
- 只绑定 `127.0.0.1`
- 保管 GitHub token / `gh auth token` 读取逻辑
- 拉取 PR files / patches / raw diff / file contents
- 规范化 hunk key
- 调度 LLM / coding agent 分析
- 把结果持久化到 SQLite

### 6.4 Analysis Engine
V1 建议分层：
- **默认路径**：普通 LLM，快速生成 hunk-level summary
- **升级路径**：用户点“Explain deeper”时，才用更重的 coding agent

这样成本、延迟、复杂度都更可控。

## 7. 数据模型
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

## 8. Hunk 对齐策略（V1 最关键）
真正难点不是“调用模型”，而是“把结果稳稳贴回正确的 hunk”。

V1 建议使用以下 key：
`headSha + filePath + normalizedHunkHeader + normalizedPatchHash`

### 8.1 DOM 侧提取
Content script 从页面提取：
- file path
- hunk header
- patch lines（仅当前 hunk）
- GitHub 行号 / anchor
- hunk 在页面上的容器节点

### 8.2 规范化
对 patch lines 做 normalize：
- 去掉 GitHub UI 装饰字符
- 保留 `+ / - / context` 行类型
- 统一换行和空白
- 生成 `patchHash`

### 8.3 服务端对齐
daemon 再用 GitHub API 返回的 canonical patch 做二次确认：
1. patch hash 完全一致 → 直接命中
2. 同 `filePath + hunkHeader`，但 hash 轻微差异 → 做 fuzzy match
3. 都失败 → 退化到 file-level summary（不要错贴到别的 hunk）

## 9. 页面工作流
1. 用户打开 GitHub PR Changes 页面
2. content script 识别当前 PR，并监听 DOM 更新
3. 通过 `IntersectionObserver` 收集 visible hunks
4. background 调用 `POST /v1/annotations/query`
5. daemon 返回：
   - 已缓存 annotations
   - 缺失 hunks
   - 是否已创建 job
6. content script 先渲染已有结果；缺失项显示 loading placeholder
7. background 轮询 job 状态
8. job 完成后重新拉取 annotations 并更新 UI

## 10. Extension 内部消息设计
```ts
type PrismMessage =
  | { type: "PR_CONTEXT_UPDATED"; pr: PRKey; visibleHunks: HunkRef[] }
  | { type: "REQUEST_VISIBLE_ANNOTATIONS"; pr: PRKey; visibleHunks: HunkRef[] }
  | { type: "ANNOTATIONS_UPDATED"; annotations: Annotation[] }
  | { type: "JOB_STATUS_UPDATED"; jobId: string; status: string; completed: number; total: number }
  | { type: "RETRY_HUNK"; pr: PRKey; hunk: HunkRef };
```

## 11. Localhost API 设计
### 11.1 Transport / Auth
- daemon 只监听 `127.0.0.1:<port>`
- Extension 请求头带：
  - `X-PRism-Client: extension`
  - `X-PRism-Token: <pairing-secret>`
- pairing secret 首次由 daemon 生成，手动粘贴到 extension settings（V1 简单可靠）

### 11.2 Endpoints
#### `GET /v1/health`
用于 extension 启动探测 daemon 是否在线。

**Response**
```json
{
  "ok": true,
  "version": "0.1.0",
  "capabilities": ["query", "jobs", "cache"]
}
```

#### `POST /v1/pr/register`
注册当前 PR 上下文，让 daemon 可基于 `headSha` 做 cache namespace。

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
批量查询 visible hunks 的 annotation；服务端可以顺便把缺失项放入 queue。

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
显式创建一个分析 job。用于 “analyze visible / retry / explain deeper”。

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
查询 job 进度。

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
按 PR / file / patchHash 拉取最新结果，给 job 完成后的刷新使用。

**Query**
- `owner`
- `repo`
- `pullNumber`
- `headSha`
- `filePath`（可选）
- `patchHash`（可选）

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

## 12. GitHub 数据获取策略
V1 不要求本地 repo checkout。
daemon 直接通过 GitHub API / raw diff 拉：
- PR metadata
- changed files
- patch text
- base / head file content（需要时）

这样 extension 只负责 UI；GitHub token 也只留在 daemon。

如果后续要更深的 repo-aware analysis，再加可选的 `repo binding`（GitHub repo → local path）。

## 13. Analysis pipeline
### 13.1 Summary mode（默认）
输入：
- PR title / description（可选）
- file path
- hunk patch
- 上下文 snippet

输出固定 JSON：
- `summary`
- `impact`
- `risk`
- `confidence`

### 13.2 Deep mode（延后）
只有当用户点击 “Explain deeper” 时才触发：
- 允许更长上下文
- 允许 coding agent / tool-use
- 结果展示在扩展的 details panel 里，不直接覆盖简短 summary

## 14. Cache 设计
建议 SQLite 表：
- `pull_requests`
- `hunks`
- `annotations`
- `analysis_jobs`

核心索引：
- `(owner, repo, pull_number, head_sha)`
- `(file_path, patch_hash)`
- `(job_id)`

失效规则：
- `headSha` 变化 → 整个 PR namespace 失效
- 同 `headSha` 下 patch hash 变化 → 单 hunk 失效

## 15. 安全与隐私
- daemon 仅监听 `127.0.0.1`
- token 不进入 content script / page context
- extension 通过 background 统一访问 daemon
- V1 不向 GitHub 写任何数据
- 日志默认不保存完整 patch，避免不必要的本地泄露面

## 16. 为什么这套 V1 合理
相对 GitHub comment / check 方案：
- 完全不打扰别人
- 更适合个人 review flow
- 可渐进演化，不被 GitHub UI/权限模型卡死

相对纯网页 app：
- 用户不需要离开 GitHub
- diff 和解释天然共视
- 交互成本最低

## 17. V1 验收标准
- 能在 GitHub PR Changes 页面识别 visible hunks
- 能从 localhost daemon 取到结构化 annotation
- 能在 hunk 附近显示 summary card
- PR 更新后（`headSha` 变化）不会错贴旧结果
- daemon 不在线时，extension 能优雅降级并提示

## 18. 工程结构与运行入口

### 18.1 Repo 结构
```text
PRism/
  DESIGN.md
  README.md
  extension/
  daemon/
  shared/
  work/
```

| 路径 | 作用 |
|------|------|
| `extension/` | Chrome/Chromium extension：content script、background service worker、inline UI |
| `daemon/` | localhost HTTP daemon：GitHub fetch、analysis pipeline、SQLite cache |
| `shared/` | extension / daemon 共用的 contracts、models、hash 逻辑 |
| `work/` | 规划、fixtures、QA checklist、任务拆分 |

### 18.2 运行入口
| 文件 | 角色 | 说明 |
|------|------|------|
| `extension/manifest.json` | Extension manifest | 定义 content script、background、权限边界 |
| `extension/src/content.ts` | 页面侧入口 | PR 页面检测、hunk 提取、卡片渲染 |
| `extension/src/background.ts` | 扩展后端入口 | localhost API gateway、请求去重、缓存、job polling |
| `daemon/src/index.ts` | Daemon 入口 | HTTP server、鉴权、路由装配、store 初始化 |
| `daemon/src/smoke-test.ts` | 操作验证入口 | 用真实 public PR 跑一遍 daemon API smoke test |

### 18.3 运行时文件
PRism 的运行时文件统一放在：
- `~/.config/prism/config.json`
- `~/.config/prism/pairing-secret`
- `~/.config/prism/prism.db`

其中：
- `config.json` 用于 daemon 配置覆盖
- `pairing-secret` 用于 extension → daemon 鉴权
- `prism.db` 是 SQLite 持久化缓存 / job store
