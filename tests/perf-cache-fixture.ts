import type { CacheEntry } from "../src/frontend-cache-state";
import {
  PERF_CACHE_VIEW_ENTRIES,
  PERF_DOMAIN_SCOPE_COUNT,
  PERF_ROUTE_HOST,
  PERF_ROUTE_SCOPE_COUNT,
  PERF_SCOPE_COUNT,
  perfScenarioDomain,
  perfScenarioRouteCode,
} from "../src/perf-scenario-definition.js";
import { RESOLVER_VERSION } from "../src/resolver-contract";

const ICON_ORIGIN = "https://cdn.perf.example.dev/";

export function largeCacheFixture(fetchedAt: number): Record<string, CacheEntry> {
  const cache: Record<string, CacheEntry> = {};
  const fresh = { fetchedAt: fetchedAt - 1_000, resolverVersion: RESOLVER_VERSION };
  for (let index = 0; index < PERF_DOMAIN_SCOPE_COUNT; index += 1) {
    const domain = perfScenarioDomain(index);
    cache[domain] = { ...fresh, url: `${ICON_ORIGIN}${domain}.png`, domain };
  }
  for (let index = 0; index < PERF_ROUTE_SCOPE_COUNT; index += 1) {
    const code = perfScenarioRouteCode(index);
    cache[`${PERF_ROUTE_HOST}::site-${code}`] = {
      ...fresh,
      url: `${ICON_ORIGIN}nocode-site-${code}.png`,
      domain: PERF_ROUTE_HOST,
      routeKey: `site-${code}`,
      pathPrefix: `/${code}`,
    };
  }
  for (let index = 0; index < PERF_CACHE_VIEW_ENTRIES - PERF_SCOPE_COUNT; index += 1) {
    const domain = `decoy-${index}.example.dev`;
    cache[domain] = { ...fresh, url: `${ICON_ORIGIN}decoy-${index}.png`, domain };
  }
  return cache;
}
