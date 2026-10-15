/**
 * Full diagnostics, counters, the last error, and Reset to Factory — the
 * System Health box's whole vocabulary.
 *
 * Every line is a check that really runs in this browser right now: the
 * origin's security, the network, IndexedDB, the encrypted vault, the
 * provider lights as they were last tested, WebContainer isolation, the
 * agents, the requests. The report is stored so the box still shows the last
 * real run after a reload.
 */
import { DEFAULT_CONFIG, readConfig, writeConfig } from "./config";
import { clearSecrets } from "./crypto";
import { forgeDb, lastError, type DiagnosticRow, type Tone } from "./db";
import { postForge } from "./events";

export type DiagnosticResult = { id: string; label: string; tone: Tone; detail: string };

/** How many rows sit in each table — the counters the box shows. */
export async function forgeCounts(): Promise<Record<string, number>> {
  const [
    projects,
    files,
    sandboxFiles,
    sessions,
    messages,
    agentLogs,
    requests,
    builds,
    research,
    secrets,
    errors,
  ] = await Promise.all([
    forgeDb.projects.count(),
    forgeDb.files.count(),
    forgeDb.sandboxFiles.count(),
    forgeDb.sessions.count(),
    forgeDb.messages.count(),
    forgeDb.agentLogs.count(),
    forgeDb.requests.count(),
    forgeDb.builds.count(),
    forgeDb.research.count(),
    forgeDb.secrets.count(),
    forgeDb.errors.count(),
  ]);
  return {
    projects,
    files,
    sandboxFiles,
    sessions,
    messages,
    agentLogs,
    requests,
    builds,
    research,
    secrets,
    errors,
  };
}

