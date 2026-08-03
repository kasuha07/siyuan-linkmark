export const PERF_DOMAIN_SCOPE_COUNT: number;
export const PERF_ROUTE_SCOPE_COUNT: number;
export const PERF_SCOPE_COUNT: number;
export const PERF_CACHE_VIEW_ENTRIES: number;
export const PERF_LINK_COUNT: number;
export const PERF_ROUTE_HOST: string;

export function perfScenarioDomain(index: number): string;
export function perfScenarioRouteCode(index: number): string;
export function perfScenarioLinkUrls(): string[];
