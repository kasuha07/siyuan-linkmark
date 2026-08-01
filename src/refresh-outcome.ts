import type { CacheEntry } from "./cache-authority";

export type FetchOutcome = "success" | "fallback" | "failure";

export function fetchOutcomeFor(entry: Pick<CacheEntry, "source"> | null | undefined): FetchOutcome {
  if (!entry) return "failure";
  return entry.source === "generated monogram" ? "fallback" : "success";
}
