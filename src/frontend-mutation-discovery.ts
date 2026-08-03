import {
  addedLinkDiscoveryRegionFor,
  type DiscoveryWork,
  type LocalDiscoverySelectors,
} from "./frontend-render-work";

export const LINK_IDENTITY_ATTRIBUTES = ["data-href", "href", "data-type"] as const;
export const LINK_CONTENT_OBSERVER_OPTIONS: MutationObserverInit = {
  childList: true,
  subtree: true,
  attributes: true,
  attributeOldValue: true,
  attributeFilter: [...LINK_IDENTITY_ATTRIBUTES],
};

export type MutationDiscoveryElement<Element> = {
  isConnected: boolean;
  tagName: string;
  matches: (selector: string) => boolean;
  closest: (selector: string) => Element | null;
  querySelector: (selector: string) => Element | null;
  getAttribute: (name: string) => string | null;
};

export type MutationDiscoveryRecord<Element> =
  | {
      type: "childList";
      addedElements: readonly Element[];
      removedElements: readonly Element[];
    }
  | {
      type: "attributes";
      target: Element;
      attributeName: (typeof LINK_IDENTITY_ATTRIBUTES)[number];
      oldValue: string | null;
    };

type LinkAttributes = {
  dataHref: string | null;
  dataType: string | null;
  href: string | null;
};

function linkUrlFor<Element extends MutationDiscoveryElement<Element>>(
  element: Element,
  attributes: LinkAttributes,
) {
  const types = new Set(attributes.dataType?.split(/\s+/).filter(Boolean) ?? []);
  if ((types.has("a") || types.has("url")) && attributes.dataHref !== null) return attributes.dataHref;
  if (element.tagName.toUpperCase() === "A" && attributes.href !== null) {
    return attributes.dataHref ?? attributes.href;
  }
  return null;
}

export function planMutationDiscovery<Element extends MutationDiscoveryElement<Element>>(
  records: readonly MutationDiscoveryRecord<Element>[],
  selectors: LocalDiscoverySelectors,
): DiscoveryWork<Element> {
  const localRegions = new Set<Element>();
  const attributeStates = new Map<Element, {
    after: LinkAttributes;
    before: LinkAttributes;
    seen: Set<string>;
  }>();

  for (const record of records) {
    if (record.type === "childList") {
      for (const element of record.removedElements) {
        if (element.matches(selectors.detachedLink) || element.querySelector(selectors.detachedLink)) {
          return { kind: "full" };
        }
      }
      for (const element of record.addedElements) {
        if (!element.matches(selectors.link) && !element.querySelector(selectors.link)) continue;
        const region = addedLinkDiscoveryRegionFor(element, selectors);
        if (region) localRegions.add(region);
      }
      continue;
    }

    let state = attributeStates.get(record.target);
    if (!state) {
      const after = {
        dataHref: record.target.getAttribute("data-href"),
        dataType: record.target.getAttribute("data-type"),
        href: record.target.getAttribute("href"),
      };
      state = { after, before: { ...after }, seen: new Set() };
      attributeStates.set(record.target, state);
    }
    if (state.seen.has(record.attributeName)) continue;
    state.seen.add(record.attributeName);
    if (record.attributeName === "data-href") state.before.dataHref = record.oldValue;
    else if (record.attributeName === "data-type") state.before.dataType = record.oldValue;
    else state.before.href = record.oldValue;
  }

  for (const [element, state] of attributeStates) {
    const beforeUrl = linkUrlFor(element, state.before);
    const afterUrl = linkUrlFor(element, state.after);
    if (beforeUrl !== null && beforeUrl !== afterUrl) return { kind: "full" };
    if (beforeUrl === null && afterUrl !== null) {
      const region = addedLinkDiscoveryRegionFor(element, selectors);
      if (region) localRegions.add(region);
    }
  }

  return localRegions.size > 0 ? { kind: "local", regions: [...localRegions] } : null;
}
