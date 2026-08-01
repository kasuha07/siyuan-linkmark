# Auto Favicon

Auto Favicon adds and manages website icons for external SiYuan links. Its cache is shared by every client connected to one SiYuan workspace.

## Language

**Cache authority**:
The single kernel-plugin owner of favicon resolution, downloads, cache-index mutations, cleanup, and private icon payloads for a workspace.
_Avoid_: frontend cache, client cache

**Kernel plugin**:
A SiYuan v3.7-or-later `kernel.js` component that runs with the SiYuan kernel rather than an individual application window.
_Avoid_: background tab, browser worker

**Kernel RPC**:
The authenticated JSON-RPC boundary through which a frontend client invokes and receives state changes from the cache authority.
_Avoid_: direct cache-file access, frontend persistence API

**Frontend client**:
A desktop, mobile, or browser plugin instance that renders icons and requests cache operations from the cache authority through RPC.
_Avoid_: cache writer, cache owner

**Pinned icon**:
A user-selected cache entry that survives ordinary refresh and cache cleanup until the user restores automatic resolution or removes it.
_Avoid_: permanent icon, protected file

**Cache entry**:
The authoritative record associating a link scope with its resolved or pinned private icon and resolution metadata.
_Avoid_: favicon file, cache row

**Cache snapshot**:
An isolated view of the authoritative cache that an RPC caller or state-change subscriber may read without changing the cache authority.
_Avoid_: live cache object, mutable cache reference

**Legacy cache**:
The pre-kernel-plugin `favicon-cache.json` index and its public icon files that are imported once when the cache authority is first initialized.
_Avoid_: disposable cache, reset cache

**Workspace cache operation**:
An explicit management action whose result applies to the shared cache for every connected frontend client.
_Avoid_: local cache action, device-only cache action

**Cache policy**:
The workspace-wide settings that determine favicon resolution, fallback generation, automatic retrieval, and entry freshness.
_Avoid_: frontend preference, device setting

**Display preference**:
A frontend-client setting that affects only how that client renders Auto Favicon without changing the shared cache.
_Avoid_: cache policy, workspace setting

**Link scope**:
The cache identity for a link: a domain or a domain-plus-route key when the site needs route-specific icons.
_Avoid_: bare domain, page URL

**Invalidated task**:
A resolution task that began before a later workspace cache operation and is no longer allowed to commit its result.
_Avoid_: delayed refresh, retry result

**Fail-open rendering**:
The frontend behavior that leaves editing and Link Icon unaffected when the cache authority cannot serve a request.
_Avoid_: blocking fallback, error icon

**Private icon route**:
The authenticated kernel-plugin HTTP endpoint that returns the bytes of an icon stored by the cache authority.
_Avoid_: public static icon URL, direct storage path

**In-flight task**:
A kernel-resident favicon resolution task that may continue after a frontend closes but is cancelled when the kernel plugin stops or reloads.
_Avoid_: durable job, resumable task
