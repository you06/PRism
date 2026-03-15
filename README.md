# PRism

A personal GitHub code review assistant. PRism runs as a Chrome extension + localhost daemon, overlaying AI-generated hunk-level summaries directly on GitHub PR Changes pages.

## Repo layout

```
extension/   Chrome/Chromium extension (content script + service worker)
daemon/      Localhost HTTP daemon (GitHub API, LLM analysis, SQLite cache)
shared/      Shared TypeScript contracts, models, and API types
work/        Planning and work breakdown (not shipped, git-ignored)
```

This is a **pnpm workspace** — `shared`, `daemon`, and `extension` are workspace packages linked via `pnpm-workspace.yaml`.

## Prerequisites

| Requirement | Version | Check |
|-------------|---------|-------|
| Node.js | >= 20 | `node -v` |
| pnpm | >= 9 | `pnpm -v` |
| GitHub auth | `gh` CLI or `GITHUB_TOKEN` | `gh auth status` |
| Chrome or Chromium | Any recent version | Developer mode enabled |

**GitHub token resolution order** (daemon uses the first one found):
1. `GITHUB_TOKEN` env var
2. `GH_TOKEN` env var
3. `gh auth token` CLI output

If none are available, the daemon will fail to start. Easiest path: `gh auth login`.

## Install

```bash
git clone <this-repo> && cd PRism

# Install all workspace dependencies (shared + daemon + extension)
pnpm install

# Type-check everything
pnpm typecheck

# Build all packages
pnpm build
```

## Start the daemon

```bash
# Development mode (auto-reload on source changes)
pnpm --filter @prism/daemon dev

# — or production mode —
pnpm --filter @prism/daemon build
pnpm --filter @prism/daemon start
```

The daemon binds to **127.0.0.1:19280** by default (never `0.0.0.0`).

Verify it's running:

```bash
curl http://127.0.0.1:19280/v1/health
# → {"ok":true,"version":"0.1.0","capabilities":["query","jobs","cache"]}
```

### Daemon configuration

Config directory: `~/.config/prism/` (or `$XDG_CONFIG_HOME/prism/`)

| File | Purpose |
|------|---------|
| `config.json` | Optional. Override `host` and `port` (defaults: `127.0.0.1`, `19280`) |
| `pairing-secret` | Auto-generated on first start. 64-char hex token, file mode `0600`. |

Environment variables `PRISM_HOST` and `PRISM_PORT` override config file values.

## Load the Chrome extension

1. Build the extension: `pnpm --filter @prism/extension build`
2. Open Chrome → `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** → select the `extension/` directory (the one containing `manifest.json`)
5. PRism should appear in your extensions list

The extension only activates on `github.com/*/pull/*/files*` pages.

## Set the pairing secret

The daemon generates a pairing secret on first start at `~/.config/prism/pairing-secret`. The extension needs this token to authenticate requests.

**Temporary approach — set via Chrome DevTools console:**

1. Open `chrome://extensions`, find PRism, and note its extension ID
2. Open the service worker inspector (click "service worker" link on the PRism card)
3. In the DevTools console, run:

```js
chrome.storage.local.set({ pairingToken: "<paste-secret-here>" });
```

Replace `<paste-secret-here>` with the contents of `~/.config/prism/pairing-secret`:

```bash
cat ~/.config/prism/pairing-secret
```

4. Verify it was stored:

```js
chrome.storage.local.get("pairingToken", console.log);
```

> A proper settings UI is planned for a future work item.

## Run the smoke test

The smoke test exercises the daemon's full API surface against a real public GitHub PR.

```bash
# Terminal 1: start the daemon
pnpm --filter @prism/daemon dev

# Terminal 2: run smoke test
pnpm --filter @prism/daemon smoke-test
```

Expected output — all steps report PASS:

```
PRism smoke test
  daemon:  http://127.0.0.1:19280
  PR:      cli/cli#9530

  ✓ GET /v1/health: v0.1.0 capabilities=[query,jobs,cache]
  ✓ POST /v1/pr/register: ...
  ✓ POST /v1/annotations/query: ...
  ✓ POST /v1/analysis/jobs: ...
  ✓ GET /v1/analysis/jobs/:jobId (poll): ...
  ✓ GET /v1/annotations: ...

─── Summary ───
6/6 steps passed
```

