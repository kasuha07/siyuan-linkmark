export const PERF_DOMAIN_SCOPE_COUNT = 480;
export const PERF_ROUTE_SCOPE_COUNT = 20;
export const PERF_SCOPE_COUNT = PERF_DOMAIN_SCOPE_COUNT + PERF_ROUTE_SCOPE_COUNT;
export const PERF_CACHE_VIEW_ENTRIES = 10_000;

const PERF_LINKS_PER_SCOPE = 4;
export const PERF_LINK_COUNT = PERF_SCOPE_COUNT * PERF_LINKS_PER_SCOPE;
export const PERF_ROUTE_HOST = "nocode.host";

export function perfScenarioDomain(index) {
  return `perf-site-${index}.example.dev`;
}

export function perfScenarioRouteCode(index) {
  return `p${String(index).padStart(5, "0")}`;
}

export function perfScenarioLinkUrls() {
  const urls = [];
  for (let index = 0; index < PERF_DOMAIN_SCOPE_COUNT; index += 1) {
    for (let copy = 0; copy < PERF_LINKS_PER_SCOPE; copy += 1) {
      urls.push(`https://${perfScenarioDomain(index)}/ref-${copy}`);
    }
  }
  for (let index = 0; index < PERF_ROUTE_SCOPE_COUNT; index += 1) {
    for (let copy = 0; copy < PERF_LINKS_PER_SCOPE; copy += 1) {
      urls.push(`https://${PERF_ROUTE_HOST}/${perfScenarioRouteCode(index)}/ref-${copy}`);
    }
  }
  return urls;
}
