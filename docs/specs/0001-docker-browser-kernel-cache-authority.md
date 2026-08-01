# Docker browser and kernel cache authority

## Problem Statement

Auto Favicon currently loads only on SiYuan desktop and mobile frontends, so it
does not load in Docker-hosted browser sessions. Its browser-local cache snapshot
can also overwrite changes made by another browser connected to the same SiYuan
workspace. This loses favicon entries, can resurrect deleted entries, and cannot
reliably deduplicate downloads across a desktop browser and a mobile browser.

## Solution

Support SiYuan browser frontends and make a SiYuan v3.7 kernel plugin the
workspace cache authority. Frontend clients render icons and request operations
through kernel RPC. The authority owns cache policy, the cache entry index,
favicon downloads, scoped in-flight work, icon payloads, cleanup, migration, and
state-change broadcasts. It downloads through SiYuan's supported forward-proxy
API and serves committed icon bytes over an authenticated private icon route.

## User Stories

1. As a Docker-hosted SiYuan desktop-browser user, I want Auto Favicon to load, so that external links receive icons without installing a desktop client.
2. As a Docker-hosted SiYuan mobile-browser user, I want the plugin to load, so that mobile web sessions behave consistently with other clients.
3. As a user with two browsers open against one workspace, I want both clients to see the same cache state, so that one client cannot overwrite the other's icon updates.
4. As a user opening the same link scope on two devices, I want one shared favicon task, so that the workspace does not download the same icon twice.
5. As a user opening distinct route-specific links on the same domain, I want each link scope to retain its own icon, so that route-aware services remain correctly represented.
6. As a user who pins a custom icon, I want it preserved during ordinary refresh and cache cleanup, so that intentional choices remain stable across devices.
7. As a user who restores automatic resolution or deletes an icon, I want the change to apply workspace-wide, so that other clients do not continue showing a conflicting selection.
8. As a user who clears cache while an icon is downloading, I want the deleted icon to stay deleted, so that an old task cannot restore it after I acted.
9. As a user migrating from the existing plugin version, I want valid legacy entries and pinned icons preserved, so that upgrading does not unexpectedly discard my curated cache.
10. As a user whose legacy automatic icon is missing or unreadable, I want normal cache validation to recover or remove it, so that stale metadata does not create broken rendering.
11. As a user whose browser closes after requesting an icon, I want a kernel-started task to continue while the kernel remains running, so that the shared server can complete work independently of the page.
12. As a user encountering an unavailable or reloading kernel plugin, I want editing and existing document content to remain unaffected, so that a transient plugin failure does not disrupt documents.
13. As a user manually refreshing or selecting an icon, I want a useful error when the request fails, so that I can decide whether to retry or change the source.
14. As a privacy-conscious user, I want favicon resolution to retain public-target validation and avoid forwarding workspace credentials, so that the cache authority does not become a route to private network resources.
15. As a workspace administrator, I want cache policy to be shared, so that resolver, fallback, monogram, discovery, and cache-lifetime decisions remain consistent for every client.
16. As a user with different device display preferences, I want rendering enablement and icon size to remain client-local, so that visual choices do not conflict across devices.
17. As a maintainer, I want deterministic regression tests at the cache-authority boundary, so that multi-client guarantees do not depend on a live browser test environment.

## Implementation Decisions

