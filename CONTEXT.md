# Linkmark

Linkmark adds and manages website icons for external SiYuan links. Its cache is shared by every client connected to one SiYuan workspace.

## Language

**Upstream project**:
The original `Acetab/auto-favicon` repository from which this repository is forked.
_Avoid_: original version, official fork

**Linkmark**:
The public product name of the independent `siyuan-linkmark` plugin, shown as "Linkmark" in English and "链接印记" in Chinese.
_Avoid_: Auto Favicon, SiYuan Favicon, Link Icon

**Independent maintainer**:
`霞葉 (Kasuha)`, the canonical human-readable maintainer attribution for Linkmark; `kasuha07` identifies the repository account rather than the display attribution.
_Avoid_: kasuha07, Acetab

**Fork copyright notice**:
The paired Acetab and `霞葉 (Kasuha)` copyright notices in Linkmark's MIT license that preserve upstream attribution while identifying independent modifications.
_Avoid_: replacement copyright, sole copyright

**Upstream credit**:
The bilingual disclosure that Linkmark is an independently maintained fork of `Acetab/auto-favicon` and has no affiliation with or endorsement from Acetab.
_Avoid_: official successor, Acetab plugin

**Link Icon acknowledgement**:
The bilingual disclosure that Linkmark credits `chenshinshi/link-icon` for the link-icon interaction idea while stating that no code or bundled icon assets are included.
_Avoid_: Link Icon compatibility, code attribution

**Unified Linkmark identity**:
The `siyuan-linkmark` identifier used for Linkmark's SiYuan plugin, package, standalone repository, storage, and private-route namespaces; it intentionally does not promise an in-place upgrade or data compatibility with the upstream-derived `auto-favicon` plugin.
_Avoid_: cosmetic rename, split technical identity

**Independent repository**:
The standalone `kasuha07/siyuan-linkmark` GitHub repository, which retains the project history and credit disclosures without remaining in the `Acetab/auto-favicon` fork network.
_Avoid_: GitHub fork, upstream repository

**Independent release line**:
The Linkmark version series beginning at `0.1.0`, with release notes on GitHub Releases rather than the upstream-derived `auto-favicon` release history.
_Avoid_: fork release, v0.6.x continuation

**Legacy data isolation**:
The rule that Linkmark starts with an empty `siyuan-linkmark` data namespace and neither imports nor deletes `auto-favicon` settings, cache entries, or pinned icons.
_Avoid_: migration, cleanup of old plugin data

**Cache authority**:
The single kernel-plugin owner of favicon resolution, downloads, cache-index mutations, cleanup, and private icon payloads for a workspace.
_Avoid_: frontend cache, client cache

**Forward-proxy retrieval**:
A cache authority request that obtains a validated public icon candidate through SiYuan's server-side network proxy.
_Avoid_: frontend cross-origin request, direct client download

**Public target**:
An HTTP(S) URL that the cache authority may retrieve through the forward proxy, excluding loopback, link-local, private, CGNAT, multicast, and reserved addresses.
_Avoid_: safe URL, external URL

**Authentication redirect**:
A candidate retrieval whose observed redirect hop targets an accounts, passport, or login host or a login, sign-in, or auth path. Cross-origin public HTTP(S) hops are allowed, while a hop with a missing, malformed, or non-public Location is invalid; the cache authority treats all of these failures as failed candidates rather than icons.
_Avoid_: login page, redirect loop

**Kernel plugin**:
A SiYuan v3.7-or-later `kernel.js` component that runs with the SiYuan kernel rather than an individual application window.
_Avoid_: background tab, browser worker

**Kernel RPC**:
The authenticated JSON-RPC boundary through which a frontend client invokes and receives state changes from the cache authority.
_Avoid_: direct cache-file access, frontend persistence API

**Queue acknowledgement**:
The immediate Kernel RPC response for a cache miss. It confirms that a new or coalesced In-flight task owns the Link scope, without representing an icon result or a failed resolution.
_Avoid_: cache miss, icon result, resolution failure

