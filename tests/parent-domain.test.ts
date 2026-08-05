import { parse } from "tldts-experimental";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  InvalidShareDomainError,
  INVALID_SHARE_DOMAIN,
  isEligibleShareTarget,
  parentDomainOf,
  pickerScopeChoices,
  shareDomainFor,
  shareEligibilityOf,
  SHARED_PIN_EXCLUSIONS,
} from "../src/parent-domain";

vi.mock("tldts-experimental", async (importOriginal) => {
  const actual = await importOriginal<typeof import("tldts-experimental")>();
  return { ...actual, parse: vi.fn(actual.parse) };
});

const parseMock = vi.mocked(parse);

beforeEach(() => parseMock.mockClear());

describe("host classification cache", () => {
  it("reuses eligible, ineligible, and invalid original hostname inputs", () => {
    expect(shareEligibilityOf("memo-eligible.example.dev")).toEqual({
      eligible: true,
      shareDomain: "example.dev",
    });
    expect(parentDomainOf("memo-eligible.example.dev")).toBe("example.dev");
    expect(shareEligibilityOf("memo-private.github.io")).toEqual({
      eligible: false,
      reason: "private-suffix-family",
    });
    expect(parentDomainOf("memo-private.github.io")).toBeUndefined();
    expect(shareEligibilityOf("memo-invalid-unknownxyz")).toEqual({ eligible: false, reason: "public-suffix" });
    expect(shareDomainFor("memo-invalid-unknownxyz")).toBeNull();

    expect(parseMock).toHaveBeenCalledTimes(3);
  });

  it("refreshes recency and evicts the least-recent input after 1,024 entries", () => {
    const retained = "lru-retained.example.dev";
    expect(parentDomainOf(retained)).toBe("example.dev");
    for (let index = 0; index < 1_023; index += 1) {
      parentDomainOf(`lru-fill-${index}.example.dev`);
    }
    expect(parentDomainOf(retained)).toBe("example.dev");
    parentDomainOf("lru-overflow.example.dev");
    expect(parentDomainOf(retained)).toBe("example.dev");
    expect(parseMock.mock.calls.filter(([hostname]) => hostname === retained)).toHaveLength(1);

    const evicted = "lru-fill-0.example.dev";
    parentDomainOf(evicted);
    expect(parseMock.mock.calls.filter(([hostname]) => hostname === evicted)).toHaveLength(2);
  });
});

describe("parentDomainOf", () => {
  it("returns no parent for registrable domains without one", () => {
    expect(parentDomainOf("example.dev")).toBeUndefined();
    expect(parentDomainOf("example.co.uk")).toBeUndefined();
    expect(parentDomainOf("localhost")).toBeUndefined();
  });

  it("returns exactly the one registrable parent for subdomains", () => {
    expect(parentDomainOf("sub.example.dev")).toBe("example.dev");
    expect(parentDomainOf("a.b.example.dev")).toBe("example.dev");
    expect(parentDomainOf("sub.example.co.uk")).toBe("example.co.uk");
  });

  it("treats the www label as an ordinary subdomain", () => {
    expect(parentDomainOf("www.example.dev")).toBe("example.dev");
    expect(parentDomainOf("www.example.co.uk")).toBe("example.co.uk");
    expect(parentDomainOf("www.sub.example.dev")).toBe("example.dev");
  });

  it("never returns a PSL public suffix", () => {
    expect(parentDomainOf("github.io")).toBeUndefined();
    expect(parentDomainOf("pages.dev")).toBeUndefined();
    expect(parentDomainOf("appspot.com")).toBeUndefined();
    expect(parentDomainOf("foo.github.io")).toBeUndefined();
    expect(parentDomainOf("www.github.io")).toBeUndefined();
  });

  it("stops probing at a tenant eTLD+1 beneath a PSL Private suffix", () => {
    expect(parentDomainOf("a.foo.github.io")).toBe("foo.github.io");
    expect(parentDomainOf("x.y.pages.dev")).toBe("y.pages.dev");
  });

  it("keeps probing bounded at the eTLD+1 even inside reviewed exclusions", () => {
    expect(parentDomainOf("docs.qq.com")).toBe("qq.com");
    expect(parentDomainOf("docs.google.com")).toBe("google.com");
    expect(parentDomainOf("x.feishu.cn")).toBe("feishu.cn");
  });

  it("rejects addresses, special-use, and malformed domains", () => {
    expect(parentDomainOf("192.168.1.1")).toBeUndefined();
    expect(parentDomainOf("example.dev:8080")).toBeUndefined();
    expect(parentDomainOf("::1")).toBeUndefined();
    expect(parentDomainOf("[::1]")).toBeUndefined();
    expect(parentDomainOf("example..dev")).toBeUndefined();
    expect(parentDomainOf("foo.local")).toBeUndefined();
    expect(parentDomainOf("foo.onion")).toBeUndefined();
    expect(parentDomainOf("x.home.arpa")).toBeUndefined();
    expect(parentDomainOf("foo.alt")).toBeUndefined();
    expect(parentDomainOf("example.com")).toBeUndefined();
    expect(parentDomainOf("www.example.net")).toBeUndefined();
    expect(parentDomainOf("x.6tisch.arpa")).toBeUndefined();
  });

  it("normalizes case and IDN spelling", () => {
    expect(parentDomainOf("SUB.EXAMPLE.DEV")).toBe("example.dev");
    expect(parentDomainOf("www.MÜNCHEN.de")).toBe("xn--mnchen-3ya.de");
  });
});

