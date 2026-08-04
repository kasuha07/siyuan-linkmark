import { scopeForUrl, type LinkScope } from "./url-scope";

export type LinkDiscoveryCandidate<Element> = {
  element: Element;
  href: string;
};

export type DiscoveredLink = {
  scope: LinkScope;
  targetUrl: string;
};

export function linkHref(element: {
  dataset: { href?: string };
  getAttribute: (name: string) => string | null;
}) {
  return element.dataset.href ?? element.getAttribute("href") ?? "";
}

export function* linkElementsIn(container: Element, selector: string): IterableIterator<HTMLElement> {
  if (container.matches(selector)) yield container as HTMLElement;
  for (const element of container.querySelectorAll<HTMLElement>(selector)) yield element;
}

/** Aggregates one synchronous discovery pass without retaining link elements. */
export function discoverLinks<Element>(input: {
  candidates: Iterable<LinkDiscoveryCandidate<Element>>;
  onElement: (element: Element, scope: LinkScope | null) => void;
  classifyHref?: (href: string) => LinkScope | null;
}): Map<string, DiscoveredLink> {
  const classifyHref = input.classifyHref ?? scopeForUrl;
  const classifiedHrefs = new Map<string, LinkScope | null>();
  const discovery = new Map<string, DiscoveredLink>();
  for (const { element, href } of input.candidates) {
    let scope = classifiedHrefs.get(href);
    if (scope === undefined && !classifiedHrefs.has(href)) {
      scope = classifyHref(href);
      classifiedHrefs.set(href, scope);
    }
    input.onElement(element, scope ?? null);
    if (scope && !discovery.has(scope.key)) discovery.set(scope.key, { scope, targetUrl: href });
  }
  return discovery;
}
