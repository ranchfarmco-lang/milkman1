/**
 * §46 Configuration storage.
 *
 * The specification asks for the settings to be kept apart rather than in one
 * blob: user settings, network settings, server settings, security settings,
 * device pairings, application state and logs. Each section is its own JSON
 * file under SUGAR's home directory, so one corrupt file cannot take the rest
 * with it, and a section is readable on its own.
 *
 * Nothing secret is stored here — no passwords, no session tokens, no private
 * keys. Secrets go to `native/storage/secrets.ts`, which uses the operating
 * system's own credential store. This module refuses to write a field whose
 * name looks like a credential, so the rule survives future edits.
 */

import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ensurePaths } from "../core/paths.ts";
import { log } from "../core/log.ts";
import { RELEASE } from "../core/version.ts";

export type NetworkSettings = {
  /** Port the local server should prefer. 0 means "any free port". */
  preferredPort: number;
  /** Bind on the LAN address as well as loopback. */
  allowLan: boolean;
  /** Probe interval for the network-change monitor, in seconds. */
  monitorSeconds: number;
};

export type ServerSettings = {
  /** The port that was actually chosen last time. */
  port: number | null;
  /** Whether a background service should keep the host running (§28). */
  backgroundService: boolean;
};

export type SecuritySettings = {
  /** Require authentication for the remote portal (§17). */
  requireAuth: boolean;
  /** Minutes a session stays valid. */
  sessionMinutes: number;
  /** Failed sign-ins before a lockout. */
  maxAttempts: number;
  /** Minutes of lockout after too many failures. */
  lockoutMinutes: number;
  /** Only serve the remote portal over TLS when a tunnel provides it. */
  httpsOnlyRemote: boolean;
};

export type UserSettings = {
  /** Beginner mode explains in plain sentences (§23); advanced shows the numbers (§24). */
  mode: "beginner" | "advanced";
  /** Tunnel provider id the user picked (§15). */
  tunnelProvider: string;
  /** The relay URL that provider should use, when it needs one. */
  relayUrl: string | null;
};

export type ApplicationState = {
  /** Whether the first-run wizard has completed (§62). */
  firstRunComplete: boolean;
  /** §63 — what the wizard last concluded. */
  firstRunResult: "READY" | "READY LOCALLY — REMOTE ACCESS NEEDS CONFIGURATION" | "ACTION REQUIRED" | "NOT RUN";
  /** Version that last started, so an upgrade can be noticed. */
  lastVersion: string | null;
  /** Timestamp of the last clean start, for uptime and recovery reporting. */
  lastStart: number | null;
};

export type DevicePairing = {
  id: string;
  /** What the user called it, e.g. "Sam's iPhone". */
  label: string;
  /** Hash of the long-lived pairing secret — never the secret itself. */
  secretHash: string;
  /** Short, single-use code, already consumed or expired when the hash exists. */
  pairedAt: number;
  lastSeen: number | null;
  revoked: boolean;
};

export type ConfigShape = {
  user: UserSettings;
  network: NetworkSettings;
  server: ServerSettings;
  security: SecuritySettings;
  state: ApplicationState;
  devices: DevicePairing[];
};

const DEFAULTS: ConfigShape = {
  user: { mode: "beginner", tunnelProvider: "relay", relayUrl: null },
  network: { preferredPort: 8123, allowLan: true, monitorSeconds: 15 },
  server: { port: null, backgroundService: false },
  security: {
    requireAuth: true,
    sessionMinutes: 720,
    maxAttempts: 5,
    lockoutMinutes: 15,
    httpsOnlyRemote: true,
  },
  state: {
    firstRunComplete: false,
    firstRunResult: "NOT RUN",
    lastVersion: null,
    lastStart: null,
  },
  devices: [],
};

const CREDENTIAL_NAME = /password|passwd|secret|token|privatekey|private_key|credential|apikey|api_key/i;

type Section = keyof ConfigShape;
const SECTIONS: Section[] = ["user", "network", "server", "security", "state", "devices"];

function sectionFile(section: Section): string {
  return join(ensurePaths().config, `${section}.json`);
}

/** Refuse to write anything that looks like a secret into a config file. */
function assertNoSecrets(section: Section, value: unknown, path: string = section): void {
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (CREDENTIAL_NAME.test(key)) {
      throw new Error(
        `Refusing to write ${path}.${key} to a configuration file: credentials belong in the OS keychain (§46).`,
      );
    }
    if (child && typeof child === "object") assertNoSecrets(section, child, `${path}.${key}`);
  }
}

/**
 * Writes are atomic: a temporary file is renamed over the target, so a crash
 * mid-write leaves the previous good file rather than half of a new one.
 */
function writeSection<T>(section: Section, value: T): void {
  assertNoSecrets(section, value);
  const target = sectionFile(section);
  const temporary = `${target}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, target);
}

function readSection<T>(section: Section, fallback: T): T {
  const target = sectionFile(section);
  if (!existsSync(target)) return fallback;
  try {
    const parsed = JSON.parse(readFileSync(target, "utf8")) as T;
    return parsed ?? fallback;
  } catch (error) {
    // A damaged section is reported and replaced by the default — the other
    // sections keep working, which is the reason for splitting them up.
    log.warn("application", `Config section "${section}" could not be read; using defaults.`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return fallback;
  }
}

export class ConfigStore {
  /** One slot per section. A Map keeps the indexing honest across the union. */
  private cache = new Map<Section, unknown>();

  get<K extends Section>(section: K): ConfigShape[K] {
    const existing = this.cache.get(section);
    if (existing !== undefined) return existing as ConfigShape[K];
    const loaded = readSection<ConfigShape[K]>(section, DEFAULTS[section]);
    this.cache.set(section, loaded);
    return loaded;
  }

  set<K extends Section>(section: K, value: ConfigShape[K]): ConfigShape[K] {
    writeSection(section, value);
    this.cache.set(section, value);
    return value;
  }

  /** Merge a partial change into a section and persist it. */
  patch<K extends Section>(section: K, change: Partial<ConfigShape[K]>): ConfigShape[K] {
    const next = { ...this.get(section), ...change } as ConfigShape[K];
    return this.set(section, next as ConfigShape[K]);
  }

  /** Every section at once, for the diagnostics export and the API. */
  all(): ConfigShape {
    return Object.fromEntries(SECTIONS.map((s) => [s, this.get(s)])) as ConfigShape;
  }

  /** Record this start, so uptime and upgrades can be reported honestly. */
  markStart(): ApplicationState {
    return this.patch("state", {
      lastStart: Date.now(),
      lastVersion: RELEASE.version,
    });
  }

  /** The config files on disk, for the download of a support bundle. */
  files(): { section: Section; path: string; exists: boolean }[] {
    return SECTIONS.map((section) => ({
      section,
      path: sectionFile(section),
      exists: existsSync(sectionFile(section)),
    }));
  }
}

export const config = new ConfigStore();
export { DEFAULTS as CONFIG_DEFAULTS };
