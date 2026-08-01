# Auto Favicon project instructions

## Purpose

Auto Favicon is a focused SiYuan plugin that automatically shows website favicons
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

- As of 2026-07-31, v0.5.7 is the current release. It separates public NoCode
  deployments by route and probes common root SVG/PNG favicon files.
- GitHub Actions run `30622377454` published v0.5.7 from `502640a`; the
  12-entry online package has SHA-256
  `4671E5CE60338E7579D8D8625A203DC1621500F1BBF50EA72EF5E31A28CBED51`.
- GitHub Actions run `30605537368` published v0.5.6 from `9b91217`; the online
  package, README image references, and reviewed PNG hashes were verified.
- v0.5.5 added the before/after preview, clearer custom-icon selection, and
  candidate icon metadata.
- v0.5.4 fixed first-run caching in a clean workspace and passed real SiYuan
  validation.
- The release package uses forward-slash ZIP entry paths.
- Missing plugin data can load as an empty string. Normalize loaded settings and
  cache values to plain objects before using them.
- Before future delivery, rerun both validation commands above.
