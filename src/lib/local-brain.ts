/**
 * The web half of the local brain: one typed client for its HTTP API.
 *
 * The local brain (`brain/brain.py`, shipped in the offline package) is the
 * system; this file is how a page talks to it. Every endpoint here exists on
 * that server and nowhere else — there is no second implementation of memory,
 * tools, connectors or diagnostics hiding in the browser. Start the brain and
 * the page is live; stop it and the page says so.
 *
 * Two things about the connection are worth knowing before reading further:
 *
 * 1. **The address is loopback.** The brain listens on `127.0.0.1` and hands out
 *    a pairing token, because an API that can run shell commands must not be
 *    open to any page you happen to have loaded.
 * 2. **The browser has to be willing.** A hub served over `https` cannot
 *    normally call `http://127.0.0.1`. Chrome allows it when the preflight
 *    answers `Access-Control-Allow-Private-Network: true` — which the brain
 *    sends — and otherwise the failure is reported here in words rather than as
 *    an opaque network error.
 */

/** The protocol this client speaks. Keep in step with `brain/src/server.py`. */
export const BRAIN_PROTOCOL = "brain/1";

/** Where the brain listens unless it was told otherwise. */
export const DEFAULT_BRAIN_URL = "http://127.0.0.1:8710";

/** The addresses tried, in order, when nothing has been paired yet. */
export const CANDIDATE_URLS = [
  DEFAULT_BRAIN_URL,
  "http://localhost:8710",
  "http://127.0.0.1:8711",
];

/** How long a call may take before it is treated as "not running". */
const TIMEOUT_MS = 20_000;

/* ----------------------------------------------------------------- protocol */

export type BrainEndpoint = {
  method: string;
  path: string;
  auth: boolean;
  what: string;
};

export type BrainHealth = {
  ok: boolean;
  product: string;
  version: string;
  protocol: string;
  uptimeSeconds: number;
  authRequired: boolean;
  online: boolean | null;
  offline: boolean;
  workspace: string;
  dataDir: string;
  tools: number;
  memory: number;
  host: string;
};

export type BrainPairing = {
  ok: boolean;
  paired: boolean;
  host: string | null;
  version: string;
  workspace: string;
  dataDir: string;
  tools: number;
  memory: number;
  modelHint: string;
};

export type CapabilityMap = {
  at: number;
  host: {
    hostname: string;
    os: string;
    distro: string;
    kernel: string;
    python: string;
  };
  cpu: { model: string; cores: number; arch: string; features: string[] };
  memory: { totalMb: number; availableMb: number; totalGb: number };
  disk: Record<string, { path: string; totalGb?: number; freeGb?: number; error?: string }>;
  gpus: { vendor: string; name: string; vramMb: number; driver: string }[];
  tools: Record<string, { path: string; version: string; purpose: string }>;
  languages: Record<string, { binary: string; path: string; extension: string; version: string }>;
  models: ModelServer[];
  modelServersMissing: ModelServer[];
  network: { online: boolean; probes: { target: string; ok: boolean }[]; checkedAt: number };
  sandbox: {
    dataDir: string;
    workspace: string;
    writable: boolean;
    allowExternal: boolean;
    auth: string;
    modelTimeout: number;
  };
};

export type BrainTool = {
  name: string;
  summary: string;
  args: Record<string, string>;
  needsNetwork?: boolean;
  mutates?: boolean;
  source: string;
  path?: string;
  broken?: string | null;
  stats?: { calls?: number; failures?: number; avg_ms?: number; last_at?: number };
};

export type ModelServer = {
  id: string;
  label: string;
  base: string;
  kind: string;
  ok: boolean;
  models: string[];
  error: string | null;
  start: string;
  note: string;
  local: boolean;
};

export type MemoryRow = {
  id: number;
  text: string;
  tags: string;
  source: string;
  pinned: number;
  created_at: number;
  updated_at: number;
};

export type Connector = {
  id: string;
  label: string;
  capability: string;
  tier: "local" | "free" | "key" | "hosted";
  auth: string;
  envVars: string[];
  base: string;
  docs: string;
  install: string;
  note: string;
  enabled: boolean;
  explicitlyEnabled: boolean;
  credential: { present: boolean; from: string | null; names: string[] };
  ready: boolean;
  lastOkAt: number | null;
  lastError: string | null;
};

export type TierStatus = {
  tier: string;
  ready: boolean;
  detail: string;
  note: string;
};

export type InfoAnswer = {
  ok: boolean;
  tier?: string | null;
  query: string;
  answer?: string;
  hits?: unknown[];
  note?: string;
  error?: string;
  tried: { tier: string; found: number; skipped?: string }[];
};

export type AskStep = {
  tool: string;
  args: Record<string, unknown>;
  result: Record<string, unknown>;
  ok: boolean;
  verification: { tool: string; checked: boolean; ok: boolean; detail: string };
};

