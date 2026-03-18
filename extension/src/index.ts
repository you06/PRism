// ---------------------------------------------------------------------------
// PRism Chrome Extension — package entry
//
// The real runtime entry points are:
//   background.ts — service worker (loaded by manifest.json)
//   content.ts    — content script (injected into GitHub PR pages)
//
// This file exists solely to validate extension-local shared types during
// `pnpm typecheck`.
// ---------------------------------------------------------------------------

import type { PRKey, HunkRef, PrismMessage } from "./shared.js";

export type { PRKey, HunkRef, PrismMessage };
