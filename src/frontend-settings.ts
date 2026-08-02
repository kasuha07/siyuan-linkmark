import type {
  FallbackMode,
  MonogramColorMode,
  MonogramShape,
  MonogramStyle,
  ProviderPreset,
  ResolverMode,
} from "./icon-resolver";

export type MonogramOverride = Omit<MonogramStyle, "colorMode"> & { letter: string };

export type Settings = {
  enabled: boolean;
  pauseAutomaticFetch: boolean;
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
  iconSize: number;
  cacheDays: number;
};

export const DISPLAY_PREFERENCE_FIELDS = ["enabled", "iconSize"] as const;

export const CACHE_POLICY_FIELDS = [
  "pauseAutomaticFetch",
  "allowFullPageDiscovery",
  "provider",
  "providerPreset",
  "resolverMode",
  "fallbackMode",
  "monogramColorMode",
  "monogramPrimary",
  "monogramSecondary",
  "monogramText",
  "monogramShape",
  "monogramOverrides",
  "cacheDays",
] as const;

export type CachePolicyField = (typeof CACHE_POLICY_FIELDS)[number];

export const defaultSettings: Settings = {
  enabled: true,
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
  iconSize: 1,
  cacheDays: 30,
};

export function mergeFrontendSettings(stored: unknown): Settings {
  const saved = stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
  const partial = saved as Partial<Settings>;
  return {
    ...defaultSettings,
    ...partial,
    monogramOverrides: { ...defaultSettings.monogramOverrides, ...(partial.monogramOverrides ?? {}) },
  };
}

export function pickCachePolicy(settings: Settings): Pick<Settings, CachePolicyField> {
  const {
    pauseAutomaticFetch,
    allowFullPageDiscovery,
    provider,
    providerPreset,
    resolverMode,
    fallbackMode,
    monogramColorMode,
    monogramPrimary,
    monogramSecondary,
    monogramText,
    monogramShape,
    monogramOverrides,
    cacheDays,
  } = settings;
  return {
    pauseAutomaticFetch,
    allowFullPageDiscovery,
    provider,
    providerPreset,
    resolverMode,
    fallbackMode,
    monogramColorMode,
    monogramPrimary,
    monogramSecondary,
    monogramText,
    monogramShape,
    monogramOverrides,
    cacheDays,
  };
}

export function clamp(value: number, min: number, max: number, fallback: number) {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

export function monogramSignature(settings: Settings) {
  return JSON.stringify({
    colorMode: settings.monogramColorMode,
    primary: settings.monogramPrimary,
    secondary: settings.monogramSecondary,
    text: settings.monogramText,
    shape: settings.monogramShape,
    overrides: settings.monogramOverrides,
  });
}
