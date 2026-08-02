## Problem Statement

Linkmark currently infers a parent domain from a short hand-maintained list of second-level labels. This treats many public suffixes and multi-tenant hosted boundaries as ordinary parents. A pinned icon or parent-domain probe can therefore reach a hostname shared by unrelated tenants, such as `github.io`, `pages.dev`, or `appspot.com`; country-code domains, Public Suffix List (PSL) wildcard rules, and exception rules are also incomplete.

Users need a predictable way to pin an icon to the Current Type or Current Domain without accidentally applying it to an unrelated tenant population. A Share-pin domain and a Registrable parent must mean the same PSL-derived eTLD+1 everywhere Linkmark makes a pin, cache-match, or probing decision.

## Solution

Use release-bundled PSL data, including the ICANN and Private sections, to derive a Registrable parent and Share eligibility. Linkmark will expose at most one parent: the current hostname's eTLD+1 when it differs from the hostname. It will never make a public suffix a pin target, walk an intermediate parent chain, or offer subdomain sharing for PSL Private-suffix families or reviewed Shared-pin exclusions.

The frontend will show only valid scope choices; the Cache authority will enforce the same eligibility independently. On startup, the Cache authority will remove legacy Pinned icons whose scope is no longer safe, writing the cache index before deleting any affected Private icon route payload. The behavior and rationale are governed by ADR 0011.

## User Stories

1. As a Linkmark user, I want a parent-domain icon option to mean the real registrable domain, so that I do not accidentally select a public suffix.
2. As a user pinning an icon for `foo.github.io`, I want Current Domain to remain available, so that I can customize the icon for my own tenant.
3. As a user pinning an icon for `foo.github.io`, I do not want an Apply to all subdomains option, so that my choice cannot affect unrelated hosted tenants.
4. As a user opening a link beneath a PSL Private suffix, I want Linkmark to keep the probe inside the tenant's eTLD+1, so that it never requests the hosting provider's suffix host as a fallback.
5. As a user opening `a.b.example.com`, I want any parent-domain fallback to use only `example.com`, so that intermediate labels are not mistaken for an ownership boundary.
6. As a user of a Japanese, Australian, or other country-code domain, I want the same correct scope behavior, so that Linkmark is not limited to a small English-centric suffix list.
7. As a user with an internationalized domain name, I want its scope to be normalized and validated consistently, so that visual spelling does not bypass the sharing boundary.
8. As a user opening an IP address, localhost, special-use, or malformed host, I want no parent or shared-pin option, so that non-registrable addresses cannot acquire a false domain scope.
9. As a user of Tencent Docs, Google Docs, Feishu, Lark, or NoCode-hosted content, I do not want a broad shared-pin option, so that a platform's multi-tenant structure is never treated as my own DNS hierarchy.
10. As a user with an existing safe exact Pinned icon, I want it retained through the upgrade, so that tightening scope rules does not discard unrelated customizations.
11. As a user with an old unsafe Pinned icon, I want Linkmark to stop applying it immediately, so that it cannot continue to affect unrelated sites after the upgrade.
12. As a user whose legacy unsafe pin is removed, I want any associated Private icon route payload removed only after the cache index is safely updated, so that Linkmark does not leave a cached entry pointing to missing bytes.
13. As a frontend user on an older plugin window, I want an invalid sharing request to fail explicitly, so that my chosen action is never silently changed into a different pin scope.
14. As a workspace administrator, I want Cache authority enforcement rather than frontend-only checks, so that every connected client observes the same sharing policy.
15. As an independent maintainer, I want PSL data to be bundled with each release, so that domain-boundary results are reproducible and no runtime suffix-list request leaks browsing context or affects availability.
16. As an independent maintainer, I want a compact reviewed exclusion table with provenance, so that known multi-tenant platform boundaries can be denied without guessing from arbitrary popular domains.
17. As an independent maintainer, I want future exclusion-table additions to require a documented host range and regression coverage, so that the policy remains narrow and auditable.
18. As an implementation agent, I want all parent probing, frontend scope selection, cache matching, pin creation, and legacy cleanup to use one Share eligibility definition, so that the bundles cannot drift.
19. As an implementation agent, I want failed index persistence during migration to preserve the old cache and payloads, so that startup never produces a half-cleaned cache.
20. As a release maintainer, I want the PSL parser update represented by normal package and lockfile changes, so that the data revision is reviewed and delivered with the plugin.

## Implementation Decisions

- Add `tldts` as the sole PSL parser and configure every calculation to include ICANN and Private suffixes plus special-use-domain detection. Do not implement or download a custom suffix list at runtime. The parser dependency is updated only through reviewed dependency and release changes.

- Replace the current heuristic with one shared domain-scope policy. It normalizes a hostname, rejects IP literals, special-use names, malformed values, bare public suffixes, and values without a registrable domain, and derives the eTLD+1 from PSL data.

