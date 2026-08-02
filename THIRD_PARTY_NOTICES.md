# Third-party notices

## link-icon

This project was inspired by and references the interaction approach of
[chenshinshi/link-icon](https://github.com/chenshinshi/link-icon), which declares
the MIT license in its package metadata.

Linkmark does not bundle or redistribute code, icons, or other assets from
link-icon. If code or assets from link-icon are incorporated in a future
version, their original copyright and license notices must be retained.

## Office-platform favicon endpoints

Linkmark contains a small, reviewed mapping from stable document-type URL
routes to favicon assets served by Tencent Docs and Google Docs. These marks
remain the property of their respective owners and are used only to identify
links to those services. The plugin does not bundle a general-purpose icon
library.

Feishu/Lark route types use locally generated neutral document-type badges when
the linked page is not anonymously accessible. They are not copies of Feishu or
Lark product artwork.

## tldts and Public Suffix List data

The plugin bundles the [tldts](https://www.npmjs.com/package/tldts) domain
parser, licensed under the MIT license with the following copyright notice:

> Copyright (c) 2017 Thomas Parisot, 2018 Rémi Berson

The plugin also embeds tldts' bundled [Public Suffix List](https://publicsuffix.org/)
data (ICANN and Private sections), licensed under the Mozilla Public License 2.0,
maintained by the Mozilla Foundation and its contributors. The list is
refreshed only through normal dependency updates and releases; Linkmark never
downloads or queries a suffix list at runtime.

## Documentation preview artwork

`preview.png` depicts recognizable favicon-style marks for GitHub, MDN Web
Docs, Google Docs, Tencent Docs, Wikipedia, and Feishu/Lark only to illustrate
external-link identification and local caching. These marks remain the property
of their respective owners. The artwork does not imply affiliation, endorsement,
or redistribution of those marks as Linkmark runtime icon assets.
