// ---------------------------------------------------------------------------
// PRism Chrome Extension — package entry
//
// The real runtime entry points are:
//   background.ts — service worker (loaded by manifest.json)
//   content.ts    — content script (injected into GitHub PR pages)
//
// This file exists solely to validate that the @prism/shared dependency
// resolves correctly during `pnpm typecheck`.
// ---------------------------------------------------------------------------

import type { PRKey, HunkRef, PrismMessage } from "@prism/shared";

export type { PRKey, HunkRef, PrismMessage };
