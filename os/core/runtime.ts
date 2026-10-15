/**
 * NOVA OS — the operating environment's own runtime.
 *
 * This is the layer every other OS service is built on: the identity of the
 * system, where its state lives, how it logs, and how its components talk to one
 * another. It is deliberately dependency-free so it can run as PID-1-adjacent
 * userspace on the real image *and* run inside a development container, which is
 * the only way the same code can be tested before a machine exists to boot it.
 *
 * Nothing here refers to any earlier application. NOVA is its own project with
 * its own identity, its own state directory and its own service bus.
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, hostname, arch } from "node:os";

/* ---------------------------------------------------------------- identity -- */

export const OS_NAME = "NOVA";
export const OS_CODENAME = "bootstrap";

export const OS_RELEASE = {
  name: OS_NAME,
  version: "0.1.0",
  build: "2026.10.01.1",
  date: "2026-10-01",
  /** The kernel generation the image targets is recorded in os/build/kernel.config. */
  kernelSeries: "6.12",
  /** What the OS is: a Linux-based independent operating environment. */
  foundation: "Linux (mainline) + musl userland, assembled by os/build",
  architecture: arch(),
  notes: [
    "OS runtime: identity, state, logging and the service bus.",
    "init: PID 1 and the service supervisor with dependency ordering and restart policy.",
    "net: interface/route/DNS/connectivity management, NAT and CGNAT detection.",
    "net/vpn: modular VPN subsystem; WireGuard provider implemented.",
    "net/firewall: nftables ruleset generation and validation.",
    "web: multi-service HTTP/HTTPS host with TLS.",
    "apps: supervised application sandboxes with lifecycle management.",
    "pkg: package manager with a content-addressed store and dependency resolution.",
    "ai: model manager, agent runtime, message bus, permissions, snapshots and the change pipeline.",
    "comms: signalling, ICE/SDP negotiation and the call state machine.",
    "diag: diagnostics and the requirement audit.",
  ],
};

/* ------------------------------------------------------------------- state -- */

export type OsPaths = {
  /** Everything the OS owns on a running system. */
  root: string;
  config: string;
  state: string;
  logs: string;
  packages: string;
  apps: string;
  models: string;
  snapshots: string;
  data: string;
};

/**
 * Where the OS keeps its things. On a booted system `NOVA_ROOT` is set by init
 * to `/var/lib/nova`; in a container or a test it defaults under the user's home
 * so the same code runs without root.
 */
export function osPaths(): OsPaths {
  const root = (process.env.NOVA_ROOT ?? "").trim() || join(homedir(), ".nova");
  return {
    root,
    config: join(root, "config"),
    state: join(root, "state"),
    logs: join(root, "logs"),
    packages: join(root, "packages"),
    apps: join(root, "apps"),
    models: join(root, "models"),
    snapshots: join(root, "snapshots"),
    data: join(root, "data"),
  };
}

export function ensureOsPaths(): OsPaths {
  const paths = osPaths();
  for (const dir of Object.values(paths)) mkdirSync(dir, { recursive: true });
  return paths;
}

/* -------------------------------------------------------------- structure -- */

/**
 * A component of the OS. Every service implements this, so init can start them,
 * the audit can list them, and the diagnostics can ask any of them for a report
 * without knowing what they are.
 */
export type ComponentStatus = "stopped" | "starting" | "running" | "degraded" | "failed";

export interface OsComponent {
  /** Stable name, e.g. "net", "web", "ai". */
  readonly name: string;
  /** One line: what it does, for the audit and the portal. */
  readonly about: string;
  /** What it needs to be running first. */
  readonly requires: string[];
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): ComponentStatus;
  /** What this component can and cannot do here, honestly (§3.D). */
  capability(): { available: string[]; blocked: { what: string; why: string; fallback: string }[] };
}

/* --------------------------------------------------------------------- log -- */

export type LogCategory =
  | "kernel"
  | "init"
  | "net"
  | "vpn"
  | "firewall"
  | "web"
  | "browser"
  | "apps"
  | "pkg"
  | "ai"
  | "comms"
  | "storage"
  | "security"
  | "update"
  | "diag";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogEntry = {
  at: number;
  level: LogLevel;
  category: LogCategory;
  message: string;
  detail?: Record<string, string | number | boolean | null>;
};

const SECRETS: [RegExp, string][] = [
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, "«jwt»"],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, "«key»"],
  [/\b(?:password|passwd|secret|token|apikey|api_key|authorization)\b\s*[:=]\s*\S+/gi, "$1=«redacted»"],
  [/([?&](?:token|key|password|secret)=)[^&\s]*/gi, "$1«redacted»"],
];

export function redact(value: string): string {
  let out = value;
  for (const [pattern, replacement] of SECRETS) out = out.replace(pattern, replacement);
  return out;
}

