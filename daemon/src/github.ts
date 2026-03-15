// ---------------------------------------------------------------------------
// PRism daemon — GitHub API adapter (WORK09)
//
// Fetches PR metadata, changed files, and file content from GitHub.
// Auth: GITHUB_TOKEN / GH_TOKEN env var, or `gh auth token` fallback.
// ---------------------------------------------------------------------------

import { execSync } from "node:child_process";

// ---- Types ----------------------------------------------------------------

export interface PRMetadata {
  title: string;
  body: string;
  state: string;
  baseSha: string;
  headSha: string;
}

export interface PRChangedFile {
  filename: string;
  status: string; // "added" | "modified" | "removed" | "renamed" | ...
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  previousFilename?: string;
}

export type GitHubErrorKind =
  | "token_missing"
  | "token_expired"
  | "not_found"
  | "rate_limited"
  | "network_error"
  | "api_error";

export class GitHubError extends Error {
  constructor(
    public readonly kind: GitHubErrorKind,
    message: string,
    public readonly status?: number,
    public readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

// ---- Token resolution -----------------------------------------------------

let cachedToken: string | undefined;

/**
 * Resolve a GitHub token. Priority:
 *   1. GITHUB_TOKEN or GH_TOKEN env var
 *   2. `gh auth token` CLI output
 *
 * Caches the result for the lifetime of the process.
 * Throws GitHubError("token_missing") if neither source provides a token.
 */
export function resolveToken(): string {
  if (cachedToken) return cachedToken;

  const envToken = process.env["GITHUB_TOKEN"] || process.env["GH_TOKEN"];
  if (envToken) {
    cachedToken = envToken;
    return cachedToken;
  }

  try {
    const token = execSync("gh auth token", {
      encoding: "utf-8",
      timeout: 5_000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (token) {
      cachedToken = token;
      return cachedToken;
    }
  } catch {
    // gh not installed or not authenticated — fall through
  }

  throw new GitHubError(
    "token_missing",
    "GitHub token not found. Set GITHUB_TOKEN env var or run `gh auth login`.",
  );
}

/** Clear the cached token (e.g. after a 401 from GitHub). */
export function clearTokenCache(): void {
  cachedToken = undefined;
}

// ---- Low-level fetch wrapper ----------------------------------------------

const GITHUB_API = "https://api.github.com";

async function ghFetch(path: string, token: string): Promise<Response> {
  const url = `${GITHUB_API}${path}`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "PRism-daemon/0.1.0",
      },
    });
  } catch (err) {
    throw new GitHubError(
      "network_error",
      `Network error fetching ${url}: ${err instanceof Error ? err.message : String(err)}. Check your connection and retry.`,
    );
  }

  // ---- Rate limit / 429 --------------------------------------------------
  if (res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0")) {
    const resetEpoch = res.headers.get("x-ratelimit-reset");
    const retryAfter = resetEpoch
      ? Math.max(0, Number(resetEpoch) - Math.floor(Date.now() / 1000))
      : undefined;
    throw new GitHubError(
      "rate_limited",
      `GitHub API rate limit exceeded. ${retryAfter != null ? `Resets in ${retryAfter}s.` : "Try again later."}`,
      res.status,
      retryAfter,
    );
  }

  // ---- 403 (bad creds / scope) -------------------------------------------
  if (res.status === 403) {
    const body = await res.text();
    if (body.includes("Bad credentials") || body.includes("token")) {
      clearTokenCache();
      throw new GitHubError(
        "token_expired",
        "GitHub token is invalid or expired. Re-run `gh auth login` or update GITHUB_TOKEN.",
        403,
      );
    }
    throw new GitHubError("api_error", `GitHub API 403: ${body}`, 403);
  }

  // ---- 401 ---------------------------------------------------------------
  if (res.status === 401) {
    clearTokenCache();
    throw new GitHubError(
      "token_expired",
      "GitHub token is invalid or expired. Re-run `gh auth login` or update GITHUB_TOKEN.",
      401,
    );
  }

  // ---- 404 ---------------------------------------------------------------
  if (res.status === 404) {
    throw new GitHubError(
      "not_found",
      `Not found: ${path}. Check that the repo exists, the PR number is correct, and your token has access.`,
      404,
    );
  }

  // ---- Other errors ------------------------------------------------------
  if (!res.ok) {
    const body = await res.text();
    throw new GitHubError("api_error", `GitHub API ${res.status}: ${body}`, res.status);
  }

  return res;
}

// ---- Public API -----------------------------------------------------------

/** Fetch PR metadata (title, body, SHAs, state). */
export async function fetchPRMetadata(
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<PRMetadata> {
  const token = resolveToken();
  const res = await ghFetch(`/repos/${owner}/${repo}/pulls/${pullNumber}`, token);
  const data = (await res.json()) as Record<string, unknown>;
  const base = data["base"] as Record<string, unknown>;
  const head = data["head"] as Record<string, unknown>;

  return {
    title: data["title"] as string,
    body: (data["body"] as string) ?? "",
    state: data["state"] as string,
    baseSha: base["sha"] as string,
    headSha: head["sha"] as string,
  };
}

/**
 * Fetch all changed files for a PR, with pagination.
 * Handles PRs with 3000+ files by following all pages.
 */
export async function fetchPRFiles(
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<PRChangedFile[]> {
  const token = resolveToken();
  const allFiles: PRChangedFile[] = [];
  let page = 1;
  const perPage = 100; // GitHub max per_page for this endpoint

  while (true) {
    const res = await ghFetch(
      `/repos/${owner}/${repo}/pulls/${pullNumber}/files?per_page=${perPage}&page=${page}`,
      token,
    );
    const files = (await res.json()) as Array<Record<string, unknown>>;
    if (files.length === 0) break;

    for (const f of files) {
      allFiles.push({
        filename: f["filename"] as string,
        status: f["status"] as string,
        additions: f["additions"] as number,
        deletions: f["deletions"] as number,
        changes: f["changes"] as number,
        patch: f["patch"] as string | undefined,
        previousFilename: f["previous_filename"] as string | undefined,
      });
    }

    if (files.length < perPage) break;
    page++;
  }

  return allFiles;
}

/** Fetch raw file content at a given ref (for context snippets). */
export async function fetchFileContent(
  owner: string,
  repo: string,
  ref: string,
  filePath: string,
): Promise<string> {
  const token = resolveToken();
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  const res = await ghFetch(
    `/repos/${owner}/${repo}/contents/${encodedPath}?ref=${ref}`,
    token,
  );
  const data = (await res.json()) as Record<string, unknown>;
  const content = data["content"] as string;
  const encoding = data["encoding"] as string;

  if (encoding === "base64") {
    return Buffer.from(content, "base64").toString("utf-8");
  }
  return content;
}