Override the test PR via environment variables:

```bash
PRISM_SMOKE_OWNER=facebook PRISM_SMOKE_REPO=react PRISM_SMOKE_PR=27453 \
  pnpm --filter @prism/daemon smoke-test
```

## Manual QA with fixture PRs

Curated public PRs for testing (from `work/fixtures/fixtures.md`):

| Size | PR | Files | Hunks |
|------|----|-------|-------|
| Small | [cli/cli#9530](https://github.com/cli/cli/pull/9530) | ~2–5 | 3–8 |
| Medium | [facebook/react#27453](https://github.com/facebook/react/pull/27453) | ~10–25 | 20–50 |
| Large | [kubernetes/kubernetes#115000](https://github.com/kubernetes/kubernetes/pull/115000) | ~50–100+ | 80–200+ |

Full QA checklist: `work/qa-checklist.md`

## Extension entry points

| File | Role | Loaded by |
|------|------|-----------|
| `extension/manifest.json` | Manifest V3 declaration | Chrome |
| `extension/src/background.ts` | Service worker — single network boundary to localhost daemon | `manifest.json → background.service_worker` |
| `extension/src/content.ts` | Content script — page detection, hunk observation, UI rendering | `manifest.json → content_scripts` |
| `extension/src/index.ts` | Package entry — type re-exports for workspace validation only | `pnpm typecheck` |

## Security model

- The daemon binds to `127.0.0.1` — never exposed to the network.
- All API routes (except `GET /v1/health`) require an `X-PRism-Token` header matching `pairing-secret`.
- The extension stores the token in `chrome.storage.local` and includes it in every request.
- GitHub tokens stay in the daemon process — they never reach the extension or page context.
- Logs never include full patch content, tokens, or secrets.

## Troubleshooting

| Symptom | Card shows | Cause | Fix |
|---------|-----------|-------|-----|
| Daemon not running | **"Daemon is offline"** (gray card) | Extension cannot reach `127.0.0.1:19280` | Start the daemon: `pnpm --filter @prism/daemon dev` |
| Token mismatch | **"Pairing token not configured or invalid"** (yellow card) | `X-PRism-Token` doesn't match `pairing-secret` | Re-copy the token: `cat ~/.config/prism/pairing-secret` → paste into extension storage (see [Set the pairing secret](#set-the-pairing-secret)) |
| GitHub auth error | **"GitHub API error"** (red card) | `GITHUB_TOKEN` not set or expired | Run `gh auth login` or set `GITHUB_TOKEN`, then restart daemon |
| GitHub rate limit | **"Rate limited. Try again in Ns."** (yellow card) | GitHub API quota exhausted | Wait for the indicated reset time |
| Analysis failed | **"Analysis failed"** (red card) | LLM pipeline error for a specific hunk | Click **Retry** on the card |
| Smoke test: "Cannot read pairing secret" | N/A | Daemon was never started (no secret generated) | Start the daemon once first: `pnpm --filter @prism/daemon dev` |
| Smoke test: "Daemon unreachable" | N/A | Daemon isn't running or wrong port | Start the daemon in another terminal |
| Extension not injecting on PR page | No cards visible | Extension not loaded or not built | Rebuild: `pnpm --filter @prism/extension build`, then reload extension at `chrome://extensions` |
| `pnpm install` fails on `better-sqlite3` | N/A | Missing native build tools | Install build essentials: `sudo apt install build-essential python3` (Linux) or Xcode CLI tools (macOS) |

**Key points:**

- PRism failures never block normal GitHub diff reading — the extension uses panic-free error boundaries.
- `GET /v1/health` is always unauthenticated so the extension can detect daemon status without a valid token.
- Each degraded state has a visually distinct card style (gray / yellow / red) so you can tell at a glance what went wrong.

## Quick reference

```bash
# Full setup from scratch
pnpm install && pnpm build

# Start daemon (dev mode)
pnpm --filter @prism/daemon dev

# Run smoke test
pnpm --filter @prism/daemon smoke-test

# Read pairing secret
cat ~/.config/prism/pairing-secret

# Health check
curl http://127.0.0.1:19280/v1/health

# Type-check everything
pnpm typecheck

# Clean all build artifacts
pnpm clean
```

## Design

See [DESIGN.md](./DESIGN.md) for the full V1 design document.
