[English](README.md) | [简体中文](README.zh-CN.md)

# Auto Favicon

Auto Favicon automatically retrieves, displays, and locally caches website icons for HTTP/HTTPS links in SiYuan. When no usable favicon is available, it can generate a colorful domain monogram locally.

![Auto Favicon before and after](preview.png)

## Features

- By default, discover icons from domain root pages, common root icon files (`/favicon.svg`, `/favicon.png`, `/apple-touch-icon.png`, and `/favicon.ico`), web manifests, and optional services without visiting paths that contain document IDs.
- Recognize stable route types for Tencent Docs, Feishu/Lark, and Google Docs, plus public NoCode app deployment routes, so different sites or content types on one domain can use different icons.
- Choose Standard Network, Proxy Network, or Direct Website Only.
- Cache verified icons in the SiYuan workspace and reuse them without external requests.
- Customize fallback monogram colors, letters, and shapes globally or per domain.
- Upload a custom icon, use an image URL, or choose from discovered candidates for a domain, with optional reuse across its subdomains.
- Work alongside **Link Icon** while preserving its curated and custom icons.
- Use the top-bar menu to change the display strategy, refresh the current document, manage cache, or open settings.
- Pause background retrieval, or explicitly allow specific-page discovery globally or once from the candidate picker.

## Features and what they are for

| Feature | Purpose |
| --- | --- |
| Automatically display website icons | Scan HTTP/HTTPS links in SiYuan documents and display an icon before each link. Disabling it stops display and automatic processing without deleting the cache. |
| Route-type icons | Classify only the stable route types of supported platforms such as Tencent Docs, Feishu/Lark, Google Docs, and NoCode, allowing different sites or content types on one domain to use different icons. Ordinary websites remain domain-scoped. |
| Pause automatic retrieval | Prevent background network access and automatic rebuilding while testing or organizing the cache. Existing and expired entries remain visible, while manual refresh, replacement, and upload actions still work. |
| Allow specific-page discovery | Off by default. Enable it only when a site declares different favicons for individual pages; requests go only to the original site and omit query parameters and fragments. |
| Load page-specific candidates | Grant access to the current page for one candidate-loading action without changing the global setting. |
| Retrieval strategy | Standard Network balances availability and coverage; Proxy Network adds Google and DuckDuckGo; Direct Website Only does not use third-party favicon services. |
| Third-party favicon service | Query FaviconKit, favicon.im, or another selected service by domain when the website has no usable icon. Document paths, titles, and tokens are never sent. |
| Local colorful monogram fallback | Generate a stable domain-letter icon locally after every real-icon source fails, so the link is not left without a visual marker. |
| Monogram appearance | Adjust fallback colors, text, and shape globally or for individual domains without changing real favicons. |
| Link Icon cooperation | Smart Fill preserves Link Icon's curated graphics; Auto Favicon Priority displays retrieved or pinned Auto Favicon icons first. |
| Icon size | Change the icon size relative to surrounding text without modifying the cached image. |
| Cache lifetime | Choose when automatic icons should be checked again; `0` disables time-based expiration. Pinned icons do not expire. |
| Refresh current document / all cache | Explicitly retrieve the current document or all non-pinned entries again, including while automatic retrieval is paused. A failed refresh keeps the previous usable icon. |
| Cache management | View route types and sources grouped by domain, then refresh, delete, or replace individual entries. This is useful for blurry, padded, bordered, or otherwise unsuitable icons. |
| Pinned-icon scope | Current Type affects only matching routes such as `/doc/` or `/sheet/`; Current Domain covers types without their own pinned icon; Parent Domain and Subdomains lets tenant subdomains share one icon. |

## Icon selection priority

The plugin first looks for local pinned entries and cache records. It performs network resolution only when no usable local entry exists. Priority is highest to lowest:

1. Pinned icon for the current route type, such as `docs.qq.com::sheet`.
2. Pinned icon for the current domain.
3. Pinned parent-domain icon marked for use by all subdomains.
4. Valid cache for the current route type.
5. Valid cache for the current domain, also used as a temporary fallback before a type cache is created.
6. Locally recognized office-platform type icon.
7. The current domain root page's `rel=icon`, web app manifest icons, and common root icon files.
8. The valid parent domain's page declarations, manifest, and common root icon files.
9. Third-party favicon results for the current domain.
10. Third-party favicon results for the parent domain.
11. A locally generated colorful domain monogram.

When **Allow specific-page discovery** is enabled or **Load page-specific candidates** is clicked, the page's own `rel=icon` and manifest icons are inserted before item 6. This authorization does not override pinned icons or an existing usable cache.

This is Auto Favicon's internal selection order. When Link Icon is also active, the display strategy below is applied afterward: Smart Fill yields to Link Icon's curated or custom icon, while Auto Favicon Priority favors the non-monogram icon selected by Auto Favicon.

## Cache behavior

Opening a document scans its web links, but a fresh cached icon is loaded locally and is not downloaded again. New, expired, missing, damaged, or manually refreshed entries are retrieved using the selected network strategy.

