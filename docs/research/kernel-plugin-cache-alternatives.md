# SiYuan kernel-plugin favicon cache alternatives

## Decision

For SiYuan **v3.7.3** (stable, released 2026-07-21; checked 2026-08-01), the
best supported design is a **single kernel-plugin cache authority**.  Its own
serialized application queue should resolve/download through
`siyuan.client.fetch("/api/network/forwardProxy", …)`, then commit the result
and notify frontends through plugin RPC.  It does **not** need a browser client
to make the network request.

This corrects the premise that a kernel plugin has no usable outbound network
path.  It has no documented general-purpose `fetch("https://…")`, but it has a
documented, authenticated *kernel REST loopback* client, and SiYuan documents
the kernel's `POST /api/network/forwardProxy` endpoint.  That endpoint returns
the same JSON envelope used by the existing frontend resolver; request
`responseEncoding: "base64"` for favicon bytes and decode `data.body` in the
kernel plugin.

The minimum safe shape is:

1. Frontends call a plugin RPC `getOrQueue(scope, policy)`; they never mutate
   the index or write `/data/public/auto-favicon`.
2. The kernel plugin holds one FIFO/in-flight map by route scope.  It rereads
   its authoritative index before dispatch and coalesces same-scope callers.
3. A worker uses `client.fetch` to POST the documented forward-proxy payload,
   verifies the response and only then commits.  Queue state and invalidation
   generation must be persisted if work needs recovery after a *kernel*
   restart; no SiYuan API supplies transactional cache commits or a durable job
   scheduler.
4. Use a data URI in the authoritative record when icons are small, or write a
   versioned public file then publish an index record that points at it.  Delete
   the replaced automatic file only after the new record is committed; pinned
   records are excluded from refresh/cleanup.

The queue, rather than `client.fetch`, supplies de-duplication: the latter
launches an asynchronous request and does not itself coalesce calls.

## Priority finding: `client.fetch` + `forwardProxy`

### Supported surface

