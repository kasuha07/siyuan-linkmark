import { describe, expect, it } from "vitest";
import { parentDomainOf, shareDomainFor } from "../src/parent-domain";

describe("parentDomainOf", () => {
  it("returns undefined for registrable domains without a parent", () => {
    expect(parentDomainOf("example.com")).toBeUndefined();
    expect(parentDomainOf("localhost")).toBeUndefined();
  });

  it("walks up to the immediate parent domain", () => {
    expect(parentDomainOf("sub.example.com")).toBe("example.com");
    expect(parentDomainOf("a.b.example.com")).toBe("b.example.com");
  });

  it("drops the www label before computing the parent", () => {
    expect(parentDomainOf("www.example.com")).toBeUndefined();
    expect(parentDomainOf("www.sub.example.com")).toBe("example.com");
  });

  it("rejects two-letter-country-code domains above a common second level", () => {
    expect(parentDomainOf("example.co.uk")).toBeUndefined();
    expect(parentDomainOf("www.example.co.uk")).toBeUndefined();
    expect(parentDomainOf("sub.example.co.uk")).toBe("example.co.uk");
  });

  it("rejects addresses and malformed domains", () => {
    expect(parentDomainOf("192.168.1.1")).toBeUndefined();
    expect(parentDomainOf("example.com:8080")).toBeUndefined();
    expect(parentDomainOf("::1")).toBeUndefined();
    expect(parentDomainOf("[::1]")).toBeUndefined();
    expect(parentDomainOf("example..com")).toBeUndefined();
  });

  it("normalizes case", () => {
    expect(parentDomainOf("SUB.EXAMPLE.COM")).toBe("example.com");
  });
});

describe("shareDomainFor", () => {
  it("keeps the domain itself when no parent exists", () => {
    expect(shareDomainFor("example.com")).toBe("example.com");
    expect(shareDomainFor("example.co.uk")).toBe("example.co.uk");
  });

  it("walks up to the parent domain", () => {
    expect(shareDomainFor("sub.example.com")).toBe("example.com");
    expect(shareDomainFor("a.b.example.com")).toBe("b.example.com");
    expect(shareDomainFor("sub.example.co.uk")).toBe("example.co.uk");
  });

  it("drops the www label to the registrable domain", () => {
    expect(shareDomainFor("www.example.com")).toBe("example.com");
    expect(shareDomainFor("www.example.co.uk")).toBe("example.co.uk");
    expect(shareDomainFor("www.sub.example.com")).toBe("example.com");
  });

  it("rejects addresses and malformed labels", () => {
    expect(shareDomainFor("127.0.0.1")).toBeNull();
    expect(shareDomainFor("example.com:8080")).toBeNull();
    expect(shareDomainFor("localhost")).toBeNull();
    expect(shareDomainFor("www.localhost")).toBeNull();
  });
});