- Define Registrable parent as exactly one eTLD+1, only when it differs from the current hostname. Parent probing obtains candidates from that one hostname after exact-host candidates fail; it neither probes immediate intermediate parents nor crosses the eTLD+1 boundary.

- Define Share eligibility as a separate policy result rather than an inferred string. A target is eligible only when it is exactly a non-public-suffix eTLD+1, is not under a PSL Private-suffix family, and does not match a reviewed Shared-pin exclusion.

- The initial reviewed Shared-pin exclusions cover the eTLD+1 boundaries reached from Linkmark's recognized Tencent Docs, Google Docs, Feishu, Lark, and NoCode host patterns. The implementation documents each source and match range. The table has no user override and is not a general website blacklist.

- Retain exact Current Type and Current Domain pinning wherever the existing pin flow accepts the hostname, including a tenant eTLD+1 such as `foo.github.io`. Only the broader `includeSubdomains` operation is restricted by Share eligibility.

- Make the Cache authority validate Share eligibility for every pin entry point. Requests that ask for an invalid shared pin fail with the stable `invalid-share-domain` error; they must not be downgraded to an exact pin.

- Make the frontend derive picker choices from the shared policy. It offers Parent Domain and Subdomains only for an eligible target and otherwise preserves the Current Type and Current Domain choices already available for the selected scope.

- Use the same policy for cache matching. A Pinned icon marked for subdomain sharing may be consulted only within its eligible eTLD+1; matching does not climb a parent chain or re-enable a legacy invalid scope.

- On Cache authority initialization, classify persisted Pinned icons before exposing the Cache snapshot. Remove every pin whose target is a public suffix and every shared pin that fails Share eligibility. Persist the pruned index first, then remove the affected Private icon route payloads. If persistence fails, fail initialization and do not remove any record or payload.

- Preserve ordinary Pinned-icon retention, refresh, cache-clear, and restore-automatic behavior for valid records. The legacy removal above is the explicit security exception, not a new general cleanup rule.

- Update the domain glossary and keep the accepted ADR as the durable boundary rationale. Update user-facing documentation only where it describes Parent Domain and Subdomains behavior; no release, version, or marketplace publication is part of this feature.

## Testing Decisions

- The primary existing seam is the shared domain-scope policy currently used to derive parent and share domains. Tests at this seam assert externally meaningful outputs: the sole Registrable parent, whether a scope is Share eligible, and whether a parent probe is permitted. They must not assert a PSL parser's internal data structure.

- Extend the current pure domain and frontend-cache-state tests to cover ICANN and Private suffix behavior, including `github.io`, `pages.dev`, `appspot.com`, country-code domains, PSL wildcard and exception cases, `www.` normalization, IP literals, special-use names, malformed input, and IDN hostnames. Existing parent-domain and cache-match tests are the prior art.

- Extend Cache authority tests at the existing storage-backed seam to prove that valid shared pins remain available; invalid direct pin requests return `invalid-share-domain`; invalid legacy public-suffix, Private-suffix, and reviewed-exclusion entries are removed during initialization; their payloads are removed only after index persistence; and a forced index-write failure preserves both index and payloads.

- Add resolver candidate-order tests using the existing mocked forward-proxy seam. They prove that only the one Registrable parent can be probed after the exact host and that no public suffix or intermediate-parent candidate is generated.

- Add frontend behavior tests at the highest practical non-DOM seam for scope-choice construction. They prove that eligible hosts expose the shared choice and ineligible Private or reviewed-exclusion hosts do not. Keep the browser picker thin and covered by this policy result rather than duplicating domain classification in UI tests.

- Run the repository's full validation command after implementation. It must pass TypeScript validation, ESLint with zero warnings, and the Vitest suite; the production build must still produce both plugin bundles and the complete package payload.

## Out of Scope

- Runtime PSL downloads, background list refreshes, or a user-configurable PSL source.
- A broad heuristic list of hosting providers, automatic inference of multi-tenancy, or a user bypass for reviewed exclusions.
- Changes to third-party icon providers, page-specific discovery authorization, network safety rules, route-type classification, or icon rendering styles.
- Migration of data from the legacy `auto-favicon` plugin namespace.
- Preserving, downgrading, or prompting for unsafe legacy shared pins; the agreed behavior is direct removal.
- New visual settings, static icon libraries, third-party link-icon compatibility, release tagging, version bumps, or publication.

## Further Notes

- The PSL is a safety and ownership-boundary input, not evidence that a registrable domain is controlled by the current user. The stricter Private-suffix and reviewed-exclusion rules intentionally prefer false negatives for sharing over accidental cross-tenant reuse.
- The work changes a shared frontend/kernel policy boundary. Both bundles must consume the same policy module; no frontend-only check can be treated as authoritative.
- This SPEC is intentionally local. Issue-tracker publication and the `ready-for-agent` label are not performed because the requested outcome is a repository-local specification.
