# Interactive render performance

## Problem Statement

Linkmark already keeps favicon resolution asynchronous, bounds Resolution
concurrency, publishes incremental Cache change events, and limits Icon rules to
Present scopes. Large SiYuan documents can still make the Interactive render
pipeline perform substantial main-thread work while a user types, pastes, adds,
rewrites, or removes links. The current repository has structural regression
coverage for local discovery and Present-scope reconciliation, but it has no
repeatable way to measure discovery, rule reconciliation, or stylesheet
publication in a real Frontend client.

The absence of browser automation means wall-clock performance cannot be a
stable CI acceptance gate. Without a development-only trace, a standard manual
scenario, and an explicit baseline-first stop condition, performance work would
either rely on impressions or introduce complexity without evidence that it
improves Editor responsiveness.

## Solution

Provide a development-only Frontend performance trace and a repeatable
Large-document performance scenario for the Interactive render pipeline. A
maintainer generates and imports a document containing 2,000 external-link
nodes across 500 distinct Link scopes, enables the trace in development
settings, performs approximately 30 seconds of ordinary editing, and disables
the trace to receive one automatic console summary. Development profiling uses
a process-local Frontend cache view containing 10,000 fixture entries; it never
mutates or replaces the Cache authority's data.

The trace reports enough evidence to compare the current baseline with a
candidate optimization: incremental-interaction sample count and P95 execution
time, the slowest Full discovery, and the slowest Rule freshness interval. The
manual targets are an Incremental interaction P95 of at most 8 milliseconds, a
Full discovery of at most 50 milliseconds, and Rule freshness of at most 300
milliseconds. These values are profiling targets, not CI gates or promises
across devices.

Automated tests lock the structural properties that make those targets
plausible: ordinary input remains locally scoped, repeated work is coalesced,
one batch publishes rules at most once, and rule computation scales with
Present scopes rather than the complete Frontend cache view. Runtime code is
changed only after the baseline identifies a concrete hotspot. A candidate
optimization is retained only when it improves a key metric by at least 20
percent in the same recorded environment without regressing the other targets
or existing behavior. If the baseline already meets the targets and no such
hotspot exists, diagnostic support, structural coverage, and the research
record are a complete outcome.

## User Stories

