import type { CacheEntry } from "./frontend-cache-state";
import {
  PERF_CACHE_VIEW_ENTRIES,
  PERF_DOMAIN_SCOPE_COUNT,
  PERF_ROUTE_HOST,
  PERF_ROUTE_SCOPE_COUNT,
  PERF_SCOPE_COUNT,
  perfScenarioDomain,
  perfScenarioRouteCode,
} from "./perf-scenario-definition.js";
import { RESOLVER_VERSION } from "./resolver-contract";
import type { LinkScope } from "./url-scope";

export {
  PERF_CACHE_VIEW_ENTRIES,
  PERF_DOMAIN_SCOPE_COUNT,
  PERF_LINK_COUNT,
  PERF_ROUTE_SCOPE_COUNT,
  PERF_SCOPE_COUNT,
  perfScenarioLinkUrls,
} from "./perf-scenario-definition.js";

/**
 * The deterministic Large-document performance scenario shared by the
 * development fixture generator script and the development Frontend cache
 * overlay: 2,000 external-link representations distributed across 500
 * distinct Link scopes, with a 10,000-entry process-local cache view.
 * Nothing here participates in production behavior.
 */
const ICON_ORIGIN = "https://cdn.perf.example.dev/";

export function perfScenarioScopes(): LinkScope[] {
  const scopes: LinkScope[] = [];
  for (let index = 0; index < PERF_DOMAIN_SCOPE_COUNT; index += 1) {
    const domain = perfScenarioDomain(index);
    scopes.push({ key: domain, domain });
  }
  for (let index = 0; index < PERF_ROUTE_SCOPE_COUNT; index += 1) {
    const code = perfScenarioRouteCode(index);
    scopes.push({
      key: `${PERF_ROUTE_HOST}::site-${code}`,
      domain: PERF_ROUTE_HOST,
      routeKey: `site-${code}`,
      pathPrefix: `/${code}`,
      discoverPage: true,
    });
  }
  return scopes;
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
    const domain = perfScenarioDomain(index);
    overlay[domain] = { ...fresh, url: `${ICON_ORIGIN}${domain}.png`, domain };
  }
  for (let index = 0; index < PERF_ROUTE_SCOPE_COUNT; index += 1) {
    const code = perfScenarioRouteCode(index);
    overlay[`${PERF_ROUTE_HOST}::site-${code}`] = {
      ...fresh,
      url: `${ICON_ORIGIN}nocode-site-${code}.png`,
      domain: PERF_ROUTE_HOST,
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
