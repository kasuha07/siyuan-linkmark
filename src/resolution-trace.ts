import type { ResolutionFailureCategory, ResolutionTrigger } from "./cache-authority";

/**
 * Development-build-only Resolution trace vocabulary shared by the Cache
 * authority (producer) and the Kernel plugin (sink). Nothing here is part of
 * the public Kernel RPC contract or a Cache policy.
 */
export type ResolutionTraceEvent =
  | "accepted"
  | "coalesced"
  | "waiting-slot"
  | "started"
  | "candidate-finished"
  | "resolved"
  | "persisted"
  | "committed"
  | "failed"
  | "invalidated";

export type CandidateAttemptOutcome = "resolved" | "failed" | "invalid" | "network" | "timeout";

/**
 * One JSON object per logger call. Every record carries the fixed schema
 * version, its event name, the owning task identifier, the sanitized Link
 * scope identity, and monotonic elapsed durations measured from task
 * acceptance. Records never contain external request URLs, query parameters,
 * fragments, response bodies, request headers, credentials, or local paths.
 */
export type ResolutionTraceRecord = {
  schema: 1;
  event: ResolutionTraceEvent;
  task: string;
  scope: { key: string; domain: string; routeKey?: string };
  trigger?: ResolutionTrigger;
  elapsedMs: number;
  ordinal?: number;
  source?: string;
  outcome?: CandidateAttemptOutcome;
  status?: number;
  contentType?: string;
  bytes?: number;
  remainingBudgetMs?: number;
  category?: ResolutionFailureCategory;
};

export type ResolutionTraceSink = (record: ResolutionTraceRecord) => void;

/**
 * Sanitized metadata for one reviewed candidate attempt. The resolver derives
 * it from a Forward-proxy response and never exposes the candidate URL, query
 * string, fragment, response body, or request headers.
 */
export type CandidateAttemptInfo = {
  ordinal: number;
  source: string;
  outcome: CandidateAttemptOutcome;
  status?: number;
  contentType?: string;
  bytes?: number;
  remainingBudgetMs?: number;
};