**Cache-miss result**:
The three-state Kernel RPC response to a cache miss: `ready` with a committed Cache entry, `queued` for accepted new or coalesced In-flight work, and `unavailable` when the Cache authority cannot accept the work. A queued response is neither an icon result nor a resolution failure.
_Avoid_: cache miss, icon result, resolution failure

**Authority initialization**:
The Cache authority's one-time load of the durable Cache index, including legacy-pin pruning. A failed initialization leaves the authority unable to accept cache-miss work, so it answers the `unavailable` Cache-miss result until the kernel plugin reloads.
_Avoid_: startup migration, cache recovery

**Interactive render pipeline**:
The Frontend path from an editor DOM change through link discovery and Icon rule reconciliation to runtime stylesheet publication. It excludes plugin startup, Cache snapshot transport, favicon resolution, network retrieval, and cache persistence.
_Avoid_: favicon resolution pipeline, plugin lifecycle, frontend performance in general

**Link content container**:
A mounted SiYuan editor or static-preview container whose external links contribute to Linkmark's Present scopes. Link changes outside these containers belong to SiYuan's surrounding UI and do not enter Linkmark's Interactive render pipeline.
_Avoid_: editor area, document body, SiYuan UI

**Frontend client**:
A desktop, mobile, or browser plugin instance that renders icons and requests cache operations from the cache authority through RPC.
_Avoid_: cache writer, cache owner

**Frontend cache client**:
The frontend client's cache-facing subsystem that owns the Frontend cache working set, Kernel RPC calls, and fetch orchestration, and that reports relevant cache changes and manual-refresh failures to the render pipeline through callbacks.
_Avoid_: frontend cache, client cache, cache authority

**Frontend cache working set**:
The bounded cache state needed by one Frontend client for its Present scopes and in-progress cache operations. It excludes the complete authoritative cache and cache-management result pages.
_Avoid_: cache snapshot, frontend cache mirror, management cache

**Working-set refresh**:
The coalesced replacement of a Frontend cache working set by looking up all Present scopes after authoritative cache state changes, reporting only Affected scopes. An invalidation that cannot affect any Present scope is skipped without a lookup; changes arriving during a lookup require at most one follow-up refresh rather than parallel lookups.
_Avoid_: cache snapshot recovery, per-entry patch, reverse-dependency update

**Affected scope**:
A Present scope whose Cache match (matched Cache key or Entry token) changed since the last adopted Cache lookup; only affected scopes can require binding synchronization.
_Avoid_: changed working-set key, union of working-set keys, all-scope resync

**Cache-management query**:
A revision-tagged search of authoritative Cache entries for management actions, ordered deterministically by normalized Cache key rather than client locale. Its result is read live from the current Cache revision rather than retained as a historical snapshot.
_Avoid_: cache lookup, cache snapshot, frontend filtering

**Cache-management page**:
One offset-based slice of a Cache-management query. It is invalidated when the Cache revision or Cache epoch changes and is never combined with pages from another revision.
_Avoid_: cursor snapshot, frontend cache page, stable historical page

**Entry token**:
An opaque Cache-authority identity for one Cache entry version, returned with a Cache-management page item and required for single-entry mutations. It changes whenever that entry's mutable state changes and rejects stale management actions.
_Avoid_: global Cache revision, iconId assumption, frontend row identity

**Editor responsiveness**:
The user-visible ability to type, paste, and add or remove external links in a mounted SiYuan document without Linkmark causing perceptible delay. It is Linkmark's primary performance outcome for large documents.
_Avoid_: favicon download speed, resolver throughput, general frontend performance

**Large-document performance scenario**:
The standard Linkmark responsiveness workload containing 2,000 external-link nodes, 500 distinct Link scopes, and an authoritative cache of 10,000 entries.
_Avoid_: large document, stress test, production maximum

**Incremental interaction target**:
In a manual profile of the Large-document performance scenario, the target 95th-percentile Linkmark main-thread execution time caused by one ordinary input or single-link change is at most 8 milliseconds, excluding deliberate scheduling delay. It is not a CI gate.
_Avoid_: total input latency, debounce delay, automated acceptance budget

**Full-discovery target**:
In a manual profile of the Large-document performance scenario, one complete Linkmark discovery and rule-reconciliation pass targets at most 50 milliseconds of main-thread execution time. It is not a CI gate.
_Avoid_: incremental interaction target, scheduling delay, automated acceptance budget