export class Logger {
  private entries: LogEntry[] = [];
  private readonly limit: number;
  echo = false;

  constructor(limit = 5000) {
    this.limit = limit;
  }

  write(level: LogLevel, category: LogCategory, message: string, detail?: Record<string, unknown>): LogEntry {
    const safe: Record<string, string | number | boolean | null> = {};
    for (const [key, value] of Object.entries(detail ?? {})) {
      safe[key] = /password|secret|token|key|credential/i.test(key)
        ? "«redacted»"
        : value === null || typeof value === "number" || typeof value === "boolean"
          ? value
          : redact(String(value));
    }
    const entry: LogEntry = {
      at: Date.now(),
      level,
      category,
      message: redact(message),
      detail: Object.keys(safe).length ? safe : undefined,
    };
    this.entries.push(entry);
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
    if (this.echo) {
      const line = `${new Date(entry.at).toISOString()} ${level.toUpperCase().padEnd(5)} ${category.padEnd(9)} ${entry.message}`;
      if (level === "error") console.error(line);
      else console.log(line);
    }
    return entry;
  }

  debug = (c: LogCategory, m: string, d?: Record<string, unknown>) => this.write("debug", c, m, d);
  info = (c: LogCategory, m: string, d?: Record<string, unknown>) => this.write("info", c, m, d);
  warn = (c: LogCategory, m: string, d?: Record<string, unknown>) => this.write("warn", c, m, d);
  error = (c: LogCategory, m: string, d?: Record<string, unknown>) => this.write("error", c, m, d);

  search(filter: { category?: LogCategory; level?: LogLevel; text?: string; limit?: number } = {}): LogEntry[] {
    const { category, level, text, limit = 200 } = filter;
    const needle = text?.toLowerCase();
    const found: LogEntry[] = [];
    for (let i = this.entries.length - 1; i >= 0 && found.length < limit; i -= 1) {
      const entry = this.entries[i];
      if (category && entry.category !== category) continue;
      if (level && entry.level !== level) continue;
      if (needle && !`${entry.message} ${JSON.stringify(entry.detail ?? {})}`.toLowerCase().includes(needle)) continue;
      found.push(entry);
    }
    return found;
  }

  counts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const entry of this.entries) counts[entry.category] = (counts[entry.category] ?? 0) + 1;
    return counts;
  }

  asText(limit = 2000): string {
    return this.entries
      .slice(-limit)
      .map((e) => `${new Date(e.at).toISOString()} ${e.level.toUpperCase().padEnd(5)} ${e.category.padEnd(9)} ${e.message}${e.detail ? ` ${JSON.stringify(e.detail)}` : ""}`)
      .join("\n");
  }
}

export const log = new Logger();

/* -------------------------------------------------------------- event bus -- */

export type OsEvent = {
  topic: string;
  at: number;
  from: string;
  payload: unknown;
};

/**
 * The OS-wide message bus.
 *
 * §23 requires AI processes to be able to talk to one another through an
 * internal bus, and the rest of the OS needs the same thing — the network
 * manager announces an interface change, the supervisor announces a service
 * restart, and whoever cares reacts. Rather than two mechanisms, there is one
 * bus, with a subscription table and a bounded history so a late subscriber can
 * still see what just happened.
 */
export class EventBus {
  private listeners = new Map<string, Set<(event: OsEvent) => void>>();
  private history: OsEvent[] = [];
  private readonly historyLimit: number;
  private sent = 0;

  constructor(historyLimit = 500) {
    this.historyLimit = historyLimit;
  }

  /** Publish. `topic` may be exact ("net.up") or a prefix ("net.*"). */
  publish(topic: string, from: string, payload: unknown = null): OsEvent {
    const event: OsEvent = { topic, at: Date.now(), from, payload };
    this.sent += 1;
    this.history.push(event);
    if (this.history.length > this.historyLimit) this.history.shift();

    for (const [pattern, subscribers] of this.listeners) {
      if (!matches(pattern, topic)) continue;
      for (const subscriber of subscribers) {
        try {
          subscriber(event);
        } catch (error) {
          // A broken subscriber must never break the publisher.
          log.warn("diag", "A bus subscriber threw.", { pattern, error: error instanceof Error ? error.message : String(error) });
        }
      }
    }
    return event;
  }

  subscribe(pattern: string, listener: (event: OsEvent) => void): () => void {
    const subscribers = this.listeners.get(pattern) ?? new Set();
    subscribers.add(listener);
    this.listeners.set(pattern, subscribers);
    return () => {
      subscribers.delete(listener);
      if (!subscribers.size) this.listeners.delete(pattern);
    };
  }

