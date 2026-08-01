# Development resolution trace

## Problem Statement

When a Linkmark Frontend client requests an uncached Link scope, the Kernel RPC
correctly returns a Queue acknowledgement immediately. Resolution continues in
the Cache authority, so the response is intentionally neither an icon result
nor a failure. In local SiYuan Docker development this leaves a maintainer with
no reliable way to distinguish a coalesced In-flight task, Resolution
concurrency wait, Forward-proxy delay, rejected candidate, deadline expiry,
cache persistence failure, invalidation, or successful commit.

The current kernel logger records initialization failures but does not provide a
correlatable, per-task resolution history. Container standard output is not a
reliable replacement for the SiYuan kernel log file, and asking a maintainer to
instrument source code or inspect private network payloads for every issue is
not an acceptable local development workflow.

## Solution

Provide a default-off Resolution trace for development builds. A developer can
turn it on from the Linkmark settings page while using a local SiYuan Docker
instance. The Cache authority then writes a structured, JSONL sequence of
sanitized lifecycle records for every In-flight task to the SiYuan kernel log.
Each sequence is correlated by a task identifier and ends in a terminal
resolution outcome or invalidation.

The trace makes the asynchronous boundary observable without changing the
Queue acknowledgement contract, Cache policy, Cache entry contents, frontend
notifications, or production package behavior. A developer can pair the trace
with the mounted workspace's kernel log to determine where a task spent time.

## User Stories

1. As a Linkmark maintainer using a local SiYuan Docker workspace, I want to enable Resolution trace from the plugin settings, so that I can diagnose a task without editing source code.
2. As a maintainer, I want Resolution trace to be unavailable and disabled by default in a production package, so that normal users do not receive a debugging surface or routine trace volume.
3. As a maintainer, I want a Queue acknowledgement to remain immediate, so that tracing does not turn asynchronous resolution back into a blocking RPC.
4. As a maintainer, I want every accepted In-flight task to receive a unique task identifier, so that I can follow it across queueing, resolution, persistence, and notification.
5. As a maintainer, I want a coalesced request recorded against the task that already owns its Link scope, so that repeated `queued` responses are distinguishable from newly accepted work.
6. As a maintainer, I want to see when a task waits for Resolution concurrency and when it starts, so that I can identify saturation of the workspace-wide bound.
7. As a maintainer, I want to see the resolution trigger and sanitized Link scope identity, so that I can distinguish automatic work from manual refresh without exposing note content.
8. As a maintainer, I want each candidate attempt to identify its reviewed source and its elapsed time, so that I can locate a slow or ineffective retrieval stage.
9. As a maintainer, I want candidate results to include sanitized HTTP status, content type, byte count, and validation outcome when available, so that I can distinguish transport, response, and image-validation failures.
10. As a maintainer, I want timeout, network, invalid, and exhausted outcomes recorded with their existing sanitized failure category, so that diagnostics agree with Resolution outcome notifications.
11. As a maintainer, I want successful private-payload storage, Cache persistence, and Cache entry commit recorded separately, so that I can distinguish resolution success from a persistence bottleneck.
12. As a maintainer, I want invalidated work recorded as invalidated rather than committed or failed, so that cache management races remain understandable.
13. As a maintainer, I want a task's terminal trace record to include total elapsed time and the terminal lifecycle event, so that I can determine whether it completed within its bounded budget.
14. As a maintainer, I want no complete external request URL, query parameter, fragment, response body, Cookie, authorization value, note content, or local path in trace records, so that debug logs do not expand Linkmark's privacy exposure.
15. As a maintainer, I want the runtime switch to be process-local and reset on kernel reload or container restart, so that debugging state cannot become a workspace setting accidentally.
16. As a maintainer, I want changing the development-only switch to take effect immediately, so that I can capture one reproduction without saving settings or restarting Docker.
17. As a maintainer, I want the ordinary `cache.changed` and `cache.resolution-failed` behavior unchanged, so that connected Frontend clients remain decoupled from diagnostic output.
18. As a maintainer, I want deterministic tests to capture trace records through one cache-authority seam, so that lifecycle guarantees do not depend on a live Docker container or a browser console.
19. As a maintainer, I want the local debugging guide to distinguish kernel-log tailing from `docker logs`, so that I do not mistake absent container output for missing trace records.
20. As a maintainer, I want an unmodified production build to omit the trace settings control and debug RPC surface, so that deployment artifacts retain their narrow public contract.

## Implementation Decisions

