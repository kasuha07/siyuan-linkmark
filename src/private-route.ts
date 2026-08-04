export const PRIVATE_ICON_CACHE_CONTROL = "private, max-age=31536000, immutable";

export function privateIconIdFromPath(path: string, pluginName: string) {
  const prefix = `/plugin/private/${pluginName}/icon/`;
  if (!path.startsWith(prefix)) return undefined;
  try {
    const iconId = decodeURIComponent(path.slice(prefix.length));
    return /^[A-Za-z0-9._-]+$/.test(iconId) ? iconId : undefined;
  } catch {
    return undefined;
  }
}
