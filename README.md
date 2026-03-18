# PRism

[中文文档](./README-cn.md)

PRism is a personal GitHub code review assistant.
It shows AI-generated summaries next to code diffs on GitHub PR **Files changed** pages.

## 3-minute quick start

### Option A: Single binary (recommended)

Build a self-contained `prism` binary with [Bun](https://bun.sh):

```bash
pnpm install && pnpm build          # build shared types first
cd daemon && bun build src/cli.ts --compile --outfile ../prism
```

Then use it (run inside a git repo):

```bash
./prism review 42                    # review PR #42 (default: codex)
./prism review 42 --agent claude     # use claude instead
./prism review 42 --model gpt-4.1   # specify model
./prism review 42 --lang cn         # output summaries in Simplified Chinese
./prism review 42 --lang jp         # output summaries in Japanese
./prism review owner/repo#42        # review PR from any repo
./prism server                       # start daemon only (no analysis)
```

`prism review` defaults to `--lang en`. Supported values are `en`, `cn`, and `jp`.

### Option B: Run from source

### 1) Install

```bash
pnpm install
pnpm build
```

### 2) Start the daemon

```bash
pnpm --filter @prism/daemon dev
```

Health check:

```bash
curl http://127.0.0.1:19280/v1/health
```

### 3) Load the extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `extension/` directory

### 4) Use it

Open any GitHub PR **Files changed** page:

```text
https://github.com/<owner>/<repo>/pull/<number>/files
```

You should see PRism cards appear next to diff hunks.

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
