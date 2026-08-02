import { describe, expect, it } from "vitest";
import { isAuthenticationRedirect, isSafePublicTarget } from "../src/url-safety";

describe("isSafePublicTarget", () => {
  it("accepts public hostnames", () => {
    expect(isSafePublicTarget(new URL("https://example.com/"))).toBe(true);
    expect(isSafePublicTarget(new URL("http://github.com/"))).toBe(true);
    expect(isSafePublicTarget(new URL("https://example.com:8443/"))).toBe(true);
  });

  it("rejects non-HTTP protocols", () => {
    expect(isSafePublicTarget(new URL("ftp://example.com/"))).toBe(false);
    expect(isSafePublicTarget(new URL("file:///tmp/icon.png"))).toBe(false);
    expect(isSafePublicTarget(new URL("data:image/png;base64,AA=="))).toBe(false);
  });

  it("rejects local hostnames", () => {
    expect(isSafePublicTarget(new URL("http://localhost/"))).toBe(false);
    expect(isSafePublicTarget(new URL("http://foo.localhost/"))).toBe(false);
    expect(isSafePublicTarget(new URL("http://bar.local/"))).toBe(false);
  });

  it("accepts hostnames that merely contain a local suffix", () => {
    expect(isSafePublicTarget(new URL("https://foo.localhost.com/"))).toBe(true);
  });

  it("rejects private, loopback, and reserved IPv4 ranges", () => {
    for (const host of [
      "10.0.0.1",
      "127.0.0.1",
      "0.0.0.0",
      "169.254.1.1",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.0.1",
      "100.64.0.1",
      "100.127.255.254",
      "192.0.0.1",
      "192.0.2.1",
      "192.2.0.1",
      "198.18.0.1",
      "198.19.255.255",
      "224.0.0.1",
      "239.1.1.1",
      "255.255.255.255",
    ]) {
      expect(isSafePublicTarget(new URL(`http://${host}/`))).toBe(false);
    }
  });

  it("accepts public IPv4 addresses", () => {
    for (const host of ["8.8.8.8", "203.0.113.5", "172.32.0.1", "100.128.0.1", "198.20.0.1", "1.2.3.4"]) {
      expect(isSafePublicTarget(new URL(`http://${host}/`))).toBe(true);
    }
  });

  it("rejects IPv6 loopback, unspecified, link-local, and unique-local addresses", () => {
    for (const host of [
      "[::1]",
      "[::]",
      "[fe80::1]",
      "[fe90::1]",
      "[feb0::1]",
      "[fc00::1]",
      "[fd12:3456:789a::1]",
      "[::ffff:192.168.1.1]",
      "[::ffff:c0a8:0101]",
    ]) {
      expect(isSafePublicTarget(new URL(`http://${host}/`))).toBe(false);
    }
  });

  it("accepts public IPv6 addresses and mapped IPv4 addresses", () => {
    for (const host of ["[2606:4700:4700::1111]", "[::ffff:8.8.8.8]", "[::ffff:0808:0808]"]) {
      expect(isSafePublicTarget(new URL(`http://${host}/`))).toBe(true);
    }
  });
});

describe("isAuthenticationRedirect", () => {
  const requested = new URL("https://example.com/icon.png");

  it("returns false without a final URL or for the same URL", () => {
    expect(isAuthenticationRedirect(requested)).toBe(false);
    expect(isAuthenticationRedirect(requested, "https://example.com/icon.png")).toBe(false);
  });

  it("returns true for a cross-origin redirect", () => {
    expect(isAuthenticationRedirect(requested, "https://cdn.other.com/icon.png")).toBe(true);
    expect(isAuthenticationRedirect(requested, "https://example.com:8443/icon.png")).toBe(true);
  });

  it("returns true for accounts, passport, and login hosts", () => {
    expect(isAuthenticationRedirect(requested, "https://accounts.example.com/icon.png")).toBe(true);
    expect(isAuthenticationRedirect(requested, "https://passport.example.com/login")).toBe(true);
    expect(isAuthenticationRedirect(requested, "https://login.example.com/x")).toBe(true);
  });

  it("returns false for hosts that merely contain an auth prefix", () => {
    const sameOrigin = new URL("https://myaccounts.example.com/icon.png");
    expect(isAuthenticationRedirect(sameOrigin, "https://myaccounts.example.com/other.png")).toBe(false);
  });

  it("returns true for login, sign-in, and auth paths", () => {
    for (const path of ["/login", "/signin", "/sign-in", "/auth", "/auth/callback", "/x/login/y"]) {
      expect(isAuthenticationRedirect(requested, `https://example.com${path}`)).toBe(true);
    }
  });

  it("returns false for ordinary paths including partial matches", () => {
    expect(isAuthenticationRedirect(requested, "https://example.com/icon.png")).toBe(false);
    expect(isAuthenticationRedirect(requested, "https://example.com/loginpage")).toBe(false);
    expect(isAuthenticationRedirect(requested, "https://example.com/not-auth")).toBe(false);
  });

  it("matches host and path case-insensitively", () => {
    expect(isAuthenticationRedirect(requested, "HTTPS://EXAMPLE.COM/Login")).toBe(true);
  });

  it("treats an unparseable final URL as an authentication redirect", () => {
    expect(isAuthenticationRedirect(requested, "http://[")).toBe(true);
  });
});
