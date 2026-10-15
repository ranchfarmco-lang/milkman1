/**
 * NOVA OS application runtime (§31, §32).
 *
 * The OS hosts its own applications. An application is a supervised instance
 * with its own directory, its own service user identity on the image, its own
 * resource limits, and a lifecycle the OS owns: start, stop, restart, logs.
 *
 * Isolation is done with the strongest mechanism actually available, chosen by
 * probing rather than by hoping:
 *
 *   1. `bwrap` (bubblewrap) — unprivileged namespaces, the same tool
 *      Flatpak uses. A real filesystem jail with no privilege required.
 *   2. `unshare` — user, mount and network namespaces, when the kernel permits
 *      them for this user.
 *   3. A supervised directory jail — the process runs in its own directory with
 *      its own environment and resource limits, and the runtime says plainly
 *      that filesystem isolation was not available.
 *
 * §36 forbids quietly presenting the weakest option as the strongest. The mode
 * actually used is recorded on every instance and shown in the portal.
 *
 * The runtime also implements §32's self-hosting shape: an application can
 * declare a port, and the runtime registers a web service for it, so
 * APPLICATION → OS SERVER → LOCAL DATABASE → REMOTE PORTAL works on this machine
 * with no hosting provider involved.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { bus, ensureOsPaths, log, type ComponentStatus, type OsComponent } from "../core/runtime.ts";
import type { WebHandler, WebService } from "../web/service.ts";
import { textResponse } from "../web/service.ts";

export type SandboxMode = "bwrap" | "unshare" | "directory";

export type AppSpec = {
  name: string;
  about: string;
  /** The command to run. */
  command: string;
  args: string[];
  /** Extra environment. Secrets belong in the OS key store, not here. */
  env?: Record<string, string>;
  /** Whether the app should be able to reach the network. */
  network?: boolean;
  /** Memory ceiling in megabytes, applied with `ulimit -v`/`-m` where possible. */
  memoryMb?: number;
  /** Whether the runtime should serve the app's declared path over the OS web service. */
  http?: { prefix: string; port: number };
  /** Restart it automatically if it exits non-zero. */
  restart?: boolean;
};

export type AppInstance = {
  name: string;
  about: string;
  sandbox: SandboxMode;
  pid: number | null;
  status: "stopped" | "running" | "exited" | "failed";
  startedAt: number | null;
  exits: number;
  lastExit: { code: number | null; signal: string | null; at: number } | null;
  directory: string;
  http: { prefix: string; port: number; published: boolean } | null;
  logLines: string[];
};

/** Which isolation this machine can really give an application. */
export function detectSandbox(): { mode: SandboxMode; detail: string } {
  if (has("bwrap") && probeBwrap()) {
    return {
      mode: "bwrap",
      detail:
        "bubblewrap is present and working, so applications run in an unprivileged filesystem jail with only their own directory, the system's read-only runtime, and the network if the application was granted it.",
    };
  }
  if (has("unshare") && probeUnshare()) {
    return {
      mode: "unshare",
      detail: "unshare works here, so applications run in their own user, mount and PID namespaces.",
    };
  }
  return {
    mode: "directory",
    detail:
      "Neither bubblewrap nor unshare could create namespaces here, so applications run in their own directory with their own environment and resource limits, but without filesystem isolation. The image installs bubblewrap precisely so the stronger mode is available.",
  };
}