- The plugin supports desktop, mobile, browser-desktop, and browser-mobile frontends and declares compatibility with all kernel targets. The existing minimum SiYuan version already permits the v3.7 kernel-plugin architecture.
- A kernel plugin is the sole cache authority. Frontend clients neither persist the cache index nor write icon payloads directly; their compatibility boundary is authenticated kernel RPC.
- The authority uses SiYuan's documented kernel REST loopback client to call the documented forward-proxy endpoint. It must retain Auto Favicon's public-target validation, pass no cookies or authorization headers to candidate sites, enforce existing image limits, and treat proxy envelope failures separately from transport success.
- The authority keeps one serialized cache-operation queue and one in-flight map keyed by Link scope. A matching request joins existing work; distinct route-specific scopes remain independent.
- A Cache entry is authoritative only after icon bytes are validated and its index update commits. Replaced automatic payloads are removed only after the replacement commits.
- Pinned icons never expire and are excluded from ordinary refresh and clear-cache cleanup. Explicit restore-automatic and delete operations remain workspace cache operations.
- Delete, restore-automatic, and clear-cache actions invalidate affected In-flight tasks. An invalidated task must not commit either icon bytes or index state, even if its network request completed.
- Cache policy is workspace-wide: resolver source and mode, fallback, monogram configuration, automatic-fetch pause, full-page discovery, and cache lifetime. Display preferences are per Frontend client: rendering enabled state and icon size.
- On first authority initialization, well-formed legacy cache entries are imported. Usable pinned icons are retained; automatic entries keep their legacy freshness time and are later refreshed or removed by normal validation if their payload is unavailable.
- Icon bytes are stored in plugin-private storage and delivered through an authenticated Private icon route. Data URIs are permitted only as a controlled fallback if future Docker-browser validation proves CSS cannot use the private route.
- The authority broadcasts committed state changes so each connected Frontend client reconciles its rendered rules. During authority startup, reload, or temporary unavailability, rendering fails open: existing usable icons remain visible, cache misses do not block editing, and automatic failures are silent.
- In-flight work is intentionally not durable in this phase. A kernel restart, hot reload, or plugin stop cancels unfinished tasks; committed entries and cache policy remain available for later scanning or explicit refresh.

## Testing Decisions

- Add a development-only Vitest harness. Tests must assert externally observable cache-authority behavior rather than queue internals.
- The primary and highest test seam is the kernel cache-authority RPC surface backed by a deterministic in-memory storage adapter and a controllable forward-proxy adapter. Frontend DOM scanning and SiYuan transport are outside this seam.
- Cover legacy import, same-scope coalescing, distinct route-scope independence, post-delete non-commit, cache-clear invalidation, pinned retention, private-route lookup, cache-policy ownership, client display-preference separation, and fail-open RPC behavior.
- Check compiled package content as a separate boundary: the distributable must include browser frontend declarations, kernel compatibility declaration, and the kernel entry artifact.
- Run TypeScript validation and the normal production package build. This repository has no prior test suite; the new authority-level suite is the initial testing precedent.
- Do not add Docker/browser end-to-end automation in this phase. Real Docker browser behavior, including authenticated CSS access to the Private icon route, is a documented validation gap rather than a claimed proof.

## Out of Scope

- Supporting SiYuan versions below the current v3.7 minimum or retaining the old frontend-only cache writer as a fallback.
- Durable task recovery, checkpointing, or automatic continuation across a kernel restart, hot reload, plugin disablement, or SiYuan shutdown.
- An external worker, sidecar, proxy, or remote cache service.
- Reliance on undocumented kernel source-only proxy facilities or undocumented public plugin routes.
- A general static icon library or unrelated resolver redesign.
- Real Docker/browser automated tests, manual two-browser acceptance, release tagging, publication, and changes outside this first-phase architecture.

## Further Notes

- The authority is designed for a persistent Docker workspace volume. Kernel storage and committed icon payloads must survive normal container/browser lifecycles according to SiYuan's workspace persistence configuration.
- The private-route choice is deliberate: it keeps icon payloads under authority control and avoids direct frontend writes to shared public workspace files.
- The forward proxy is a documented SiYuan API, but its runtime safe-mode behavior must not replace the plugin's own public-target checks.
- The domain language for Cache authority, Frontend client, Cache entry, Cache policy, Display preference, Link scope, Workspace cache operation, Private icon route, Invalidated task, and In-flight task is defined in the project context document. The architectural rationale is recorded in ADR 0001.
