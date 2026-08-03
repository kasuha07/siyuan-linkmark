import { showMessage } from "siyuan";
import type { LinkScope } from "./url-scope";

export type Translator = (key: string) => string;

export function cacheSourceLabel(t: Translator, source?: string) {
  if (!source) return t("cacheUnknownSource");
  if (source === "generated monogram") return t("cacheGenerated");
  if (source === "custom upload") return t("customUploadSource");
  if (source === "custom URL") return t("customUrlSource");
  if (source.startsWith("selected candidate:")) {
    return `${t("selectedCandidateSource")} · ${resolverSourceLabel(t, source.slice("selected candidate:".length))}`;
  }
  return resolverSourceLabel(t, source);
}

export function resolverSourceLabel(t: Translator, source: string) {
  const parent = source.match(/^parent domain ([^·]+) · (.+)$/);
  if (parent) return `${t("parentDomainSource").replace("{domain}", parent[1].trim())} · ${parent[2]}`;
  const platform = source.match(/^platform type ([^:]+):(.+)$/);
  if (platform) return t("platformTypeSource").replace("{type}", scopeTypeLabel(t, { routeKey: platform[2] }));
  return source;
}

export function scopeTypeLabel(t: Translator, scope: Pick<LinkScope, "routeKey">) {
  const key = `scopeType_${scope.routeKey ?? "domain"}`;
  const translated = t(key);
  return translated === key ? (scope.routeKey ?? t("cacheDomainDefault")) : translated;
}

export function showRefreshResult(
  t: Translator,
  result: { queued: number; failed: number; skipped: number; failures?: string[] },
) {
  const summary = t("refreshFinished")
    .replace("{queued}", String(result.queued))
    .replace("{failed}", String(result.failed))
    .replace("{skipped}", String(result.skipped));
  const details = result.failures?.length ? `\n${result.failures.join("\n")}` : "";
  showMessage(`${summary}${details}`);
}