- The official kernel-plugin declaration defines `siyuan.client.fetch(path,
  init)` as a request through the kernel REST API; the path must be absolute
  and the response exposes `.json()` and `.arrayBuffer()`.
  [Petal `kernel.d.ts` (v3.7.3-era commit)](https://github.com/siyuan-note/petal/blob/4ed2754341c89ed7e097d8b7ede96d5b162632d2/kernel.d.ts#L383-L415)
  and [binary response access](https://github.com/siyuan-note/petal/blob/4ed2754341c89ed7e097d8b7ede96d5b162632d2/kernel.d.ts#L53-L103).
- The official sample uses exactly this form: `client.fetch(path, { method:
  "POST", body: "{}" })` followed by `await resp.json()`.
  [Plugin sample](https://github.com/siyuan-note/plugin-sample/blob/2215ae74c14828e7b04243d661e99b9d59b196f3/src/kernel.ts#L236-L250).
- The official API documents `POST /api/network/forwardProxy`, including GET
  forwarding, timeout/headers, and `base64` response encoding.  Its return is
  `{code,msg,data:{body,bodyEncoding,contentType,status,…}}`.
  [API reference](https://github.com/siyuan-note/siyuan/blob/eef10568384e2e7cf547adb029ae46a72e43c287/docs/API.md#L1479-L1553).

Therefore the kernel equivalent of the current frontend call is supported:

```ts
const response = await siyuan.client.fetch("/api/network/forwardProxy", {
  method: "POST",
  body: JSON.stringify({
    url,
    method: "GET",
    timeout: 8_000,
    contentType: "image/*",
    headers: [{Accept: "image/avif,image/webp,image/*,*/*"}],
    payload: {},
    payloadEncoding: "text",
    responseEncoding: "base64",
  }),
});
const envelope = await response.json(); // check HTTP status *and* envelope.code
```

The request/response shape above is an application of the two documented
surfaces, not an extra private endpoint.  In particular, `forwardProxy`
business failures are represented by its JSON `code`/`msg`, so a successful
loopback HTTP status alone is insufficient.

### Authentication and SSRF behavior

This is a supported call in a kernel plugin, not a way to smuggle an API token
into frontend code.  The kernel implementation accepts only `/…` paths,
builds a `127.0.0.1:<kernel-port>` request, and injects the plugin's own
`X-Auth-Token` before sending it.
[`api_client.go`](https://github.com/siyuan-note/siyuan/blob/eef10568384e2e7cf547adb029ae46a72e43c287/kernel/plugin/api_client.go#L48-L157).
The plugin JWT is created with the administrator role
([`auth.go`](https://github.com/siyuan-note/siyuan/blob/eef10568384e2e7cf547adb029ae46a72e43c287/kernel/model/auth.go#L133-L151));
the route itself requires authentication and administrator role
([`router.go`](https://github.com/siyuan-note/siyuan/blob/eef10568384e2e7cf547adb029ae46a72e43c287/kernel/api/router.go#L606-L614)).
Thus a kernel plugin may call this admin endpoint; an ordinary unauthenticated
browser cannot.

The proxy rejects malformed URLs and non-HTTP(S) schemes, defaults to 7 s,
and limits redirects to three.
[`network.go`](https://github.com/siyuan-note/siyuan/blob/eef10568384e2e7cf547adb029ae46a72e43c287/kernel/api/network.go#L150-L190)
and [redirect/client construction](https://github.com/siyuan-note/siyuan/blob/eef10568384e2e7cf547adb029ae46a72e43c287/kernel/api/network.go#L331-L339).
It uses `SSRFSafeDialer`; source shows that private/loopback/link-local and
unspecified IPs are prohibited **only when SiYuan Safe Mode is enabled**.  When
Safe Mode is off they are logged but the dial proceeds.
[`net.go`](https://github.com/siyuan-note/siyuan/blob/eef10568384e2e7cf547adb029ae46a72e43c287/kernel/util/net.go#L126-L150).
Treat all candidate URLs as untrusted regardless: retain Auto Favicon's own
public-host validation and do not forward cookies, authorization headers, or
workspace URLs.

## Alternatives matrix

| Alternative | Support status | No index overwrite | No duplicate download | Continues after browser closure | Assessment |
| --- | --- | --- | --- | --- | --- |
| Kernel queue + `client.fetch` → `forwardProxy` | **Supported** APIs; application queue is plugin code | Yes, if all mutations pass the one kernel queue | Yes, if in-flight map is keyed by scope | **Yes while the kernel plugin remains running**; persist queue for kernel-restart recovery | **Recommended.** |
| Frontend downloads; kernel serializes only commit | Supported primitives, but split workflow | Yes, with kernel-only commits | Only with a kernel lease/in-flight record; browser failure needs recovery | **No** for an in-progress browser download | Inferior: network work remains tied to a client. |
| Browser-to-kernel job leasing | RPC is supported; leases/scheduler are not supplied | Yes, if kernel owns lease/index | Only if kernel assigns and recovers leases | **No** if browser is the worker; **yes** only when the kernel itself downloads | Do not make browsers the workers. |
| Kernel private route serves stored binary or data URI | **Supported** private HTTP/raw-response APIs | Yes when queue owns record changes | N/A for serving; downloader still needs queue | Stored icon survives; a route request needs a client | Good for authenticated delivery, not a downloader/scheduler. |
| `/data/public` file via `/api/file/putFile` | File upload API documented; `/public/` static URL is source-confirmed | Yes only with one queue; no multi-file transaction | Yes only with the queue | Yes after a successful kernel write | Viable, but use versioned names and crash-tolerant ordering. |
| Kernel `ResponseProxy` streaming external image | **Source-only / unstable** (not present in matching `kernel.d.ts`) | No cache commit supplied | No queue semantics | No work independent of the requesting browser | Do not use as cache architecture. |
| External worker/proxy/cache service | Requires an external service | Depends on that service | Depends on that service | Yes if service persists jobs | Out of scope unless deployment is explicitly authorized. |

### Frontend downloader + serialized commit

This can prevent index overwrites only by moving *all* read/modify/write and
generation checks into the kernel.  It cannot promise that an already leased
download completes after the browser closes.  The official sample describes
the kernel runtime as a separate lifecycle and tells plugin authors to defer
slow work from lifecycle hooks; the kernel creates/starts that event loop and
marks the plugin running independently of a web request.
[Sample lifecycle guidance](https://github.com/siyuan-note/plugin-sample/blob/2215ae74c14828e7b04243d661e99b9d59b196f3/src/kernel.ts#L29-L76),
[kernel lifecycle source](https://github.com/siyuan-note/siyuan/blob/eef10568384e2e7cf547adb029ae46a72e43c287/kernel/plugin/plugin.go#L253-L287).
That makes continuing a **kernel-started** request after browser closure a
reasonable source-backed inference, but it is not a documented durable-job
guarantee across plugin reload/kernel exit.

### Browser-to-kernel job leasing

Plugin RPC is an official client boundary: the declaration documents the HTTP
and WebSocket RPC endpoints, and the kernel uses registered methods only while
the plugin is running.
[RPC declaration](https://github.com/siyuan-note/petal/blob/4ed2754341c89ed7e097d8b7ede96d5b162632d2/kernel.d.ts#L563-L588)
and [running-state dispatch](https://github.com/siyuan-note/siyuan/blob/eef10568384e2e7cf547adb029ae46a72e43c287/kernel/plugin/plugin.go#L639-L655).
But there is no official lease, retry, durable queue, or client-heartbeat API.
Implementing leases would be application code; if the browser owns the fetch,
the three-way requirement still fails on browser closure.  A lease is useful
only for client notification/cancellation while the kernel queue remains the
worker.

## Binary storage and asset delivery

### 1. Data URI in plugin storage — supported, bounded

`siyuan.storage` is scoped persistent storage and can read raw bytes, but its
documented `put(path, content)` accepts only a UTF-8 string.
[Storage declaration](https://github.com/siyuan-note/petal/blob/4ed2754341c89ed7e097d8b7ede96d5b162632d2/kernel.d.ts#L501-L537).
`forwardProxy` already returns base64, so `data:<mime>;base64,<body>` can be
stored in the same serialized JSON record as the index and returned to clients
over RPC.  This avoids a separate public-file index and ordinary cleanup cannot
touch a pinned record.  Costs: base64 expansion, larger index writes, and no
transaction/durable-job guarantee.  It is suitable only under a conservative
icon-size cap.

### 2. Private authenticated serving — supported

The official kernel declaration exposes only
`/plugin/private/<name>/*path`; it requires kernel authentication and
administrator role.  A handler can return `raw` bytes with a MIME type or a
local filesystem file.
[Private scope](https://github.com/siyuan-note/petal/blob/4ed2754341c89ed7e097d8b7ede96d5b162632d2/kernel.d.ts#L1126-L1178)
and [raw/file response types](https://github.com/siyuan-note/petal/blob/4ed2754341c89ed7e097d8b7ede96d5b162632d2/kernel.d.ts#L870-L945).
It can serve an icon read via `storage.get(...).arrayBuffer()`, but does not
write it and is not a public asset route.  Do not derive an absolute storage
path from implementation details; use the raw-response path or data URI.

### 3. Workspace public files — viable but source-backed URL contract

SiYuan officially documents multipart `POST /api/file/putFile` for a path
under the workspace.
[API reference](https://github.com/siyuan-note/siyuan/blob/eef10568384e2e7cf547adb029ae46a72e43c287/docs/API.md#L1186-L1237).
At v3.7.3 the server mounts `data/public/*` at `/public/*` without the normal
auth middleware; this static-route detail is upstream source evidence rather
than an API-reference promise.
[`servePublic`](https://github.com/siyuan-note/siyuan/blob/eef10568384e2e7cf547adb029ae46a72e43c287/kernel/server/serve.go#L428-L431).

`client.fetch` can send an `ArrayBuffer`, but the file endpoint requires a
multipart form.  The kernel-plugin declaration does not expose `FormData`, so
constructing multipart bytes manually is an implementation detail.  The safer
supported alternative is the data URI; retain public files only if their
existing URL behavior is required and test it against each supported SiYuan
release.  `putFile` overwrites the target path directly
([source](https://github.com/siyuan-note/siyuan/blob/eef10568384e2e7cf547adb029ae46a72e43c287/kernel/api/file.go#L821-L913)),
so never reuse a scope's filename while another client can observe it.

### 4. `ResponseProxy` — reject for this design

The v3.7.3 kernel source contains a streaming `ResponseProxy` implementation
with HTTP(S)-only GET/HEAD and an SSRF-safe dialer, but the matching public
`IResponseBody` declaration contains no `proxy` member.  It is consequently
**source-only/unstable**, and it streams to the requesting browser rather than
capturing bytes for a cache.
[Source implementation](https://github.com/siyuan-note/siyuan/blob/eef10568384e2e7cf547adb029ae46a72e43c287/kernel/plugin/server.go#L179-L300)
versus [public declaration](https://github.com/siyuan-note/petal/blob/4ed2754341c89ed7e097d8b7ede96d5b162632d2/kernel.d.ts#L926-L945).

## Constraints and unresolved boundaries

- No reviewed official v3.7.3 API provides an atomic transaction spanning a
  favicon binary and a JSON index, a distributed lock, or a persistent task
  scheduler.  Serialize all mutations in the kernel plugin and design
  versioned-file/commit/recovery ordering explicitly.
- No `plugin/public` kernel route is registered at this version (the source
  line is commented out); only the private scope is in the public plugin type
  declaration.  Do not depend on a public plugin route.
  [Router evidence](https://github.com/siyuan-note/siyuan/blob/eef10568384e2e7cf547adb029ae46a72e43c287/kernel/api/router.go#L600-L612).
- The forward proxy buffers its complete upstream body before returning it.
  Enforce the plugin's existing favicon size cap after decoding; no streaming
  favicon write path is documented.
  [Body read/encoding source](https://github.com/siyuan-note/siyuan/blob/eef10568384e2e7cf547adb029ae46a72e43c287/kernel/api/network.go#L264-L318).
- Findings are pinned to SiYuan `v3.7.3` commit
  `eef10568384e2e7cf547adb029ae46a72e43c287`, Petal
  `4ed2754341c89ed7e097d8b7ede96d5b162632d2`, and the official plugin sample
  `2215ae74c14828e7b04243d661e99b9d59b196f3`.  Revalidate after upgrading
  SiYuan or Petal, especially the source-only public/static and proxy details.