**Rule freshness target**:
In a manual profile, Linkmark targets publication of the applicable icon-rule update within 300 milliseconds after editor input becomes stable, including its deliberate scheduling delay. It is not a CI gate.
_Avoid_: network resolution time, icon download latency, automated acceptance budget

**Frontend memory target**:
In a manual profile of the Large-document performance scenario, Linkmark may use at most 5 MiB of additional Frontend memory for performance-derived state, which must scale with Present scopes rather than duplicate the authoritative cache.
_Avoid_: total plugin memory, browser heap limit, automated acceptance budget

**Pinned icon**:
A user-selected cache entry that survives ordinary refresh and cache cleanup until the user restores automatic resolution or removes it.
_Avoid_: permanent icon, protected file

**Share-pin domain**:
The eTLD+1 derived from the ICANN and Private sections of the Public Suffix List, after dropping the `www.` label; it bounds an includeSubdomains pin and is never itself a public suffix.
_Avoid_: parent domain, effective domain

**Public Suffix List (PSL) snapshot**:
The release-bundled ICANN and Private Public Suffix List data that Linkmark uses locally to derive eTLD+1 boundaries; it is refreshed through normal dependency updates and releases, never downloaded at runtime.
_Avoid_: live suffix list, runtime suffix update

**Invalid shared pin**:
A legacy includeSubdomains pin whose share scope is a public suffix or otherwise no longer a valid eTLD+1; it is deleted with its private icon payload during migration rather than retained as a compatible cache record.
_Avoid_: legacy shared pin, downgraded shared pin

**Shared-pin exclusion**:
A reviewed, provenance-documented multi-tenant platform boundary that forbids an includeSubdomains pin even when the hostname has a valid PSL-derived eTLD+1.
_Avoid_: optional platform rule, user bypass

**Recognized multi-tenant boundary**:
The eTLD+1 boundary containing a Linkmark-recognized platform host: `docs.qq.com`, `docs.google.com`, `*.feishu.cn`, `*.larksuite.com`, or `nocode.host`; it is initially excluded from shared pins and each entry must carry provenance and regression coverage.
_Avoid_: general platform blacklist, inferred hosting platform

**Platform route icon**:
A reviewed route-type icon attached to a Link scope for a recognized office platform. Tencent Docs and Google Docs use hosted HTTP(S) URLs (`platformIconUrl`); Feishu uses a locally generated composite SVG (`platformIconSvg`) that resolves without any network retrieval.
_Avoid_: favicon, platform icon URL, data URI

**Generated monogram**:
A locally generated fallback icon for a Link scope that the cache authority produces when resolution is exhausted and the workspace cache policy's fallback mode is monogram.
_Avoid_: fallback icon, generated icon, placeholder

**Registrable parent**:
The one eTLD+1 returned by PSL for a hostname when it differs from that hostname; it is the only parent Linkmark may probe or target with a shared pin.
_Avoid_: immediate parent, parent chain

**Share eligibility**:
The condition under which Linkmark may create an includeSubdomains pin: the target is a non-public-suffix eTLD+1, is outside every PSL Private-suffix family, and is outside every Shared-pin exclusion; ineligible historical pins are removed during cache-authority initialization.
_Avoid_: best-effort pin safety, frontend-only validation

**Cache entry**:
The authoritative record associating a link scope with its resolved or pinned private icon and resolution metadata.
_Avoid_: favicon file, cache row

**Cache match**:
The effective cache entry selected by the Cache authority for a Link scope after Pinned, route-domain, Shared-pin, automatic, and freshness precedence resolution.
_Avoid_: cache hit, lookup result

**Cache lookup**:
A Cache-authority read that returns the Cache match for each requested Link scope without exposing the complete authoritative cache.
_Avoid_: cache snapshot, frontend cache search, cache-management query

**Cache snapshot**:
A complete isolated view of the authoritative cache. It is not transferred to a Frontend client for rendering or cache management.
_Avoid_: live cache object, mutable cache reference

