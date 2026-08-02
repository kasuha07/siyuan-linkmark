import { describe, expect, it } from "vitest";
import {
  CACHE_POLICY_FIELDS,
  DISPLAY_PREFERENCE_FIELDS,
  clamp,
  defaultSettings,
  mergeFrontendSettings,
  monogramSignature,
  pickCachePolicy,
} from "../src/frontend-settings";

describe("mergeFrontendSettings", () => {
  it("returns full defaults for empty, missing, or invalid stored values", () => {
    for (const stored of [undefined, null, "", 42, [], { monogramOverrides: null }]) {
      expect(mergeFrontendSettings(stored)).toEqual(defaultSettings);
    }
  });

  it("merges saved values over defaults", () => {
    const merged = mergeFrontendSettings({ enabled: false, cacheDays: 7 });
    expect(merged.enabled).toBe(false);
    expect(merged.cacheDays).toBe(7);
    expect(merged.providerPreset).toBe(defaultSettings.providerPreset);
  });

  it("merges monogram overrides without clobbering other overrides", () => {
    const merged = mergeFrontendSettings({
      monogramOverrides: {
        "example.com": { letter: "E", primary: "#111111", secondary: "#222222", text: "#FFFFFF", shape: "circle" },
      },
    });
    expect(merged.monogramOverrides["example.com"]?.letter).toBe("E");
    expect(merged.monogramOverrides).toEqual({
      "example.com": { letter: "E", primary: "#111111", secondary: "#222222", text: "#FFFFFF", shape: "circle" },
    });
  });
});

describe("settings field lists", () => {
  it("keeps display preference fields limited to the client-local pair", () => {
    expect(DISPLAY_PREFERENCE_FIELDS).toEqual(["enabled", "iconSize"]);
  });

  it("covers every cache policy field with a default and no display fields", () => {
    expect(CACHE_POLICY_FIELDS).toHaveLength(13);
    for (const key of CACHE_POLICY_FIELDS) {
      expect(defaultSettings[key], key).toBeDefined();
      expect(DISPLAY_PREFERENCE_FIELDS).not.toContain(key);
    }
  });

  it("picks exactly the cache policy fields from a settings object", () => {
    const policy = pickCachePolicy(defaultSettings);
    expect(Object.keys(policy).sort()).toEqual([...CACHE_POLICY_FIELDS].sort());
    expect(policy.cacheDays).toBe(30);
  });
});

describe("clamp", () => {
  it("clamps finite values to the range and falls back for non-finite values", () => {
    expect(clamp(1, 0.7, 1.8, 1)).toBe(1);
    expect(clamp(0.5, 0.7, 1.8, 1)).toBe(0.7);
    expect(clamp(9, 0.7, 1.8, 1)).toBe(1.8);
    expect(clamp(Number.NaN, 0.7, 1.8, 1)).toBe(1);
    expect(clamp(Number.POSITIVE_INFINITY, 0, 365, 30)).toBe(30);
  });
});

describe("monogramSignature", () => {
  it("changes when monogram styling changes and ignores unrelated settings", () => {
    const base = monogramSignature(defaultSettings);
    expect(monogramSignature({ ...defaultSettings, iconSize: 1.8 })).toBe(base);
    expect(monogramSignature({ ...defaultSettings, monogramPrimary: "#000000" })).not.toBe(base);
    expect(monogramSignature({
      ...defaultSettings,
      monogramOverrides: { "example.com": { letter: "E", primary: "#111111", secondary: "#222222", text: "#FFFFFF", shape: "circle" } },
    })).not.toBe(base);
  });
});
