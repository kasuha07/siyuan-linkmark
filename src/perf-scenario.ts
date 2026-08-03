import {
  PERF_DOMAIN_SCOPE_COUNT,
  PERF_ROUTE_HOST,
  PERF_ROUTE_SCOPE_COUNT,
  perfScenarioDomain,
  perfScenarioRouteCode,
} from "./perf-scenario-definition.js";
import type { LinkScope } from "./url-scope";

export {
  PERF_DOMAIN_SCOPE_COUNT,
  PERF_LINK_COUNT,
  PERF_ROUTE_SCOPE_COUNT,
  PERF_SCOPE_COUNT,
  perfScenarioLinkUrls,
} from "./perf-scenario-definition.js";

/**
 * The deterministic Large-document performance scenario shared by the
 * generated document and structural regression tests: 2,000 external-link
 * representations distributed across 500 distinct Link scopes. Nothing here
 * participates in production behavior.
 */
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
