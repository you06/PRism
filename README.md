<p align="center">
  <img src="./logo.png" alt="PRism" width="128" />
</p>

# PRism

[中文文档](./README-cn.md)

PRism is a personal GitHub code review assistant.
It shows AI-generated summaries next to code diffs on GitHub PR **Files changed** pages.

## 3-minute quick start

### Option A: Install (recommended)

**1) Install the CLI:**

```bash
npm i -g prism-code-review
```

**2) Install the Chrome extension:**

1. Download the extension zip from the [latest release](https://github.com/you06/PRism/releases/latest)
2. Unzip
3. Open `chrome://extensions`, enable **Developer mode**
4. Click **Load unpacked** and select the unzipped folder

**3) Use it (run inside a git repo):**

```bash
prism review 42                    # review PR #42 (default: codex)
prism review 42 --agent claude     # use claude instead
prism review 42 --model gpt-4.1   # specify model
prism review 42 --lang cn         # output summaries in Simplified Chinese
prism review 42 --lang jp         # output summaries in Japanese
prism review owner/repo#42        # review PR from any repo
prism server                       # start daemon only (no analysis)
```

`prism review` defaults to `--lang en`. Supported values are `en`, `cn`, and `jp`.

Open any GitHub PR **Files changed** page to see PRism cards next to diff hunks.

### Option B: Run from source

```bash
pnpm install
pnpm build
pnpm --filter @prism/daemon dev
```

Health check: `curl http://127.0.0.1:19280/v1/health`

Load the extension from `extension/` directory in `chrome://extensions` (Developer mode → Load unpacked).

## Prerequisites

- Node.js >= 20
- pnpm >= 9
- Chrome / Chromium
- Authenticated GitHub CLI: `gh auth login`
- One of the following analysis agents:
  - [Codex CLI](https://github.com/openai/codex) (default)
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`--agent claude`)

## Smoke test

```bash
# terminal 1
pnpm --filter @prism/daemon dev

# terminal 2
pnpm --filter @prism/daemon smoke-test
```

## Troubleshooting

- **No cards appear**
  - Rebuild: `pnpm --filter @prism/extension build`
  - Reload the extension in `chrome://extensions`
  - Make sure you are on a `.../pull/<n>/files` page

- **Daemon is offline**
  - Start it with: `pnpm --filter @prism/daemon dev`
  - Check: `curl http://127.0.0.1:19280/v1/health`

- **GitHub auth error**
  - Run `gh auth login`
  - Restart the daemon

## More docs

- Developer setup / scripts / fixtures / QA: [CONTRIBUTING.md](./CONTRIBUTING.md)
- Design / architecture: [DESIGN.md](./DESIGN.md)
