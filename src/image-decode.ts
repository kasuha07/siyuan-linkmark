import { MAX_ICON_BYTES } from "./resolver-contract";

export async function isDecodableImage(blob: Blob): Promise<boolean> {
  if (!blob.size || blob.size > MAX_ICON_BYTES) return false;
  const objectUrl = URL.createObjectURL(blob);
  try {
    return await new Promise<boolean>((resolve) => {
      const image = new Image();
      const timer = window.setTimeout(() => resolve(false), 5000);
      image.onload = () => {
        window.clearTimeout(timer);
        resolve(image.naturalWidth > 0 && image.naturalHeight > 0);
      };
      image.onerror = () => {
        window.clearTimeout(timer);
        resolve(false);
      };
      image.src = objectUrl;
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
