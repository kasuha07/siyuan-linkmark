# Scalable cache management

## Problem Statement

Linkmark targets an authoritative cache of 10,000 entries, but the cache
manager currently filters and locale-sorts the complete Frontend Cache mirror,
creates DOM for every match, and replaces the complete list after every search
input. This can block the main thread and makes every Frontend client retain and
synchronize cache state that it does not need for the Present document.

The user needs cache search, paging, single-entry actions, Bulk cache refresh,
and private icon delivery to remain responsive and correct across multiple
Frontend clients without being asked to perform manual testing.

## Solution

Move cache matching and management reads behind the Kernel Cache authority.
Each Frontend client keeps only a bounded Frontend cache working set for Present
scopes, while the cache manager reads deterministic, revision-tagged pages of at
most 100 entries by default. Compact Cache change events invalidate Frontend
views without broadcasting Cache entries. Single-entry actions use optimistic
entry identity, Bulk cache refresh becomes a Kernel-owned Workspace operation,
and private icon responses become long-lived and immutable only after icon IDs
are guaranteed never to be reused.

## User Stories

1. As a user with 10,000 cached entries, I want the cache manager to open without rendering every entry, so that opening settings remains responsive.
2. As a user searching the cache, I want input to be debounced, so that each keystroke does not trigger redundant work.
3. As a user searching the cache, I want matching to cover Cache key and domain text, so that I can find both domain and route entries.
4. As a user browsing search results, I want deterministic ordering, so that entries do not move because another client uses a different locale.
5. As a user browsing the cache, I want 100 entries per page by default, so that the manager creates a bounded amount of DOM.
6. As a user browsing later pages, I want clear page and total counts, so that I understand my position in the result set.
7. As a user viewing a page while the cache changes, I want the page refreshed as one revision, so that rows from different revisions are never mixed.
8. As a user deleting an entry, I want a stale action rejected, so that I cannot delete a newer icon created by another client.
9. As a user restoring automatic resolution, I want the action rejected if the Pinned entry changed, so that another client's newer choice is preserved.
10. As a user refreshing one entry, I want the action bound to the row I selected, so that an obsolete page cannot requeue replacement of newer state.
11. As a user editing a document, I want icon matching to preserve Pinned, route-domain, Shared-pin, automatic, and freshness precedence, so that pagination work does not change rendered icons.
12. As a user editing a document, I want Linkmark memory to scale with Present scopes, so that a large Workspace cache does not become a full per-window mirror.
13. As a user with multiple mounted editors or previews, I want all Present scopes looked up together, so that every mounted Link content container receives consistent matches.
14. As a user receiving rapid cache updates, I want lookup work coalesced, so that Linkmark does not start parallel full working-set refreshes.
15. As a user whose Kernel plugin reloads, I want stale lookup and page responses discarded, so that the previous Cache epoch cannot overwrite current state.
16. As a user starting Bulk cache refresh, I want it to use bounded Kernel concurrency, so that 10,000 Frontend RPC calls are not created.
17. As a user starting Bulk cache refresh twice, I want the second request to report the existing run, so that duplicate Workspace operations are not created.
18. As a user closing the initiating window, I want Bulk cache refresh to continue, so that the Workspace operation does not depend on one Frontend lifecycle.
19. As a user reopening the manager, I want to see current Bulk cache refresh status, so that missed progress notifications do not hide the operation.
20. As a user cancelling Bulk cache refresh, I want unscheduled work to stop while shared in-flight resolutions finish safely, so that cancellation does not disrupt other clients.
21. As a user Pinning or deleting during Bulk cache refresh, I want generation invalidation to protect the newer mutation, so that an older refresh result cannot recreate or overwrite it, and a scope mutated after the run started is skipped rather than re-resolved even when its refresh task has not begun.
22. As a user loading the same private icon repeatedly, I want the browser to reuse it for a year, so that unchanged icon bytes are not repeatedly requested.
23. As a user receiving a refreshed icon, I want its private URL never reused for different bytes, so that immutable caching cannot display stale content.
24. As a maintainer, I want deterministic automated acceptance at the authority, Frontend synchronization, and manager state seams, so that no manual browser testing is delegated to the user.
25. As a maintainer, I want structural performance evidence separated from profiling claims, so that bounded work is verified without inventing latency improvements.
26. As a maintainer, I want existing Goja host constraints preserved, so that new identity and scheduling code does not assume browser-only globals.

## Implementation Decisions

