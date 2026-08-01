import { Dialog, showMessage } from "siyuan";
import type { LinkScope } from "./url-scope";

type CacheDiagnostic = {
  outcome: "success" | "no-icon" | "invalidated" | "skipped-pinned" | "failed";
  stage: string;
  source?: string;
  contentType?: string;
  byteLength?: number;
  error?: string;
};

type DebugKernelStatus = { ready: boolean; error?: string };

type DebugUiInput = {
  domains: Map<string, { scope: LinkScope; targetUrl: string }>;
  callKernel: (method: string, ...args: unknown[]) => Promise<unknown>;
  sanitizeTargetUrl: (targetUrl: string, domain: string) => string;
  replaceCache: (cache: Record<string, unknown>) => void;
  rebuildRules: () => Promise<void>;
  errorText: (error: unknown) => string;
  t: (key: string) => string;
  actionButton: (label: string, className: string, callback: () => void) => HTMLButtonElement;
};

export async function diagnoseCurrentDocument(input: DebugUiInput) {
  if (input.domains.size === 0) {
    showMessage(input.t("noCurrentDomains"));
    return;
  }
  let status: DebugKernelStatus;
  try {
    status = await input.callKernel("cache.debug.status") as DebugKernelStatus;
  } catch (error) {
    openDebugReport(input.domains.size === 0 ? [] : [{
      key: "kernel",
      targetUrl: "",
      diagnostic: { outcome: "failed", stage: "debug status RPC", error: input.errorText(error) },
    }], input);
    return;
  }
  if (!status?.ready) {
    openDebugReport([{
      key: "kernel",
      targetUrl: "",
      diagnostic: { outcome: "failed", stage: "kernel initialization", error: status?.error ?? "Kernel did not report a ready state" },
    }], input);
    return;
  }
  const results: Array<{ key: string; targetUrl: string; diagnostic: CacheDiagnostic }> = [];
  for (const [key, { scope, targetUrl }] of input.domains) {
    try {
      const diagnostic = await input.callKernel("cache.debug.resolve", {
        ...scope,
        targetUrl: input.sanitizeTargetUrl(targetUrl, scope.domain),
      }) as CacheDiagnostic;
      results.push({ key, targetUrl, diagnostic });
    } catch (error) {
      results.push({ key, targetUrl, diagnostic: { outcome: "failed", stage: "debug RPC", error: input.errorText(error) } });
    }
  }
  try {
    const cache = await input.callKernel("cache.snapshot");
    if (cache && typeof cache === "object" && !Array.isArray(cache)) input.replaceCache(cache as Record<string, unknown>);
  } catch {
    // The report already captures an unavailable debug RPC. Preserve the last cache snapshot.
  }
  await input.rebuildRules();
  openDebugReport(results, input);
}

function openDebugReport(results: Array<{ key: string; targetUrl: string; diagnostic: CacheDiagnostic }>, input: DebugUiInput) {
  const report = JSON.stringify({
    generatedAt: new Date().toISOString(),
    build: "debug",
    diagnostics: results,
  }, null, 2);
  const dialog = new Dialog({
    title: input.t("debugReportTitle"),
    content: '<div class="auto-favicon-debug-report"></div>',
    width: "min(760px, 94vw)",
    height: "min(620px, 84vh)",
  });
  const root = dialog.element.querySelector<HTMLElement>(".auto-favicon-debug-report");
  if (!root) return;
  const hint = document.createElement("p");
  hint.textContent = input.t("debugReportHint");
  const copy = input.actionButton(input.t("debugCopyReport"), "b3-button b3-button--outline", () => {
    const write = navigator.clipboard
      ? navigator.clipboard.writeText(report)
      : Promise.reject(new Error("Clipboard API is unavailable"));
    void write.then(
      () => showMessage(input.t("debugReportCopied")),
      () => showMessage(input.t("debugCopyFailed")),
    );
  });
  const output = document.createElement("pre");
  output.textContent = report;
  root.append(hint, copy, output);
}
