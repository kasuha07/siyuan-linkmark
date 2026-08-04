# Asynchronous bounded icon resolution

## Problem Statement

When Linkmark encounters a cache miss, both automatic discovery and a manual
refresh keep the Frontend client RPC open until the Cache authority has resolved
an icon, written its private payload, and committed the Cache entry. A rejected
Forward-proxy retrieval can escape this path as an RPC internal error; a slow
site can make the request appear to have no response. Multi-label domains can
also trigger extra sequential discovery work. These outcomes delay editing,
hide the distinction between queued work and failure, and let slow resolution
tasks consume limited Resolution concurrency for too long.

## Solution

Make a cache miss an asynchronous workspace operation. The Cache authority
immediately acknowledges that it owns a new or coalesced In-flight task, while
the kernel continues resolution within a bounded budget. A committed Cache entry
is distributed through the existing cache-state notification; an exhausted task
emits a separate, sanitized failure notification. The Frontend client renders a
cache hit immediately, treats a queued result as a normal pending state, stays
silent for automatic failures, and gives a manual refresh one actionable error.

Default resolution becomes a fast path: it does not retrieve HTML or manifests
unless Specific-page discovery has been explicitly enabled. It applies the
approved candidate and time limits without weakening public-target validation,
Cache entry atomicity, pinned-icon protection, or same-scope coalescing.

## User Stories

1. As a Linkmark user opening a document, I want cache-miss requests to return promptly, so that favicon discovery never delays editing.
2. As a user manually refreshing an icon, I want the action to be accepted immediately, so that a slow external site does not leave the interface waiting indefinitely.
3. As a user with a cached icon, I want a ready Cache entry immediately, so that established links retain their current responsive behavior.
4. As a user whose Link scope is already resolving, I want subsequent requests to receive the same queue acknowledgement, so that the workspace does not duplicate downloads.
5. As a user with two Frontend clients, I want a committed icon to appear in both clients, so that workspace cache state stays consistent.
6. As a user whose automatic retrieval cannot find an image, I want the document to remain unchanged and quiet, so that routine failures do not interrupt writing.
7. As a user manually refreshing an unavailable icon, I want one useful failure message, so that I know I can retry or choose a custom icon.
8. As a privacy-conscious user, I want failure notifications to expose only a sanitized category, so that external responses and credentials never reach a Frontend client.
9. As a user visiting a slow or unreachable site, I want the task to stop within a predictable budget, so that other Link scopes can continue resolving.
10. As a user opening many links, I want Resolution concurrency to remain workspace-bounded, so that Linkmark does not overload the Forward-proxy retrieval service.
11. As a user opening a conventional website, I want Linkmark to try standard root icon locations and configured providers first, so that common icons resolve with minimal network work.
12. As a user who needs a site-specific icon declared in HTML or a manifest, I want to opt in to Specific-page discovery, so that the slower discovery capability remains available deliberately.
13. As a user of a multi-label domain, I want default resolution to avoid unnecessary parent-domain HTML retrieval, so that domain structure does not create long request chains.
14. As a user whose proxy request is rejected, I want the task to end as a normal resolution failure, so that Linkmark never turns it into an RPC internal error.
15. As a user whose Cache authority is reloading or unavailable, I want an explicit unavailable result and fail-open rendering, so that temporary plugin state does not corrupt documents or masquerade as an icon failure.
16. As a user with a Pinned icon, I want ordinary queued work and cleanup to leave it intact, so that deliberate choices remain authoritative.
17. As a user deleting, clearing, or restoring automatic resolution, I want older In-flight tasks to remain unable to commit, so that a stale task cannot recreate an unwanted Cache entry.
18. As a user closing a Frontend client after queueing work, I want the kernel-resident task to complete while the kernel remains available, so that another connected client can receive the committed icon.
19. As a user restarting or disabling the kernel plugin, I want unfinished work to be discarded without damaging committed entries, so that later scans can safely start fresh work.
20. As a Chinese or English user, I want any manual failure message to be localizable, so that the interaction remains understandable in the supported interface languages.
21. As a maintainer, I want the three RPC outcomes to be unambiguous, so that a queued task is never mistaken for a ready icon or an unavailable Cache authority.
22. As a maintainer, I want deterministic regression coverage for the asynchronous boundary, so that proxy timing and browser behavior are not required to prove correctness.

## Implementation Decisions

