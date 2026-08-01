# Linkmark project instructions

## Purpose

Linkmark is a focused SiYuan plugin that automatically shows website favicons
before external links. Keep the scope narrow and independent of third-party link-icon plugins.

## Commands

```powershell
npm ci
npm run check
npm run build
```

`npm run check` must pass TypeScript validation. `npm run build` must produce the
complete marketplace payload in `dist/`.

## Stack and structure

- TypeScript, Vite, npm, and the SiYuan plugin API.
- `src/index.ts`: plugin lifecycle, settings, cache management, and UI.
- `src/icon-resolver.ts`: favicon discovery and resolution.
- `src/style.css`: plugin UI styles.
- `i18n/`: English and Chinese strings; keep both key sets aligned.
- `scripts/render-assets.mjs`: generated image assets.
- `.github/workflows/release.yml`: tagged-release build and publication.

## Conventions

- Do not write `style` or `data-*` attributes to editable SiYuan document nodes.
  Use runtime CSS injected into `document.head`.
- Do not add third-party link-icon detection, priority behavior, or compatibility settings.
- Keep user-pinned icons safe from ordinary refresh and cache cleanup.
- Do not add general static icon libraries. A small reviewed mapping for
  privacy-safe office-platform route types is allowed when its provenance and
  fallback behavior are documented.
- Avoid unrelated refactors, formatting, and line-ending changes.
- Do not discard uncommitted user work or publish without explicit approval.

## Release

- Keep versions aligned in `package.json`, `package-lock.json`, and `plugin.json`.
- Keep the recent-updates sections in both READMEs synchronized and limited to
  the latest two releases; link to GitHub Releases for the complete history.
- Commit and push the intended source state before tagging.
- Never move or reuse a tag that has already been published or indexed by the
  SiYuan Bazaar; increment the version instead.
- Push a `vX.Y.Z` tag; GitHub Actions validates, builds `package.zip`, and creates
  the GitHub Release automatically.
- Do not manually create the same Release or upload a second package beforehand.

## Current status

- Linkmark's first independent version is `0.1.0`. It is intentionally
  untagged and unpublished until an explicit release request.
- Linkmark uses the `siyuan-linkmark` plugin, package, storage, and private-route
  namespace. It neither imports nor deletes `auto-favicon` user data.
- The project retains explicit upstream and Link Icon acknowledgements and the
  original Acetab MIT notice alongside the independent maintainer notice.
- The release package uses forward-slash ZIP entry paths.
- Missing plugin data can load as an empty string. Normalize loaded settings and
  cache values to plain objects before using them.
- Before future delivery, rerun both validation commands above.
