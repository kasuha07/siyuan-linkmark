import { describe, expect, it, vi } from "vitest";
import { discoverLinks, linkElementsIn, linkHref } from "../src/frontend-link-discovery";
import { PERF_LINK_COUNT, PERF_SCOPE_COUNT, perfScenarioLinkUrls } from "../src/perf-scenario";
import { scopeForUrl } from "../src/url-scope";

describe("discoverLinks", () => {
  it("reads data-href before href", () => {
    const element = {
      dataset: { href: "https://data.example.dev" },
      getAttribute: vi.fn(() => "https://href.example.dev"),
    };

    expect(linkHref(element)).toBe("https://data.example.dev");
    expect(element.getAttribute).not.toHaveBeenCalled();
  });

  it("visits a matching root before descendants in DOM order", () => {
    const descendants = [{ id: "first" }, { id: "second" }];
    const root = {
      id: "root",
      matches: () => true,
      querySelectorAll: () => descendants,
    } as unknown as Element;

    expect([...linkElementsIn(root, "link")].map((element) => (element as unknown as { id: string }).id))
      .toEqual(["root", "first", "second"]);
  });


  it("memoizes valid and invalid href classification while reporting every element in order", () => {
    const classifyHref = vi.fn(scopeForUrl);
    const reported: Array<[number, string | null]> = [];
    const discovery = discoverLinks({
      candidates: [
        { element: 1, href: "not a URL" },
        { element: 2, href: "https://example.dev/first" },
        { element: 3, href: "not a URL" },
        { element: 4, href: "https://example.dev/first" },
      ],
      classifyHref,
      onElement: (element, scope) => reported.push([element, scope?.key ?? null]),
    });

    expect(classifyHref).toHaveBeenCalledTimes(2);
    expect(reported).toEqual([
      [1, null],
      [2, "example.dev"],
      [3, null],
      [4, "example.dev"],
    ]);
    expect(discovery).toEqual(new Map([
      ["example.dev", {
        scope: { key: "example.dev", domain: "example.dev" },
        targetUrl: "https://example.dev/first",
      }],
    ]));
  });

  it("retains the first target when different hrefs share one Link scope", () => {
    const discovery = discoverLinks({
      candidates: [
        { element: "root", href: "https://example.dev/first" },
        { element: "descendant", href: "https://example.dev/second" },
      ],
      onElement: () => undefined,
    });

    expect(discovery.get("example.dev")?.targetUrl).toBe("https://example.dev/first");
  });

  it("classifies 500 distinct hrefs once and reports all 2,000 scenario elements", () => {
    const urls = perfScenarioLinkUrls();
    const classifyHref = vi.fn(scopeForUrl);
    const onElement = vi.fn();
    const discovery = discoverLinks({
      candidates: urls.map((href, element) => ({ element, href })),
      classifyHref,
      onElement,
    });

    expect(new Set(urls).size).toBe(PERF_SCOPE_COUNT);
    expect(classifyHref).toHaveBeenCalledTimes(PERF_SCOPE_COUNT);
    expect(onElement).toHaveBeenCalledTimes(PERF_LINK_COUNT);
    expect(discovery.size).toBe(PERF_SCOPE_COUNT);
  });
});