export type AskResult = {
  ok: boolean;
  answer: string;
  mode: "local-model" | "tools-only";
  offline: boolean;
  steps: AskStep[];
  verification: AskStep["verification"][];
  errors: string[];
  provider: string | null;
  providerLabel: string | null;
  model: string | null;
  modelHint: string | null;
  workspace: string;
  dataDir: string;
  ms: number;
  context: {
    online: boolean;
    cores: number;
    memoryGb: number;
    gpus: string[];
    modelServers: string[];
    languages: string[];
    memory: { id: number; text: string }[];
  };
};

export type Finding = {
  id: string;
  level: "blocking" | "degraded" | "note";
  area: string;
  message: string;
  detail: string;
  repair: string;
};

export type DiagnosticReport = {
  ok: boolean;
  at: number;
  ms: number;
  version: string;
  findings: Finding[];
  counts: { blocking: number; degraded: number; note: number };
  tools: { tool: string; calls: number; failures: number; avgMs: number; lastAt: number }[];
  repairs: string[];
  capabilities: {
    host: CapabilityMap["host"];
    cores: number;
    memoryGb: number;
    gpus: string[];
    diskFreeGb: number | null;
    online: boolean;
  };
};

export type BrainEvent = {
  id: number;
  at: number;
  level: string;
  kind: string;
  text: string;
  data: string | null;
};

export type BrainStats = {
  ok: boolean;
  path: string;
  bytes: number;
  fts: boolean;
  memory: number;
  events: number;
  toolRuns: number;
  snapshots: number;
  conversations: number;
  credentials: number;
  tasks?: number;
  tasksDue?: number;
};

/** Work the brain does on its own, on a clock it owns. */
export type BrainTask = {
  id: number;
  name: string;
  kind: "ask" | "tool";
  payload: unknown;
  every_seconds: number | null;
  daily_at: string | null;
  enabled: boolean;
  next_run: number | null;
  last_run: number | null;
  lastOk: boolean | null;
  last_error: string | null;
  last_result: string | null;
  runs: number;
  created_at: number;
  /** "every 15 minutes" or "every day at 07:30" — written by the brain. */
  schedule: string;
  dueInSeconds: number | null;
};

/** The clock itself: a thread inside `serve`, not a daemon to install. */
export type SchedulerStatus = {
  running: boolean;
  tickSeconds: number;
  maxPerTick: number;
  lastTick: number | null;
  runsSinceStart: number;
  tasks: number;
  enabled: number;
  next: number | null;
};

export type TaskList = {
  ok: boolean;
  tasks: BrainTask[];
  runner: SchedulerStatus;
  kinds: string[];
  examples: string[];
};

export type TaskRunResult = {
  ok: boolean;
  task: string;
  ms: number;
  error: string | null;
  result: string;
  nextRun: number;
};

/** One installer the package ships, and what it is for. */
export type Installer = {
  name: string;
  path: string;
  purpose: string;
  bytes: number;
  runnable: boolean;
};

/** A capability in use, next to the local thing that could replace it. */
export type IndependenceEntry = {
  capability: string;
  inUse: string[];
  local: string[];
  free: string[];
  keyed: string[];
  independent: boolean;
  couldBeReplaced: boolean;
  instead: string;
  use: string;
  how: string;
  note: string;
};

/** The package manager's whole picture: what is here, and what could be local. */
export type PackageReport = {
  ok: boolean;
  at: number;
  version: string;
  packageRoot: string;
  packagePresent: boolean;
  inventory: {
    brain: string;
    python: string | null;
    kernel: string | null;
    tools: Record<string, string>;
    languages: Record<string, string>;
    models: string[];
  };
  changes: string[];
  suggestions: { missing: string; why: string; install: string }[];
  installers: Installer[];
  independence: {
    capabilities: IndependenceEntry[];
    independent: number;
    couldBeReplaced: number;
    summary: string;
  };
  note: string;
};

/* ------------------------------------------------------------------- failure */

/** A failure with something a person can act on, rather than a status code. */
export class BrainError extends Error {
  status: number;
  hint: string;
  payload: unknown;

  constructor(message: string, status = 0, hint = "", payload: unknown = null) {
    super(message);
    this.name = "BrainError";
    this.status = status;
    this.hint = hint;
    this.payload = payload;
  }
}

/** True when the call never reached the brain at all. */
export function isUnreachable(error: unknown): boolean {
  return error instanceof BrainError && error.status === 0;
}

function networkHint(url: string): string {
  if (typeof window !== "undefined" && window.location.protocol === "https:") {
    return (
      `Could not reach ${url} from this https page. Start the brain with ` +
      "`python3 brain/brain.py serve`, and if your browser still refuses, open the " +
      "hub from its own address over http:// or allow local network access for this site."
    );
  }
  return `Could not reach ${url}. Start it with \`python3 brain/brain.py serve\` on the machine running it.`;
}