async function probe(url: string, timeoutMs = 6000): Promise<{ ok: boolean; ms: number }> {
  const started = performance.now();
  try {
    const response = await fetch(url, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { ok: response.ok, ms: Math.round(performance.now() - started) };
  } catch {
    return { ok: false, ms: Math.round(performance.now() - started) };
  }
}

/** Run the whole battery and store the report. */
export async function runDiagnostics(): Promise<DiagnosticRow> {
  const results: DiagnosticResult[] = [];
  const push = (id: string, label: string, tone: Tone, detail: string) =>
    results.push({ id, label, tone, detail });

  push(
    "secure",
    "Secure context",
    isSecureContext ? "good" : "bad",
    isSecureContext
      ? "Encrypted storage and the vault are available on this address."
      : "Not a secure origin — the encrypted vault will refuse to open.",
  );

  const online = navigator.onLine;
  push("online", "Internet connection", online ? "good" : "bad", online ? "The browser reports this device online." : "The browser reports no connection.");

  const reach = await probe("https://api.ipify.org?format=json");
  push(
    "reach",
    "Outbound HTTPS",
    reach.ok ? "good" : "bad",
    reach.ok ? `Answered in ${reach.ms} ms.` : `Could not reach a public endpoint (${reach.ms} ms).`,
  );

  const counts = await forgeCounts();
  const rows = Object.values(counts).reduce((total, value) => total + value, 0);
  push(
    "indexeddb",
    "IndexedDB (local-first store)",
    "good",
    `${rows} rows across ${Object.keys(counts).length} tables in the “controlforge” database.`,
  );

  let opfsDetail = "Not offered by this browser.";
  let opfsTone: Tone = "warn";
  try {
    if (navigator.storage?.getDirectory) {
      const dir = await navigator.storage.getDirectory();
      opfsDetail = `Available — ${dir.name ? `“${dir.name}”` : "root"} reachable.`;
      opfsTone = "good";
    }
  } catch (error) {
    opfsDetail = `Refused: ${error instanceof Error ? error.message : String(error)}`;
    opfsTone = "bad";
  }
  push("opfs", "OPFS", opfsTone, opfsDetail);

  const estimate = await navigator.storage?.estimate?.().catch(() => null);
  if (estimate?.quota) {
    const used = ((estimate.usage ?? 0) / estimate.quota) * 100;
    push(
      "quota",
      "Storage quota",
      used > 90 ? "bad" : used > 70 ? "warn" : "good",
      `${(estimate.usage ?? 0) / (1024 * 1024) | 0} MB of ${(estimate.quota / (1024 * 1024) / 1024).toFixed(1)} GB used (${used.toFixed(1)}%).`,
    );
  }

  push(
    "vault",
    "Encrypted key vault",
    globalThis.crypto?.subtle ? (counts.secrets ? "good" : "warn") : "bad",
    !globalThis.crypto?.subtle
      ? "crypto.subtle is unavailable on this origin."
      : counts.secrets
        ? `${counts.secrets} secret(s) encrypted at rest.`
        : "Working, but no keys are saved yet.",
  );

  const lights = await forgeDb.lights.toArray();
  const providerLights = lights.filter((light) => light.id.startsWith("provider:"));
  const goodProviders = providerLights.filter((light) => light.tone === "good").length;
  push(
    "providers",
    "LLM providers (last tested)",
    goodProviders ? "good" : providerLights.length ? "warn" : "warn",
    providerLights.length
      ? `${goodProviders} of ${providerLights.length} tested providers answered.`
      : "No provider has been tested yet — use Test in the BYOK hub.",
  );

  const sandboxLight = lights.find((light) => light.id === "sandbox");
  push(
    "sandbox",
    "Sandbox",
    sandboxLight?.tone ?? "muted",
    sandboxLight?.detail ?? "Never booted yet.",
  );

  push(
    "isolation",
    "Cross-origin isolation",
    typeof crossOriginIsolated !== "undefined" && crossOriginIsolated ? "good" : "warn",
    typeof crossOriginIsolated !== "undefined" && crossOriginIsolated
      ? "WebContainer can boot here."
      : "WebContainer needs COOP/COEP response headers; the LocalBox engine serves instead.",
  );

  const config = await readConfig();
  push(
    "config",
    "Configuration",
    config.emergencyStopped ? "bad" : "good",
    config.emergencyStopped
      ? "Emergency stop is engaged — the forge is locked until it is released."
      : `Auto-boot ${onOff(config.autoBoot)}, auto-save ${onOff(config.autoSave)}, parallel agents ${onOff(config.parallelAgents)}, auto-deploy ${onOff(config.autoDeploy)}.`,
  );

  const running = await forgeDb.agents.where("status").equals("running").count();
  const pending = await forgeDb.requests.where("status").equals("pending").count();
  push("agents", "Agents", running ? "good" : "muted", running ? `${running} running now.` : "None running.");
  push("requests", "Build requests", pending ? "warn" : "muted", pending ? `${pending} waiting for the Builder.` : "Nothing waiting.");

  const errorRow = await lastError();
  const fresh = errorRow && Date.now() - errorRow.at < 24 * 60 * 60 * 1000;
  push(
    "last-error",
    "Last error",
    fresh ? "warn" : "muted",
    errorRow ? `${errorRow.where}: ${errorRow.message.slice(0, 160)}` : "Nothing recorded.",
  );

  const report: DiagnosticRow = { id: "last", at: Date.now(), results, counts };
  await forgeDb.diagnostics.put(report);
  postForge({ type: "diagnostics" });
  return report;
}

function onOff(value: boolean) {
  return value ? "on" : "off";
}

/**
 * Reset to Factory: every forge table emptied, every key forgotten, every
 * switch back to its default. Deliberate and destructive — the page asks
 * twice before calling it.
 */
export async function resetFactory(): Promise<void> {
  await forgeDb.transaction(
    "rw",
    [
      forgeDb.config,
      forgeDb.secrets,
      forgeDb.vault,
      forgeDb.lights,
      forgeDb.projects,
      forgeDb.files,
      forgeDb.sandboxFiles,
      forgeDb.sessions,
      forgeDb.messages,
      forgeDb.agents,
      forgeDb.agentLogs,
      forgeDb.requests,
      forgeDb.builds,
      forgeDb.diagnostics,
      forgeDb.errors,
      forgeDb.research,
    ],
    async () => {
      await Promise.all([
        forgeDb.secrets.clear(),
        forgeDb.vault.clear(),
        forgeDb.lights.clear(),
        forgeDb.projects.clear(),
        forgeDb.files.clear(),
        forgeDb.sandboxFiles.clear(),
        forgeDb.sessions.clear(),
        forgeDb.messages.clear(),
        forgeDb.agents.clear(),
        forgeDb.agentLogs.clear(),
        forgeDb.requests.clear(),
        forgeDb.builds.clear(),
        forgeDb.diagnostics.clear(),
        forgeDb.errors.clear(),
        forgeDb.research.clear(),
      ]);
      await forgeDb.config.put({ ...DEFAULT_CONFIG, updatedAt: Date.now() });
    },
  );
  await clearSecrets().catch(() => undefined);
  await writeConfig({ emergencyStopped: false }).catch(() => undefined);
  for (const type of [
    "config",
    "agents",
    "sandbox",
    "messages",
    "sessions",
    "requests",
    "builds",
    "files",
    "projects",
    "lights",
    "secrets",
    "diagnostics",
    "emergency",
  ] as const) {
    postForge({ type });
  }
}
