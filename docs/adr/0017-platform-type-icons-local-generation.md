# Generate Feishu platform type icons locally instead of hosting them

Recognized office-platform route scopes attach a reviewed per-type icon to the Link scope. Tencent Docs and Google Docs have stable public per-type icon URLs (gtimg CDN and gstatic), but Feishu has no equally traceable per-type icon source. An earlier attempt carried a locally generated composite SVG as a `data:` URI inside `platformIconUrl`, which the kernel resolver's public-target safety check (HTTP(S) only) silently discarded, so Feishu routes fell back to generic resolution. The Link scope now carries the raw generated SVG in `platformIconSvg`, which the kernel resolver encodes locally without any network retrieval; hosted icons continue to travel as `platformIconUrl`.

Keeping the `data:` URI contract with a decoder in the resolver was rejected because it preserved the URL fiction and split the format knowledge across modules. Hosting or bundling the generated icons was rejected because generation exists precisely to avoid third-party and packaging dependencies.

**Status**: accepted
