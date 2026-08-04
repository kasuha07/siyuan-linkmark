# Carry changed Cache keys in Cache change events for targeted invalidation

Cache change events carry the changed Cache keys of the committed batch, or a null sentinel when the batch is too broad to enumerate, so a Frontend client can skip its working-set lookup when no Present scope's candidate Cache keys intersect the change. This partially supersedes ADR 0015's "Cache delta broadcasts are replaced by invalidation cursors": the cursor remains the invalidation authority and no Cache entries are broadcast, but a key-only hint restores what the original ADR 0008 delta transport provided at far smaller cost. Without the hint, every committed batch — including one mutating domains unrelated to the open document — forces every connected client through an O(S) lookup, entry copies, token computation, and binding synchronization for all Present scopes, which bulk refresh amplifies across clients.

The null sentinel is sent when a batch's key list would exceed 128 keys (bulk clears); any document with real links almost certainly intersects a broad change, so the list would only waste payload bytes. The sentinel and legacy events without the field force an unconditional lookup.

## Considered options

- Keep events cursor-only and rely on the Frontend diff alone. The diff removes the binding-synchronization amplification but keeps the lookup RPC and Kernel-side O(S) match and token work for every unrelated batch on every client.
- Re-broadcast full entry deltas (original ADR 0008 transport). Rejected by ADR 0015 because Frontend clients no longer apply deltas; entries would be transferred only to be discarded by the lookup.
- Track per-client Present scopes in the Kernel for precise targeting. Rejected: lookups are stateless, and the Kernel would maintain a reverse dependency index that SPEC 0008 explicitly rules out.

## Consequences

- The Frontend skip predicate is exact for "cannot be affected": a scope's candidate keys (`scope.key`, its route-domain slot, and its eligible share-domain slot) are exactly the Cache slots `effectiveCacheMatch` reads, so an empty intersection proves no match changed. Intersections are conservative and fall back to the lookup plus the token diff.
- An event from another Cache epoch always triggers a lookup so Entry tokens are re-established under the new baseline; a skipped lookup must never skip a rebaseline.
- Mutation receipts deliberately remain cursor-only: the initiating client's own mutations almost always touch its own document and still refresh unconditionally.
- A null `changedKeys` means "unknown or too broad" and is indistinguishable from a legacy event; both must refresh.
