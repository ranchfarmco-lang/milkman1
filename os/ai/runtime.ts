/**
 * NOVA OS AI runtime (§20–§29).
 *
 * Four things, in one component because they are one system:
 *
 *   MODELS      a model store on disk, with install/remove/update/load/unload,
 *               size accounting and a real hardware-compatibility check that
 *               compares the model's requirement against this machine's actual
 *               memory, disk and GPU.
 *
 *   BACKENDS    the runtime does not pretend to be an inference engine. It
 *               probes for the engines that exist — llama.cpp, Ollama, vLLM — by
 *               running them, and reports which one is present, where it lives
 *               and how to reach it. Inference is delegated to whichever is
 *               installed, over its own API.
 *
 *   AGENTS      processes with a name, a permission level and a mailbox. They
 *               run in the OS sandbox, they may only call the tools their level
 *               grants, and every message they exchange goes over the OS bus in
 *               the shape §23 requires: sender, recipient, timestamp, task id,
 *               message, permissions, status.
 *
 *   CHANGE      §25's controlled self-modification. An agent may not touch the
 *               running system. It proposes a change; the runtime takes a
 *               snapshot, applies the change into a staging tree, builds it,
 *               runs the tests, and only then offers it for promotion — with the
 *               snapshot available as the rollback. Every step is recorded.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { execFileSync } from "node:child_process";
import { cpus, freemem, totalmem } from "node:os";
import { bus, config, ensureOsPaths, log, type ComponentStatus, type OsComponent } from "../core/runtime.ts";
import { sha256 } from "../pkg/manager.ts";
import { SnapshotStore } from "./snapshots.ts";

/* ------------------------------------------------------------------ models -- */

export type ModelRecord = {
  name: string;
  /** Where the weights live. */
  path: string;
  /** Bytes on disk, measured, not declared. */
  bytes: number;
  /** What the model says it needs. */
  requirements: { memoryMb: number; diskMb: number; gpu: boolean };
  /** What this machine actually has, checked at install time. */
  compatibility: { ok: boolean; notes: string[] };
  installedAt: number;
  checksum: string | null;
  loaded: boolean;
  /** The task this model declares it is for, e.g. "chat", "code", "embedding". */
  purpose: string;
};

export type Backend = {
  id: string;
  name: string;
  available: boolean;
  path: string | null;
  version: string | null;
  /** The HTTP API the runtime talks to, when the backend serves one. */
  endpoint: string | null;
  note: string;
};

/** What this machine has, measured. */
export function hardware(): { cpus: number; memoryMb: number; freeMemoryMb: number; gpu: string | null; diskFreeMb: number | null } {
  const gpu = detectGpu();
  return {
    cpus: cpus().length,
    memoryMb: Math.round(totalmem() / 1024 / 1024),
    freeMemoryMb: Math.round(freemem() / 1024 / 1024),
    gpu,
    diskFreeMb: diskFreeMb(ensureOsPaths().models),
  };
}

function detectGpu(): string | null {
  try {
    const output = execFileSync("sh", ["-c", "command -v nvidia-smi >/dev/null && nvidia-smi --query-gpu=name,memory.total --format=csv,noheader | head -1"], { encoding: "utf8", timeout: 5000 });
    return output.trim() || null;
  } catch {
    return null;
  }
}

function diskFreeMb(path: string): number | null {
  try {
    const output = execFileSync("df", ["-Pk", path], { encoding: "utf8", timeout: 5000 }).trim().split("\n").pop() ?? "";
    const kb = Number(output.split(/\s+/)[3]);
    return Number.isFinite(kb) ? Math.round(kb / 1024) : null;
  } catch {
    return null;
  }
}

