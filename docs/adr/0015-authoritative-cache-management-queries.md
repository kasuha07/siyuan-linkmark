# Keep cache management and rendering reads authoritative in Kernel

The event-payload portion of this decision is partially superseded by ADR 0018: change events now carry the changed Cache keys (or a null sentinel) so Frontend clients can skip unrelated working-set lookups, while lookup responses and mutation receipts keep their cursor-only contracts.

Linkmark will remove the Frontend's complete Cache mirror. The Kernel Cache
authority owns effective Cache matching, revision-tagged search and offset
pagination, while the Frontend keeps only a Present-scope working set and
refreshes it after compact epoch/revision invalidations. This preserves one
source of precedence truth and bounds Frontend memory and manager DOM work by
the active view rather than the 10,000-entry authority cache; historical page
snapshots and Frontend-side full-cache filtering are deliberately rejected.

**Status**: accepted

**Consequences**:

- Cache delta broadcasts are replaced by invalidation cursors carrying the changed Cache keys (ADR 0018); lookup responses
  carry the authoritative revision and epoch.
- Single-entry management mutations require an authority-issued `entryToken`.
- Bulk refresh is a Kernel Workspace operation with bounded concurrency and an
  independent lifecycle.
