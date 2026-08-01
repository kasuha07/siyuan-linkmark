# Acknowledge favicon resolution before it completes

Linkmark will return immediately from a cache-miss `cache.get-or-queue` RPC,
whether the caller initiated automatic discovery or a manual refresh. The RPC
returns a three-state response: `ready` with a committed Cache entry, `queued`
when a new or coalesced In-flight task owns the Link scope, and `unavailable`
only when the Cache authority cannot accept the request. A queued response is
not an icon result and is not a resolution failure.

The Cache authority will continue the task in the kernel. On a successful
durable cache commit it broadcasts `cache.changed`; on exhaustion it broadcasts
`cache.resolution-failed` with the Link scope and a sanitized failure category.
Automatic tasks remain silent to the user. A manual refresh may present one
actionable failure message.

Default resolution avoids HTML and manifest retrieval. It checks at most four
standard root-icon or configured-provider candidates within a ten-second
per-scope budget. HTML and manifest discovery are available only when the
workspace has explicitly enabled Specific-page discovery. The existing
workspace-wide maximum of four concurrent tasks remains in force.

## Consequences

Frontend and kernel artifacts must be deployed together because the RPC result
is no longer `CacheEntry | null`. Cached icons remain immediately available,
while cache misses never hold a frontend RPC open for network resolution or
cache persistence. Slow or rejected forward-proxy requests cannot consume a
resolution slot indefinitely, and a failure carries neither remote response
bodies nor credentials to frontend clients.
