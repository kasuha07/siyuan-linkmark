# Establish a separate `siyuan-linkmark` identity

Linkmark will be released as `siyuan-linkmark` from the standalone `kasuha07/siyuan-linkmark` repository, with `0.1.0` as the first independent version, rather than continuing the `auto-favicon` plugin identity, release history, or GitHub fork-network relationship. Its manifest, package, storage, and private-route namespaces will share the same independent identifier, intentionally foregoing in-place installation and settings, cache, or pinned-icon compatibility so the project has an unambiguous ownership boundary.

## Considered options

- Retain the `auto-favicon` identity for an in-place compatible fork.
- Establish `siyuan-linkmark` as a separately installed independent project.

## Consequences

All identity-coupled metadata and runtime namespaces must change together. `霞葉 (Kasuha)` is the independent maintainer attribution. The MIT license retains Acetab's copyright notice and adds a `霞葉 (Kasuha)` notice for Linkmark's independent modifications. Public documentation describes Linkmark as an independently maintained fork of `Acetab/auto-favicon` without affiliation or endorsement, and separately credits `chenshinshi/link-icon` for interaction inspiration without claiming to include its code or bundled icon assets. Its recent-update sections begin at `0.1.0`; upstream releases are source history, not Linkmark releases. Linkmark starts with an empty `siyuan-linkmark` data namespace and neither imports nor deletes old-plugin settings, cache entries, or pinned icons.
