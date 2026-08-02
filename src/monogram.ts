import type { MonogramColorMode, MonogramOverride, MonogramShape } from "./resolver-contract";

export type MonogramSource = {
  domain: string;
  colorMode: MonogramColorMode;
  primary: string;
  secondary: string;
  text: string;
  shape: MonogramShape;
  overrides: Record<string, MonogramOverride>;
};

export function monogramSvg(source: MonogramSource) {
  const override = source.overrides[source.domain];
  const derivedLetter = source.domain.replace(/^www\./, "").match(/[a-z0-9]/i)?.[0] ?? "?";
  const letter = escapeXml(Array.from((override?.letter ?? derivedLetter).trim() || "?")[0].toUpperCase());
  let hash = 0;
  for (const character of source.domain) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  const hue = Math.abs(hash) % 360;
  const domainColor = source.colorMode === "domain" && !override;
  const primary = domainColor ? `hsl(${hue} 72% 58%)` : safeColor(override?.primary ?? source.primary, "#4F7CFF");
  const secondary = domainColor ? `hsl(${(hue + 28) % 360} 68% 42%)` : safeColor(override?.secondary ?? source.secondary, "#745CFF");
  const text = safeColor(override?.text ?? source.text, "#FFFFFF");
  const shape = override?.shape ?? source.shape;
  const background = shape === "circle"
    ? '<circle cx="32" cy="32" r="32" fill="url(#g)"/>'
    : `<rect width="64" height="64" rx="${shape === "square" ? 4 : 14}" fill="url(#g)"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${primary}"/><stop offset="1" stop-color="${secondary}"/></linearGradient></defs>${background}<text x="32" y="43" text-anchor="middle" font-family="Arial, sans-serif" font-size="34" font-weight="700" fill="${text}">${letter}</text></svg>`;
}

function safeColor(value: string, fallback: string) {
  return /^#[0-9a-f]{6}$/i.test(value) ? value.toUpperCase() : fallback;
}

function escapeXml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;",
  })[character]!);
}