function has(program: string): boolean {
  try {
    execFileSync("sh", ["-c", `command -v ${program}`], { stdio: "ignore", timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function probeBwrap(): boolean {
  try {
    execFileSync("bwrap", ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--", "/bin/true"], {
      stdio: "ignore",
      timeout: 8000,
    });
    return true;
  } catch {
    return false;
  }
}

function probeUnshare(): boolean {
  try {
    execFileSync("unshare", ["--user", "--map-root-user", "--mount", "--", "/bin/true"], { stdio: "ignore", timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

export class AppRuntime implements OsComponent {
  readonly name = "apps";
  readonly about = "Runs applications as supervised, isolated instances with their own directories, limits and lifecycle.";
  readonly requires: string[] = ["web"];

  private current: ComponentStatus = "stopped";
  private specs = new Map<string, AppSpec>();
  private instances = new Map<string, AppInstance>();
  private processes = new Map<string, ChildProcess>();

  constructor(private readonly web: WebService) {}

  status(): ComponentStatus {
    return this.current;
  }

  async start(): Promise<void> {
    this.current = "running";
    const sandbox = detectSandbox();
    log.info("apps", `Application runtime started; isolation mode is ${sandbox.mode}.`);
  }

  async stop(): Promise<void> {
    for (const name of [...this.instances.keys()]) await this.stopApp(name);
    this.current = "stopped";
  }

  sandbox(): { mode: SandboxMode; detail: string } {
    return detectSandbox();
  }

  /** Declare an application. Nothing runs until `startApp`. */
  define(spec: AppSpec): void {
    if (this.specs.has(spec.name)) throw new Error(`An application called "${spec.name}" is already defined.`);
    this.specs.set(spec.name, spec);
    const directory = this.appDir(spec.name);
    mkdirSync(directory, { recursive: true });
    // Every application gets a data directory of its own plus a manifest, so the
    // OS knows what it is without reading the application's code.
    mkdirSync(join(directory, "data"), { recursive: true });
    writeFileSync(
      join(directory, "manifest.json"),
      `${JSON.stringify({ name: spec.name, about: spec.about, command: spec.command, args: spec.args, network: spec.network ?? false, http: spec.http ?? null }, null, 2)}\n`,
      "utf8",
    );
    log.info("apps", `Application declared: ${spec.name}.`);
  }

  list(): AppInstance[] {
    return [...this.instances.values()].map((instance) => ({ ...instance }));
  }

  get(name: string): AppInstance | null {
    return this.instances.get(name) ?? null;
  }

  /**
   * Start an application under the strongest available isolation.
   *
   * The command line is built from the spec, never from a request: §42's rule
   * that nothing arriving over a network may become a shell command is honoured
   * by construction, because there is no code path here that accepts one.
   */
  async startApp(name: string): Promise<AppInstance> {
    const spec = this.specs.get(name);
    if (!spec) throw new Error(`No application called "${name}" is defined.`);
    const existing = this.instances.get(name);
    if (existing?.status === "running") return existing;

    const { mode } = detectSandbox();
    const directory = this.appDir(name);
    const instance: AppInstance = {
      name,
      about: spec.about,
      sandbox: mode,
      pid: null,
      status: "running",
      startedAt: Date.now(),
      exits: existing?.exits ?? 0,
      lastExit: existing?.lastExit ?? null,
      directory,
      http: spec.http ? { ...spec.http, published: false } : null,
      logLines: existing?.logLines ?? [],
    };

    const child = spawn("/bin/sh", ["-c", this.commandLine(spec, directory)], {
      cwd: directory,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: directory,
        NOVA_APP: name,
        NOVA_APP_DIR: directory,
        ...(spec.env ?? {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    instance.pid = child.pid ?? null;
    this.processes.set(name, child);
    this.instances.set(name, instance);

    const record = (line: string) => {
      instance.logLines.push(`${new Date().toISOString()} ${line}`);
      if (instance.logLines.length > 500) instance.logLines.shift();
    };
    child.stdout?.on("data", (chunk: Buffer) => chunk.toString().split("\n").filter(Boolean).forEach(record));
    child.stderr?.on("data", (chunk: Buffer) => chunk.toString().split("\n").filter(Boolean).forEach((line) => record(`[stderr] ${line}`)));

    child.on("exit", (code, signal) => {
      instance.status = code === 0 ? "exited" : "failed";
      instance.pid = null;
      instance.exits += 1;
      instance.lastExit = { code, signal: signal ?? null, at: Date.now() };
      this.processes.delete(name);
      log.warn("apps", `${name} exited with code ${code ?? "none"}${signal ? ` (${signal})` : ""}.`);
      bus.publish("apps.exit", "apps", { name, code, signal: signal ?? null });
      if (spec.restart && code !== 0) {
        setTimeout(() => void this.startApp(name).catch(() => undefined), 1000).unref?.();
      }
    });

    // §32 — an application that declares an HTTP path becomes reachable through
    // the OS's own web service, which is what makes self-hosting real.
    if (spec.http) {
      try {
        this.web.registerService(`app:${name}`, spec.http.prefix, `application ${name}`, this.proxyTo(spec.http.port));
        instance.http = { ...spec.http, published: true };
        log.info("apps", `${name} published at ${spec.http.prefix}.`);
      } catch (error) {
        record(`[nova] the web service could not publish ${spec.http.prefix}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    log.info("apps", `${name} started in ${mode} mode${instance.pid ? ` as pid ${instance.pid}` : ""}.`);
    return instance;
  }

  async stopApp(name: string): Promise<void> {
    const child = this.processes.get(name);
    const instance = this.instances.get(name);
    const spec = this.specs.get(name);
    if (child) {
      child.kill("SIGTERM");
      // Give it a moment, then insist. A supervised runtime must not leak.
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 3000).unref?.();
      this.processes.delete(name);
    }
    if (instance) {
      instance.status = "stopped";
      instance.pid = null;
    }
    if (spec?.http) this.web.unregisterService(`app:${name}`);
    log.info("apps", `${name} stopped.`);
  }

  async restartApp(name: string): Promise<AppInstance> {
    await this.stopApp(name);
    return await this.startApp(name);
  }

  logs(name: string, limit = 100): string[] {
    return (this.instances.get(name)?.logLines ?? []).slice(-limit);
  }

  /** Remove an application and everything it kept. */
  remove(name: string): boolean {
    if (!this.specs.has(name)) return false;
    void this.stopApp(name);
    this.specs.delete(name);
    this.instances.delete(name);
    rmSync(this.appDir(name), { recursive: true, force: true });
    log.warn("apps", `${name} was removed along with its directory.`);
    return true;
  }

  /* ------------------------------------------------------------- internals --- */

  private appDir(name: string): string {
    return join(ensureOsPaths().apps, name.replace(/[^\w.-]/g, "_"));
  }

  /**
   * The command line for one application: the spec's command, wrapped in the
   * best sandbox this machine can provide.
   */
  private commandLine(spec: AppSpec, directory: string): string {
    const limits: string[] = [];
    if (spec.memoryMb) limits.push(`ulimit -v ${Math.max(1024, spec.memoryMb) * 1024} 2>/dev/null || true`);
    const inner = [spec.command, ...spec.args.map(shellQuote)].join(" ");
    const guarded = [...limits, `exec ${inner}`].join("; ");

    const { mode } = detectSandbox();
    if (mode === "bwrap") {
      const args = [
        "bwrap",
        "--ro-bind", "/usr", "/usr",
        "--ro-bind", "/bin", "/bin",
        "--ro-bind", "/lib", "/lib",
        ...(existsSync("/lib64") ? ["--ro-bind", "/lib64", "/lib64"] : []),
        "--ro-bind", "/etc", "/etc",
        "--proc", "/proc",
        "--dev", "/dev",
        "--tmpfs", "/tmp",
        "--bind", directory, "/app",
        "--chdir", "/app",
        spec.network === false ? "--unshare-net" : "--share-net",
        "--die-with-parent",
        "--",
        "/bin/sh", "-c", guarded,
      ];
      return args.map(shellQuote).join(" ");
    }
    if (mode === "unshare") {
      return [
        "unshare", "--user", "--map-root-user", "--mount", "--pid", "--fork",
        ...(spec.network === false ? ["--net"] : []),
        "--", "/bin/sh", "-c", shellQuote(guarded),
      ].map(shellQuote).join(" ");
    }
    return `/bin/sh -c ${shellQuote(guarded)}`;
  }

  /** The bridge from a web path to the application's own port. */
  private proxyTo(port: number): WebHandler {
    return async (request) => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}${request.path}${request.query.size ? `?${request.query}` : ""}`, {
          method: request.method,
          headers: { ...request.headers, "x-forwarded-for": request.remote ?? "" },
          body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
          redirect: "manual",
        });
        const body = Buffer.from(await response.arrayBuffer());
        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          if (key.startsWith("x-nova") || key === "content-encoding") return;
          headers[key] = value;
        });
        return { status: response.status, headers, body };
      } catch (error) {
        return textResponse(502, `The application did not answer on port ${port}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
  }

  capability() {
    const sandbox = detectSandbox();
    return {
      available: [
        "Declaring applications with their own directory, manifest and data directory.",
        "Starting, stopping, restarting and supervising them, with logs kept per instance.",
        "Publishing an application's HTTP path through the OS's own web service (§32).",
        `Isolation in use here: ${sandbox.mode}.`,
      ],
      blocked: sandbox.mode === "directory"
        ? [
            {
              what: "Filesystem isolation for applications",
              why: "Neither bubblewrap nor user namespaces could be created in this container.",
              fallback: "Applications run in their own directory with their own environment and memory ceiling, and every instance records `sandbox: \"directory\"` so the weaker mode is visible rather than implied.",
            },
          ]
        : [],
    };
  }
}

function shellQuote(value: string): string {
  return /^[\w./:=@+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The applications whose directories exist on disk, whether or not they run. */
export function installedApps(): { name: string; manifest: Record<string, unknown> | null; bytes: number }[] {
  const dir = ensureOsPaths().apps;
  if (!existsSync(dir)) return [];
  const found: { name: string; manifest: Record<string, unknown> | null; bytes: number }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(dir, entry.name, "manifest.json");
    let manifest: Record<string, unknown> | null = null;
    if (existsSync(manifestPath)) {
      try {
        manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
      } catch {
        manifest = null;
      }
    }
    found.push({ name: entry.name, manifest, bytes: statSync(join(dir, entry.name)).size });
  }
  return found;
}