/* -------------------------------------------------------------------- client */

export type BrainTarget = { url: string; token: string };

export class BrainClient {
  readonly url: string;
  private readonly token: string;

  constructor(target: BrainTarget) {
    this.url = target.url.replace(/\/+$/, "");
    this.token = target.token.trim();
  }

  /** One request, with the token, a timeout, and every failure named. */
  private async request<T>(path: string, init?: RequestInit, timeoutMs = TIMEOUT_MS): Promise<T> {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.url}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          ...(this.token ? { "X-Brain-Token": this.token } : {}),
          ...(init?.headers ?? {}),
        },
      });

      const text = await response.text();
      let payload: unknown = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        throw new BrainError(
          `${this.url}${path} answered with something that is not JSON.`,
          response.status,
          "That address is probably not a brain. Check the port in the Control Room's sidebar or `brain.py pair`.",
          text.slice(0, 300),
        );
      }

      if (!response.ok) {
        const body = (payload ?? {}) as { error?: string; hint?: string };
        throw new BrainError(
          body.error ?? `the brain answered ${response.status}`,
          response.status,
          body.hint ?? "",
          payload,
        );
      }
      return payload as T;
    } catch (error) {
      if (error instanceof BrainError) throw error;
      if ((error as DOMException)?.name === "AbortError") {
        throw new BrainError(
          `${this.url} did not answer within ${Math.round(timeoutMs / 1000)}s.`,
          0,
          "It may be busy on a long model call or an installer, or not running at all.",
        );
      }
      throw new BrainError(`Could not reach ${this.url}.`, 0, networkHint(`${this.url}${path}`), error);
    } finally {
      window.clearTimeout(timer);
    }
  }

  private get<T>(path: string) {
    return this.request<T>(path);
  }

  private post<T>(path: string, body?: unknown, timeoutMs = TIMEOUT_MS) {
    return this.request<T>(
      path,
      { method: "POST", body: JSON.stringify(body ?? {}) },
      timeoutMs,
    );
  }

  /* ------------------------------------------------------------- the endpoints */

  health() {
    return this.get<BrainHealth>("/api/v1/health");
  }

  protocol() {
    return this.get<{ ok: boolean; protocol: string; version: string; endpoints: BrainEndpoint[] }>(
      "/api/v1/protocol",
    );
  }

  /** Confirms the token. Throws with a 401 if it is wrong, which is the check. */
  pair() {
    return this.get<BrainPairing>("/api/v1/pair");
  }

  stats() {
    return this.get<BrainStats>("/api/v1/stats");
  }

  capabilities(fresh = false) {
    return this.get<{ ok: boolean; capabilities: CapabilityMap }>(
      `/api/v1/capabilities${fresh ? "?fresh=1" : ""}`,
    );
  }

  tools() {
    return this.get<{ ok: boolean; tools: BrainTool[]; loaded: { loaded: string[]; broken: Record<string, string> } }>(
      "/api/v1/tools",
    );
  }

  runTool(tool: string, args: Record<string, unknown>) {
    return this.post<Record<string, unknown>>("/api/v1/tools/run", { tool, args });
  }

  models() {
    return this.get<{
      ok: boolean;
      servers: ModelServer[];
      chosen: { provider: string; model: string } | false | null;
      hint: string;
    }>("/api/v1/models");
  }

  memory(query = "", limit = 50) {
    const search = query ? `?q=${encodeURIComponent(query)}&limit=${limit}` : `?limit=${limit}`;
    return this.get<{ ok: boolean; hits: MemoryRow[]; count: number; total: number }>(
      `/api/v1/memory${search}`,
    );
  }

  remember(text: string, tags: string[] = []) {
    return this.post<{ ok: boolean; id: number; total: number }>("/api/v1/memory", { text, tags });
  }

  forget(id: number) {
    return this.request<{ ok: boolean; id: number }>(`/api/v1/memory/${id}`, { method: "DELETE" });
  }

  connectors() {
    return this.get<{
      ok: boolean;
      connectors: Connector[];
      summary: {
        total: number;
        ready: number;
        needingKeys: number;
        byCapability: Record<string, { total: number; ready: number; local: number }>;
      };
    }>("/api/v1/connectors");
  }

  setConnector(id: string, enabled: boolean) {
    return this.post<Connector>(`/api/v1/connectors/${id}`, { enabled });
  }

  putCredential(id: string, name: string, value: string) {
    return this.post<{ ok: boolean; name: string }>(`/api/v1/connectors/${id}/credentials`, {
      name,
      value,
    });
  }

  dropCredential(id: string, name: string) {
    return this.request<{ ok: boolean; name: string }>(
      `/api/v1/connectors/${id}/credentials/${encodeURIComponent(name)}`,
      { method: "DELETE" },
    );
  }

  hierarchy() {
    return this.get<{ ok: boolean; tiers: TierStatus[]; order: string[] }>("/api/v1/hierarchy");
  }

  lookup(query: string) {
    return this.post<InfoAnswer>("/api/v1/info", { query });
  }

  cache() {
    return this.get<{ ok: boolean; documents: { url: string; title: string; cachedAt: number; bytes: number }[] }>(
      "/api/v1/cache?limit=50",
    );
  }

  ask(question: string) {
    return this.post<AskResult>("/api/v1/ask", { question });
  }

  tasks() {
    return this.get<TaskList>("/api/v1/tasks");
  }

  addTask(input: {
    name: string;
    when: string;
    kind?: "ask" | "tool";
    payload?: unknown;
    enabled?: boolean;
  }) {
    return this.post<{ ok: boolean; task: BrainTask }>("/api/v1/tasks", {
      kind: "ask" as const,
      ...input,
    });
  }

  setTaskEnabled(nameOrId: string | number, enabled: boolean) {
    return this.post<{ ok: boolean; task: BrainTask | null }>(
      `/api/v1/tasks/${encodeURIComponent(String(nameOrId))}`,
      { enabled },
    );
  }

  removeTask(nameOrId: string | number) {
    return this.request<{ ok: boolean; removed: string }>(
      `/api/v1/tasks/${encodeURIComponent(String(nameOrId))}`,
      { method: "DELETE" },
    );
  }

  runTask(nameOrId: string | number) {
    return this.post<TaskRunResult>(
      `/api/v1/tasks/${encodeURIComponent(String(nameOrId))}/run`,
    );
  }

  updates(refresh = false) {
    return this.get<PackageReport>(`/api/v1/updates${refresh ? "?refresh=1" : ""}`);
  }

  /**
   * Run one of the package's own installers.
   *
   * A long timeout on purpose: fetching toolchains and Python environments is
   * measured in minutes, and the browser must not give up before the server does.
   */
  runInstaller(installer: string, timeout = 3600) {
    return this.post<Record<string, unknown>>(
      "/api/v1/updates/run",
      { installer, timeout },
      (timeout + 30) * 1000,
    );
  }

  diagnostics(deep = false) {
    return this.get<DiagnosticReport>(`/api/v1/diagnostics${deep ? "?deep=1" : ""}`);
  }

  repair(name: string) {
    return this.post<Record<string, unknown>>(`/api/v1/repairs/${name}`);
  }

  events(limit = 40) {
    return this.get<{ ok: boolean; events: BrainEvent[] }>(`/api/v1/events?limit=${limit}`);
  }

  config() {
    return this.get<{ ok: boolean; config: Record<string, unknown>; editable: string[] }>("/api/v1/config");
  }

  setConfig(patch: Record<string, unknown>) {
    return this.post<{ ok: boolean; config: Record<string, unknown>; note: string }>(
      "/api/v1/config",
      patch,
    );
  }
}

