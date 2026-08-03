# Interactive render performance: baseline-first research record

Status: structural evidence green; standard-scenario manual baseline pending.

## Recorded environment

| Field | Value |
| --- | --- |
| Source revision | Record the exact revision used by each future manual session. |
| Linkmark version | 0.1.2 (`siyuan-linkmark`) at the time this record was revised. |
| SiYuan version | Record the local development workspace version. |
| Chromium version | Record the desktop Chromium used by the SiYuan client. |
| Device summary | Record OS, CPU, and memory. |

## Scenario confirmation

- `node scripts/generate-perf-scenario.mjs` produces an importable Markdown
  document with exactly 2,000 links across 500 Link scopes.
- A test-only 10,000-entry cache fixture exercises large-cache isolation without
  entering either plugin artifact or mutating the Cache authority.
- Structural tests prove local discovery, work coalescing, one publication per
  batch, Full-discovery eviction, and exactly 500 rules for the Present scopes.

## Baseline summary

No standard-scenario browser baseline has been measured. The targets remain:

- Incremental interaction P95: at most 8 ms, excluding scheduling delay.
- Full discovery: at most 50 ms of main-thread execution.
- Rule freshness: at most 300 ms, including scheduling delay.

These are manual goals, not CI gates or cross-device promises. A prior
exploratory session on 2026-08-01 used a smaller 1,000-link and 250-scope
workload, so it is not the standard baseline.

## Retained implementation

- Local discovery and render-work coalescing.
- Present-scope-bounded Icon rule reconciliation.
- Streaming copy-on-write for no-op local reconciliation.
- The generated document scenario and test-only large-cache fixture.

The former in-app frontend performance trace and runtime fixture overlay were
removed. Future measurements use ordinary browser profiling tools against the
real Frontend cache state.

## Manual profiling flow

1. Run `node scripts/generate-perf-scenario.mjs` and import
   `.scratch/perf-scenario.md` into a fresh SiYuan document.
2. Build and load the exact Linkmark revision being measured.
3. Record the environment table and capture a browser performance profile while
   performing ordinary typing, link paste, and link deletion.
4. Record the relevant Interactive render pipeline timings as the baseline.
5. Repeat the same workload and environment for a candidate. Retain a complex
   optimization only with clear improvement and no regression in other targets
   or existing behavior.

## Limitations

- No browser, Docker, or SiYuan end-to-end automation exists in this repository.
- The test-only cache fixture proves algorithmic scale, not wall-clock latency.
- Browser profiles are device-dependent and must be interpreted with the
  recorded environment.
- This file records evidence for optimization work; it is not a platform-wide
  benchmark guarantee.
