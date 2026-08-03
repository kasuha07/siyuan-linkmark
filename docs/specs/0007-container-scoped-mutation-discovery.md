# Container-scoped mutation discovery

## Problem Statement

While a user edits a SiYuan document, Linkmark observes the complete application
body for subtree child-list, character-data, and link-attribute changes. Every
MutationObserver record first enters local scan scheduling, even when the change
belongs to SiYuan chrome or cannot change a Link scope. A separate document-level
input listener can schedule the same edit again. Large mutation batches also
accumulate local regions through repeated containment comparisons before the
existing debounce flushes them.

This makes the Interactive render pipeline do avoidable main-thread work during
ordinary typing and unrelated SiYuan UI updates. The behavior is especially
undesirable in the Large-document performance scenario, where Editor
responsiveness is the primary outcome. Linkmark must reduce this noise without
changing Present-scope semantics, selector coverage, departed-scope eviction, or
runtime icon behavior.

## Solution

Observe only registered Link content containers and let SiYuan Protyle lifecycle
events own their registration and teardown. Classify each complete mutation batch
before submitting one discovery request. Ignore text-only changes, use Local
discovery for additions, and reserve Full discovery for changes that may have
removed a previously Present scope.

Bound pending Local work across the complete 250 millisecond discovery
coalescing window. At most eight independent regions remain Local; a ninth
upgrades the pending work to one Full discovery. Full discovery continues to
cover every mounted Link content container, including hidden tabs and inactive
Preview modes.

## User Stories

1. As a user typing ordinary text, I want Linkmark to perform no link discovery when no Link scope changed, so that editing stays responsive.
2. As a user editing a large document, I want Linkmark work to remain bounded during a burst of DOM mutations, so that a single edit does not create growing containment work.
3. As a user changing one link, I want Linkmark to inspect the smallest useful local region, so that unrelated document content is not rescanned.
4. As a user adding a link, I want its icon to appear through Local discovery, so that Linkmark does not require a whole-document pass for an additive change.
5. As a user changing a link URL, I want the old scope to be evicted and the new scope discovered, so that stale icon rules do not remain Present.
6. As a user removing a link, I want Linkmark to evict its departed scope, so that runtime bindings remain bounded by mounted document content.
7. As a user deleting a block that contains links, I want Linkmark to detect links in the removed subtree, so that deleted scopes do not remain bound.
8. As a user deleting plain text or word-break nodes, I want Linkmark to ignore the mutation, so that SiYuan input normalization does not cause unnecessary scans.
9. As a user pasting links through SiYuan's custom paste path, I want Linkmark to discover them even when SiYuan emits no document input event, so that paste behavior remains correct.
10. As a user changing a link through SiYuan's link menu, I want Linkmark to respond to the URL attribute mutation, so that operations without a document input event remain covered.
11. As a user cancelling a link, I want Linkmark to recognize both data-type removal and subtree replacement, so that every supported unlink path evicts the old scope.
12. As a user viewing a static Preview, I want Preview links to receive the same icon behavior as editor links, so that mode switching preserves Linkmark rendering.
13. As a user opening a hidden tab later, I want its already-mounted links to remain Present, so that icons do not flash or require rediscovery on tab activation.
14. As a user switching between WYSIWYG and Preview modes, I want both mounted containers to retain their Present scopes, so that visibility changes do not alter Linkmark identity.
15. As a mobile user switching documents in a reused Protyle, I want whole-content replacement to evict departed scopes and discover new ones, so that container reuse remains correct.
16. As a user opening a block panel, I want its Protyle links observed without relying on a desktop layout ancestor, so that floating editors receive normal Linkmark behavior.
17. As a user closing a tab or block panel, I want Linkmark to disconnect its container observers and reconcile departed scopes, so that detached containers retain no observer or runtime binding state.
18. As a user interacting with SiYuan toolbars, dialogs, settings, and changelog content, I want their link mutations ignored, so that application chrome cannot trigger Linkmark discovery.
19. As a user with several mounted editors, I want Full discovery to inspect all of them, so that Present remains defined by mounting rather than activity or visibility.
20. As a maintainer, I want one idempotent startup sweep, so that containers created before Linkmark loads are registered exactly once.
21. As a maintainer, I want Protyle lifecycle events to register later containers, so that steady-state operation needs no application-body subtree observer.
22. As a maintainer, I want container registration to scan immediately, so that mutations occurring before observer attachment cannot leave initial links undiscovered.
23. As a maintainer, I want one discovery submission per MutationObserver callback, so that record count does not directly multiply scheduler calls.
24. As a maintainer, I want Full discovery to supersede Local work, so that one batch cannot execute redundant full and regional passes.
25. As a maintainer, I want Local-region containment work capped at a small constant, so that coalescing cannot approach quadratic behavior.
26. As a maintainer, I want mutation classification tested structurally, so that CI does not depend on Chromium-specific record grouping or unstable timing thresholds.
27. As a maintainer, I want the existing render-work flush to remain the highest behavioral test seam, so that tests cover discovery decisions through publication without duplicating pipeline internals.
28. As a maintainer, I want no new runtime dependency or persistent DOM index, so that the optimization stays small, reversible, and bounded by mounted content.
29. As a maintainer, I want unsupported third-party DOM lifecycle bypasses stated explicitly, so that a future body-observer fallback is not reintroduced accidentally.
30. As a maintainer, I want unload cleanup to disconnect every observer and event listener, so that plugin reloads cannot accumulate duplicate scheduling paths.