1. As a Linkmark user editing a large SiYuan document, I want ordinary typing to remain responsive, so that favicon rendering does not interrupt writing.
2. As a user pasting an external link, I want Linkmark to inspect only the relevant local region, so that the rest of the document does not add avoidable work.
3. As a user changing one external link, I want Linkmark's incremental main-thread work to target a P95 of no more than 8 milliseconds, so that SiYuan retains time for its own editing and rendering.
4. As a user removing a link, I want any required Full discovery to target no more than 50 milliseconds, so that stale-rule eviction does not create a browser long task.
5. As a user finishing an edit, I want the applicable Icon rule published within a target of 300 milliseconds, so that an optimization cannot hide cost by postponing visible updates indefinitely.
6. As a user with several copies of the same link, I want Linkmark to preserve the correct Present-scope behavior, so that performance work does not remove icons or create duplicate rules.
7. As a user with domain and route-specific links, I want their existing selector precedence preserved, so that faster publication does not select the wrong icon.
8. As a user with a Pinned icon, I want its rendering and protection unchanged, so that performance work never weakens an explicit customization.
9. As a user with stale, missing, or legacy cache entries, I want the existing freshness and fail-open behavior preserved, so that a faster scan does not render invalid placeholders.
10. As a user with automatic retrieval paused, I want the existing paused behavior preserved, so that profiling or optimization does not initiate unexpected Cache operations.
11. As a maintainer, I want one canonical Large-document performance scenario, so that baseline and candidate measurements describe the same workload.
12. As a maintainer, I want the scenario to contain 2,000 external-link nodes and 500 distinct Link scopes, so that it exercises both repeated links and scope diversity.
13. As a maintainer, I want the Frontend cache view to contain 10,000 entries, so that Present-scope work is measured against the project's intended large-cache scale.
14. As a maintainer, I want the cache fixture to remain process-local and development-only, so that profiling cannot pollute a real workspace Cache authority.
15. As a maintainer, I want the document fixture generated on demand rather than committed as a large artifact, so that the repository stays reviewable.
16. As a maintainer, I want to enable Frontend performance trace from development settings, so that profiling does not require source edits or a private console API.
17. As a maintainer, I want disabling the trace to print and clear one summary, so that a short profiling session has an obvious start and stop.
18. As a maintainer, I want trace state reset on Frontend reload, so that one session cannot silently contaminate another.
19. As a maintainer, I want trace records to exclude document text, external URLs, note identifiers, and cache payloads, so that performance diagnosis does not expand Linkmark's privacy exposure.
20. As a maintainer, I want an unmodified production build to omit the trace control and fixture surface, so that normal users incur no diagnostic UI or fixture behavior.
21. As a maintainer, I want the trace state bounded, so that collecting a longer session cannot itself cause an unbounded memory increase.
22. As a maintainer, I want structural tests instead of CI timing assertions, so that slower test hosts do not produce false failures.
23. As a maintainer, I want the standard fixture to prove local discovery, work coalescing, single publication per batch, and Present-scope-bounded reconciliation, so that automated coverage protects the intended algorithmic shape.
24. As a maintainer, I want baseline and candidate measurements recorded with the SiYuan, Chromium, Linkmark, device, and source revision details, so that a claimed improvement can be interpreted and reproduced.
25. As a maintainer, I want a candidate optimization to improve a key metric by at least 20 percent in the same environment, so that code complexity is justified by evidence rather than measurement noise.
26. As a maintainer, I want a baseline that already meets every target to permit no runtime optimization, so that performance work does not become mandatory churn.
27. As a maintainer, I want a persistent DOM index considered only after profiling proves Full discovery remains a bottleneck, so that MutationObserver state complexity is not introduced speculatively.
28. As a maintainer, I want any new performance-derived production state to scale with Present scopes and target at most 5 MiB in the standard scenario, so that CPU improvements do not copy the complete Cache or create unbounded memory growth.
29. As a maintainer, I want the full TypeScript, ESLint, Vitest, build, and package checks to remain green, so that diagnostic work does not weaken the marketplace payload.

## Implementation Decisions

