# Use bounded concurrent favicon resolution

The cache authority will run at most four favicon resolution tasks for distinct link scopes at once, while callers for the same scope continue to share one task. This supersedes the global-serialization behavior in ADR 0001 so batch first-resolution latency improves without allowing unbounded pressure on the forward proxy, external hosts, or cache storage.

## Consequences

Invalidation and same-scope coalescing remain mandatory, and regression coverage must prove that concurrent resolution never exceeds four tasks.
