/**
 * ControlForge's own database: everything the three forge pages know, kept in
 * this browser and nowhere else.
 *
 * The hub's shared family data lives in Convex; the forge deliberately does
 * not follow it there. Builds, keys, projects, agent logs and chat history are
 * local-first — the owner keeps them, and the only way to lose them is to lose
 * the browser profile (which is exactly what Export ZIP guards against).
 *
 * One IndexedDB database, `controlforge`, through Dexie.
 */
import Dexie, { type Table } from "dexie";

/** The four colours a status light may show. Green and red are readings only. */
export type Tone = "good" | "warn" | "bad" | "muted";

/** The six-person crew — same ids as the hub's `ai_crew` roster. */
export type AgentId =
  | "director"
  | "planner"
  | "files"
  | "research"
  | "implement"
  | "review";

export type AgentStatus = "idle" | "running" | "done" | "error" | "stopped";

/** Every switch the forge owns, in one row. */
export type ConfigRow = {
  id: "config";
  /** The implementation agent may write independent files side by side. */
  parallelAgents: boolean;
  /** Boot the sandbox as soon as the Builder page opens. */
  autoBoot: boolean;
  /** Keep sandbox edits saved into IndexedDB as they are typed. */
  autoSave: boolean;
  /** Push to the deploy target automatically after Apply to Live Project. */
  autoDeploy: boolean;
  /** Set by Emergency Stop; the pipeline refuses to start while it stands. */
  emergencyStopped: boolean;
  /**
   * The app the sandbox's bench is holding, or null for a bench of loose files.
   *
   * The bench's files survive a reload, but *what they are* used to live only
   * in memory — so after a refresh Saved Projects read "unfinished apps and
   * experiments" over somebody's actual project, and the prompt studio had
   * nothing to say about which app a change was for. This is that name, kept
   * beside the rest of the forge's settings.
   */
  benchAppId: string | null;
  /** Which search source the Research agent is allowed to use. */
  researchProvider: "wikipedia" | "brave" | "searxng";
  /** A self-hosted SearxNG instance, when that source is chosen. */
  searxngUrl: string;
  /** Which provider/model the Assistant and the Builder talk to. */
  aiProvider: string | null;
  aiModel: string | null;
  /** Local endpoints (Ollama, LM Studio): address and on/off, per provider. */
  endpoints: Record<string, { baseUrl: string; enabled: boolean }>;
  updatedAt: number;
};

/** The AES-GCM master key the vault encrypts every secret with. */
export type VaultRow = { id: "master"; key: CryptoKey };

/** An encrypted secret. The plain text exists only while a call is running. */
export type SecretRow = {
  id: string;
  iv: Uint8Array;
  data: Uint8Array;
  updatedAt: number;
};

/** A status light's last real reading, kept so a reload starts informed. */
export type LightRow = { id: string; tone: Tone; detail: string; at: number };

/** A live project — the thing Apply writes to and Export ZIP takes away. */
export type ProjectRow = {
  id: string;
  name: string;
  note: string;
  createdAt: number;
  updatedAt: number;
};

/** One file of a live project. */
export type FileRow = {
  /** `${project}::${path}` — Dexie wants one simple primary key. */
  id: string;
  project: string;
  path: string;
  content: string;
  updatedAt: number;
};

/** One file inside the sandbox. Isolated: never read by the hub itself. */
export type SandboxFileRow = { path: string; content: string; updatedAt: number };

/** A conversation. The Assistant keeps one stream, the Builder another. */
export type SessionRow = {
  id: string;
  page: "assistant" | "builder";
  title: string;
  createdAt: number;
  updatedAt: number;
  /** The build report that most recently succeeded, if any. */
  lastBuildId: string | null;
  /** Set when its build was applied to the live project. */
  appliedAt: number | null;
};

export type MessageRow = {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  text: string;
  /** A quiet second line — what a tool did, in plain words. */
  note: string | null;
  at: number;
};

/** Live status of one crew member, written by the pipeline as it runs. */
export type AgentRow = {
  id: AgentId;
  status: AgentStatus;
  detail: string;
  sessionId: string | null;
  startedAt: number | null;
  endedAt: number | null;
  at: number;
};

export type AgentLogRow = {
  id?: number;
  sessionId: string;
  agent: AgentId;
  text: string;
  at: number;
};

/** A build request the Assistant packaged for the Builder. */
export type RequestRow = {
  id: string;
  goal: string;
  context: string;
  constraints: string;
  priority: "normal" | "high";
  status: "pending" | "accepted" | "done" | "declined";
  answer: string | null;
  createdAt: number;
  updatedAt: number;
};

export type BuildStepRow = { label: string; ok: boolean; detail: string };

