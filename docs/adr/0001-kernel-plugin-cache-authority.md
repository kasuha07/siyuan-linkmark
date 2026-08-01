# Make the kernel plugin the favicon cache authority

The plugin must support multiple Docker-hosted browser clients without cache-index overwrites or duplicated in-flight downloads. We will move favicon resolution, downloading, queuing, cache-index mutation, cleanup, and icon-payload ownership to one SiYuan v3.7 kernel plugin; all frontend clients will render state and invoke those operations through RPC. A frontend-only read-merge-write design, including timestamps and tombstones, was rejected because independent clients still cannot make that sequence atomic.

## Consequences

The frontend must stop directly writing `favicon-cache.json` and `/data/public/auto-favicon`. The kernel RPC contract becomes the compatibility boundary, and migration must preserve existing cache entries and pinned icons.

On first initialization, the cache authority imports well-formed legacy entries and their existing public files into private payload storage where readable. It retains usable pinned icons, uses each automatic entry's `fetchedAt` for its existing freshness semantics, and lets normal validation refresh or remove missing or unreadable automatic icons.

Selecting a custom icon, restoring automatic resolution, deleting an entry, and clearing cache are workspace cache operations. The authority broadcasts the resulting state to connected frontend clients; clearing cache continues to retain pinned icons.

Resolution sources and fallback, monogram configuration, automatic-fetch pause, full-page discovery, and cache lifetime are cache policy stored by the authority. Per-client display preferences are limited to enabled rendering and icon size.

The authority deduplicates and serializes active resolution work by link scope, not by bare domain. Clients requesting the same scope share one task; distinct route-specific scopes retain their own icons.

An explicit deletion, restore-automatic action, or cache clear invalidates older affected resolution tasks. A task that finishes after invalidation must not commit an index entry or private icon payload; only a newly requested task may populate that scope again.

If the cache authority is starting, reloading, or unavailable, frontend rendering fails open: usable cached icons remain visible, cache misses do not block editing, and automatic requests remain silent. Explicit user actions surface actionable errors.

The migration adds a development-only test runner and regression coverage for legacy import, scoped task deduplication, invalidated-task non-commit, pinned-icon retention, and frontend RPC fail-open behavior.

Docker browser end-to-end automation is intentionally outside this phase. Delivery evidence is limited to deterministic cache-service regression tests, TypeScript validation, and package-content checks; live Docker-browser behavior remains an explicit validation gap.

The authority does not persist its in-flight queue in this phase. A kernel restart, hot reload, or plugin stop cancels unfinished work while retaining cache policy and committed entries; a later scan or explicit request creates a new task.

The authority persists icon bytes in plugin-private storage and serves them through an authenticated private icon route. Frontends use that route rather than direct public-workspace files; a data URI is only a controlled fallback if Docker browser acceptance proves that CSS cannot request the private route.

The resolver rejects private, loopback, link-local, unspecified, multicast, and IPv4-mapped private literal targets before forwarding. DNS rebinding protection at connect time belongs to SiYuan's `forwardProxy` Safe Mode dialer; Docker deployments that use this feature must keep Safe Mode enabled because the supported plugin API does not expose a custom dialer.