- The Cache authority remains the sole owner of resolution, private icon payloads, Cache entry commits, invalidation, and broadcasts, in accordance with the existing cache-authority architecture.
- Cache-miss requests, including forced manual refreshes, return a three-state result: `ready` with a committed Cache entry, `queued` for accepted new or coalesced In-flight work, and `unavailable` only when the Cache authority cannot accept work. A queued response is neither a successful icon result nor a failure.
- A Cache authority whose initialization failed cannot accept cache-miss work: `cache.get-or-queue` answers `unavailable` from the moment initialization fails until the kernel plugin reloads, while the remaining Kernel RPC methods keep failing open through RPC errors.
- Resolution and persistence continue after `queued` in the kernel. A Cache entry becomes visible only after private payload validation and its durable cache-index commit succeed.
- A successful commit uses the existing cache-state broadcast. An exhausted task broadcasts a resolution-failure event containing its Link scope and a sanitized failure category only.
- Automatic failures remain silent and continue to use the existing failure cooldown. Manual failures may surface one localizable, actionable message after the failure event.
- Default candidate selection excludes HTML and manifest retrieval. Standard root icon paths, any reviewed route-specific platform icon, and configured provider candidates form the fast path. Specific-page discovery enables HTML and manifest retrieval deliberately.
- Each In-flight task has a ten-second total resolution budget and considers no more than four candidates. The workspace-wide maximum remains four simultaneous tasks for distinct Link scopes; same-scope requests continue to coalesce.
- Any Forward-proxy transport or response-parsing rejection is converted to an ordinary candidate failure or sanitized task failure. It must not reject the cache-miss RPC after queue acknowledgement.
- Existing public-target validation, Safe Mode assumptions, image validation, private-route ownership, pinned-icon retention, scoped invalidation, and atomic Cache persistence remain unchanged.
- The Frontend client must handle `ready`, `queued`, and `unavailable` explicitly. It must not place a queued scope in the failed-domain cooldown or create a placeholder icon.
- Kernel and Frontend artifacts are deployed together because this changes their Kernel RPC contract. There is no backward-compatible mixed-version response shape.

## Testing Decisions

- The primary acceptance seam is the existing Cache authority public behavior backed by deterministic in-memory Cache storage, a controllable resolver/Forward-proxy adapter, and a state-change subscriber. It tests observable requests, returned states, committed snapshots, and notifications rather than queue internals.
- Regression tests must prove that a cache hit returns `ready` without resolver work; a cache miss returns `queued` before resolution or persistence completes; and same-scope callers receive a coalesced queued result while distinct scopes still respect the concurrency limit.
- Tests must prove that a successful queued task persists a validated Cache entry before broadcasting the committed cache state, and that all connected Frontend clients can reconcile that state through the existing notification behavior.
- Tests must prove that proxy rejection, malformed proxy data, candidate exhaustion, and resolution-budget expiry produce a sanitized failure notification without an RPC internal error, payload leak, or Cache entry.
- Tests must prove that automatic failures remain fail-open and silent, while manual failures produce the frontend's localizable actionable outcome without marking a queued task as failed prematurely.
- Resolver tests must prove the fast path skips HTML and manifest retrieval by default, limits attempts to four candidates and ten seconds, and enables page or manifest discovery only under Specific-page discovery.
- Existing tests for same-scope coalescing, four-task concurrency, scoped invalidation, atomic cache batches, private payload cleanup, and pinned retention are the prior art and must be adapted rather than replaced.
- TypeScript validation, the complete regression suite, and production package-content validation remain required delivery gates. Docker/browser end-to-end automation remains outside this SPEC.

## Out of Scope

- Durable task recovery, checkpointing, or continuation across kernel restart, reload, plugin disablement, or SiYuan shutdown.
- Changing the four-task workspace Resolution concurrency limit.
- New external workers, sidecars, proxy services, icon libraries, or third-party link-icon compatibility behavior.
- Relaxing public-target validation, Forward-proxy Safe Mode expectations, image limits, or private icon-route access control.
- Reworking cache policy ownership, display preferences, legacy-data isolation, pinned-icon rules, or route-scope identity.
- Docker/browser end-to-end automation, release tagging, publication, and unrelated UI redesign.

## Further Notes

This SPEC supersedes the synchronous cache-miss behavior while retaining ADR
0001's cache-authority ownership, ADR 0003's four-task concurrency bound, and
ADR 0005's asynchronous bounded-resolution decision. The local ADR and glossary
capture the stable architectural vocabulary; this SPEC defines the delivery and
acceptance behavior. No issue-tracker item is created because this request is
explicitly for a local SPEC.
