import { describe, expect, it } from "vitest";
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

describe("parentDomainOf", () => {
  it("returns no parent for registrable domains without one", () => {
    expect(parentDomainOf("example.com")).toBeUndefined();
    expect(parentDomainOf("example.co.uk")).toBeUndefined();
    expect(parentDomainOf("localhost")).toBeUndefined();
  });

  it("returns exactly the one registrable parent for subdomains", () => {
    expect(parentDomainOf("sub.example.com")).toBe("example.com");
    expect(parentDomainOf("a.b.example.com")).toBe("example.com");
    expect(parentDomainOf("sub.example.co.uk")).toBe("example.co.uk");
  });

  it("treats the www label as an ordinary subdomain", () => {
    expect(parentDomainOf("www.example.com")).toBe("example.com");
    expect(parentDomainOf("www.example.co.uk")).toBe("example.co.uk");
    expect(parentDomainOf("www.sub.example.com")).toBe("example.com");
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
    expect(parentDomainOf("example.com:8080")).toBeUndefined();
    expect(parentDomainOf("::1")).toBeUndefined();
    expect(parentDomainOf("[::1]")).toBeUndefined();
    expect(parentDomainOf("example..com")).toBeUndefined();
    expect(parentDomainOf("foo.local")).toBeUndefined();
  });

  it("normalizes case and IDN spelling", () => {
    expect(parentDomainOf("SUB.EXAMPLE.COM")).toBe("example.com");
    expect(parentDomainOf("www.MÜNCHEN.de")).toBe("xn--mnchen-3ya.de");
  });
});

describe("shareDomainFor", () => {
  it("keeps the eTLD+1 itself when no parent exists", () => {
    expect(shareDomainFor("example.com")).toBe("example.com");
    expect(shareDomainFor("example.co.uk")).toBe("example.co.uk");
  });

  it("derives the single PSL eTLD+1", () => {
    expect(shareDomainFor("sub.example.com")).toBe("example.com");
    expect(shareDomainFor("a.b.example.com")).toBe("example.com");
    expect(shareDomainFor("sub.example.co.uk")).toBe("example.co.uk");
  });

  it("drops the www label to the registrable domain", () => {
    expect(shareDomainFor("www.example.com")).toBe("example.com");
    expect(shareDomainFor("www.example.co.uk")).toBe("example.co.uk");
    expect(shareDomainFor("www.sub.example.com")).toBe("example.com");
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
    expect(shareDomainFor("example.com:8080")).toBeNull();
    expect(shareDomainFor("localhost")).toBeNull();
    expect(shareDomainFor("www.localhost")).toBeNull();
    expect(shareDomainFor("a..example.com")).toBeNull();
    expect(shareDomainFor("foo_bar.com")).toBeNull();
  });
});

describe("shareEligibilityOf", () => {
  it("marks an ICANN eTLD+1 scope as eligible with its share domain", () => {
    expect(shareEligibilityOf("example.com")).toEqual({ eligible: true, shareDomain: "example.com" });
    expect(shareEligibilityOf("sub.example.com")).toEqual({ eligible: true, shareDomain: "example.com" });
    expect(shareEligibilityOf("example.co.uk")).toEqual({ eligible: true, shareDomain: "example.co.uk" });
    expect(shareEligibilityOf("www.example.com")).toEqual({ eligible: true, shareDomain: "example.com" });
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
  });

  it("rejects malformed values and values without a registrable domain", () => {
    expect(shareEligibilityOf("a..example.com")).toEqual({ eligible: false, reason: "malformed" });
    expect(shareEligibilityOf("example.com:8080")).toEqual({ eligible: false, reason: "malformed" });
    expect(shareEligibilityOf("unknownxyz")).toEqual({ eligible: false, reason: "public-suffix" });
  });
});

describe("isEligibleShareTarget", () => {
  it("accepts only exactly a non-public-suffix eTLD+1 outside exclusions", () => {
    expect(isEligibleShareTarget("example.com")).toBe(true);
    expect(isEligibleShareTarget("example.co.uk")).toBe(true);
    expect(isEligibleShareTarget("www.example.com")).toBe(false);
    expect(isEligibleShareTarget("a.b.example.com")).toBe(false);
    expect(isEligibleShareTarget("foo.github.io")).toBe(false);
    expect(isEligibleShareTarget("github.io")).toBe(false);
    expect(isEligibleShareTarget("qq.com")).toBe(false);
    expect(isEligibleShareTarget("127.0.0.1")).toBe(false);
  });
});

describe("pickerScopeChoices", () => {
  it("offers the shared choice only for an eligible parent", () => {
    expect(pickerScopeChoices({ domain: "sub.example.com" })).toEqual([
      { kind: "domain" },
      { kind: "subdomains", shareDomain: "example.com" },
    ]);
    expect(pickerScopeChoices({ domain: "a.b.example.com" })).toEqual([
      { kind: "domain" },
      { kind: "subdomains", shareDomain: "example.com" },
    ]);
  });

  it("keeps Current Type and Current Domain for route scopes", () => {
    expect(pickerScopeChoices({ domain: "sub.example.com", routeKey: "doc" })).toEqual([
      { kind: "type" },
      { kind: "domain" },
      { kind: "subdomains", shareDomain: "example.com" },
    ]);
    expect(pickerScopeChoices({ domain: "example.com", routeKey: "doc" })).toEqual([
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
    expect(pickerScopeChoices({ domain: "example.com" })).toEqual([{ kind: "domain" }]);
    expect(pickerScopeChoices({ domain: "127.0.0.1" })).toEqual([{ kind: "domain" }]);
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
