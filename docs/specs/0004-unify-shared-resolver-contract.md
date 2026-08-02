## Problem Statement

The frontend bundle still carries a full favicon resolution pipeline — page and manifest discovery, third-party provider selection, parent-domain fallback, monogram generation, candidate scoring and download, and network-safety checks — in a single `icon-resolver.ts` module. That pipeline is dead code: the cache authority owns resolution, downloads, and monogram generation, and no frontend code path calls these functions. The module is intentionally untested (documented in ADR 0006), so it can drift silently.

At the same time, the same domain vocabulary is declared in several modules and is already beginning to drift: provider presets, resolver modes, and monogram color/shape enums appear both in the frontend contract and inline in the kernel resolver; the frontend default settings and the kernel default policy duplicate the same thirteen cache-policy fields; and `RESOLVER_VERSION` is a frontend constant that the kernel hardcodes separately.

## Solution

Remove the frontend resolution pipeline entirely and consolidate the shared contract into a single module. The kernel plugin remains the only component that resolves, downloads, or generates icons. A shared contract module becomes the single source for the shared types, constants, and default cache policy; both the frontend and kernel bundles import from it instead of re-declaring the vocabulary. The refactor is behavior-neutral: resolution, caching, rendering, and monogram output are unchanged.

## User Stories

1. As an independent maintainer, I want the frontend bundle to contain no favicon resolution, download, provider-selection, or monogram-generation code, so that the cache authority is the only component that performs resolution.
2. As an independent maintainer, I want `src/icon-resolver.ts` deleted entirely, so that there is no lingering dead code whose behavior can drift unnoticed.
3. As a frontend engineer, I want `ResolverMode`, `ProviderPreset`, `FallbackMode`, `MonogramColorMode`, `MonogramShape`, `MonogramStyle`, and `MonogramOverride` to be importable from one shared module, so that I never re-declare enum unions.
4. As a frontend engineer, I want the kernel resolver policy to reference the same shared enum types instead of re-declaring them inline, so that the kernel policy cannot drift from the frontend settings.
5. As a frontend engineer, I want `DEFAULT_CACHE_POLICY` to be the single default object used by both frontend settings and kernel policy, so that a missing stored value loads identically on both sides.
6. As a frontend engineer, I want `CACHE_POLICY_FIELDS` derived from the shared default-policy keys, so that the policy field list can never drift from the defaults.
7. As the cache authority, I want `RESOLVER_VERSION` defined once and imported by both the frontend and kernel, so that cache freshness decisions use a single value.
8. As the cache authority, I want `MAX_ICON_BYTES` defined once and used by both the frontend image-decode helper and the kernel download validation, so that the size limit cannot drift.
9. As an independent maintainer, I want the monogram generation logic extracted into a pure function, so that it is testable without a browser or a forward proxy.
10. As an independent maintainer, I want the frontend monogram generator deleted rather than moved, so that only the kernel generates monograms.
11. As a frontend engineer, I want `isDecodableImage` extracted to its own module unchanged, so that the frontend pin flow keeps validating decoded images against the shared size limit.
12. As a frontend engineer, I want the cache authority's minimal `CachePolicy` type derived from the shared `CachePolicyFields`, so that the fields the authority actually reads stay structurally aligned with the contract.
13. As an independent maintainer, I want monogram output to be byte-identical before and after the refactor, so that users do not see changed fallback icons.
14. As an independent maintainer, I want resolution behavior unchanged, so that the existing test suite stays green.
15. As an independent maintainer, I want `AGENTS.md` and ADR 0006 updated to stop referencing the deleted module, so that documentation does not point at removed code.
16. As an independent maintainer, I want the refactor to keep the plugin scope narrow, without adding third-party link-icon detection, priority behavior, or compatibility settings.
17. As an implementation agent, I want `npm run check` to pass with zero ESLint warnings, so that CI is green.

## Implementation Decisions

- **Delete `src/icon-resolver.ts` entirely.** Its network-resolution functions (`resolveBestIcon`, `discoverIconCandidates`, `resolveIconUrl`), provider selection and URL templates, candidate scoring, page/manifest discovery, download/validation, and the frontend monogram generator are removed, not moved.

