# Bound parent scopes with the Public Suffix List

**Status: accepted.** Linkmark will replace its short second-level suffix heuristic with the `tldts` PSL resolver, using its bundled ICANN and Private data with `allowPrivateDomains: true` and special-use-domain detection. The list is updated only through normal dependency updates and releases, never by runtime download; this makes eTLD+1 calculation reproducible while covering country-code, wildcard, exception, and multi-tenant hosted suffixes. The [Public Suffix List](https://publicsuffix.org/list/) defines a public suffix as the part of a DNS name not controlled by an individual registrant, and [`tldts`](https://www.npmjs.com/package/tldts) exposes its ICANN and Private PSL parsing in TypeScript.

## Decision

- A **Registrable parent** is the single PSL-derived eTLD+1, only when it differs from the current hostname. It is the sole parent target for both parent-domain probing and a prospective shared pin; Linkmark does not walk immediate-parent chains. Thus `a.b.example.com` has only `example.com`, `foo.example.co.uk` has only `example.co.uk`, and `foo.github.io` has no parent.
- A public suffix is never a valid pin target. An `includeSubdomains` pin is valid only when its target is exactly a non-public-suffix eTLD+1.
- PSL Private-suffix families do not offer `includeSubdomains`, including a deeper hostname whose eTLD+1 is a tenant host such as `foo.github.io`. Exact current-type and current-domain pins remain available for that tenant. Parent-domain probing still stops at the PSL eTLD+1 and never reaches the provider suffix.
- A small reviewed exclusion table also forbids shared pins for the eTLD+1 boundaries containing Linkmark's already recognized platform hosts: `docs.qq.com`, `docs.google.com`, `*.feishu.cn`, `*.larksuite.com`, and `nocode.host`. The table is a default-deny policy with no user bypass; every future entry needs provenance, a documented match range, and regression coverage. It complements PSL rather than replacing it.
- The frontend hides unavailable sharing choices, while the cache authority independently validates Share eligibility. A stale or direct RPC request for an ineligible shared pin receives `invalid-share-domain`; it is never silently converted into an exact-domain pin.

## Legacy cache handling

During cache-authority initialization, Linkmark removes every existing pin whose target is a public suffix and every `includeSubdomains` pin that is not Share eligible, including PSL Private-suffix and reviewed-exclusion matches. It writes the pruned cache index successfully before deleting affected private icon payloads. If that index write fails, initialization fails without deleting the old records or payloads. This deliberate safety exception to ordinary pinned-icon retention prevents legacy data from continuing to affect unrelated tenants.

## Consequences

Implementation must add PSL, shared-scope, kernel-rejection, and migration regressions. The test matrix must cover `github.io`, `pages.dev`, and `appspot.com`; country and PSL wildcard/exception cases; IP, special-use, malformed, and IDN hosts; one-hop eTLD+1 probing; rejected direct RPC calls; hidden frontend controls; legacy-record deletion and index-write failure. Both frontend and kernel bundles must consume the same shared eligibility logic so a UI decision cannot diverge from cache-authority enforcement.