describe("shareDomainFor", () => {
  it("keeps the eTLD+1 itself when no parent exists", () => {
    expect(shareDomainFor("example.dev")).toBe("example.dev");
    expect(shareDomainFor("example.co.uk")).toBe("example.co.uk");
  });

  it("derives the single PSL eTLD+1", () => {
    expect(shareDomainFor("sub.example.dev")).toBe("example.dev");
    expect(shareDomainFor("a.b.example.dev")).toBe("example.dev");
    expect(shareDomainFor("sub.example.co.uk")).toBe("example.co.uk");
  });

  it("drops the www label to the registrable domain", () => {
    expect(shareDomainFor("www.example.dev")).toBe("example.dev");
    expect(shareDomainFor("www.example.co.uk")).toBe("example.co.uk");
    expect(shareDomainFor("www.sub.example.dev")).toBe("example.dev");
  });

  it("keeps tenant eTLD+1s under PSL Private suffixes", () => {
    expect(shareDomainFor("foo.github.io")).toBe("foo.github.io");
    expect(shareDomainFor("www.github.io")).toBe("www.github.io");
    expect(shareDomainFor("a.foo.github.io")).toBe("foo.github.io");
    expect(shareDomainFor("foo.pages.dev")).toBe("foo.pages.dev");
    expect(shareDomainFor("foo.appspot.com")).toBe("foo.appspot.com");
  });

  it("returns null for bare public suffixes", () => {
    expect(shareDomainFor("github.io")).toBeNull();
    expect(shareDomainFor("pages.dev")).toBeNull();
    expect(shareDomainFor("appspot.com")).toBeNull();
    expect(shareDomainFor("co.uk")).toBeNull();
  });

  it("normalizes IDN hostnames to punycode", () => {
    expect(shareDomainFor("münchen.de")).toBe("xn--mnchen-3ya.de");
    expect(shareDomainFor("www.münchen.de")).toBe("xn--mnchen-3ya.de");
    expect(shareDomainFor("BÜCHER.example")).toBeNull();
  });

  it("rejects addresses, special-use, and malformed labels", () => {
    expect(shareDomainFor("127.0.0.1")).toBeNull();
    expect(shareDomainFor("example.dev:8080")).toBeNull();
    expect(shareDomainFor("localhost")).toBeNull();
    expect(shareDomainFor("www.localhost")).toBeNull();
    expect(shareDomainFor("a..example.dev")).toBeNull();
    expect(shareDomainFor("foo_bar.dev")).toBeNull();
    expect(shareDomainFor("foo.onion")).toBeNull();
    expect(shareDomainFor("x.home.arpa")).toBeNull();
    expect(shareDomainFor("foo.alt")).toBeNull();
    expect(shareDomainFor("example.com")).toBeNull();
    expect(shareDomainFor("sub.example.org")).toBeNull();
  });
});

