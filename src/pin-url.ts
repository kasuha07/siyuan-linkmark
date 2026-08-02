import type { CacheEntry, LinkScope, ResolvedIcon } from "./cache-authority";
import { InvalidShareDomainError, isEligibleShareTarget } from "./parent-domain";

export type PinUrlDependencies = {
  resolveUrl: (url: string) => Promise<ResolvedIcon | null>;
  putPinned: (scope: LinkScope, entry: CacheEntry, contentType: string, bytes: ArrayBuffer, replaceKey?: string) => Promise<CacheEntry>;
};

/**
 * The cache.pin-url flow. The shared-pin eligibility check runs before any
 * network download, so an invalid shared pin always fails with the stable
 * invalid-share-domain error and never triggers a custom icon URL request.
 */
export async function pinCustomUrl(
  deps: PinUrlDependencies,
  scope: LinkScope,
  iconUrl: string,
  includeSubdomains: boolean,
  replaceKey?: string,
): Promise<CacheEntry> {
  if (includeSubdomains && !isEligibleShareTarget(scope.domain)) {
    throw new InvalidShareDomainError();
  }
  const resolved = await deps.resolveUrl(iconUrl);
  if (!resolved) throw new Error("Custom icon URL did not return a usable image");
  return deps.putPinned(scope, {
    url: "",
    fetchedAt: Date.now(),
    source: "custom URL",
    targetUrl: scope.targetUrl,
    domain: scope.domain,
    routeKey: scope.routeKey,
    pathPrefix: scope.pathPrefix,
    pinned: true,
    includeSubdomains,
  }, resolved.contentType, resolved.bytes, replaceKey);
}