## Implementation Decisions

- A Link content container is either a mounted Protyle WYSIWYG root or the typography content root directly owned by a Protyle Preview. The generic typography class alone is not an identity because SiYuan also uses it in application UI.
- Linkmark installs Protyle lifecycle listeners before performing one startup container sweep. Registration is idempotent, so an event racing with the sweep cannot attach duplicate observers.
- Protyle static-load, dynamic-load, active-switch, and mode-switch events register the WYSIWYG and Preview content roots available from the event's Protyle object. A destroy event disconnects those roots. Plugin unload removes all lifecycle listeners and disconnects all remaining observers.
- Each newly registered container requests Local discovery immediately after observer attachment. Startup retains the existing immediate Full discovery behavior and trailing debounce safety pass.
- Linkmark maintains only the process-local container-to-observer associations required for lifecycle cleanup. This registry is not persisted and is not a DOM index or scope reference count.
- Linkmark does not retain a MutationObserver on the application body. Third-party code that creates Protyle-like roots or removes them while bypassing SiYuan Protyle lifecycle events is unsupported.
- Full discovery traverses every registered container that is still connected to the current document. Hidden tabs, inactive WYSIWYG roots, and inactive Preview roots remain included because Present means mounted, not visible.
- Static Preview discovery uses the content root owned by the Preview component. Other typography elements in dialogs or application chrome are outside the Interactive render pipeline.
- Each container observer enables subtree child-list and attribute observation. Its attribute filter contains only `href`, `data-href`, and `data-type`, and attribute old values are retained. Character data is not observed.
- The document-level input listener is removed. Text changes alone cannot change a Link scope, while every supported scope-affecting SiYuan path produces a child-list or observed attribute mutation.
- One mutation-batch planner consumes the complete callback record list and produces no work, a set of Local regions, or Full discovery. The callback submits that result to discovery scheduling exactly once.
- Added nodes request Local discovery only when the added element is or contains a Link representation. The chosen region is the narrowest useful connected link, editor block, added subtree, or Preview content region.
- Removed nodes request Full discovery only when a removed element is or contains a Link representation. Removed text nodes, word breaks, and unrelated formatting elements are ignored.
- Adding a previously absent `href` or `data-href` requests Local discovery when the final element is a Link representation. Rewriting or removing an existing URL identity requests Full discovery when the element represented a Link before or after the batch.
- Adding an `a` or `url` token to `data-type` requests Local discovery when the final element has a URL identity. Removing the final link token requests Full discovery. Changes to unrelated data-type tokens are ignored.
- Mutation classification is based on the before/after Link representation, not record order. Multiple attribute records for one element in the same callback must not produce contradictory Local and Full submissions.
- Full discovery supersedes all Local regions in the same callback and all pending Local regions already accumulated in the current discovery coalescing window.
- The existing 250 millisecond discovery debounce remains unchanged. The pending work queue, rather than an individual observer callback, owns the Local-region limit.
- The queue retains at most eight non-contained Local regions across the complete coalescing window. Requests already contained by an existing region are ignored; a new outer region replaces regions it contains.
- The ninth independent Local region upgrades pending work to Full discovery, clears both pending and flushed Local sets, and causes later Local requests in the same window to be ignored. This bounds containment comparisons before Full discovery.
- The threshold is a fixed count rather than a DOM-size or link-count estimate. Deciding whether to scan must not require another DOM traversal.
- Link discovery, Link scope identity, cache decisions, automatic resolution, Present-binding reconciliation, CSSOM publication, Pinned precedence, and fail-open behavior remain unchanged after discovery work is selected.
- No new dependency, persistent rendering metadata, inline style, custom node attribute, DOM index, scope reference count, or runtime performance instrumentation is introduced.
- The implementation follows the accepted Protyle-event lifecycle decision recorded in the corresponding ADR and the broader performance boundaries in the Interactive render performance SPEC.