**Cache change event**:
A compact cache-authority invalidation carrying the current Cache revision, Cache epoch, and the changed Cache keys of the committed batch, or a null sentinel when the batch is too broad to enumerate. It tells Frontend clients to refresh affected query views and to refresh Frontend cache working sets only when a Present scope may be affected, without broadcasting Cache entries.
_Avoid_: cache delta, full cache broadcast, cache snapshot push

**Cache mutation receipt**:
The authoritative result of an explicit Workspace cache operation, identifying whether state changed and carrying the resulting Cache revision and Cache epoch without Cache entry deltas.
_Avoid_: cache delta, refreshed snapshot, local optimistic result

**Cache revision**:
The strictly increasing per-process number attached to authoritative cache reads, Cache change events, and Cache mutation receipts. A newer revision invalidates older Frontend cache working sets and cache-management query results, and the number is discarded when the Cache epoch changes.
_Avoid_: version number, cache generation

**Cache epoch**:
The per-process marker identifying a Cache authority instance, changing whenever the kernel plugin starts or reloads; a Frontend client uses it to detect that the per-process Cache revision was reset and resynchronize. Any authoritative response or event carrying a new Cache epoch is accepted as the new baseline, while Cache entries are adopted only from responses whose cursor matches the current baseline.
_Avoid_: version number, cache generation

**Cache index**:
The durable persistence system of the authoritative Cache, composed of an Index checkpoint and a Cache journal; the Cache authority rebuilds its in-memory Cache from it at initialization.
_Avoid_: favicon-cache file, disk snapshot

**Index checkpoint**:
The Cache index's durable full-Cache snapshot file (`favicon-cache-v2.json`), loaded at Cache authority initialization and replaced atomically by Index compaction.
_Avoid_: snapshot, Cache snapshot

**Cache journal**:
The append-only Cache index file of revision-tagged Cache entry deltas whose records correspond one-to-one with Cache change events; the Cache authority replays it in order over the Index checkpoint at initialization.
_Avoid_: WAL, log file

**Index compaction**:
The Cache-authority operation that folds the Cache journal into a new Index checkpoint and clears the journal, triggered by journal growth beyond a size threshold, the end of a Bulk cache refresh, or Kernel plugin unload.
_Avoid_: journal merge, log rotation

**Cache persistence batch**:
One durable Cache journal record that commits all compatible cache-entry changes collected during a short scheduling window. Each committed resolution publishes state only after that append succeeds; its earlier Queue acknowledgement does not represent a commit.
_Avoid_: deferred best-effort save, per-entry index write

**Incremental cache hot path**:
The ordinary Cache entry mutation path in which work scales with the changed entries and each Cache persistence batch appends one Cache journal record; only Index compaction rewrites the whole index. Complete Cache snapshots remain internal; Frontend synchronization uses Cache lookup, Cache-management queries, and compact invalidations.
_Avoid_: fully incremental persistence, frontend snapshot synchronization

**Legacy cache**:
The old `auto-favicon` `favicon-cache.json` index and public icon files that Linkmark deliberately neither imports nor deletes.
_Avoid_: Linkmark cache, migration source

**Workspace cache operation**:
An explicit management action whose result applies to the shared cache for every connected frontend client.
_Avoid_: local cache action, device-only cache action

**Bulk cache refresh**:
A Kernel-owned Workspace cache operation over the non-Pinned Cache entries present when the operation starts. It uses bounded resolution concurrency, admits only one workspace run at a time, and reports progress without requiring a Frontend client to enumerate the authoritative cache. A scope mutated after the run starts is excluded from that run even when its refresh task has not begun, so deletion, Pinning, or replacement cannot be undone by the refresh.
_Avoid_: frontend refresh loop, refresh current page, unbounded refresh queue

**Workspace operation lifecycle**:
The lifetime of a shared cache management operation independent of its initiating Frontend: it may continue after that client disconnects, can be observed and cooperatively cancelled by another client, and is terminated by Kernel plugin reload.
_Avoid_: dialog lifetime, frontend task, durable background job

**Per-link refresh**:
A manual Workspace cache operation initiated from a link's context menu that re-queues resolution for that link's Link scope without an Entry token, skipping Pinned matches.
_Avoid_: single-entry refresh, document refresh, refresh-one

