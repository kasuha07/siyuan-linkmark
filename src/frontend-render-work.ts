export type DiscoveryWork<Region> =
  | { kind: "full" }
  | { kind: "local"; regions: Region[] }
  | null;

const MAX_LOCAL_DISCOVERY_REGIONS = 8;

export type FrontendRenderWork<Region> = {
  discovery: DiscoveryWork<Region>;
  rebuildRules: boolean;
  publishRules: boolean;
};

export type FrontendRenderWorkExecutor<Region> = {
  rebuildRules: () => void;
  discover: (discovery: Exclude<DiscoveryWork<Region>, null>) => boolean;
  publishRules: () => void;
};

type LocalDiscoveryElement = {
  isConnected: boolean;
  matches: (selector: string) => boolean;
  closest: (selector: string) => LocalDiscoveryElement | null;
};

type AddedLinkDiscoveryElement = LocalDiscoveryElement & {
  querySelector: (selector: string) => LocalDiscoveryElement | null;
};

export type LocalDiscoverySelectors = {
  link: string;
  detachedLink: string;
  editor: string;
  block: string;
  staticContainer: string;
};

/**
 * Picks the narrowest useful discovery region without falling back to the
 * editable document host. An input event is normally dispatched on that host,
 * so scanning it would turn ordinary typing into a whole-document pass.
 */
export function localDiscoveryRegionFor<Region extends LocalDiscoveryElement>(
  element: Region | null,
  selectors: LocalDiscoverySelectors,
): Region | null {
  if (!element?.isConnected) return null;
  const link = element.matches(selectors.link) ? element : element.closest(selectors.link);
  if (link) return link as Region;
  const block = element.closest(selectors.block);
  if (block?.closest(selectors.editor)) return block as Region;
  const staticContainer = element.closest(selectors.staticContainer);
  return staticContainer && !staticContainer.matches(selectors.editor) ? staticContainer as Region : null;
}

/**
 * An off-DOM editor subtree can arrive in one child-list mutation. Limit that
 * scan to the newly inserted subtree when it contains a link instead of using
 * the already-mounted document host as a fallback.
 */
export function addedLinkDiscoveryRegionFor<Region extends AddedLinkDiscoveryElement>(
  element: Region | null,
  selectors: LocalDiscoverySelectors,
): Region | null {
  return localDiscoveryRegionFor(element, selectors)
    ?? (element?.isConnected && element.querySelector(selectors.link) ? element : null);
}

export class FrontendRenderWorkQueue<Region> {
  private pendingFullDiscovery = false;
  private readonly pendingLocalRegions = new Set<Region>();
  private fullDiscovery = false;
  private readonly localRegions = new Set<Region>();
  private rebuildRules = false;
  private publishRules = false;

  constructor(private readonly contains?: (outer: Region, inner: Region) => boolean) {}

  requestFullDiscovery() {
    this.pendingFullDiscovery = true;
    this.pendingLocalRegions.clear();
    this.fullDiscovery = false;
    this.localRegions.clear();
  }

  requestLocalDiscovery(region: Region) {
    if (this.pendingFullDiscovery || this.fullDiscovery) return;
    this.addRegion(this.pendingLocalRegions, region);
    if (this.pendingLocalRegions.size > MAX_LOCAL_DISCOVERY_REGIONS) this.requestFullDiscovery();
  }

  flushDiscovery() {
    if (this.pendingFullDiscovery) {
      this.fullDiscovery = true;
      this.localRegions.clear();
    } else if (!this.fullDiscovery) {
      for (const region of this.pendingLocalRegions) this.addRegion(this.localRegions, region);
    }
    this.pendingFullDiscovery = false;
    this.pendingLocalRegions.clear();
  }

  requestRuleRebuild() {
    this.rebuildRules = true;
    this.publishRules = true;
  }

  requestRulePublication() {
    this.publishRules = true;
  }

  take(): FrontendRenderWork<Region> {
    const discovery: DiscoveryWork<Region> = this.fullDiscovery
      ? { kind: "full" }
      : this.localRegions.size > 0
        ? { kind: "local", regions: [...this.localRegions] }
        : null;
    const work = {
      discovery,
      rebuildRules: this.rebuildRules,
      publishRules: this.publishRules,
    };
    this.fullDiscovery = false;
    this.localRegions.clear();
    this.rebuildRules = false;
    this.publishRules = false;
    return work;
  }

  private addRegion(regions: Set<Region>, region: Region) {
    if (!this.contains) {
      regions.add(region);
      return;
    }
    for (const existing of regions) {
      if (this.contains(existing, region)) return;
      if (this.contains(region, existing)) regions.delete(existing);
    }
    regions.add(region);
  }
}

export function flushFrontendRenderWork<Region>(
  queue: FrontendRenderWorkQueue<Region>,
  executor: FrontendRenderWorkExecutor<Region>,
) {
  const work = queue.take();
  if (work.rebuildRules) executor.rebuildRules();
  const rulesChanged = work.discovery ? executor.discover(work.discovery) : false;
  if (work.publishRules || rulesChanged) executor.publishRules();
  return work;
}
