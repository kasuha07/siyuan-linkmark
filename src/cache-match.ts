import { shareEligibilityOf } from "./parent-domain";

export type MatchableCacheEntry = {
  pinned?: boolean;
  includeSubdomains?: boolean;
};

export type MatchableScope = {
  key: string;
  domain: string;
  routeKey?: string;
};

export function effectiveCacheMatch<T extends MatchableCacheEntry>(
  cache: Record<string, T>,
  scope: MatchableScope,
): { cacheKey: string; entry: T } | null {
  const exact = cache[scope.key];
  if (exact?.pinned) return { cacheKey: scope.key, entry: exact };
  const domainPinned = scope.routeKey ? cache[scope.domain] : undefined;
  if (domainPinned?.pinned) return { cacheKey: scope.domain, entry: domainPinned };
  const shareEligibility = shareEligibilityOf(scope.domain);
  if (shareEligibility.eligible && shareEligibility.shareDomain !== scope.domain) {
    const shared = cache[shareEligibility.shareDomain];
    if (shared?.pinned && shared.includeSubdomains) {
      return { cacheKey: shareEligibility.shareDomain, entry: shared };
    }
  }
  if (exact) return { cacheKey: scope.key, entry: exact };
  const domainFallback = scope.routeKey ? cache[scope.domain] : undefined;
  return domainFallback ? { cacheKey: scope.domain, entry: domainFallback } : null;
}
