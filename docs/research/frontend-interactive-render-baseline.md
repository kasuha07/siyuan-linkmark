# Interactive render performance: baseline-first research record

Status: diagnostic delivered, structural evidence green, review fixes for the
trace isolation, Pinned-preserving cache view, and interaction-sample
semantics retained; manual baseline session pending.

## Recorded environment

| Field | Value |
| --- | --- |
| Source revision | 70f118b (delivers the diagnostic, scenario, and the review fixes described under Retained in this pass). |
| Linkmark version | 0.1.2 (siyuan-linkmark) |
| SiYuan version | Manual sessions run against the local development workspace (`b3log/siyuan:latest`; prior exploratory profiling recorded 3.7.3). |
| Chromium version | Manual sessions record the desktop Chromium used by the SiYuan client; prior exploratory profiling recorded Chromium 151. |
| Device summary | Pending: record OS, CPU, and memory with the first manual session. |

## Scenario confirmation

The standard Large-document performance scenario is delivered and verified by
automated structural tests, not by elapsed-time assertions:

- `node scripts/generate-perf-scenario.mjs` deterministically produces an
  importable Markdown artifact with exactly 2,000 external-link nodes across
  500 distinct Link scopes (480 `perf-site-*.example.dev` domains and 20
  `nocode.host` route scopes), written outside the tracked source set.
- The development-only Frontend cache overlay contains exactly 10,000 fresh
  current entries: the 500 scenario scopes plus 9,500 decoy entries that
  exercise large-cache isolation. It is read-only (frozen), process-local,
  cleared on trace disablement and Frontend reload, and never touches the
  adopted Cache snapshot, revision, epoch, cache counts, Kernel RPC, or
  persistence.
- Structural tests prove ordinary input and newly added links produce local
  discovery only, one scheduling window coalesces into one batch that
  publishes at most once, a Full discovery supersedes pending local discovery
  and evicts departed scopes, and Present-scope reconciliation against the
  10,000-entry view produces rules only for the 500 discovered scopes.

## Baseline summary

No standard-scenario baseline has been measured yet. The profiling targets
(Incremental interaction P95 at most 8 ms excluding scheduling delay, Full
discovery at most 50 ms, Rule freshness at most 300 ms) are manual goals for
the session described below; they are neither CI gates nor cross-device
promises.

Prior evidence from an exploratory session on 2026-08-01 (1,000 links, 250
scopes, warm cache, detached protyle fixture, SiYuan 3.7.3, Chromium 151)
recorded a cached-scan P95 of 8.1 ms and a mutation-to-stable P95 of 273.3 ms
with zero long tasks. That session predates the standard scenario and is not a
baseline for it.

## Candidate summary

No candidate optimization has been implemented. Per the baseline-first
decision, runtime code changes wait for a measured hotspot.

## Identified hotspot

None identified yet; profiling is required before one can be named. The
speculative persistent DOM index remains unselected until Full discovery is
measured as a material hotspot that stays above target after simpler measured
improvements.

## Retained and rejected changes

Retained in this pass:

- Development-only Frontend performance trace (default-off, process-local,
  bounded samples, one console summary on disable) in `src/frontend-performance-trace.ts`.
- Development-only fixture scenario, overlay, and generator in
  `src/perf-scenario.ts` and `scripts/generate-perf-scenario.mjs`.
- Structural coverage for local discovery, coalescing, single publication per
  batch, and Present-scope-bounded reconciliation.
- Trace-session scans never issue Cache authority RPC: while the trace is
  active the scan decision loop runs in the automatic-fetch-paused mode, so
  scopes missing from the fixture view are skipped and stale entries are not
  expired instead of queuing `cache.get-or-queue` or `cache.remove` calls.
- The render cache view layers the real cache's pinned entries over the
  10,000-entry fixture overlay (cloned and frozen), so Pinned precedence and
  pinned-domain route suppression stay invariant while profiling and unpinned
  real entries remain invisible to the pipeline.
- Incremental interaction samples cover batches with local discovery work
  only; rule rebuilds and publications without discovery (for example the
  reconciliation scheduled when the trace is enabled) are excluded, and the
  summary reports the full session interaction count alongside the P95
  computed from a bounded retained window.
- Glossary entries in `CONTEXT.md` and the SPEC `docs/specs/0006-interactive-render-performance.md`.

Rejected in this pass: every runtime optimization, any persistent DOM index,
any new dependency, and any change to Cache policy, Display preferences,
pinned-icon behavior, freshness, route precedence, or fail-open rendering.

## Manual profiling flow

1. Generate the scenario document: `node scripts/generate-perf-scenario.mjs`
   (writes `.scratch/perf-scenario.md`) and import it into a fresh SiYuan
   document.
2. In development settings, enable "Frontend performance trace (development
   only)". Enabling supplies the read-only 10,000-entry fixture cache view so
   the 500 Present scopes render without Cache authority traffic.
3. Perform approximately 30 seconds of ordinary typing, link pasting, and
   link deletion in the document.
4. Disable the trace. The developer console prints the single session summary
   with the Incremental interaction P95, the slowest Full discovery, the
   slowest Rule freshness interval, and stage aggregates.
5. Keep the summary and this record's environment table for the baseline; a
   candidate optimization is retained only if it improves a key metric by at
   least 20 percent in the same recorded environment without regressing the
   other targets or existing behavior.

## Limitations

- No browser, Docker, or SiYuan end-to-end automation exists in this
  repository, so wall-clock targets are validated only by manual sessions.
- The targets are device- and environment-dependent; they must be interpreted
  with the recorded environment, not as automated acceptance budgets.
- Trace records contain only stage names, counts, durations, and fixture
  metadata; they deliberately exclude document text, external URLs, cache
  payloads, and note identifiers, so they cannot fully localize a hotspot by
  themselves.
- This record is evidence for this optimization pass, not a permanent
  platform benchmark.
