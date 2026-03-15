// ---------------------------------------------------------------------------
// PRism daemon — Lightweight request validation (WORK12)
//
// Simple field-presence + type checks for API request bodies and query
// params.  Returns a human-readable { field, message } on the first
// violation, or null when valid.
//
// No external dependencies — just plain conditionals.
// ---------------------------------------------------------------------------

export interface ValidationError {
  field: string;
  message: string;
}

/** Validate the minimal PRKey fields (owner, repo, pullNumber). */
export function validatePRKey(pr: unknown): ValidationError | null {
  if (typeof pr !== "object" || pr === null) {
    return { field: "pr", message: "must be an object" };
  }
  const obj = pr as Record<string, unknown>;
  if (typeof obj["owner"] !== "string" || !obj["owner"]) {
    return { field: "pr.owner", message: "required string" };
  }
  if (typeof obj["repo"] !== "string" || !obj["repo"]) {
    return { field: "pr.repo", message: "required string" };
  }
  if (
    typeof obj["pullNumber"] !== "number" ||
    !Number.isInteger(obj["pullNumber"]) ||
    obj["pullNumber"] <= 0
  ) {
    return { field: "pr.pullNumber", message: "required positive integer" };
  }
  return null;
}

/** Validate PRKey including baseSha + headSha (needed for cache lookups). */
export function validatePRKeyWithSha(pr: unknown): ValidationError | null {
  const base = validatePRKey(pr);
  if (base) return base;
  const obj = pr as Record<string, unknown>;
  if (typeof obj["headSha"] !== "string" || !obj["headSha"]) {
    return { field: "pr.headSha", message: "required string" };
  }
  if (typeof obj["baseSha"] !== "string" || !obj["baseSha"]) {
    return { field: "pr.baseSha", message: "required string" };
  }
  return null;
}

/** Validate an array of { filePath, patchHash } targets. */
export function validateHunkTargets(
  targets: unknown,
): ValidationError | null {
  if (!Array.isArray(targets)) {
    return { field: "targets", message: "must be an array" };
  }
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i] as Record<string, unknown> | null;
    if (typeof t !== "object" || t === null) {
      return { field: `targets[${i}]`, message: "must be an object" };
    }
    if (typeof t["filePath"] !== "string" || !t["filePath"]) {
      return { field: `targets[${i}].filePath`, message: "required string" };
    }
    if (typeof t["patchHash"] !== "string" || !t["patchHash"]) {
      return { field: `targets[${i}].patchHash`, message: "required string" };
    }
  }
  return null;
}

/** Validate an array of visible HunkRefs (at least filePath + patchHash). */
export function validateVisibleHunks(
  hunks: unknown,
): ValidationError | null {
  if (!Array.isArray(hunks)) {
    return { field: "visibleHunks", message: "must be an array" };
  }
  for (let i = 0; i < hunks.length; i++) {
    const h = hunks[i] as Record<string, unknown> | null;
    if (typeof h !== "object" || h === null) {
      return { field: `visibleHunks[${i}]`, message: "must be an object" };
    }
    if (typeof h["filePath"] !== "string" || !h["filePath"]) {
      return {
        field: `visibleHunks[${i}].filePath`,
        message: "required string",
      };
    }
    if (typeof h["patchHash"] !== "string" || !h["patchHash"]) {
      return {
        field: `visibleHunks[${i}].patchHash`,
        message: "required string",
      };
    }
  }
  return null;
}
