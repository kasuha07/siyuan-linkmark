export function isSafePublicTarget(url: URL) {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
  if (host === "::" || host === "::1" || /^(?:fc|fd|fe[89ab])[0-9a-f]*:/i.test(host)) return false;
  const mappedIpv4 = mappedIpv4Address(host);
  if (mappedIpv4) return isPublicIpv4(mappedIpv4);
  if (host.includes(":")) return true;
  return isPublicIpv4(host);
}

export function isAuthenticationRedirect(requested: URL, finalValue?: string) {
  if (!finalValue) return false;
  let finalUrl: URL;
  try {
    finalUrl = new URL(finalValue);
  } catch {
    return true;
  }
  if (finalUrl.href === requested.href) return false;
  return isAuthenticationTarget(finalUrl);
}

export function isAuthenticationTarget(url: URL) {
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  return host.startsWith("accounts.")
    || host.startsWith("passport.")
    || host.startsWith("login.")
    || /(?:^|\/)(?:login|signin|sign-in|auth)(?:\/|$)/.test(path);
}

function mappedIpv4Address(host: string) {
  const value = host.match(/^::ffff:(.+)$/i)?.[1];
  if (!value) return undefined;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return value;
  const hexadecimal = value.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (!hexadecimal) return undefined;
  const number = (parseInt(hexadecimal[1], 16) << 16) + parseInt(hexadecimal[2], 16);
  return [(number >>> 24) & 255, (number >>> 16) & 255, (number >>> 8) & 255, number & 255].join(".");
}

function isPublicIpv4(host: string) {
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return true;
  const [a, b, c] = ipv4.slice(1).map(Number);
  if ([a, b, c].some((part) => part > 255)) return false;
  return !(a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 0 || b === 168 || b === 2)) || (a === 198 && (b === 18 || b === 19))
    || a >= 224);
}