- The Kernel Cache authority remains the sole owner of Cache entries, effective
  Cache matching, management search and sorting, pagination, Entry tokens, and
  Bulk cache refresh state.
- Cache precedence moves to a shared, Kernel-safe pure module. The Cache
  authority returns the effective Cache match for each requested Link scope;
  the Frontend does not assemble raw candidate entries.
- A batch Cache lookup accepts the current Present scopes and returns one
  complete match set tagged with Cache epoch and Cache revision. The result
  atomically replaces the Frontend cache working set.
- The Frontend no longer calls the complete Cache snapshot RPC for startup or
  recovery. A complete snapshot may remain internal to the authority and tests,
  but it is not a Frontend transport contract.
- Cache change events carry Cache epoch, Cache revision, and the changed Cache keys of the committed batch, or a null sentinel when the batch is too broad to enumerate (ADR 0018). A Frontend client skips its working-set lookup when no Present scope's candidate Cache keys intersect the change; an event from another Cache epoch always triggers a lookup. Resolution failure notifications continue to carry a Link scope key and sanitized failure category without entry or payload data.
- Cache mutation receipts identify `committed` or `unchanged` and carry Cache
  epoch and Cache revision without Cache entry deltas or batch keys. Existing rules remain:
  no-op mutations do not persist, broadcast, or advance revision, and committed
  persistence is not rolled back by notification failure.
- A newer revision or a different epoch invalidates the Frontend cache working
  set and any Cache-management page. If a change arrives during lookup, the
  current request finishes and at most one follow-up Working-set refresh runs.
  Responses from another epoch or older than an already observed invalidation
  are discarded.
- Working-set refresh looks up all Present scopes. No reverse dependency index
  is maintained for targeted invalidation.
- The Cache-management query accepts normalized substring, offset, and limit.
  It matches normalized Cache key and domain text.
- Management ordering is deterministic ordinal ordering by normalized Cache
  key. Locale-aware ordering is not part of the contract.
- The authority caches the sorted Cache-key index for the current Cache
  epoch/revision and discards it after the next committed mutation. Search
  filters this index instead of sorting all entries for every query.
- Cache-management pages use live offset pagination. Responses contain items,
  total, offset, limit, Cache epoch, and Cache revision. Historical snapshots,
  query sessions, and cross-revision page composition are not supported.
- The Frontend search debounce defaults to 200 milliseconds. The default page
  limit is 100 and the Kernel-enforced maximum is 200. Search or page changes
  replace only the current result page, and the manager creates DOM only for
  returned items.
- Each management item contains the fields needed to display and act on the
  entry, plus an opaque Entry token. A single-entry mutation supplies Cache key,
  page epoch, and Entry token. An epoch or token mismatch returns the stable
  `cache_entry_changed` conflict without mutating state, after which the manager
  reloads its page.
- A lightweight Cache stats read provides authoritative entry count, Cache
  epoch/revision, and current Bulk cache refresh state for settings and manager
  summaries without transferring entries.
- Refreshing the current document continues to use Link scopes already
  discovered in that document. It does not depend on management pagination.
- Bulk cache refresh is a Kernel-owned Workspace cache operation. It captures
  the non-Pinned entries present when the run starts; entries added later are
  excluded from that run.
- Bulk cache refresh uses the existing bounded resolver concurrency and admits
  one run per Workspace. A duplicate start returns `already-running`.
- Bulk cache refresh returns an immediate start receipt and exposes observable
  counts for total, scheduled, completed, failed, and skipped work. Its states
  are `running`, `cancelling`, `cancelled`, and `completed`.
- Bulk cache refresh survives the initiating Frontend closing. Any Frontend may
  query status or request cancellation. Cancellation stops future scheduling;
  shared in-flight resolver work settles normally. Kernel reload terminates the
  run without persistent recovery.
- Existing generation invalidation remains authoritative when Bulk cache
  refresh races deletion, Pinning, replacement, or other explicit mutations.
  Each scope captured at run start carries the generation baseline taken with
  it; a scope whose generation changed before its refresh task begins returns
  unavailable without starting a task, so deletion or replacement before task
  creation cannot resurrect the entry, and such scopes count as skipped work.
- Icon IDs must become non-reusable across Kernel authority lifetimes and icon
  replacements while retaining legacy icon-ID parsing. The implementation must
  not require browser-only randomness APIs unavailable in Goja.
- Only after the non-reuse invariant is established, successful Private icon
  route responses use `private, max-age=31536000, immutable`.
