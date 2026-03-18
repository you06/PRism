// ---------------------------------------------------------------------------
// PRism — Background Annotation Cache
//
// Short-lived in-memory cache for annotation results, keyed by PR + hunk
// identity. Prevents duplicate daemon queries when the user scrolls back
// and forth over the same hunks.
// ---------------------------------------------------------------------------

import type { Annotation, PRKey } from "./shared.js";

/** Default cache entry TTL in milliseconds (30 seconds). */
const DEFAULT_TTL_MS = 30_000;

/** Maximum number of entries before oldest are evicted. */
const MAX_ENTRIES = 500;

interface CacheEntry {
  annotation: Annotation;
  expiresAt: number;
}

/**
 * Build a cache key from PR identity + hunk patchHash.
 * Format: "owner/repo#pullNumber@headSha:patchHash"
 */
export function cacheKey(pr: PRKey, patchHash: string): string {
  return `${pr.owner}/${pr.repo}#${pr.pullNumber}@${pr.headSha}:${patchHash}`;
}

/**
 * Short-lived annotation cache.
 *
 * Entries expire after TTL and are lazily evicted on access.
 * A hard cap (MAX_ENTRIES) prevents unbounded memory growth.
 */
export class AnnotationCache {
  private store = new Map<string, CacheEntry>();
  private ttlMs: number;

  constructor(ttlMs = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  /** Get a cached annotation, or undefined if missing/expired. */
  get(key: string): Annotation | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    // Promote to most-recently-used (move to end of Map iteration order)
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.annotation;
  }

  /** Cache an annotation. */
  set(key: string, annotation: Annotation): void {
    // Evict oldest entry if at capacity
    if (this.store.size >= MAX_ENTRIES) {
      const firstKey = this.store.keys().next().value;
      if (firstKey !== undefined) this.store.delete(firstKey);
    }
    this.store.set(key, {
      annotation,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  /** Look up multiple keys. Returns [cached annotations, missed keys]. */
  getMany(keys: string[]): [Annotation[], string[]] {
    const cached: Annotation[] = [];
    const missed: string[] = [];
    for (const key of keys) {
      const ann = this.get(key);
      if (ann) {
        cached.push(ann);
      } else {
        missed.push(key);
      }
    }
    return [cached, missed];
  }

  /** Remove a specific entry (e.g., on retry). */
  invalidate(key: string): void {
    this.store.delete(key);
  }

  /** Clear all entries for a given PR (e.g., on context change or job completion). */
  clearForPR(pr: PRKey): void {
    const prefix = `${pr.owner}/${pr.repo}#${pr.pullNumber}@${pr.headSha}:`;
    for (const key of [...this.store.keys()]) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
      }
    }
  }

  /** Clear the entire cache. */
  clear(): void {
    this.store.clear();
  }

  /** Number of live entries (may include expired until accessed). */
  get size(): number {
    return this.store.size;
  }
}
