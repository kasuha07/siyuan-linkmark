# Unify duplicated URL-safety and parent-domain logic in a shared module

The same domain concepts — public-target safety, authentication-redirect
detection, and parent-domain computation — were implemented two or three times
across the frontend bundle, the kernel bundle, and the frontend cache-state
module, and the copies had already drifted. The kernel copies were more
thorough (mapped IPv4, CGNAT, multicast, and reserved-range handling, a
cross-origin rule in redirect detection) while the frontend copies were
simpler; the kernel's `parentDomainOf` stripped `www.` while the frontend copy
did not, so `www.example.co.uk` resolved differently on each side.

Linkmark now imports `isSafePublicTarget` and `isAuthenticationRedirect` from a
single shared `src/url-safety.ts` module and `parentDomainOf` and
`shareDomainFor` from a single shared `src/parent-domain.ts` module. The
kernel's stricter semantics are the authoritative source, and each bundle
inlines the shared code it needs. Unit tests exercise one implementation
instead of pinning each drifting copy.

## Consequences

- The shared IPv6 prefix rule fixes a real kernel safety hole: the copied
  regex only matched `fc`/`fd` prefixes followed by exactly one hex digit, so
  canonical unique-local addresses such as `fc00::1` and `fd12::1` were
  treated as public. The shared rule blocks all of `fc00::/7` and the
  `fe80::/10` link-local range.
- Kernel resolution now probes the parent domain of `www.*` sites after exact
  candidates fail, matching what the frontend already did for pin sharing.
- A `www.<sub>.<tld>` includeSubdomains pin now shares across the registrable
  domain instead of stopping at the first subdomain level; the previous
  frontend behavior is preserved everywhere else.
- The frontend copies of the network resolution functions remain in
  `src/icon-resolver.ts` as dead code and are intentionally untested.