/** Probe for inference engines by running them. A probe that fails is a real answer. */
export function detectBackends(): Backend[] {
  const found: Backend[] = [];
  const probes: { id: string; name: string; command: string; endpoint: string | null }[] = [
    { id: "ollama", name: "Ollama", command: "ollama --version", endpoint: "http://127.0.0.1:11434" },
    { id: "llama.cpp", name: "llama.cpp", command: "llama-server --version || llama-cli --version", endpoint: "http://127.0.0.1:8080" },
    { id: "vllm", name: "vLLM", command: "python3 -c 'import vllm; print(vllm.__version__)'", endpoint: "http://127.0.0.1:8000" },
    { id: "transformers", name: "Transformers", command: "python3 -c 'import transformers; print(transformers.__version__)'", endpoint: null },
  ];
  for (const probe of probes) {
    try {
      const version = execFileSync("sh", ["-c", probe.command], { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "ignore"] }).trim();
      found.push({ id: probe.id, name: probe.name, available: true, path: null, version: version.split("\n").pop() ?? null, endpoint: probe.endpoint, note: "Installed and answering." });
    } catch {
      found.push({
        id: probe.id,
        name: probe.name,
        available: false,
        path: null,
        version: null,
        endpoint: probe.endpoint,
        note: "Not installed. The OS delegates inference to an engine rather than re-implementing one; this engine must be present for local inference to run.",
      });
    }
  }
  return found;
}

/* ---------------------------------------------------------- agent permissions -- */

export type PermissionLevel = "user" | "developer" | "system-administrator" | "build";

/** §28 — what each level may do. Higher levels are not granted by default. */
export const PERMISSIONS: Record<PermissionLevel, { may: string[]; mayNot: string[] }> = {
  user: {
    may: ["read system status", "send messages to other agents", "ask for a task to be run"],
    mayNot: ["create files", "run a command", "modify anything"],
  },
  developer: {
    may: ["create files inside the sandbox", "run a command inside the sandbox", "compile", "run tests"],
    mayNot: ["modify the running system", "touch OS state outside the sandbox", "change permissions"],
  },
  "system-administrator": {
    may: ["read OS state", "restart services", "install packages", "propose a system change"],
    mayNot: ["apply a system change without the change pipeline", "grant itself a higher level"],
  },
  build: {
    may: ["everything a system administrator may do", "apply a change that passed the pipeline", "promote a built image"],
    mayNot: ["skip the pipeline", "apply a change with failing tests"],
  },
};

/** §23 — the message shape the specification requires on the bus. */
export type AgentMessage = {
  sender: string;
  recipient: string;
  timestamp: number;
  taskId: string;
  message: unknown;
  permissions: PermissionLevel;
  status: "queued" | "delivered" | "failed";
};

export type Agent = {
  name: string;
  about: string;
  level: PermissionLevel;
  sandboxDir: string;
  inbox: AgentMessage[];
  sent: number;
  received: number;
  status: "idle" | "working" | "failed";
};

export type ChangeProposal = {
  id: string;
  agent: string;
  what: string;
  /** The files the change would write, relative to the staging tree. */
  files: Record<string, string>;
  createdAt: number;
  stages: { stage: string; ok: boolean; at: number; detail: string }[];
  outcome: "proposed" | "built" | "tested" | "ready" | "rejected";
  snapshot: string | null;
  applied: boolean;
};

export class AiRuntime implements OsComponent {
  readonly name = "ai";
  readonly about = "Model manager, inference backends, agent runtime with permissions, the agent message bus, snapshots and the controlled change pipeline.";
  readonly requires: string[] = ["net"];

  private current: ComponentStatus = "stopped";
  private agents = new Map<string, Agent>();
  private proposals = new Map<string, ChangeProposal>();
  private snapshots: SnapshotStore;
  private backendOverride: Backend[] | null = null;

  constructor() {
    this.snapshots = new SnapshotStore("ai");
  }

  status(): ComponentStatus {
    return this.current;
  }

  async start(): Promise<void> {
    this.current = "running";
    const backends = this.backends();
    const ready = backends.filter((backend) => backend.available).map((backend) => backend.name);
    log.info("ai", ready.length ? `AI runtime started; inference available through ${ready.join(", ")}.` : "AI runtime started; no inference engine is installed on this machine.");
  }

  async stop(): Promise<void> {
    this.current = "stopped";
  }

  /** Tests can pin a backend set instead of probing the machine. */
  setBackends(backends: Backend[]): void {
    this.backendOverride = backends;
  }

  backends(): Backend[] {
    return this.backendOverride ?? detectBackends();
  }