- The work is limited to the Interactive render pipeline: editor mutation scheduling, link discovery, Icon rule reconciliation, and runtime stylesheet publication. Plugin startup, Cache snapshot transport, favicon resolution, network retrieval, Cache persistence, and private icon serving are non-regression boundaries rather than optimization targets.
- Baseline measurement precedes runtime optimization. The first implementation slice provides the development diagnostic, the generated scenario, structural coverage, and a recorded baseline before choosing a hotspot.
- The existing Frontend render-work boundary is the primary automated seam. It already represents discovery requests, rule rebuild requests, publication requests, work coalescing, and one externally visible flush. Present-scope rule reconciliation remains its collaborating pure policy seam rather than being replaced by a lower-level test surface.
- Frontend performance trace is available only in development builds. It is default-off, process-local, never persisted, and reset when the Frontend client reloads.
- Development settings expose one Frontend performance trace switch alongside the existing development Resolution trace surface. Enabling it starts a fresh session; disabling it prints one summary to the developer console and clears all samples and fixture state.
- Trace timing uses a monotonic Frontend clock. The measured stages distinguish discovery, Icon rule reconciliation, stylesheet publication, total incremental execution, Full discovery execution, and the interval from stable editor input to applicable rule publication.
- The required summary contains the session sample counts, Incremental interaction P95, slowest Full discovery, and slowest Rule freshness interval. It may include stage-level totals or maxima when they make a hotspot actionable, but it must remain a concise single-session summary.
- Trace state is bounded independently of session duration. It may use fixed-size samples or bounded aggregates sufficient to calculate the required summary; it must not retain DOM nodes, Link elements, document content, external URLs, cache payloads, or an unbounded event history.
- Production artifacts omit the development control, fixture activation, and reporting surface. When tracing is disabled, ordinary render behavior remains unchanged and avoids per-event record allocation beyond any minimal clock checks justified by the implementation.
- The standard document fixture is generated by a dependency-free repository script. It contains 2,000 external-link nodes distributed deterministically across 500 distinct Link scopes and produces an importable Markdown artifact outside the tracked source set.
- Enabling the development performance scenario supplies a read-only, process-local Frontend cache overlay of exactly 10,000 fresh current entries. The 500 Present scopes resolve through that view, while the remaining entries exercise large-cache isolation.
- The fixture overlay exists only at the Interactive render pipeline's cache-read boundary. It must not overwrite the adopted Cache snapshot, change Cache revision or Cache epoch, affect cache counts or management UI, invoke Kernel RPC, suppress or create real cache mutations, persist data, or survive trace disablement or Frontend reload.
- Disabling the trace removes the fixture overlay and requests the ordinary reconciliation needed to restore rendering from the real Frontend cache state.
- The manual profiling flow remains deliberately short: generate and import the document, enable the trace, perform approximately 30 seconds of ordinary input, link paste, and link deletion, then disable the trace and retain the resulting summary.
- Incremental interaction targets P95 execution time of at most 8 milliseconds, excluding deliberate scheduling delay. Full discovery targets at most 50 milliseconds of main-thread execution. Rule freshness targets publication within 300 milliseconds after input becomes stable, including scheduling delay.
- The targets are manual profiling goals only. They are interpreted against the environment recorded with the result and are not cross-device guarantees, automated acceptance budgets, or reasons to add flaky timing assertions.
- Any performance-derived state added to production must scale with Present scopes rather than the complete Frontend cache. If such state is introduced, one manual heap check records whether its additional memory remains within the 5 MiB target in the standard scenario.
- A persistent DOM index, element-to-scope map, or scope reference count is not a predetermined solution. It becomes a candidate only when the baseline shows Full discovery is a material hotspot that remains above target after simpler measured improvements.
- Prefer deletion, existing work coalescing, existing rule maps, and narrower discovery before new state or abstractions. No new dependency is permitted for instrumentation, fixture generation, percentile calculation, or optimization.
- A runtime optimization is retained only when the same manual scenario and recorded environment show at least 20 percent improvement in a key metric, every other profiling target remains non-regressed, and automated behavior checks remain green.
- If the baseline already meets all profiling targets and no candidate clears the improvement threshold, the diagnostic, fixture generator, structural tests, glossary, SPEC, and research record complete the work without a runtime optimization.
- The performance research record contains the source revision, Linkmark version, SiYuan version, Chromium version, device summary, scenario confirmation, baseline summary, any candidate summary, identified hotspot, retained or rejected change, and explicit limitations. It is evidence for this optimization pass, not a permanent platform benchmark.
- Existing rendering behavior remains invariant: supported link elements and URL forms, domain and route selector precedence, Display preference sizing, Pinned icon precedence, freshness policy, paused legacy monograms, fail-open behavior, Cache change reconciliation, and removal of rules for scopes that are no longer Present.

## Testing Decisions

