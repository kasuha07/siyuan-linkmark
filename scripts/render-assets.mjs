import sharp from "sharp";

await sharp("assets/preview-linkmark.png")
  .resize(1024, 768)
  .png({ compressionLevel: 9, adaptiveFiltering: true })
  .toFile("preview.png");