- Resolution trace is development-build-only in both the Frontend client and Kernel plugin artifacts. The production build removes the settings control, the runtime toggle endpoint, and trace emission paths rather than merely hiding them.
- The development settings page contains one default-off Resolution trace switch. Its change takes effect immediately and does not participate in the normal settings confirmation flow.
- The switch communicates only with the development Kernel plugin and sets process-local state. It is neither a Cache policy nor a Display preference and is never persisted through plugin storage, workspace cache storage, or a state-change broadcast.
- The Cache authority remains the owner of Resolution trace lifecycle timing because it owns In-flight tasks, same-scope coalescing, Resolution concurrency, invalidation, resolution outcomes, private-payload persistence, Cache persistence batches, and cache-state notification.
- The Cache authority receives one optional trace sink through its existing construction boundary. When tracing is off, the sink is absent and trace-record creation is avoided. The Kernel plugin provides the sink by emitting development trace records through SiYuan's plugin logger at debug level.
- A trace record is one JSON object per logger call. Every record includes a fixed schema version, event name, task identifier, sanitized Link scope identity, trigger where applicable, and monotonic elapsed durations measured from task acceptance.
- The required lifecycle events are `accepted`, `coalesced`, `waiting-slot`, `started`, `candidate-finished`, `resolved`, `persisted`, `committed`, `failed`, and `invalidated`. Only valid transitions are emitted; terminal events are mutually exclusive for one task.
- Candidate records include the candidate source, a sanitized target identity, attempt ordinal, elapsed duration, remaining budget where applicable, HTTP status when received, normalized content type when received, validated byte count when available, and a sanitized outcome. They never include the candidate URL, query string, fragment, response body, request headers, or credentials.
- Trace records reuse the existing sanitized Resolution failure categories. Unknown thrown errors are represented through the existing network category rather than serializing arbitrary error objects.
- Cache persistence is represented as distinct `persisted` and `committed` events so an icon result is not mistaken for an authoritative Cache entry before its durable Cache persistence batch and state notification complete.
- The existing Queue acknowledgement, `ready`, and `unavailable` Kernel RPC response shape is unchanged. Resolution trace is diagnostic output only and never becomes a frontend notification or a user-visible error.
- Pinned icon retention, public-target validation, Forward-proxy request sanitization, resolution candidate and total-time budgets, four-task Resolution concurrency, cache invalidation, atomic Cache persistence, and fail-open rendering retain their existing behavior.
- The local development guide documents mounting the development artifact into the SiYuan workspace plugin location, reloading the plugin after artifact changes, locating and following the kernel log file, and treating container stdout as supplemental diagnostic output.

## Testing Decisions

- The primary acceptance seam is a Cache authority constructed with deterministic in-memory Cache storage, a controllable Icon resolver, and a recording Resolution trace sink. Tests assert the sequence and fields of externally emitted trace records, not private queue collections, logger call implementation, or timer internals.
- Existing cache-authority tests for a queued cache miss, same-scope coalescing, four-scope Resolution concurrency, invalidation, persistence batching, successful cache-state publication, and sanitized resolution failure are the prior art. They should be extended rather than replaced.
- Tests prove that a newly accepted cache miss emits acceptance and start records, returns `queued` before resolution completes, and completes with the correct resolved, persisted, and committed lifecycle sequence.
- Tests prove that a second request for a matching Link scope still returns `queued`, invokes the resolver once, and emits a coalesced record that references the owning task.
- Tests prove that a fifth distinct scope emits a waiting-slot record and begins only after an earlier task releases one of the four Resolution concurrency slots.
- Tests prove candidate outcome records for a usable image, non-success response, malformed or invalid image data, resolver transport rejection, and deadline expiry. Assertions verify only sanitized metadata and must reject raw URLs, query values, response bodies, headers, tokens, and arbitrary error text.
- Tests prove that a failed task emits exactly one terminal `failed` record carrying the existing sanitized category and that an invalidated task emits `invalidated` without a later commit or failure record.
- Tests prove that a successful resolution which is blocked on Cache persistence emits its persistence lifecycle only after storage succeeds and emits `committed` only with the existing authoritative cache-state publication behavior.
- Tests prove that tracing disabled produces no records and does not change Queue acknowledgement, cache contents, resolution count, Resolution concurrency, state-change broadcasts, or failure notifications.
- Tests at the development build boundary prove that the development artifact includes the switch and toggle endpoint while the production artifact excludes both. TypeScript validation and the complete package-content validation remain delivery gates.
- Docker/browser testing remains a manual smoke check rather than the main automated seam: enable the switch, reproduce a manual refresh, and follow the kernel log for a complete correlated sequence.

## Out of Scope

- Changing the Queue acknowledgement into a synchronous resolution result, polling the Cache authority, or adding task-status retrieval to the public Kernel RPC contract.
- Persisting trace state, trace history, task checkpoints, or unfinished In-flight tasks across a kernel reload, plugin disablement, SiYuan shutdown, or Docker restart.
- Adding a production diagnostic UI, production debug RPC, telemetry, remote log collection, external worker, sidecar, queue dashboard, or third-party observability dependency.
- Logging raw external URLs, document paths, query parameters, fragments, response payloads, request headers, cookies, authorization data, tokens, note content, or local filesystem paths.
- Changing the existing Cache policy, Display preference, resolver selection, public-target validation, Forward-proxy behavior, resolution budget, candidate limit, Resolution concurrency, pinned-icon behavior, or private icon route.
- Docker/browser end-to-end automation, release tagging, publication, and unrelated frontend redesign.

## Further Notes

- `queued` is a Queue acknowledgement, not a resolution result. A trace exists to explain the work that follows it, not to redefine the Cache authority contract.
- SiYuan's plugin logger writes to the kernel log file. Docker standard output may still be useful for process startup and crashes, but the local guide must not promise that it contains all plugin trace output.
- The glossary defines Resolution trace as a development-build-only, default-off, process-local diagnostic mechanism. No new ADR is needed because the feature is reversible, local to development, and does not alter a durable architecture boundary.
- GitHub Issues are currently disabled for the repository, so this specification cannot be published to the configured issue tracker or labeled `ready-for-agent` until repository Issues are enabled.
