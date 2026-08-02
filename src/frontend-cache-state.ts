import { shareDomainFor } from "./parent-domain";
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

/**
 * A revisioned incremental change event broadcast by the Cache authority.
 * `upserts` maps Link scope keys to their new Cache entries and `removed`
 * lists the keys that left the cache since the previous event.
 */
export type CacheChangeEvent = {
  revision: number;
  upserts: Record<string, CacheEntry>;
  removed: string[];
};

export type CacheEventApplication =
  | { status: "applied"; cache: Record<string, CacheEntry>; revision: number }
  | { status: "refetch"; revision: number }
  | { status: "ignored" };

/**
 * Applies a Cache change event to a local cache copy. The first event is
 * valid without a prior revision; later events must follow the previous
 * revision by exactly one, and a gap requests a snapshot refetch instead of
 * an application. Stale, malformed, and missing-revision events leave the
 * cache untouched.
 */
export function applyCacheChangeEvent(
  cache: Record<string, CacheEntry>,
  event: unknown,
  lastRevision: number | undefined,
): CacheEventApplication {
  if (!isRecord(event)) return { status: "ignored" };
  const revision = event.revision;
  if (typeof revision !== "number" || !Number.isFinite(revision)) return { status: "ignored" };
  if (!isRecord(event.upserts) || !Array.isArray(event.removed)) return { status: "ignored" };
  if (lastRevision !== undefined) {
    if (revision <= lastRevision) return { status: "ignored" };
    if (revision !== lastRevision + 1) return { status: "refetch", revision };
  }
  const next: Record<string, CacheEntry> = { ...cache };
  for (const [key, entry] of Object.entries(event.upserts)) {
    if (isValidCacheEntry(entry)) next[key] = { ...entry };
  }
  for (const key of event.removed) {
    if (typeof key === "string") delete next[key];
  }
  return { status: "applied", cache: next, revision };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isValidCacheEntry(value: unknown): value is CacheEntry {
  return isRecord(value) && typeof value.url === "string" && typeof value.fetchedAt === "number";
}

export function cachedIconForScope(cache: Record<string, CacheEntry>, scope: LinkScope): CacheMatch | null {
  const exact = cache[scope.key];
  if (exact?.pinned) return { cacheKey: scope.key, entry: exact };
  const domainPinned = scope.routeKey ? cache[scope.domain] : undefined;
  if (domainPinned?.pinned) return { cacheKey: scope.domain, entry: domainPinned };
  let parent = shareDomainFor(scope.domain);
  while (parent && parent !== scope.domain) {
    const shared = cache[parent];
    if (shared?.pinned && shared.includeSubdomains) return { cacheKey: parent, entry: shared };
    const next = shareDomainFor(parent);
    if (next === parent) break;
    parent = next;
  }
  if (exact) return { cacheKey: scope.key, entry: exact };
  const domainFallback = scope.routeKey ? cache[scope.domain] : undefined;
  return domainFallback ? { cacheKey: scope.domain, entry: domainFallback } : null;
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