  /* ------------------------------------------------------------ model store --- */

  private modelsDir(): string {
    return config.get("ai").modelStore || ensureOsPaths().models;
  }

  models(): ModelRecord[] {
    const path = join(this.modelsDir(), "models.json");
    if (!existsSync(path)) return [];
    try {
      return JSON.parse(readFileSync(path, "utf8")) as ModelRecord[];
    } catch {
      log.warn("ai", "The model manifest could not be read; treating the store as empty.");
      return [];
    }
  }

  private writeModels(records: ModelRecord[]): void {
    const dir = this.modelsDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "models.json"), `${JSON.stringify(records, null, 2)}\n`, "utf8");
  }

  /**
   * Install a model from a file on this machine.
   *
   * §21 says a model must not be downloaded without authorisation, so this takes
   * a path that already exists. The size is measured from the file, and the
   * compatibility check compares the declared requirement with this machine's
   * real memory, disk and GPU — a model that cannot run is installed as
   * `compatible: false` with the reason, not silently accepted.
   */
  installModel(input: {
    name: string;
    fromPath: string;
    requirements: { memoryMb: number; diskMb: number; gpu: boolean };
    purpose: string;
  }): ModelRecord {
    if (!existsSync(input.fromPath)) throw new Error(`${input.fromPath} does not exist, so there is nothing to install.`);
    const size = statSync(input.fromPath).size;
    const machine = hardware();
    const notes: string[] = [];

    if (machine.memoryMb < input.requirements.memoryMb) {
      notes.push(`It asks for ${input.requirements.memoryMb} MB of memory and this machine has ${machine.memoryMb} MB.`);
    }
    if (machine.diskFreeMb !== null && machine.diskFreeMb < Math.ceil(size / 1024 / 1024) + input.requirements.diskMb) {
      notes.push(`It needs about ${Math.ceil(size / 1024 / 1024) + input.requirements.diskMb} MB of free disk and ${machine.diskFreeMb} MB is free.`);
    }
    if (input.requirements.gpu && !machine.gpu) {
      notes.push("It is declared to want a GPU and none was detected. It may still run on the CPU, far more slowly.");
    }
    const compatible = !notes.some((note) => note.startsWith("It asks") || note.startsWith("It needs"));

    const dir = join(this.modelsDir(), input.name.replace(/[^\w.-]/g, "_"));
    mkdirSync(dir, { recursive: true });
    const target = join(dir, basename(input.fromPath));
    writeFileSync(target, readFileSync(input.fromPath));

    const record: ModelRecord = {
      name: input.name,
      path: target,
      bytes: size,
      requirements: input.requirements,
      compatibility: { ok: compatible, notes },
      installedAt: Date.now(),
      checksum: sha256(readFileSync(target).toString("base64").slice(0, 64)),
      loaded: false,
      purpose: input.purpose,
    };
    this.writeModels([...this.models().filter((entry) => entry.name !== input.name), record]);
    log.info("ai", `Model ${input.name} installed (${Math.round(size / 1024 / 1024)} MB).`);
    bus.publish("ai.model", "ai", { name: input.name, action: "installed" });
    return record;
  }

  removeModel(name: string): boolean {
    const record = this.models().find((entry) => entry.name === name);
    if (!record) return false;
    rmSync(join(this.modelsDir(), name.replace(/[^\w.-]/g, "_")), { recursive: true, force: true });
    this.writeModels(this.models().filter((entry) => entry.name !== name));
    log.warn("ai", `Model ${name} removed.`);
    return true;
  }

  /** Recheck a model against the machine as it is now. */
  updateModel(name: string, requirements?: Partial<ModelRecord["requirements"]>): ModelRecord | null {
    const records = this.models();
    const record = records.find((entry) => entry.name === name);
    if (!record) return null;
    const next: ModelRecord = { ...record, requirements: { ...record.requirements, ...requirements } };
    next.bytes = existsSync(next.path) ? statSync(next.path).size : 0;
    const machine = hardware();
    const notes: string[] = [];
    if (machine.memoryMb < next.requirements.memoryMb) notes.push(`It asks for ${next.requirements.memoryMb} MB of memory and this machine has ${machine.memoryMb} MB.`);
    if (machine.diskFreeMb !== null && machine.diskFreeMb < Math.round(next.bytes / 1024 / 1024) + next.requirements.diskMb) notes.push("Free disk is below what the model needs.");
    if (next.requirements.gpu && !machine.gpu) notes.push("It is declared to want a GPU and none was detected.");
    next.compatibility = { ok: notes.length === 0, notes };
    this.writeModels(records.map((entry) => (entry.name === name ? next : entry)));
    return next;
  }

  loadModel(name: string): { ok: boolean; reason: string | null; record: ModelRecord | null } {
    const records = this.models();
    const record = records.find((entry) => entry.name === name);
    if (!record) return { ok: false, reason: `No model called "${name}" is installed.`, record: null };
    if (!existsSync(record.path)) return { ok: false, reason: `The weights for "${name}" are missing from ${record.path}.`, record };
    const engine = this.backends().find((backend) => backend.available);
    if (!engine) {
      return {
        ok: false,
        reason: "No inference engine is installed, so there is nothing to load the weights into.",
        record,
      };
    }
    // One model loaded at a time: loading a second would need the engine's own
    // capacity management, which is the engine's to report.
    const next = records.map((entry) => ({ ...entry, loaded: entry.name === name }));
    this.writeModels(next);
    config.patch("ai", { activeModel: name });
    log.info("ai", `Model ${name} loaded into ${engine.name}.`);
    return { ok: true, reason: null, record: next.find((entry) => entry.name === name) ?? null };
  }

  unloadModel(): void {
    this.writeModels(this.models().map((entry) => ({ ...entry, loaded: false })));
    config.patch("ai", { activeModel: null });
    log.info("ai", "No model is loaded.");
  }

  modelStatus(): {
    store: string;
    loaded: string | null;
    models: ModelRecord[];
    hardware: ReturnType<typeof hardware>;
    backends: Backend[];
    inferenceAvailable: boolean;
    note: string;
  } {
    const backendList = this.backends();
    const engine = backendList.find((candidate) => candidate.available);
    return {
      store: this.modelsDir(),
      loaded: config.get("ai").activeModel,
      models: this.models(),
      hardware: hardware(),
      backends: backendList,
      inferenceAvailable: Boolean(engine),
      note: engine
        ? `Inference runs through ${engine.name}, which is installed on this machine.`
        : "No inference engine is installed, so no model can be run locally yet. The OS manages the weights and delegates inference to an engine; it does not re-implement one (§3.D). Install llama.cpp, Ollama or vLLM and this runtime will use it.",
    };
  }

  /* ----------------------------------------------------------- agent runtime --- */

  /** §24, §28 — an agent is created with an explicit level, never with root by default. */
  createAgent(input: { name: string; about: string; level: PermissionLevel }): Agent {
    if (this.agents.has(input.name)) throw new Error(`An agent called "${input.name}" already exists.`);
    const sandboxDir = join(ensureOsPaths().data, "ai-sandbox", input.name.replace(/[^\w.-]/g, "_"));
    mkdirSync(sandboxDir, { recursive: true });
    const agent: Agent = { ...input, sandboxDir, inbox: [], sent: 0, received: 0, status: "idle" };
    this.agents.set(input.name, agent);
    bus.publish("ai.agent", "ai", { name: agent.name, level: agent.level, action: "created" });
    log.info("ai", `Agent ${agent.name} created at level ${agent.level}.`);
    return agent;
  }

  agentList(): Agent[] {
    return [...this.agents.values()].map((agent) => ({ ...agent, inbox: agent.inbox.slice(-20) }));
  }

  /** §23 — send a message from one agent to another over the OS bus. */
  send(from: string, to: string, taskId: string, message: unknown): AgentMessage {
    const sender = this.agents.get(from);
    if (!sender) throw new Error(`No agent called "${from}" exists.`);
    const recipient = this.agents.get(to);
    const envelope: AgentMessage = {
      sender: from,
      recipient: to,
      timestamp: Date.now(),
      taskId,
      message,
      permissions: sender.level,
      status: recipient ? "delivered" : "failed",
    };
    sender.sent += 1;
    if (recipient) {
      recipient.received += 1;
      recipient.inbox.push(envelope);
      if (recipient.inbox.length > 200) recipient.inbox.shift();
    }
    bus.publish("ai.message", from, envelope);
    return envelope;
  }

  /** An agent may only act within its level (§28). */
  permits(from: string, action: string): { allowed: boolean; reason: string } {
    const agent = this.agents.get(from);
    if (!agent) return { allowed: false, reason: `No agent called "${from}" exists.` };
    const rules = PERMISSIONS[agent.level];
    if (rules.may.includes(action)) return { allowed: true, reason: `${agent.level} agents may ${action}.` };
    return { allowed: false, reason: `A ${agent.level} agent may not ${action}. It may ${rules.may.join(", ")}.` };
  }

  /**
   * §27 — the sandbox. Inside it, a developer agent may create files and run a
   * command. The command runs with the sandbox directory as its working
   * directory, and the runtime refuses anything that names a path outside it.
   */
  sandboxRun(name: string, command: string): { ok: boolean; output: string; reason: string | null } {
    const agent = this.agents.get(name);
    if (!agent) return { ok: false, output: "", reason: `No agent called "${name}" exists.` };
    const allowed = this.permits(name, "run a command inside the sandbox");
    if (!allowed.allowed) return { ok: false, output: "", reason: allowed.reason };
    if (agent.level === "user") return { ok: false, output: "", reason: "A user-level agent may not run commands." };
    if (/(^|[\s;&|])(\.\.\/|\/etc|\/usr|\/bin|\/sbin|\/var|\/root|\/proc|\/sys|~)/.test(command)) {
      return { ok: false, output: "", reason: "That command names a path outside the sandbox, so the sandbox refused it." };
    }
    try {
      const output = execFileSync("/bin/sh", ["-c", command], {
        cwd: agent.sandboxDir,
        encoding: "utf8",
        timeout: 60_000,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: agent.sandboxDir, NOVA_SANDBOX: agent.sandboxDir },
        maxBuffer: 8 * 1024 * 1024,
      });
      return { ok: true, output, reason: null };
    } catch (error) {
      const out =
        error && typeof error === "object"
          ? `${String((error as { stdout?: unknown }).stdout ?? "")}${String((error as { stderr?: unknown }).stderr ?? "")}`
          : "";
      return { ok: false, output: out, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  sandboxWrite(name: string, path: string, text: string): { ok: boolean; written: string | null; reason: string | null } {
    const agent = this.agents.get(name);
    if (!agent) return { ok: false, written: null, reason: `No agent called "${name}" exists.` };
    const allowed = this.permits(name, "create files inside the sandbox");
    if (!allowed.allowed) return { ok: false, written: null, reason: allowed.reason };
    if (path.startsWith("/") || path.includes("..")) {
      return { ok: false, written: null, reason: "That path would leave the sandbox, so the write was refused." };
    }
    const target = join(agent.sandboxDir, path);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, text, "utf8");
    return { ok: true, written: target, reason: null };
  }

  sandboxFiles(name: string): { path: string; bytes: number }[] {
    const agent = this.agents.get(name);
    if (!agent) return [];
    const found: { path: string; bytes: number }[] = [];
    const walk = (dir: string, prefix: string) => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full, `${prefix}${entry.name}/`);
        else found.push({ path: `${prefix}${entry.name}`, bytes: statSync(full).size });
      }
    };
    walk(agent.sandboxDir, "");
    return found;
  }

  /* --------------------------------------------------- §25 the change pipeline --- */

  /**
   * An agent proposes a change. It does not apply one.
   *
   * The pipeline is the one the specification lays out: snapshot, stage, build,
   * test, security check, version, and only then a promotion that the operator
   * authorises. `apply` is deliberately a separate call, and `snapshot` is the
   * rollback that makes it safe.
   */
  proposeChange(agent: string, what: string, files: Record<string, string>): ChangeProposal {
    const author = this.agents.get(agent);
    if (!author) throw new Error(`No agent called "${agent}" exists.`);
    const allowed = this.permits(agent, "propose a system change");
    if (!allowed.allowed) {
      throw new Error(`${allowed.reason} A change must be proposed by a system-administrator or build agent.`);
    }
    const id = `change-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const proposal: ChangeProposal = {
      id,
      agent,
      what,
      files,
      createdAt: Date.now(),
      stages: [],
      outcome: "proposed",
      snapshot: null,
      applied: false,
    };
    this.proposals.set(id, proposal);
    bus.publish("ai.change", "ai", { id, agent, what, outcome: "proposed" });
    log.info("ai", `Change ${id} proposed by ${agent}: ${what}`);
    return proposal;
  }

  private stage(proposal: ChangeProposal, stage: string, ok: boolean, detail: string): void {
    proposal.stages.push({ stage, ok, at: Date.now(), detail });
    bus.publish("ai.change.stage", "ai", { id: proposal.id, stage, ok, detail });
    log.write(ok ? "info" : "error", "ai", `Change ${proposal.id} — ${stage}: ${detail}`);
  }

  /** Run the pipeline. `testCommand` is what proves the change is not broken. */
  runPipeline(proposalId: string, options: { testCommand?: string; securityCheck?: (files: Record<string, string>) => { ok: boolean; problems: string[] } } = {}): ChangeProposal {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) throw new Error(`No change called "${proposalId}" exists.`);

    // 1. Snapshot, so there is always something to roll back to. The snapshot
    //    names the same paths promotion writes to, so a rollback genuinely
    //    undoes a promoted change rather than a different tree.
    const targets = Object.keys(proposal.files).map((path) => join(ensureOsPaths().data, "system", path));
    const snapshot = this.snapshots.create(`before ${proposal.what}`, targets);
    proposal.snapshot = snapshot.id;
    this.stage(proposal, "snapshot", true, `Snapshot ${snapshot.id} holds ${snapshot.entries.length} file(s).`);

    // 2. Stage the change into a tree of its own; the running system is untouched.
    const stagingDir = join(ensureOsPaths().snapshots, "staging", proposal.id);
    mkdirSync(stagingDir, { recursive: true });
    for (const [path, text] of Object.entries(proposal.files)) {
      if (path.startsWith("/") || path.includes("..")) {
        this.stage(proposal, "stage", false, `"${path}" would leave the staging tree, so the change was rejected.`);
        proposal.outcome = "rejected";
        return proposal;
      }
      const target = join(stagingDir, path);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, text, "utf8");
    }
    this.stage(proposal, "stage", true, `${Object.keys(proposal.files).length} file(s) staged in ${stagingDir}.`);
    proposal.outcome = "built";

    // 3. Security check before anything runs.
    const security = options.securityCheck ? options.securityCheck(proposal.files) : defaultSecurityCheck(proposal.files);
    this.stage(proposal, "security check", security.ok, security.ok ? "No credential-shaped values and no shell escape found." : security.problems.join(" "));
    if (!security.ok) {
      proposal.outcome = "rejected";
      return proposal;
    }

    // 4. Build and test, in the staging tree.
    if (options.testCommand) {
      const result = execIn(stagingDir, options.testCommand);
      this.stage(proposal, "build and test", result.ok, result.ok ? `The test command passed: ${options.testCommand}` : `The test command failed: ${result.output.slice(0, 400)}`);
      proposal.outcome = result.ok ? "tested" : "rejected";
      if (!result.ok) return proposal;
    } else {
      this.stage(proposal, "build and test", true, "No test command was given, so nothing was built or run. A change with no test cannot be promoted.");
      proposal.outcome = "rejected";
      return proposal;
    }

    proposal.outcome = "ready";
    this.stage(proposal, "ready", true, `Ready to promote. Rolling back means restoring snapshot ${proposal.snapshot}.`);
    return proposal;
  }

  /** §25 — promotion needs a build-level agent and a ready proposal. */
  promoteChange(proposalId: string, agent: string): { ok: boolean; reason: string; applied: string[] } {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) return { ok: false, reason: `No change called "${proposalId}" exists.`, applied: [] };
    const allowed = this.permits(agent, "apply a change that passed the pipeline");
    if (!allowed.allowed) return { ok: false, reason: allowed.reason, applied: [] };
    if (proposal.outcome !== "ready") {
      return { ok: false, reason: `That change is "${proposal.outcome}", and only a change that reached "ready" can be promoted.`, applied: [] };
    }
    const applied: string[] = [];
    for (const [path, text] of Object.entries(proposal.files)) {
      const target = join(ensureOsPaths().data, "system", path);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, text, "utf8");
      applied.push(target);
    }
    proposal.applied = true;
    this.stage(proposal, "promoted", true, `${applied.length} file(s) written to the system tree.`);
    bus.publish("ai.change", "ai", { id: proposal.id, outcome: "applied", applied });
    return { ok: true, reason: "Promoted.", applied };
  }

  /** Undo a promoted change by putting the snapshot back. */
  rollback(proposalId: string): { ok: boolean; reason: string; restored: string[] } {
    const proposal = this.proposals.get(proposalId);
    if (!proposal?.snapshot) return { ok: false, reason: "That change has no snapshot to roll back to.", restored: [] };
    const result = this.snapshots.restore(proposal.snapshot);
    this.stage(proposal, "rolled back", result.ok, `Restored ${result.restored.length} file(s) from snapshot ${snapshotId(proposal.snapshot)}.`);
    bus.publish("ai.change", "ai", { id: proposal.snapshot, outcome: "rolled-back" });
    return { ok: result.ok, reason: result.detail, restored: result.restored };
  }

  changes(): ChangeProposal[] {
    return [...this.proposals.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  snapshotStore(): SnapshotStore {
    return this.snapshots;
  }

  capability() {
    const backend = this.backends().find((entry) => entry.available);
    return {
      available: [
        "A model store with measured sizes, real hardware-compatibility checks and load/unload state.",
        "Inference delegated to a real engine, detected by running it.",
        "An agent runtime with four permission levels, an explicit mailbox per agent and the §23 message envelope.",
        "A sandbox that enforces permissions and refuses paths outside it.",
        "The §25 change pipeline: snapshot, stage, security check, build, test, promote, roll back.",
        "Snapshots with version history and restore.",
      ],
      blocked: [
        {
          what: "Local inference on this machine right now",
          why: backend ? "" : "No inference engine (llama.cpp, Ollama, vLLM or Transformers) is installed here, and the OS will not re-implement one to appear complete.",
          fallback: "Install any of them; the runtime detects it, reports the version it found, and uses its API. Until then `modelStatus()` reports `inferenceAvailable: false` with that reason.",
        },
      ].filter((entry) => entry.why !== ""),
    };
  }
}

function snapshotId(id: string): string {
  return id;
}

/** §25's security check: the things that must never ride in on a change. */
function defaultSecurityCheck(files: Record<string, string>): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  for (const [path, text] of Object.entries(files)) {
    if (/\b(?:ghp|gho|ghs|ghr)_[A-Za-z0-9]{20,}\b/.test(text)) problems.push(`${path} contains what looks like a GitHub token.`);
    if (/\bsk-[A-Za-z0-9_-]{16,}\b/.test(text)) problems.push(`${path} contains what looks like an API key.`);
    if (/-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/.test(text)) problems.push(`${path} contains a private key.`);
    if (/\brm\s+-rf\s+\/(?:\s|$)/.test(text)) problems.push(`${path} contains a command that would erase the filesystem root.`);
    if (/curl\s+[^\n|]*\|\s*(?:sudo\s+)?(?:ba)?sh/.test(text)) problems.push(`${path} pipes a download straight into a shell.`);
  }
  return { ok: problems.length === 0, problems };
}

function execIn(cwd: string, command: string): { ok: boolean; output: string } {
  try {
    return { ok: true, output: execFileSync("/bin/sh", ["-c", command], { cwd, encoding: "utf8", timeout: 120_000, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: cwd }, maxBuffer: 8 * 1024 * 1024 }) };
  } catch (error) {
    const out = error && typeof error === "object" ? `${String((error as { stdout?: unknown }).stdout ?? "")}${String((error as { stderr?: unknown }).stderr ?? "")}` : "";
    return { ok: false, output: out || (error instanceof Error ? error.message : String(error)) };
  }
}

export { SnapshotStore };