**Cache policy**:
The workspace-wide settings that determine favicon resolution, fallback generation, automatic retrieval, and entry freshness.
_Avoid_: frontend preference, device setting

**Display preference**:
A frontend-client setting that affects only how that client renders Linkmark without changing the shared cache.
_Avoid_: cache policy, workspace setting

**Frontend settings**:
The frontend client's combined settings object, mirroring the cache policy fields it may change while carrying its own display preferences.
_Avoid_: plugin settings, workspace policy

**Independent icon rendering**:
The frontend behavior that renders Linkmark's selected icon according to its own cache and display rules, without detecting, preserving, or prioritizing another plugin's icon.
_Avoid_: Link Icon compatibility, cooperative rendering

**Icon rule**:
The short runtime CSS rule that maps one Runtime binding token to its icon URL. Display sizing lives in one shared layout rule.
_Avoid_: style rule, selector string

**Runtime icon binding**:
A frontend-only association between a Present link element and its chosen icon. It is disposable render state and must never become persisted document content.
_Avoid_: inline style, document attribute, cache entry

**Icon binding key**:
The Link scope key selected for a Runtime icon binding after icon precedence is resolved. It may be the domain key rather than the discovered route key when a Pinned domain icon governs that link.
_Avoid_: discovered scope, link URL, selector key

**Runtime binding token**:
A short, opaque number assigned to an Icon binding key for one plugin instance and stored in `data-linkmark-key`. Tokens are not reused within that instance and are not persistent identities.
_Avoid_: binding key, scope key, persistent ID

**Specific-page discovery**:
An optional workspace cache policy that permits retrieving an external link's path, without its query parameters or fragment, to discover a page-specific icon. It is disabled by default; default resolution probes standard root icon paths and configured providers without retrieving HTML documents or manifests.
_Avoid_: ordinary favicon retrieval, automatic page visit

**Link scope**:
The cache identity for a link: a domain or a domain-plus-route key when the site needs route-specific icons.
_Avoid_: bare domain, page URL

**Present scope**:
A Link scope whose link elements currently exist in a mounted editor or static container in a Frontend client's document; Runtime icon bindings are reconciled only for Present scopes, so the stylesheet stays bounded by document content rather than cache size.
_Avoid_: active scope key, visible scope

**Parent-domain probing**:
The resolution fallback that retrieves the registrable parent domain's candidates after the exact-domain candidates fail.
_Avoid_: domain fallback, second request

**Invalidated task**:
A resolution task that began before a later workspace cache operation and is no longer allowed to commit its result.
_Avoid_: delayed refresh, retry result

**Fail-open rendering**:
The frontend behavior that leaves editing and existing document content unaffected when the cache authority cannot serve a request.
_Avoid_: blocking fallback, error icon

**Private icon route**:
The authenticated kernel-plugin HTTP endpoint that returns the bytes of an icon stored by the cache authority.
_Avoid_: public static icon URL, direct storage path

**Immutable private icon URL**:
A Private icon route URL whose iconId is never reused across Cache authority lifetimes or icon replacements, allowing the authenticated response to use a long private max-age with `immutable` without serving a different icon under the same URL.
_Avoid_: long-lived cache URL, content URL without identity guarantee

**In-flight task**:
A kernel-resident favicon resolution task that may continue after a frontend closes but is cancelled when the kernel plugin stops or reloads. A cache-miss request receives a queue acknowledgement without waiting for this task to resolve; a committed result is delivered through a cache-state change.
_Avoid_: durable job, resumable task

**Resolution outcome notification**:
A cache-authority broadcast marking an In-flight task as committed or exhausted. A committed task advances the Cache revision and becomes visible through Cache lookup after the compact invalidation; an exhausted task sends only its Link scope and a sanitized failure category.
_Avoid_: RPC error, remote response payload, retry loop

**Resolution concurrency**:
The workspace-wide limit of four simultaneous favicon resolution tasks for different Link scopes. Each task has a ten-second total budget and examines at most four candidates.
_Avoid_: per-client concurrency, unbounded parallelism