/* -------------------------------------------------------------- the connection */

const STORAGE_KEY = "local-brain.connection";

/** The address and token last paired with, if any. */
export function loadConnection(): BrainTarget | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<BrainTarget>;
    if (!parsed?.url) return null;
    return { url: parsed.url, token: parsed.token ?? "" };
  } catch {
    return null;
  }
}

export function saveConnection(target: BrainTarget): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(target));
  } catch {
    // A browser that refuses storage still works — it just forgets the pairing.
  }
}

export function clearConnection(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do: there was never anything stored.
  }
}

/**
 * Find a brain that is running and willing to talk.
 *
 * Only the health check is attempted here — it needs no token — so looking for
 * a brain is never the same as being let into one. A brain that answers is
 * remembered, because the alternative is asking for the address every visit.
 */
export async function discoverBrain(
  candidates: string[] = CANDIDATE_URLS,
): Promise<{ url: string; health: BrainHealth } | null> {
  for (const url of candidates) {
    try {
      const health = await new BrainClient({ url, token: "" }).health();
      if (health?.ok) return { url, health };
    } catch {
      // Not there, or not a brain. Either way, try the next address.
    }
  }
  return null;
}

/** "3.8 GB", "512 MB" — the same shapes the brain prints. */
export function humanBytes(bytes: number | undefined | null): string {
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** "3 minutes ago" — for a heartbeat, a snapshot or a cached page. */
export function since(when: number | null | undefined): string {
  if (!when) return "never";
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - when));
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86_400)} d ago`;
}

/** The URL a person would paste, from whatever they typed. */
export function normalizeUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (!trimmed) return DEFAULT_BRAIN_URL;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}
