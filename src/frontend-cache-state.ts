import { effectiveCacheMatch } from "./cache-match";
import type { LinkScope } from "./url-scope";

export type CacheEntry = {
  url: string;
  fetchedAt: number;
  resolverVersion?: number;
  source?: string;
  targetUrl?: string;
  domain?: string;
  routeKey?: string;
  pathPrefix?: string;
  pinned?: boolean;
  includeSubdomains?: boolean;
  iconId?: string;
  contentType?: string;
};

export const FAILURE_COOLDOWN = 10 * 60 * 1000;

export type CacheMatch = { cacheKey: string; entry: CacheEntry };

/** Creates a sparse before-view for binding comparisons without copying the cache. */
export function cacheBeforeChange(cache: Record<string, CacheEntry>, previous: Record<string, CacheEntry | undefined>) {
  const before = Object.create(cache) as Record<string, CacheEntry>;
  for (const [key, entry] of Object.entries(previous)) {
    Object.defineProperty(before, key, { value: entry, enumerable: true, configurable: true, writable: true });
  }
  return before;
}

export function cachedIconForScope(cache: Record<string, CacheEntry>, scope: LinkScope): CacheMatch | null {
  return effectiveCacheMatch(cache, scope);
}

export function isCacheEntryFresh(entry: CacheEntry, cacheDays: number, now = Date.now()) {
  if (entry.pinned) return true;
  const maxAge = cacheDays > 0 ? cacheDays * 86400000 : Infinity;
  return now - entry.fetchedAt <= maxAge;
}

export type ScanDecision =
  | { action: "expire"; cacheKey: string; entry: CacheEntry }
  | { action: "keep"; entry: CacheEntry; fetch: boolean }
  | { action: "fetch" }
  | { action: "skip" };

export function planScanDecision(input: {
  scopeKey: string;
  scope: LinkScope;
  cache: Record<string, CacheEntry>;
  pauseAutomaticFetch: boolean;
  cacheDays: number;
  failedAt: number | undefined;
  now?: number;
}): ScanDecision {
  const { scopeKey, scope, cache, pauseAutomaticFetch, cacheDays, failedAt } = input;
  const now = input.now ?? Date.now();
  const match = cachedIconForScope(cache, scope);
  if (match) {
    const { cacheKey, entry } = match;
    if (!pauseAutomaticFetch && !isCacheEntryFresh(entry, cacheDays, now)) {
      return { action: "expire", cacheKey, entry };
    }
    if (cacheKey === scopeKey || entry.pinned || pauseAutomaticFetch) {
      return { action: "keep", entry, fetch: false };
    }
  } else if (pauseAutomaticFetch) {
    return { action: "skip" };
  }
  if (failedAt !== undefined && now - failedAt < FAILURE_COOLDOWN) return { action: "skip" };
  return match ? { action: "keep", entry: match.entry, fetch: true } : { action: "fetch" };
}