/** One build's report, kept with the session that produced it. */
export type BuildRow = {
  id: string;
  sessionId: string;
  ok: boolean;
  files: string[];
  steps: BuildStepRow[];
  errors: string[];
  at: number;
  appliedAt: number | null;
};

/**
 * An app the builder made, in the home it lives in.
 *
 * The files are kept whole, with the app, rather than by reference to the
 * sandbox: the sandbox is one working bench that the next build overwrites, and
 * an app that could only be run until somebody started something else would not
 * be an app at all. `goal` is kept for the same reason — it is what lets an app
 * be rebuilt, or sent back to the builder with a note instead of a blank page.
 */
export type AppRow = {
  id: string;
  name: string;
  /** What was asked for, in the words it was asked in. */
  goal: string;
  /** The page the app opens on, inside `files`. */
  entry: string | null;
  files: { path: string; content: string }[];
  /** The build that published it: its steps are shown as they really were. */
  build: { ok: boolean; steps: BuildStepRow[]; errors: string[] };
  /** The Builder session it came from, when it came from one. */
  sessionId: string | null;
  at: number;
  updatedAt: number;
  /** How many times it has been launched from the App Sandbox. A real reading. */
  runs: number;
  launchedAt: number | null;
  /** Set when it was sent back to the builder for work. */
  sentBackAt: number | null;
  /**
   * Whether it sits on the home screen.
   *
   * Two places hold apps, with one difference between them: the home screen is
   * for apps that are finished enough to launch, and Projects is for the ones
   * that are not yet. `false` is a draft; absent means the home screen, which
   * is what every row written before this existed is — an app the crew built.
   */
  onHome?: boolean;
};

export type DiagnosticRow = {
  id: string;
  at: number;
  results: { id: string; label: string; tone: Tone; detail: string }[];
  counts: Record<string, number>;
};

export type ErrorRow = { id?: number; at: number; where: string; message: string };

export type ResearchRow = { key: string; provider: string; text: string; at: number };

/** The one place every forge page reads and writes local state. */
class ForgeDatabase extends Dexie {
  config!: Table<ConfigRow, string>;
  vault!: Table<VaultRow, string>;
  secrets!: Table<SecretRow, string>;
  lights!: Table<LightRow, string>;
  projects!: Table<ProjectRow, string>;
  files!: Table<FileRow, string>;
  sandboxFiles!: Table<SandboxFileRow, string>;
  sessions!: Table<SessionRow, string>;
  messages!: Table<MessageRow, string>;
  agents!: Table<AgentRow, string>;
  agentLogs!: Table<AgentLogRow, number>;
  requests!: Table<RequestRow, string>;
  builds!: Table<BuildRow, string>;
  diagnostics!: Table<DiagnosticRow, string>;
  errors!: Table<ErrorRow, number>;
  research!: Table<ResearchRow, string>;
  apps!: Table<AppRow, string>;

  constructor() {
    super("controlforge");
    this.version(1).stores({
      config: "&id",
      vault: "&id",
      secrets: "&id",
      lights: "&id",
      projects: "id, updatedAt",
      files: "id, project, path",
      sandboxFiles: "path, updatedAt",
      sessions: "id, page, updatedAt",
      messages: "id, sessionId, at",
      agents: "&id",
      agentLogs: "++id, sessionId, at",
      requests: "id, status, createdAt",
      builds: "id, sessionId, at",
      diagnostics: "&id, at",
      errors: "++id, at",
      research: "&key, at",
    });

    // v2 — the App Sandbox. Apps the builder has made, each kept whole so it
    // can be launched, sent back for work, or taken away. Nothing in v1 moves:
    // a new version adds the table and leaves every existing row where it is.
    this.version(2).stores({
      apps: "id, name, at, updatedAt",
    });
  }
}

export const forgeDb = new ForgeDatabase();

/** A fresh local id. */
export function forgeId(): string {
  return crypto.randomUUID();
}

/**
 * Keep the last few failures where the diagnostics box can show them. The
 * pipeline, the deploy buttons and the key tests all feed this — an error the
 * owner never sees is an error they cannot act on.
 */
export async function recordError(where: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  try {
    await forgeDb.errors.add({ at: Date.now(), where, message });
    const count = await forgeDb.errors.count();
    if (count > 50) {
      const old = await forgeDb.errors.orderBy("at").limit(count - 50).primaryKeys();
      await forgeDb.errors.bulkDelete(old);
    }
  } catch {
    // The error log failing must not become the error.
  }
}

/** The most recent recorded failure, for the diagnostics box. */
export async function lastError(): Promise<ErrorRow | null> {
  const row = await forgeDb.errors.orderBy("at").reverse().first();
  return row ?? null;
}

/** Write a status light's latest real reading. */
export async function setLight(id: string, tone: Tone, detail: string): Promise<void> {
  await forgeDb.lights.put({ id, tone, detail, at: Date.now() });
}
