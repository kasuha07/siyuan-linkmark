import { cachedIconForScope, isCacheEntryFresh, type CacheEntry } from "./frontend-cache-state";
import { RESOLVER_VERSION } from "./resolver-contract";
import { scopeMatchTarget, type LinkScope } from "./url-scope";

const RULE_ELEMENTS = [
  [".protyle-wysiwyg span[data-type~='a']", "data-href"],
  [".protyle-wysiwyg span[data-type~='url']", "data-href"],
  [".protyle-wysiwyg a", "href"],
  [".b3-typography a", "href"],
] as const;

export type PresentRuleContext = {
  cache: Record<string, CacheEntry>;
  iconSize: number;
  cacheDays: number;
  pauseAutomaticFetch: boolean;
};

export type PresentRuleReconcileResult = {
  rules: Map<string, string>;
  changed: boolean;
};

/**
 * Computes the Icon rule map for the discovered Present scopes against the
 * current cache. A full reconcile replaces the previous map, so scopes
 * absent from the new discovery are evicted; a local reconcile only adds or
 * updates rules for its region. The currentness and freshness filters match
 * the historical cache sweep: Pinned entries, matching resolver version,
 * fresh entries, paused-legacy monograms, and route-scope suppression under
 * a pinned domain.
 */
export function reconcilePresentRules(input: {
  discovery: Iterable<LinkScope>;
  context: PresentRuleContext;
  previous: ReadonlyMap<string, string>;
  full: boolean;
}): PresentRuleReconcileResult {
  const computed = new Map<string, string>();
  for (const scope of input.discovery) {
    const rule = presentRuleFor(scope, input.context);
    if (rule) computed.set(rule.key, rule.rule);
  }
  if (!input.full) {
    let changed = false;
    const rules = new Map(input.previous);
    for (const [key, rule] of computed) {
      if (rules.get(key) !== rule) {
        rules.set(key, rule);
        changed = true;
      }
    }
    return { rules, changed };
  }
  let changed = input.previous.size !== computed.size;
  if (!changed) {
    for (const [key, rule] of computed) {
      if (input.previous.get(key) !== rule) {
        changed = true;
        break;
      }
    }
  }
  return { rules: computed, changed };
}

function presentRuleFor(scope: LinkScope, context: PresentRuleContext): { key: string; rule: string } | undefined {
  if (scope.routeKey && context.cache[scope.domain]?.pinned) {
    // Route-scope suppression under a pinned domain: the domain rule serves
    // the route links with the pinned icon, so no route rule is emitted.
    const domainEntry = context.cache[scope.domain];
    return {
      key: scope.domain,
      rule: createIconRule({ key: scope.domain, domain: scope.domain }, domainEntry.url, context.iconSize),
    };
  }
  const match = cachedIconForScope(context.cache, scope);
  if (!match) return undefined;
  const { entry } = match;
  const pausedLegacyMonogram = context.pauseAutomaticFetch
    && entry.source === "generated monogram"
    && entry.resolverVersion !== RESOLVER_VERSION;
  const current = entry.pinned || entry.resolverVersion === RESOLVER_VERSION || pausedLegacyMonogram;
  if (!current) return undefined;
  const fresh = context.pauseAutomaticFetch || isCacheEntryFresh(entry, context.cacheDays);
  if (!fresh) return undefined;
  return { key: scope.key, rule: createIconRule(scope, entry.url, context.iconSize) };
}

export function createIconRule(scope: LinkScope, iconUrl: string, iconSize: number) {
  const selectors: string[] = [];
  for (const protocol of ["https", "http"] as const) {
    const match = scopeMatchTarget(scope, protocol);
    for (const [element, attribute] of RULE_ELEMENTS) {
      selectors.push(`${element}[${attribute}=${cssString(match.exact)}]::before`);
      for (const boundary of match.boundaries) {
        selectors.push(`${element}[${attribute}^=${cssString(match.exact + boundary)}]::before`);
      }
    }
  }
  return `${selectors.join(",\n")} {
      content: "";
      display: inline-block;
      width: ${iconSize}em;
      height: ${iconSize}em;
      margin-right: 0.22em;
      vertical-align: -0.12em;
      background-image: url(${cssString(iconUrl)});
      background-position: center;
      background-size: contain;
      background-repeat: no-repeat;
    }`;
}

function cssString(value: string) {
  return JSON.stringify(value).replace(/</g, "\\3c ");
}
