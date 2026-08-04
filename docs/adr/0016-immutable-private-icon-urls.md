# Make private icon URLs immutable only after identity is non-reusable

Private icon responses will use `private, max-age=31536000, immutable` only
after icon IDs are proven non-reusable across Kernel authority lifetimes and
icon replacements. The current process-local sequence is insufficient on its
own; a cross-reload identity component and deterministic non-reuse tests are
required first. This keeps long browser caching compatible with stale-payload
rejection at the private route.

**Status**: accepted
