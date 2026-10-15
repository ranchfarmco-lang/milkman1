/**
 * Reading and writing the forge's configuration — the row behind every switch
 * on the Control Room's forge boxes, plus the endpoint addresses the local
 * model servers live at.
 *
 * Config is local (Dexie), not a hub setting: the forge is local-first, and
 * these values must be readable by all three pages even when the hub's own
 * database is unreachable.
 */
import { forgeDb, recordError, type ConfigRow } from "./db";
import { postForge } from "./events";

/**
 * Every switch, where nothing has been chosen yet.
 *
 * The model pair starts on **This hub** rather than on nothing: the hub's own
 * models are on the deployment, behind the keys it already holds, and the
 * crew's calls reach them through `ai.complete`. So the Builder's Build button
 * works on a fresh browser with nothing pasted into the BYOK hub — which is
 * the whole point of it. Pasting a key, or pointing at a model on this
 * machine, replaces the pair the moment it is chosen; nothing here overrides
 * a choice somebody made.
 */
export const DEFAULT_CONFIG: ConfigRow = {
  id: "config",
  parallelAgents: false,
  autoBoot: true,
  autoSave: true,
  autoDeploy: false,
  emergencyStopped: false,
  benchAppId: null,
  researchProvider: "wikipedia",
  searxngUrl: "",
  aiProvider: "hub",
  aiModel: "auto",
  endpoints: {},
  updatedAt: 0,
};

/** The config as it stands, defaults filled in for anything never written. */
export async function readConfig(): Promise<ConfigRow> {
  try {
    const row = await forgeDb.config.get("config");
    if (!row) return { ...DEFAULT_CONFIG };
    return { ...DEFAULT_CONFIG, ...row, id: "config" };
  } catch (error) {
    await recordError("forge config read", error);
    return { ...DEFAULT_CONFIG };
  }
}

/** Merge a patch into the config row and wake every page that reads it. */
export async function writeConfig(patch: Partial<ConfigRow>): Promise<ConfigRow> {
  const current = await readConfig();
  const next: ConfigRow = {
    ...current,
    ...patch,
    id: "config",
    endpoints: patch.endpoints ?? current.endpoints,
    updatedAt: Date.now(),
  };
  await forgeDb.config.put(next);
  postForge({ type: "config" });
  return next;
}

/** The default address of each local model server — an origin, no path. */
export const DEFAULT_ENDPOINTS: Record<string, string> = {
  ollama: "http://127.0.0.1:11434",
  lmstudio: "http://127.0.0.1:1234",
};

/** One local endpoint's address and switch, with defaults filled in. */
export function endpointOf(
  config: ConfigRow,
  provider: string,
): { baseUrl: string; enabled: boolean } {
  return (
    config.endpoints[provider] ?? {
      baseUrl: DEFAULT_ENDPOINTS[provider] ?? "",
      enabled: provider === "ollama" || provider === "lmstudio",
    }
  );
}