- Pagination is chosen instead of virtual scrolling because it bounds DOM work
  with simpler focus, keyboard, mutation, and revision invalidation behavior.
- Existing Pinned-icon safety, Cache policy, Display preferences, fail-open
  rendering, private route authentication, and fixed 32-millisecond persistence
  batching (250 milliseconds during a Bulk cache refresh) remain unchanged
  unless explicitly described above.

## Testing Decisions

- Tests assert observable contracts rather than private collection choices or
  exact helper call counts. Structural bounds are acceptable evidence; elapsed
  time, percentiles, and memory improvements require a recorded profile.
- The primary Kernel seam is the Cache authority with in-memory storage, a
  controlled resolver, a controlled clock, and captured broadcasts. This
  extends the existing authority tests for resolution concurrency, persistence
  batching, generation invalidation, revision/epoch behavior, mutation
  receipts, private icon identity, and the 10,000-entry fixture.
- Authority tests cover effective batch lookup precedence, atomic response
  cursors, query normalization, deterministic ordering, offset boundaries,
  limit enforcement, sorted-index invalidation, Cache stats, Entry-token
  conflicts, and compact notification/receipt payloads.
- Bulk refresh tests cover the invocation-time input set, Pinned skips, maximum
  concurrency, duplicate starts, state and counts, Frontend disconnection,
  cancellation, shared in-flight work, mutation races, and Kernel reload.
- Private route tests cover legacy ID parsing, frozen-clock uniqueness,
  cross-authority non-reuse, refreshed and removed ID rejection, and the exact
  successful Cache-Control response. Absent browser-like globals remain a
  regression case for Kernel code.
- The primary Frontend seam is the Frontend cache client with a fake Kernel RPC.
  It covers startup without Cache snapshot, batch lookup adoption, revision and
  epoch invalidation, stale response rejection, atomic working-set replacement,
  coalesced dirty follow-up, mutation receipt handling, Cache stats, and Bulk
  refresh status reconnection.
- Existing render-work tests remain the highest seam for Present-scope bounds.
  The standard scenario uses 2,000 external links, 500 Present scopes, and a
  10,000-entry authority fixture; it must produce at most 500 working-set results
  and exactly the applicable 500 Icon rules.
- The cache manager gains one pure, timer-injected page controller seam for
  debounce, query replacement, page navigation, revision invalidation, page
  clamping after deletion, stale request suppression, loading/empty/conflict
  states, and Bulk cache refresh state. The dialog remains a thin renderer of
  controller state.
- A focused renderer test uses a minimal injected document surface, following
  existing runtime binding test patterns, to prove that the default page creates
  no more than 100 entry rows and that input does not synchronously rebuild a
  complete list. No DOM test dependency is added.
- Build-boundary tests prove that the Frontend bundle contains no complete-cache
  snapshot synchronization path or runtime 10,000-entry fixture and that the
  marketplace payload remains complete.
- Fresh verification runs `npm run check` followed by `npm run build`. The user
  is not required to perform manual testing.

## Out of Scope

- Virtual scrolling or an infinite list.
- Historical pagination snapshots, cursor sessions, or MVCC.
- A reverse dependency index for targeted Present-scope invalidation. The changed-keys hint in Cache change events (ADR 0018) is not a reverse dependency index: the Kernel never tracks which Frontend clients hold which scopes, and the client-side candidate-key predicate is computed locally.
- Persisting or resuming Bulk cache refresh across Kernel reload.
- Cache index partitioning (sharding) or removal of the whole-index Index
  checkpoint write per Index compaction; Cache journaling is adopted instead
  (ADR 0019).
- Changing Cache freshness policy, Link scope identity, Pinned precedence,
  Shared-pin eligibility, route fallback, automatic-fetch behavior, or
  fail-open rendering.
- A general settings or cache-manager visual redesign.
- Browser, Docker, or SiYuan end-to-end automation; new test dependencies.
- Runtime telemetry, a performance overlay, or an in-app performance trace.
- Numeric latency, percentile, or memory improvement claims without a recorded
  profiling session.
- Version changes, release publication, tags, commits, or pushes.

## Further Notes

- ADR 0015 records the authoritative query and bounded Frontend working-set
  boundary. ADR 0016 records the private icon identity prerequisite for
  immutable caching.
- The fixed-size page and Present-scope working set provide deterministic
  structural reductions. They do not by themselves prove a specific wall-clock
  improvement on a particular device.
- This is a local project SPEC. It is not published to an issue tracker and has
  no `ready-for-agent` label.
