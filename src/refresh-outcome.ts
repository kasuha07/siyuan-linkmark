import type { CacheEntry, CacheRequestResult } from "./cache-authority";

export type FetchOutcome = "success" | "fallback" | "queued" | "unavailable" | "failure";

export function fetchOutcomeFor(entry: Pick<CacheEntry, "source"> | null | undefined): FetchOutcome {
  if (!entry) return "failure";
  return entry.source === "generated monogram" ? "fallback" : "success";
}

export function outcomeForCacheRequest(result: CacheRequestResult): FetchOutcome {
  if (result.status === "ready") return fetchOutcomeFor(result.entry);
  if (result.status === "queued") return "queued";
  return "unavailable";
}