- The highest automated seam is one Frontend render-work flush supplied with a deterministic executor that performs discovery, Present-scope reconciliation, and publication. Tests assert observable discovery scope, resulting Icon rules, fetch decisions where applicable, and publication count rather than private timers, sets, MutationObserver records, or implementation-specific caches.
- The Large-document structural fixture contains 2,000 link representations across 500 distinct Link scopes and a 10,000-entry cache view. Automated tests do not measure its elapsed time; they prove the amount and shape of externally visible work.
- Ordinary input and a newly added link must produce local discovery only. Tests prove the mounted editor host is not selected as a fallback whole-document region and that nested or repeated local regions are reduced to the narrowest useful set.
- Repeated mutations in one scheduling window must coalesce into one work batch. A batch may rebuild, discover, and publish as required, but it publishes the runtime stylesheet at most once.
- A Full discovery supersedes pending local discovery and evicts Icon rules for Link scopes no longer Present. Local discovery only adds or updates rules for its regions and does not accidentally evict scopes outside those regions.
- Present-scope reconciliation against 10,000 cache entries must produce rules only for the 500 discovered scopes. Tests prove the behavior through lookup and output cardinality rather than inspecting loop counters or private collections.
- Tests preserve domain and route-rule ordering, pinned-domain suppression of route rules, fresh/current entry filtering, paused legacy-monogram behavior, and no rule for missing or unusable entries.
- Development trace tests use a controllable monotonic clock and the same high-level flush seam. They prove session reset, bounded samples, correct P95 and maxima, one summary on disable, and complete clearing before a later session.
- Diagnostic privacy tests prove that summaries contain only stage names, counts, durations, build or session metadata, and fixture metadata. They must not contain Link elements, document text, external URLs, cache keys, icon URLs, note identifiers, payloads, or arbitrary error text.
- Fixture-isolation tests prove that enabling and disabling the development overlay does not mutate the adopted Cache snapshot, revision, epoch, cache count, Kernel RPC calls, persistence operations, or production settings.
- Build-boundary tests extend the existing development-versus-production prior art. They prove that development artifacts contain the Frontend performance trace control and fixture surface while production artifacts omit them.
- The fixture generator has a deterministic output test or package check that proves exactly 2,000 links and 500 distinct Link scopes without committing the generated Markdown artifact.
- Existing Frontend render-work tests, Present-scope rule tests with a 10,000-entry cache, frontend cache-state tests, and production build-boundary tests are the prior art and should be extended rather than replaced.
- Manual profiling is the only evidence for the 8 millisecond, 50 millisecond, 300 millisecond, 5 MiB, and 20 percent targets. The research record must distinguish measured values from structural test evidence.
- Run the repository's full validation command after implementation. It must pass TypeScript validation, ESLint with zero warnings, and the Vitest suite. The production build and package-content validation must still produce and accept the complete marketplace payload.

## Out of Scope

- Browser, Docker, or SiYuan end-to-end automation and CI timing benchmarks.
- Treating manual millisecond targets as cross-device guarantees or release-blocking automated thresholds.
- Optimizing plugin startup, Cache snapshot serialization or transfer, Kernel RPC, favicon discovery, Forward-proxy retrieval, Resolution concurrency, image decoding, private icon serving, or Cache persistence.
- Changing Cache policy, Display preferences, Link scope identity, Icon rule selector coverage, pinned-icon behavior, cache freshness, route precedence, automatic-fetch behavior, or fail-open rendering.
- Persisting performance trace sessions, fixture cache entries, generated documents, profiling history, or diagnostic settings.
- Writing fixture data into the Cache authority, workspace plugin storage, SiYuan documents automatically, or any real cache-management surface.
- Production telemetry, analytics, remote logging, a user-facing performance dashboard, external profiling service, or a new dependency.
- Committing to a persistent DOM index before measurement, or retaining an optimization that misses the 20 percent improvement threshold.
- General UI redesign, third-party link-icon detection or compatibility, static icon libraries, release tagging, version changes, publication, and unrelated refactors.

## Further Notes

- Editor responsiveness is the primary performance outcome. Favicon download speed and resolver throughput are intentionally not proxies for it.
- The 250 millisecond discovery debounce and subsequent render batch are part of the current Rule freshness behavior. They may change only when the measured result remains within the 300 millisecond target and coalescing behavior is preserved.
- The 5 MiB target applies only if an optimization adds production Frontend state. The development-only 10,000-entry fixture and bounded trace samples are diagnostic inputs and are reported separately.
- No ADR is required at specification time. The diagnostic and baseline-first workflow are reversible, and a persistent DOM index has not been selected. If later profiling justifies a hard-to-reverse architecture change, that decision must be evaluated independently against the repository's ADR criteria.
- This SPEC is intentionally local. Issue-tracker publication and the `ready-for-agent` label are not performed because the requested outcome is a repository-local specification.
