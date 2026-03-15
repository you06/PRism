// ---------------------------------------------------------------------------
// PRism — Patch Normalization & Hashing (extension re-export)
//
// The canonical implementation lives in @prism/shared (shared/src/patch-hash.ts).
// This file re-exports everything so existing extension imports continue to work.
//
// IMPORTANT: Do NOT add logic here. All normalize/hash code must stay in shared/
// so the daemon produces identical patchHash values.
// ---------------------------------------------------------------------------

export {
  type DiffLineType,
  type NormalizedLine,
  normalizeLine,
  canonicalizePatch,
  computePatchHash,
} from "@prism/shared";
