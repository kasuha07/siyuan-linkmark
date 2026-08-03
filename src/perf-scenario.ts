import type { CacheEntry } from "./frontend-cache-state";
import { RESOLVER_VERSION } from "./resolver-contract";
import type { LinkScope } from "./url-scope";

/**
 * The deterministic Large-document performance scenario shared by the
 * development fixture generator script and the development Frontend cache
 * overlay: 2,000 external-link representations distributed across 500
 * distinct Link scopes, with a 10,000-entry process-local cache view.
 * Nothing here participates in production behavior.
 */
export const PERF_LINK_COUNT = 2000;
export const PERF_SCOPE_COUNT = 500;
export const PERF_DOMAIN_SCOPE_COUNT = 480;
export const PERF_ROUTE_SCOPE_COUNT = 20;
export const PERF_CACHE_VIEW_ENTRIES = 10_000;
const PERF_LINKS_PER_SCOPE = 4;
const ROUTE_HOST = "nocode.host";
const ICON_ORIGIN = "https://cdn.perf.example.dev/";

function perfDomain(index: number) {
  return `perf-site-${index}.example.dev`;
}

function perfRouteCode(index: number) {
  return `p${String(index).padStart(5, "0")}`;
}

export function perfScenarioScopes(): LinkScope[] {
  const scopes: LinkScope[] = [];
  for (let index = 0; index < PERF_DOMAIN_SCOPE_COUNT; index += 1) {
    const domain = perfDomain(index);
    scopes.push({ key: domain, domain });
  }
  for (let index = 0; index < PERF_ROUTE_SCOPE_COUNT; index += 1) {
    const code = perfRouteCode(index);
    scopes.push({
      key: `${ROUTE_HOST}::site-${code}`,
      domain: ROUTE_HOST,
      routeKey: `site-${code}`,
      pathPrefix: `/${code}`,
      discoverPage: true,
    });
  }
  return scopes;
}

export function perfScenarioLinkUrls(): string[] {
  const urls: string[] = [];
  for (let index = 0; index < PERF_DOMAIN_SCOPE_COUNT; index += 1) {
    for (let copy = 0; copy < PERF_LINKS_PER_SCOPE; copy += 1) {
      urls.push(`https://${perfDomain(index)}/ref-${copy}`);
    }
  }
  for (let index = 0; index < PERF_ROUTE_SCOPE_COUNT; index += 1) {
    for (let copy = 0; copy < PERF_LINKS_PER_SCOPE; copy += 1) {
      urls.push(`https://${ROUTE_HOST}/${perfRouteCode(index)}/ref-${copy}`);
    }
  }
  return urls;
}

/**
 * A read-only, process-local Frontend cache view containing exactly 10,000
 * fresh current entries. The 500 scenario scopes resolve through this view
 * while the remaining entries exercise large-cache isolation. The returned
 * object is frozen so the render pipeline can never mutate it, and it never
 * touches the adopted Cache snapshot, revision, epoch, or kernel state.
 * `fetchedAt` is a wall-clock timestamp because the pipeline compares it with
 * `Date.now()` when deciding entry freshness.
 */
export function perfCacheOverlay(fetchedAt: number): Record<string, CacheEntry> {
  const overlay: Record<string, CacheEntry> = {};
  const fresh = { fetchedAt: fetchedAt - 1_000, resolverVersion: RESOLVER_VERSION };
  for (let index = 0; index < PERF_DOMAIN_SCOPE_COUNT; index += 1) {
    const domain = perfDomain(index);
    overlay[domain] = { ...fresh, url: `${ICON_ORIGIN}${domain}.png`, domain };
  }
  for (let index = 0; index < PERF_ROUTE_SCOPE_COUNT; index += 1) {
    const code = perfRouteCode(index);
    overlay[`${ROUTE_HOST}::site-${code}`] = {
      ...fresh,
      url: `${ICON_ORIGIN}nocode-site-${code}.png`,
      domain: ROUTE_HOST,
      routeKey: `site-${code}`,
      pathPrefix: `/${code}`,
    };
  }
  for (let index = 0; index < PERF_CACHE_VIEW_ENTRIES - PERF_SCOPE_COUNT; index += 1) {
    const domain = `decoy-${index}.example.dev`;
    overlay[domain] = { ...fresh, url: `${ICON_ORIGIN}decoy-${index}.png`, domain };
  }
  for (const key of Object.keys(overlay)) overlay[key] = Object.freeze(overlay[key]);
  return Object.freeze(overlay);
}
