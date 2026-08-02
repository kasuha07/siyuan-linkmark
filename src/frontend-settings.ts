import { DEFAULT_CACHE_POLICY, type CachePolicyFields } from "./resolver-contract";

export type Settings = {
  enabled: boolean;
  iconSize: number;
} & CachePolicyFields;

export const DISPLAY_PREFERENCE_FIELDS = ["enabled", "iconSize"] as const;

export const CACHE_POLICY_FIELDS = Object.keys(DEFAULT_CACHE_POLICY) as Array<keyof CachePolicyFields>;

export type CachePolicyField = (typeof CACHE_POLICY_FIELDS)[number];

export const defaultSettings: Settings = {
  enabled: true,
  iconSize: 1,
  ...DEFAULT_CACHE_POLICY,
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