- **Create a shared contract module** (`resolver-contract.ts`) as the single source for:
  - Enum types: `ResolverMode`, `ProviderPreset`, `FallbackMode`, `MonogramColorMode`, `MonogramShape`.
  - Shapes: `MonogramStyle`, `MonogramOverride` (moving from `frontend-settings.ts`).
  - Constants: `RESOLVER_VERSION` (6) and `MAX_ICON_BYTES` (2 MiB).
  - The `CachePolicyFields` type and `DEFAULT_CACHE_POLICY` object.

  `CachePolicyFields` is the thirteen cache-policy fields shared by both bundles, per the resolved interview:
  `pauseAutomaticFetch`, `allowFullPageDiscovery`, `provider`, `providerPreset`, `resolverMode`, `fallbackMode`, `monogramColorMode`, `monogramPrimary`, `monogramSecondary`, `monogramText`, `monogramShape`, `monogramOverrides`, `cacheDays`.

- **Create `image-decode.ts`**: exports `isDecodableImage` unchanged (browser-only, relies on `Image`/`window`/`URL.createObjectURL`), importing `MAX_ICON_BYTES` from the contract.

- **Create `monogram.ts`**: a pure SVG builder that turns a domain and a resolved style (letter, colors, shape) into an SVG string, plus the policy-to-style resolution (per-domain overrides, domain-hash hue, custom colors). Output must be byte-identical to the current kernel monogram.

- **Rewrite `kernel-resolver.ts`**: `KernelResolverPolicy` is redefined from the shared contract types; the `monogramOverrides` record uses the shared `MonogramOverride`; monogram generation delegates to `monogram.ts`. Provider URL construction, image-payload sniffing, redirect handling, and candidate ordering stay.

- **Rewrite `kernel.ts`**: `defaultPolicy = { ...DEFAULT_CACHE_POLICY }`; `CachePolicyState` becomes `CachePolicyFields` (the old `CachePolicy & KernelResolverPolicy` intersection is dropped); `resolverVersion` imports `RESOLVER_VERSION` instead of a hardcoded `6`.

- **Rewrite `frontend-settings.ts`**: `defaultSettings = { enabled: true, iconSize: 1, ...DEFAULT_CACHE_POLICY }`; `CACHE_POLICY_FIELDS` derived from `Object.keys(DEFAULT_CACHE_POLICY)`; types imported from the contract. `MonogramOverride` moves to the contract.

- **Rewrite `cache-authority.ts`**: `CachePolicy = Pick<CachePolicyFields, "cacheDays" | "pauseAutomaticFetch">`.

- **Rewrite `index.ts`**: import `isDecodableImage` from `image-decode.ts` and all enum types plus `RESOLVER_VERSION` from the contract module.

- **Docs**: update `AGENTS.md` (module listing) and ADR 0006 (the consequence line describing the dead code) to reflect the deletion.

- No i18n, no `plugin.json`, no version changes, no new dependencies.

## Testing Decisions

- A good test asserts external behavior — the resolved icon, candidates, settings merge, policy field set, and monogram SVG output — not the internal module structure.
- **Existing seam — `ForwardProxyIconResolver` with a mocked forward proxy** (`tests/cache-authority.test.ts`). This already covers candidate ordering, manifest discovery, and the monogram fallback (which now exercises `monogram.ts` through the same seam). Keep these tests green.
- **Existing seam — `frontend-settings.test.ts`**. This pins `defaultSettings`, `CACHE_POLICY_FIELDS` (length 13), `mergeFrontendSettings`, and `pickCachePolicy`. The contract extraction and derived field list must keep these assertions green, which pins the shared default-policy shape.
- **New pure seam — `monogram.ts` unit tests** in the Node vitest environment (no DOM, no proxy): letter derivation, stable per-domain hue, custom colors, override resolution, and shape variants, asserting the produced SVG. Prior art: the existing pure-module test files (`frontend-format.test.ts`, `frontend-cache-state.test.ts`, `parent-domain.test.ts`, `url-safety.test.ts`) test exported pure functions directly.
- **`image-decode.ts`** is not unit-tested: the Node vitest environment has no DOM, so `isDecodableImage` is validated by type-check and unchanged behavior, matching the current situation.

## Out of Scope

- No behavioral changes to resolution, caching, freshness, or rendering.
- No new link-icon detection, priority behavior, or compatibility settings.
- No general static icon libraries.
- No i18n string changes.
- No addition of a DOM test environment.
- No legacy `auto-favicon` data migration.
- No release, tag, or version bump.

## Further Notes

- This completes the path already documented in ADR 0001 (kernel plugin is the cache authority) and ADR 0006 (the frontend resolution copies are dead code and intentionally untested).
- The refactor touches modules bundled into both `index.js` (frontend) and `kernel.js` (kernel); the shared contract must stay free of browser-only globals so it inlines cleanly into the kernel bundle.
