export type ResolverMode = "mainland" | "global" | "direct";
export type FallbackMode = "monogram" | "none";
export type ProviderPreset = "auto" | "faviconkit" | "faviconim" | "iconhorse" | "custom";
export type MonogramColorMode = "domain" | "custom";
export type MonogramShape = "rounded" | "circle" | "square";

export type MonogramStyle = {
  colorMode: MonogramColorMode;
  primary: string;
  secondary: string;
  text: string;
  shape: MonogramShape;
  letter?: string;
};

export type MonogramOverride = Omit<MonogramStyle, "colorMode"> & { letter: string };

export const RESOLVER_VERSION = 6;

export const MAX_ICON_BYTES = 2 * 1024 * 1024;

export type CachePolicyFields = {
  pauseAutomaticFetch?: boolean;
  allowFullPageDiscovery: boolean;
  provider: string;
  providerPreset: ProviderPreset;
  resolverMode: ResolverMode;
  fallbackMode: FallbackMode;
  monogramColorMode: MonogramColorMode;
  monogramPrimary: string;
  monogramSecondary: string;
  monogramText: string;
  monogramShape: MonogramShape;
  monogramOverrides: Record<string, MonogramOverride>;
  cacheDays: number;
};

export const DEFAULT_CACHE_POLICY: CachePolicyFields = {
  pauseAutomaticFetch: false,
  allowFullPageDiscovery: false,
  provider: "https://example.com/favicon/{domain}",
  providerPreset: "auto",
  resolverMode: "mainland",
  fallbackMode: "monogram",
  monogramColorMode: "domain",
  monogramPrimary: "#4F7CFF",
  monogramSecondary: "#745CFF",
  monogramText: "#FFFFFF",
  monogramShape: "rounded",
  monogramOverrides: {},
  cacheDays: 30,
};