  /** Wait for one event matching a pattern, or reject on timeout. */
  once(pattern: string, timeoutMs = 10_000): Promise<OsEvent> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`Waited ${timeoutMs} ms for ${pattern} and nothing arrived.`));
      }, timeoutMs);
      const unsubscribe = this.subscribe(pattern, (event) => {
        clearTimeout(timer);
        unsubscribe();
        resolve(event);
      });
    });
  }

  recent(pattern?: string, limit = 100): OsEvent[] {
    const events = pattern ? this.history.filter((event) => matches(pattern, event.topic)) : this.history;
    return events.slice(-limit);
  }

  stats(): { sent: number; retained: number; patterns: number; subscribers: number } {
    let subscribers = 0;
    for (const set of this.listeners.values()) subscribers += set.size;
    return { sent: this.sent, retained: this.history.length, patterns: this.listeners.size, subscribers };
  }
}

/** "net.*" matches "net.up"; an exact pattern matches only itself. */
function matches(pattern: string, topic: string): boolean {
  if (pattern === topic) return true;
  if (pattern.endsWith(".*")) return topic.startsWith(pattern.slice(0, -1));
  if (pattern === "*") return true;
  return false;
}

export const bus = new EventBus();

/* ------------------------------------------------------------------ config -- */

export type OsConfig = {
  system: { hostname: string; timezone: string; locale: string; autoStartServices: boolean };
  net: { dhcp: boolean; address: string | null; gateway: string | null; dns: string[] };
  vpn: { enabled: boolean; provider: string; configPath: string | null; killSwitch: boolean };
  firewall: { enabled: boolean; defaultInbound: "drop" | "accept"; allowLan: boolean };
  web: { httpPort: number; httpsPort: number; tlsCert: string | null; tlsKey: string | null };
  ai: { modelStore: string; activeModel: string | null; autoLoad: boolean; allowSelfModification: boolean };
  comms: { displayName: string; stunServers: string[]; turnServer: string | null };
  update: { channel: "stable" | "testing"; feed: string | null; autoCheck: boolean; autoInstall: false };
};

const DEFAULTS: OsConfig = {
  system: { hostname: hostname(), timezone: "UTC", locale: "C", autoStartServices: true },
  net: { dhcp: true, address: null, gateway: null, dns: [] },
  vpn: { enabled: false, provider: "wireguard", configPath: null, killSwitch: false },
  firewall: { enabled: true, defaultInbound: "drop", allowLan: true },
  web: { httpPort: 8080, httpsPort: 8443, tlsCert: null, tlsKey: null },
  ai: { modelStore: "", activeModel: null, autoLoad: false, allowSelfModification: false },
  comms: { displayName: "Operator", stunServers: ["stun:stun.l.google.com:19302"], turnServer: null },
  update: { channel: "stable", feed: null, autoCheck: true, autoInstall: false },
};

/** One file per section, written atomically, so a crash cannot corrupt the rest. */
export class ConfigStore {
  private cache = new Map<string, unknown>();

  get<K extends keyof OsConfig>(section: K): OsConfig[K] {
    const cached = this.cache.get(section);
    if (cached !== undefined) return cached as OsConfig[K];
    const file = join(ensureOsPaths().config, `${String(section)}.json`);
    let loaded: OsConfig[K] = DEFAULTS[section];
    if (existsSync(file)) {
      try {
        loaded = { ...DEFAULTS[section], ...(JSON.parse(readFileSync(file, "utf8")) as object) } as OsConfig[K];
      } catch {
        log.warn("diag", `The ${String(section)} configuration could not be read; using defaults.`);
      }
    }
    this.cache.set(section, loaded);
    return loaded;
  }

  set<K extends keyof OsConfig>(section: K, value: OsConfig[K]): OsConfig[K] {
    const file = join(ensureOsPaths().config, `${String(section)}.json`);
    const temporary = `${file}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(temporary, file);
    this.cache.set(section, value);
    bus.publish(`config.${String(section)}`, "config", value);
    return value;
  }

  patch<K extends keyof OsConfig>(section: K, change: Partial<OsConfig[K]>): OsConfig[K] {
    return this.set(section, { ...this.get(section), ...change } as OsConfig[K]);
  }

  all(): OsConfig {
    return Object.fromEntries(
      (Object.keys(DEFAULTS) as (keyof OsConfig)[]).map((section) => [section, this.get(section)]),
    ) as OsConfig;
  }
}

export const config = new ConfigStore();

/** What the OS says it is, in one line, for every report. */
export function osVersionLine(): string {
  return `${OS_NAME} OS ${OS_RELEASE.version} (build ${OS_RELEASE.build}, ${OS_RELEASE.date}, ${OS_RELEASE.kernelSeries} kernel series, ${process.platform}/${process.arch})`;
}
