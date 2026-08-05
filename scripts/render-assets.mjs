import sharp from "sharp";

// Palette quantization: the 1024x768 source screenshot carries tens of
// thousands of colors, and a full-RGB PNG compresses to about 1 MB. The
// libimagequant palette capped at 128 colors reduces the marketplace preview
// to about 143 KB with only minor banding in photographic gradients.
await sharp("assets/preview-linkmark.png")
  .resize(1024, 768)
  .png({ compressionLevel: 9, adaptiveFiltering: true, palette: true, colors: 128 })
  .toFile("preview.png");
