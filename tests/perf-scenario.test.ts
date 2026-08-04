import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PERF_DOMAIN_SCOPE_COUNT,
  PERF_LINK_COUNT,
  PERF_ROUTE_SCOPE_COUNT,
  PERF_SCOPE_COUNT,
  perfScenarioLinkUrls,
  perfScenarioScopes,
} from "../src/perf-scenario";
import { PERF_CACHE_VIEW_ENTRIES } from "../src/perf-scenario-definition.js";
import { isCacheEntryFresh } from "../src/frontend-cache-state";
import { RESOLVER_VERSION } from "../src/resolver-contract";
import { scopeForUrl } from "../src/url-scope";
import { largeCacheFixture } from "./perf-cache-fixture";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("perfScenarioScopes", () => {
  it("derives 500 distinct Link scopes with 480 domains and 20 route scopes", () => {
    const scopes = perfScenarioScopes();
    expect(scopes).toHaveLength(PERF_SCOPE_COUNT);
    expect(new Set(scopes.map((scope) => scope.key)).size).toBe(PERF_SCOPE_COUNT);
    const domains = scopes.filter((scope) => !scope.routeKey);
    const routes = scopes.filter((scope) => scope.routeKey);
    expect(domains).toHaveLength(PERF_DOMAIN_SCOPE_COUNT);
    expect(routes).toHaveLength(PERF_ROUTE_SCOPE_COUNT);
    expect(domains[0]).toEqual({ key: "perf-site-0.example.dev", domain: "perf-site-0.example.dev" });
    expect(routes[0]).toMatchObject({
      key: "nocode.host::site-p00000",
      domain: "nocode.host",
      routeKey: "site-p00000",
      pathPrefix: "/p00000",
      discoverPage: true,
    });
  });
});

describe("perfScenarioLinkUrls", () => {
  it("contains 2,000 links across 500 distinct hrefs and Link scopes with four copies each", () => {
    const urls = perfScenarioLinkUrls();
    expect(urls).toHaveLength(PERF_LINK_COUNT);
    const scopeKeys = urls.map((url) => scopeForUrl(url)?.key).filter((key): key is string => Boolean(key));
    expect(new Set(scopeKeys).size).toBe(PERF_SCOPE_COUNT);
    expect(new Set(urls).size).toBe(PERF_SCOPE_COUNT);
    const counts = new Map<string, number>();
    for (const key of scopeKeys) counts.set(key, (counts.get(key) ?? 0) + 1);
    for (const count of counts.values()) expect(count).toBe(4);
    expect(urls[0]).toBe("https://perf-site-0.example.dev/ref");
    expect(urls[urls.length - 1]).toBe("https://nocode.host/p00019");
  });
});

describe("largeCacheFixture", () => {
  const now = 5_000_000;

  it("builds a 10,000-entry view containing the 500 scenario scopes", () => {
    const cache = largeCacheFixture(now);
    expect(Object.keys(cache)).toHaveLength(PERF_CACHE_VIEW_ENTRIES);
    for (const url of perfScenarioLinkUrls()) {
      const scope = scopeForUrl(url);
      expect(cache[scope!.key]).toBeDefined();
    }
  });

  it("provides only fresh current entries for the render pipeline", () => {
    const cache = largeCacheFixture(now);
    for (const entry of Object.values(cache)) {
      expect(isCacheEntryFresh(entry, 30, now)).toBe(true);
      expect(entry.resolverVersion).toBe(RESOLVER_VERSION);
      expect(entry.url).toMatch(/^https:\/\/cdn\.perf\.example\.dev\//);
    }
  });

  it("is deterministic for a fixed clock", () => {
    expect(largeCacheFixture(now)).toEqual(largeCacheFixture(now));
  });

  it("resolves the route scopes through their own cache keys", () => {
    const cache = largeCacheFixture(now);
    const scope = scopeForUrl("https://nocode.host/p00019/ref-3")!;
    expect(cache[scope.key].domain).toBe("nocode.host");
    expect(cache[scope.key].routeKey).toBe("site-p00019");
    expect(cache[scope.key].pathPrefix).toBe("/p00019");
  });
});

describe("scenario generator script", () => {
  it("produces an importable Markdown artifact with exactly 2,000 links and 500 distinct scopes", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "linkmark-perf-scenario-"));
    try {
      const out = join(tmp, "scenario.md");
      execFileSync(process.execPath, [
        join(root, "scripts", "generate-perf-scenario.mjs"),
        "--out", out,
      ], { cwd: root, stdio: "pipe" });
      const markdown = await readFile(out, "utf8");
      const urls = [...markdown.matchAll(/\]\(<https:\/\/[^>]+>\)/g)].map((match) => match[0].slice(3, -2));
      expect(urls).toHaveLength(PERF_LINK_COUNT);
    const scopeKeys = urls.map((url) => scopeForUrl(url)?.key).filter((key): key is string => Boolean(key));
      expect(new Set(scopeKeys).size).toBe(PERF_SCOPE_COUNT);
      expect(urls).toEqual(perfScenarioLinkUrls());
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 30_000);
});