describe("shareEligibilityOf", () => {
  it("marks an ICANN eTLD+1 scope as eligible with its share domain", () => {
    expect(shareEligibilityOf("example.dev")).toEqual({ eligible: true, shareDomain: "example.dev" });
    expect(shareEligibilityOf("sub.example.dev")).toEqual({ eligible: true, shareDomain: "example.dev" });
    expect(shareEligibilityOf("example.co.uk")).toEqual({ eligible: true, shareDomain: "example.co.uk" });
    expect(shareEligibilityOf("www.example.dev")).toEqual({ eligible: true, shareDomain: "example.dev" });
  });

  it("rejects scopes beneath PSL Private-suffix families", () => {
    expect(shareEligibilityOf("foo.github.io")).toEqual({ eligible: false, reason: "private-suffix-family" });
    expect(shareEligibilityOf("a.foo.github.io")).toEqual({ eligible: false, reason: "private-suffix-family" });
    expect(shareEligibilityOf("foo.pages.dev")).toEqual({ eligible: false, reason: "private-suffix-family" });
    expect(shareEligibilityOf("foo.appspot.com")).toEqual({ eligible: false, reason: "private-suffix-family" });
  });

  it("rejects reviewed Shared-pin exclusion boundaries", () => {
    for (const host of [
      "qq.com", "docs.qq.com",
      "google.com", "docs.google.com",
      "feishu.cn", "x.feishu.cn",
      "larksuite.com", "x.larksuite.com",
      "nocode.host", "x.nocode.host",
    ]) {
      expect(shareEligibilityOf(host)).toEqual({ eligible: false, reason: "reviewed-exclusion" });
    }
  });

  it("rejects bare public suffixes", () => {
    expect(shareEligibilityOf("github.io")).toEqual({ eligible: false, reason: "public-suffix" });
    expect(shareEligibilityOf("co.uk")).toEqual({ eligible: false, reason: "public-suffix" });
  });

  it("applies PSL wildcard and exception rules", () => {
    expect(shareEligibilityOf("foo.kawasaki.jp")).toEqual({ eligible: false, reason: "public-suffix" });
    expect(shareEligibilityOf("x.foo.kawasaki.jp")).toEqual({ eligible: true, shareDomain: "x.foo.kawasaki.jp" });
    expect(shareEligibilityOf("city.kawasaki.jp")).toEqual({ eligible: true, shareDomain: "city.kawasaki.jp" });
    expect(parentDomainOf("x.city.kawasaki.jp")).toBe("city.kawasaki.jp");
    expect(shareEligibilityOf("foo.ck")).toEqual({ eligible: false, reason: "public-suffix" });
    expect(parentDomainOf("a.www.ck")).toBe("www.ck");
  });

  it("rejects IP literals and special-use names", () => {
    expect(shareEligibilityOf("127.0.0.1")).toEqual({ eligible: false, reason: "ip-address" });
    expect(shareEligibilityOf("[::1]")).toEqual({ eligible: false, reason: "ip-address" });
    expect(shareEligibilityOf("localhost")).toEqual({ eligible: false, reason: "special-use" });
    expect(shareEligibilityOf("www.localhost")).toEqual({ eligible: false, reason: "special-use" });
    expect(shareEligibilityOf("foo.local")).toEqual({ eligible: false, reason: "special-use" });
    expect(shareEligibilityOf("foo.onion")).toEqual({ eligible: false, reason: "special-use" });
    expect(shareEligibilityOf("x.home.arpa")).toEqual({ eligible: false, reason: "special-use" });
    expect(shareEligibilityOf("foo.alt")).toEqual({ eligible: false, reason: "special-use" });
    expect(shareEligibilityOf("example.com")).toEqual({ eligible: false, reason: "special-use" });
    expect(shareEligibilityOf("www.example.net")).toEqual({ eligible: false, reason: "special-use" });
  });

  it("rejects malformed values and values without a registrable domain", () => {
    expect(shareEligibilityOf("a..example.dev")).toEqual({ eligible: false, reason: "malformed" });
    expect(shareEligibilityOf("example.dev:8080")).toEqual({ eligible: false, reason: "malformed" });
    expect(shareEligibilityOf("unknownxyz")).toEqual({ eligible: false, reason: "public-suffix" });
  });
});

