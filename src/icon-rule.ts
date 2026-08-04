import { cachedIconForScope, isCacheEntryFresh, type CacheEntry } from "./frontend-cache-state";
import { RESOLVER_VERSION } from "./resolver-contract";
import { scopeMatchTarget, type LinkScope } from "./url-scope";

const LINK_ELEMENTS = [
  [".protyle-wysiwyg span[data-type~='a']", "data-href"],
  [".protyle-wysiwyg span[data-type~='url']", "data-href"],
  [".protyle-wysiwyg a", "href"],
  [".b3-typography a", "href"],
] as const;

export type PresentBindingContext = {
  cache: Record<string, CacheEntry>;
  cacheDays: number;
  pauseAutomaticFetch: boolean;
  now: number;
};

export type PresentIconBinding = {
  key: string;
  iconUrl: string;
};

export type PresentBindingReconcileResult = {
  bindings: Map<string, string>;
  changed: boolean;
};

export type BindingSynchronizationPlan =
  | { kind: "rules" }
  | { kind: "targeted"; scopes: LinkScope[] }
  | { kind: "full" };

/**
 * Resolves a discovered link scope to the cache entry that currently governs
 * its icon. The returned key is the final binding key, not necessarily the
 * discovered scope: route and subdomain links can bind to a governing domain.
 */
export function presentIconBindingFor(
  scope: LinkScope,
  context: PresentBindingContext,
): PresentIconBinding | undefined {
  const match = cachedIconForScope(context.cache, scope);
  if (!match) return undefined;
  const { cacheKey, entry } = match;
  const pausedLegacyMonogram = context.pauseAutomaticFetch
    && entry.source === "generated monogram"
    && entry.resolverVersion !== RESOLVER_VERSION;
  const current = entry.pinned || entry.resolverVersion === RESOLVER_VERSION || pausedLegacyMonogram;
  if (!current) return undefined;
  const fresh = context.pauseAutomaticFetch || isCacheEntryFresh(entry, context.cacheDays, context.now);
  if (!fresh) return undefined;
  return { key: cacheKey, iconUrl: entry.url };
}

/** Computes the compact binding map for the currently Present scopes. */
export function reconcilePresentBindings(input: {
  discovery: Iterable<LinkScope>;
  context: PresentBindingContext;
  previous: Map<string, string>;
}): PresentBindingReconcileResult {
  const bindings = new Map<string, string>();
  for (const scope of input.discovery) {
    const binding = presentIconBindingFor(scope, input.context);
    if (binding) bindings.set(binding.key, binding.iconUrl);
  }
  let changed = input.previous.size !== bindings.size;
  if (!changed) {
    for (const [key, iconUrl] of bindings) {
      if (input.previous.get(key) !== iconUrl) {
        changed = true;
        break;
      }
    }
  }
  return { bindings, changed };
}

/** Classifies a cache change by whether existing element tokens stay valid. */
export function planBindingSynchronization(input: {
  scopes: Iterable<LinkScope>;
  before: PresentBindingContext;
  after: PresentBindingContext;
  changedKeys: Iterable<string>;
  maxTargetedScopes?: number;
}): BindingSynchronizationPlan {
  for (const key of input.changedKeys) {
    const before = input.before.cache[key];
    const after = input.after.cache[key];
    if (before?.pinned !== after?.pinned || before?.includeSubdomains !== after?.includeSubdomains) {
      return { kind: "full" };
    }
  }
  const affected: LinkScope[] = [];
  for (const scope of input.scopes) {
    if (presentIconBindingFor(scope, input.before)?.key !== presentIconBindingFor(scope, input.after)?.key) {
      affected.push(scope);
    }
  }
  if (affected.length === 0) return { kind: "rules" };
  if (affected.length > (input.maxTargetedScopes ?? 8)) return { kind: "full" };
  return { kind: "targeted", scopes: affected };
}

/**
 * Builds a transient query used to revisit links for a small set of changed
 * scopes. These selectors never enter a stylesheet and therefore do not add
 * persistent selector-matching cost.
 */
export function createScopeQuery(scope: LinkScope) {
  const selectors: string[] = [];
  for (const protocol of ["https", "http"] as const) {
    const match = scopeMatchTarget(scope, protocol);
    for (const [element, attribute] of LINK_ELEMENTS) {
      selectors.push(`${element}[${attribute}=${cssString(match.exact)}]`);
      for (const boundary of match.boundaries) {
        selectors.push(`${element}[${attribute}^=${cssString(match.exact + boundary)}]`);
      }
    }
  }
  return selectors.join(",");
}

export function cssString(value: string) {
  return JSON.stringify(value).replace(/</g, "\\3c ");
}
