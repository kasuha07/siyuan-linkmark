# Journal-backed cache persistence

The Cache authority previously rewrote the whole `favicon-cache-v2.json` index on every Cache persistence batch: at the 10,000-entry scenario that serializes and writes about 3.2 MiB per batch, amplifying a full Bulk cache refresh to tens of gigabytes of Kernel CPU, GC, and disk I/O. We replaced the whole-index write with an append-only Cache journal replayed over an Index checkpoint: each batch appends one revision-tagged journal record (one `siyuan.storage.put`, which is atomic and fsync'd), and Index compaction folds the journal into a new checkpoint.

**Status**: accepted

**Considered Options**:

- Whole-index rewrite per batch (status quo): simplest, but O(cache) CPU and bytes per batch; measured 25 GiB of writes per 8,000-scope Bulk cache refresh.
- Sharded index (256 files): no compaction machinery and per-shard corruption granularity, but 256 storage reads at startup, cross-shard batches need multiple puts, and every existing index-seeding test must change.
- Deferred persistence with larger batches: minimal code, but widens the crash-loss window to a whole refresh, contradicting the committed-state-never-lost semantics.
- Journal (chosen): shrinks bytes and CPU per batch while keeping one put per batch; the batch window widens to 250 ms only during a Bulk cache refresh to cut the fsync count, and committed resolutions reuse the immutable iconId when the downloaded bytes match the stored payload, eliminating payload rewrites for refreshes that change nothing.

**Consequences**:

- The Cache revision is allocated at journal append; a failed append leaves a revision gap, which clients already treat as a missed batch and refetch.
- Recovery boundary: normal crashes never lose committed entries (atomic writes, idempotent replay); disk-level corruption of the Index checkpoint is treated like the previous index loss, and a corrupt journal tail is truncated with a log warning. No dual-checkpoint ping-pong.
- Kernel plugin unload flushes the pending batch and waits the persist chain before compacting; SiYuan blocks the plugin stop on the `onunload` promise, so the flush is a hard guarantee.
- Orphan payloads (written before a crash) remain uncleaned: `siyuan.storage` offers no directory listing, matching the previous behavior.
