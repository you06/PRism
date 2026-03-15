# AGENTS.md

## Project overview

PRism is a personal GitHub code review assistant. It consists of:

- **daemon/** — localhost HTTP server that fetches PR data from GitHub and runs LLM analysis
- **extension/** — Chrome extension that renders annotation cards on GitHub PR pages
- **shared/** — shared types and contracts between daemon and extension

## Build

```bash
pnpm install
pnpm build            # builds shared → daemon → extension (TypeScript)
```

## Build binary

```bash
cd daemon && bun build src/cli.ts --compile --outfile ../prism
```

## Run (development)

```bash
pnpm --filter @prism/daemon dev       # start daemon with hot reload
```

## Test

```bash
# Health check
curl http://127.0.0.1:19280/v1/health

# Smoke test (requires daemon running)
pnpm --filter @prism/daemon smoke-test
```

## Type check

```bash
pnpm typecheck        # runs tsc --noEmit across all packages
```

## Key files

| File | Purpose |
|------|---------|
| `daemon/src/cli.ts` | CLI entry point (`prism review` / `prism server`) |
| `daemon/src/server.ts` | Daemon server factory |
| `daemon/src/index.ts` | Standalone daemon entry |
| `daemon/src/routes.ts` | HTTP API route handlers |
| `daemon/src/github.ts` | GitHub API adapter |
| `daemon/src/store.ts` | In-memory store interfaces and implementations |
| `extension/src/content.ts` | Content script injected into GitHub PR pages |
| `extension/src/background.ts` | Background service worker |
| `shared/src/contracts.ts` | API contracts and message types |
| `shared/src/models.ts` | Shared data models |

## Rules

- Keep same contents for `README.md` and `README-cn.md`. If one is changed, also translate the changes into the other language.
