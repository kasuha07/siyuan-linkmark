import { parentDomainOf } from "./icon-resolver";
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
};

export const FAILURE_COOLDOWN = 10 * 60 * 1000;

export type CacheMatch = { cacheKey: string; entry: CacheEntry };

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

export function shareDomainFor(domain: string) {
  if (domain.includes(":") || /^\d+(?:\.\d+){3}$/.test(domain)) return null;
  const labels = domain.split(".");
  if (labels.length < 2 || labels.some((label) => !label)) return null;
  return parentDomainOf(domain) ?? domain;
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