- Default lifetime: 30 days.
- Enter `0` to keep icons until they are manually cleared.
- Generated monograms follow the same lifetime.
- Failed domains are paused for 10 minutes during the current plugin session.
- A failed manual refresh keeps the previous working icon.
- Manually selected icons are pinned locally until automatic retrieval is restored; normal cache clearing and expiration do not remove them.
- Icon files: `workspace/data/public/auto-favicon/`.
- Cache index: `favicon-cache.json`, managed through SiYuan plugin storage. Normal entries retain only the domain; adapted-platform entries may also retain stable routes such as `doc`, `sheet`, `base`, or a public NoCode deployment identifier, never query parameters, fragments, or titles.
- While automatic retrieval is paused, existing and expired entries remain visible and deleted entries are not rebuilt; manual refresh, candidate selection, and uploads remain available.

Cache management supports refreshing the current document, refreshing every automatically cached domain, searching cached domains, and refreshing or deleting a single domain.

## When an icon does not look right

A website may publish several icons whose sharpness, padding, and borders vary by source. If an automatically retrieved icon is blurry, bordered, or otherwise unsuitable, open **Manage cache** from the top toolbar, find the domain, and select **Change icon**:

![Choose an icon candidate for a domain](icon-picker.png)

- Choose from privacy-safe candidates; each card shows its source, pixel dimensions, format, and file size.
- Specific pages are not visited by default. Use **Load page-specific candidates** for one-time explicit discovery.
- Upload a local image.
- Enter a directly accessible image URL.

A manually selected icon is pinned locally and is not replaced by normal refreshes, cache expiration, or **Clear all cache**. Office-platform icons can be pinned to the current route type, the whole domain, or a parent domain and its subdomains. Select **Restore automatic retrieval** when you want the plugin to choose again.

## Working with Link Icon

[Link Icon](https://github.com/chenshinshi/link-icon) is the marketplace name of the project whose repository name is `link-icon`. The recommended **Smart Fill** mode uses this priority:

1. Link Icon curated or user-defined icons.
2. A real favicon retrieved by Auto Favicon.
3. A local colorful monogram.
4. Link Icon's generic web placeholder.

Auto Favicon does not redistribute Link Icon's static icon library or copy its block-reference implementation. SiYuan document and block-reference icons remain handled by Link Icon.

Pinned custom icons follow the same display strategy: Smart Fill still yields to a meaningful Link Icon graphic, while Auto Favicon Priority displays the pinned icon first.

## Network and privacy

- **Standard Network:** Current and valid parent domains plus the selected favicon service; no Google or DuckDuckGo requests.
- **Proxy Network:** Adds Google and DuckDuckGo for maximum coverage.
- **Direct Website Only:** Contacts only current and valid parent domains, then uses a local fallback if needed.

Automatic retrieval does not visit paths containing document IDs by default. Platform types are classified locally; to distinguish public NoCode deployments hosted on one domain, the plugin visits that app's deployment entry. Third-party services receive only the domain. Other paths are sent to the original site only when **Allow specific-page discovery** is enabled or the user clicks **Load page-specific candidates**. All path requests omit query parameters, fragments, Cookie, Authorization, and Referer headers, and icons from authentication redirects are discarded.

Localhost, `.local`, loopback, link-local, and private IP addresses are not sent to favicon services. Third-party services never receive note content, anchor text, document paths, or tokens.

## Install and use

Search for **Auto Favicon** in the SiYuan Marketplace and install it, or extract `package.zip` into `workspace/data/plugins/auto-favicon/`. Enable the plugin, open its settings to choose a network and display strategy, then use the Auto Favicon button in the top toolbar for common actions.

## Feedback

Users who cannot conveniently access GitHub can reply to the [Auto Favicon community post](https://ld246.com/article/1785052610863). GitHub users can also report problems through [GitHub Issues](https://github.com/Acetab/auto-favicon/issues).

When reporting a problem, please include the Auto Favicon and SiYuan versions, operating system, affected public URL, network strategy, favicon provider and fallback setting, whether Link Icon is enabled, and any relevant `[auto-favicon] Unable to cache` console error. Remove private URLs, note content, tokens, and local paths before posting.

## Credits and license

The idea of displaying icons before links and the original need for this plugin were inspired by [Link Icon](https://github.com/chenshinshi/link-icon). Auto Favicon was built through **Vibe Coding** and is licensed under the [MIT License](LICENSE).

## Recent updates

### 0.5.7

- Keep public NoCode deployments on shared hosting domains in separate route-scoped caches and discover each app's declared favicon.
- Probe common root icon files such as `/favicon.svg`, `/favicon.png`, and `/apple-touch-icon.png` before falling back to `/favicon.ico` or third-party services.

### 0.5.6

- Stop visiting document-specific paths by default, with an explicit setting and one-time action for page-specific discovery.
- Cache and display stable route types separately for Tencent Docs, Feishu/Lark, and Google Docs.
- Add pause automatic retrieval, parent-domain fallback, and type-scoped pinned icons.

See [GitHub Releases](https://github.com/Acetab/auto-favicon/releases) for the complete version history.