describe("isEligibleShareTarget", () => {
  it("accepts only exactly a non-public-suffix eTLD+1 outside exclusions", () => {
    expect(isEligibleShareTarget("example.dev")).toBe(true);
    expect(isEligibleShareTarget("example.co.uk")).toBe(true);
    expect(isEligibleShareTarget("www.example.dev")).toBe(false);
    expect(isEligibleShareTarget("a.b.example.dev")).toBe(false);
    expect(isEligibleShareTarget("foo.github.io")).toBe(false);
    expect(isEligibleShareTarget("github.io")).toBe(false);
    expect(isEligibleShareTarget("qq.com")).toBe(false);
    expect(isEligibleShareTarget("127.0.0.1")).toBe(false);
    expect(isEligibleShareTarget("example.com")).toBe(false);
    expect(isEligibleShareTarget("foo.onion")).toBe(false);
    expect(isEligibleShareTarget("x.home.arpa")).toBe(false);
  });
});

describe("pickerScopeChoices", () => {
  it("offers the shared choice only for an eligible parent", () => {
    expect(pickerScopeChoices({ domain: "sub.example.dev" })).toEqual([
      { kind: "domain" },
      { kind: "subdomains", shareDomain: "example.dev" },
    ]);
    expect(pickerScopeChoices({ domain: "a.b.example.dev" })).toEqual([
      { kind: "domain" },
      { kind: "subdomains", shareDomain: "example.dev" },
    ]);
  });

  it("keeps Current Type and Current Domain for route scopes", () => {
    expect(pickerScopeChoices({ domain: "sub.example.dev", routeKey: "doc" })).toEqual([
      { kind: "type" },
      { kind: "domain" },
      { kind: "subdomains", shareDomain: "example.dev" },
    ]);
    expect(pickerScopeChoices({ domain: "example.dev", routeKey: "doc" })).toEqual([
      { kind: "type" },
      { kind: "domain" },
    ]);
  });

  it("never exposes the shared choice for PSL Private-suffix tenants", () => {
    expect(pickerScopeChoices({ domain: "foo.github.io" })).toEqual([{ kind: "domain" }]);
    expect(pickerScopeChoices({ domain: "a.foo.github.io" })).toEqual([{ kind: "domain" }]);
    expect(pickerScopeChoices({ domain: "www.github.io" })).toEqual([{ kind: "domain" }]);
  });

  it("never exposes the shared choice inside reviewed exclusions", () => {
    expect(pickerScopeChoices({ domain: "docs.qq.com", routeKey: "doc" })).toEqual([
      { kind: "type" },
      { kind: "domain" },
    ]);
    expect(pickerScopeChoices({ domain: "docs.google.com", routeKey: "document" })).toEqual([
      { kind: "type" },
      { kind: "domain" },
    ]);
    expect(pickerScopeChoices({ domain: "x.feishu.cn", routeKey: "docx" })).toEqual([
      { kind: "type" },
      { kind: "domain" },
    ]);
    expect(pickerScopeChoices({ domain: "nocode.host", routeKey: "site-abc123" })).toEqual([
      { kind: "type" },
      { kind: "domain" },
    ]);
  });

  it("offers no shared choice without a parent", () => {
    expect(pickerScopeChoices({ domain: "example.dev" })).toEqual([{ kind: "domain" }]);
    expect(pickerScopeChoices({ domain: "127.0.0.1" })).toEqual([{ kind: "domain" }]);
  });

  it("never exposes the shared choice for special-use names", () => {
    expect(pickerScopeChoices({ domain: "foo.onion" })).toEqual([{ kind: "domain" }]);
    expect(pickerScopeChoices({ domain: "x.home.arpa", routeKey: "doc" })).toEqual([
      { kind: "type" },
      { kind: "domain" },
    ]);
    expect(pickerScopeChoices({ domain: "foo.alt" })).toEqual([{ kind: "domain" }]);
    expect(pickerScopeChoices({ domain: "www.example.com" })).toEqual([{ kind: "domain" }]);
  });
});

describe("Shared-pin exclusion table", () => {
  it("covers the recognized multi-tenant boundaries with provenance", () => {
    expect(SHARED_PIN_EXCLUSIONS.map((entry) => entry.boundary)).toEqual([
      "qq.com", "google.com", "feishu.cn", "larksuite.com", "nocode.host",
    ]);
    for (const entry of SHARED_PIN_EXCLUSIONS) {
      expect(entry.platforms.length).toBeGreaterThan(0);
      expect(entry.provenance.length).toBeGreaterThan(0);
    }
  });
});

describe("InvalidShareDomainError", () => {
  it("carries the stable error identity", () => {
    const error = new InvalidShareDomainError();
    expect(error.message).toBe(INVALID_SHARE_DOMAIN);
    expect(error.name).toBe("InvalidShareDomainError");
  });
});
