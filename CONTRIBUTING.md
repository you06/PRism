# Contributing to PRism

This file is for development workflow.
If you just want to run PRism, use [README.md](./README.md).
If you want architecture details, use [DESIGN.md](./DESIGN.md).

## Local development setup

### Requirements

- Node.js >= 20
- pnpm >= 9
- Chrome / Chromium
- GitHub auth via `gh auth login` or `GITHUB_TOKEN` / `GH_TOKEN`

### Install

```bash
pnpm install
pnpm typecheck
pnpm build
```

## Repo layout

```text
extension/   Chrome extension
daemon/      Local daemon
shared/      Shared contracts/models/hash logic
work/        Planning docs, fixtures, QA checklists
```

## Main commands

### Whole repo

```bash
pnpm build
pnpm typecheck
pnpm clean
```

### Daemon

```bash
pnpm --filter @prism/daemon dev
pnpm --filter @prism/daemon build
pnpm --filter @prism/daemon start
pnpm --filter @prism/daemon typecheck
pnpm --filter @prism/daemon smoke-test
```

### Extension

```bash
pnpm --filter @prism/extension build
pnpm --filter @prism/extension typecheck
```

## Runtime files

PRism stores runtime files here:

- `~/.config/prism/config.json`
- `~/.config/prism/pairing-secret`
- `~/.config/prism/prism.db`

## Development workflow

1. Start the daemon:

```bash
pnpm --filter @prism/daemon dev
```

2. Build the extension:

```bash
pnpm --filter @prism/extension build
```

3. Load `extension/` in `chrome://extensions`
4. Set `pairingToken` in the extension service worker console:

```js
chrome.storage.local.set({ pairingToken: "<paste-secret-here>" });
```

5. Open a GitHub PR `.../pull/<n>/files`
6. Reload the extension after TypeScript output changes if needed

## Smoke test

The smoke test exercises the daemon API end-to-end.

```bash
# terminal 1
pnpm --filter @prism/daemon dev

# terminal 2
pnpm --filter @prism/daemon smoke-test
```

Use a different public PR if needed:

```bash
PRISM_SMOKE_OWNER=facebook PRISM_SMOKE_REPO=react PRISM_SMOKE_PR=27453 \
  pnpm --filter @prism/daemon smoke-test
```

## Manual QA fixtures

Recommended public PRs:

- Small: <https://github.com/cli/cli/pull/9530>
- Medium: <https://github.com/facebook/react/pull/27453>
- Large: <https://github.com/kubernetes/kubernetes/pull/115000>

Related files:

- `work/fixtures/fixtures.md`
- `work/qa-checklist.md`

## Troubleshooting for developers

- **Daemon health check**

```bash
curl http://127.0.0.1:19280/v1/health
```

- **Read pairing secret**

```bash
cat ~/.config/prism/pairing-secret
```

- **Daemon unreachable in smoke test**
  - Make sure the daemon is already running

- **GitHub auth issues**
  - Run `gh auth login`
  - Or export `GITHUB_TOKEN`

- **Extension not injecting**
  - Rebuild the extension
  - Reload it in `chrome://extensions`
  - Confirm the page URL is `.../pull/<n>/files`

## Docs map

- User quick start: [README.md](./README.md)
- Development workflow: [CONTRIBUTING.md](./CONTRIBUTING.md)
- Architecture / implementation: [DESIGN.md](./DESIGN.md)