## Testing Decisions

- The primary behavioral seam is the existing Frontend render-work flush supplied with the real work queue and a deterministic discovery/publication executor. Tests assert selected discovery work and externally observable publication count rather than private callback sequencing.
- A focused mutation-batch planning seam accepts mutation-like records and returns no work, Local regions, or Full discovery. This seam isolates browser record-grouping variability while preserving the complete before/after classification contract.
- A focused container-lifecycle seam accepts startup roots and Protyle lifecycle events, then exposes registered roots and emitted discovery work. Tests use fake containers and observers; a browser runtime is not required.
- Lifecycle tests cover listener-before-sweep ordering, idempotent registration, immediate discovery, duplicate load/switch events, Preview registration, destroy-time disconnection, unload cleanup, and event arrival for an already disconnected root.
- Full-discovery tests cover multiple mounted editors, hidden tabs, inactive modes, disconnected registered roots, Preview roots, and exclusion of unrelated typography UI.
- Attribute tests cover URL addition, rewrite, removal, repeated assignment, simultaneous URL and data-type changes, addition of a link token, removal of one of several tokens, removal of the final link token, and unrelated token changes.
- Child-list tests cover direct Link nodes, nested Link descendants, whole-block replacement, whole-container replacement, plain text nodes, word breaks, unrelated formatting nodes, and mixed add/remove batches.
- Batch tests prove that zero relevant records schedule nothing, Local-only records submit once, any departed-scope signal submits one Full request, and record order does not change the result.
- Queue tests use nested and independent fake regions to prove containment reduction. Eight independent regions remain Local; the ninth across one or several observer callbacks becomes Full; later Local requests stay ignored until the coalescing work is taken.
- End-to-end render-work tests prove Full supersession, one publication per work batch, departed-scope eviction, and unchanged Local upsert behavior.
- Regression tests prove that no document-level input listener, body-subtree MutationObserver, or character-data observation remains in the plugin lifecycle.
- Existing selector, Present-binding, large-cache, and build-boundary tests remain prior art. Tests continue to prove that rule output is bounded by Present scopes rather than cache size.
- CI tests are structural and deterministic. They do not assert MutationObserver record counts from a particular Chromium build or use the manual millisecond targets as pass/fail thresholds.
- Fresh verification runs the repository check command followed by the complete marketplace build. Manual SiYuan profiling is useful supporting evidence but is not required to prove the structural work reduction.

## Out of Scope

- Supporting third-party code that creates or destroys Protyle-like DOM roots without SiYuan lifecycle events.
- Redefining Present to mean visible, active, focused, or located in the current tab.
- Adding a persistent DOM index, per-scope reference count, visibility tracker, or MutationObserver-driven element index.
- Replacing the existing 250 millisecond discovery debounce or render publication batching.
- Dynamically estimating scan cost from region size, descendant count, or link count.
- Changing Link selectors, Link scope identity, Pinned icon behavior, cache freshness, automatic fetch policy, route precedence, or fail-open rendering.
- Changing Cache authority RPC, kernel resolution, network retrieval, persistence, private icon serving, or cache-event contracts.
- Adding runtime telemetry, an in-app performance trace, analytics, remote logging, or CI timing gates.
- Pinning or changing the SiYuan Docker image, changing the minimum supported SiYuan version, or redesigning plugin compatibility policy.
- General UI changes, release publication, version changes, or unrelated refactoring.

## Further Notes

- The SiYuan source investigation used the fixed `siyuan-note/siyuan` snapshot at commit `eef10568384e2e7cf547adb029ae46a72e43c287`, whose application version is `3.7.3`. Linkmark currently declares SiYuan `3.7.0` as its minimum and its installed plugin API types expose the required Protyle lifecycle events and container references.
- Linkmark's development image currently follows `b3log/siyuan:latest`; the source snapshot is design evidence, not a claim that every local runtime uses that exact commit.
- The source investigation found no narrow DOM ancestor shared by desktop tabs, the reused mobile editor, and block panels. It also found no Preview-render-complete event, which is why per-container mutation observation remains necessary after event-driven registration.
- SiYuan may perform multiple DOM rewrites for one edit, and several paste, link-menu, unlink, and block-delete paths do not emit a document input event. The design therefore treats structural and identity mutations as the authority instead of input events.
- This work is expected to reduce structurally unnecessary callbacks and comparisons. It must not be reported as a measured latency or percentage improvement without a recorded manual profile.
