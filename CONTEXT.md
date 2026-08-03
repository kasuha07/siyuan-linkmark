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

**Interactive render pipeline**:
The Frontend path from an editor DOM change through link discovery and Icon rule reconciliation to runtime stylesheet publication. It excludes plugin startup, Cache snapshot transport, favicon resolution, network retrieval, and cache persistence.
_Avoid_: favicon resolution pipeline, plugin lifecycle, frontend performance in general

**Frontend client**:
A desktop, mobile, or browser plugin instance that renders icons and requests cache operations from the cache authority through RPC.
_Avoid_: cache writer, cache owner

**Editor responsiveness**:
The user-visible ability to type, paste, and add or remove external links in a mounted SiYuan document without Linkmark causing perceptible delay. It is Linkmark's primary performance outcome for large documents.
_Avoid_: favicon download speed, resolver throughput, general frontend performance

**Large-document performance scenario**:
The standard Linkmark responsiveness workload containing 2,000 external-link nodes, 500 distinct Link scopes, and a Frontend cache view of 10,000 entries.
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
The cache entry that applies to a link scope after pinned, subdomain-shared, and domain-fallback precedence resolution.
_Avoid_: cache hit, lookup result

**Cache snapshot**:
An isolated view of the authoritative cache that an RPC caller or state-change subscriber may read without changing the cache authority, carrying the Cache revision and Cache epoch current when the view was taken; a Frontend client adopts them as its baseline at startup, when a Cache revision gap is detected, and when the Cache epoch changes.
_Avoid_: live cache object, mutable cache reference

**Cache change event**:
A cache-authority broadcast that reports which Cache entries changed and which Link scopes were removed since the previous event, tagged with a Cache revision and the Cache epoch.
_Avoid_: full cache broadcast, cache snapshot push

**Cache revision**:
The strictly increasing per-process number attached to each Cache change event and Cache snapshot; a gap between the last revision a Frontend client saw and the next event's revision means its local cache is out of date, and the number is discarded when the Cache epoch changes.
_Avoid_: version number, cache generation

**Cache epoch**:
The per-process marker identifying a Cache authority instance, changing whenever the kernel plugin starts or reloads; a Frontend client uses it to detect that the per-process Cache revision was reset and resynchronize.
_Avoid_: version number, cache generation

**Cache persistence batch**:
One durable cache-index write that commits all compatible cache-entry changes collected during a short scheduling window. Each committed resolution publishes state only after that write succeeds; its earlier Queue acknowledgement does not represent a commit.
_Avoid_: deferred best-effort save, per-entry index write

**Legacy cache**:
The old `auto-favicon` `favicon-cache.json` index and public icon files that Linkmark deliberately neither imports nor deletes.
_Avoid_: Linkmark cache, migration source

**Workspace cache operation**:
An explicit management action whose result applies to the shared cache for every connected frontend client.
_Avoid_: local cache action, device-only cache action

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

**In-flight task**:
A kernel-resident favicon resolution task that may continue after a frontend closes but is cancelled when the kernel plugin stops or reloads. A cache-miss request receives a queue acknowledgement without waiting for this task to resolve; a committed result is delivered through a cache-state change.
_Avoid_: durable job, resumable task

**Resolution outcome notification**:
A cache-authority broadcast marking an In-flight task as committed or exhausted. A committed task's entry arrives through a Cache change event; an exhausted task sends only its Link scope and a sanitized failure category.
_Avoid_: RPC error, remote response payload, retry loop

**Resolution concurrency**:
The workspace-wide limit of four simultaneous favicon resolution tasks for different Link scopes. Each task has a ten-second total budget and examines at most four candidates.
_Avoid_: per-client concurrency, unbounded parallelism
