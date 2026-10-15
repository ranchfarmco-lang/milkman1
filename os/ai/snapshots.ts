/**
 * NOVA OS snapshots (§26).
 *
 * §25 and §26 together ask for something specific: before the system changes
 * itself, there must be a way back. This is that way, and it is deliberately
 * simple so it can be trusted:
 *
 *   · a snapshot copies the named files into a versioned directory, keeping
 *     their contents and a SHA-256 of each;
 *   · `restore` puts them back byte for byte and reports every file it touched,
 *     including files it had to delete because they were absent when the
 *     snapshot was taken;
 *   · the history is kept, so you can see what was taken and when, and restore
 *     an older one;
 *   · entries are pruned by count, not by guesswork, and a restore of a snapshot
 *     that has been pruned says so rather than restoring nothing.
 *
 * Snapshots here are of the OS's own configuration and system trees — the parts
 * an AI-driven change touches. A whole-disk snapshot is the filesystem's job on
 * the image (the build system configures the root as btrfs precisely so that is
 * cheap), and this component names that rather than claiming to do it.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { ensureOsPaths, log, bus, type ComponentStatus, type OsComponent } from "../core/runtime.ts";

export type SnapshotEntry = {
  /** The absolute path this file was taken from. */
  source: string;
  /** Its path inside the snapshot. */
  stored: string;
  bytes: number;
  sha256: string;
  existed: boolean;
};

export type Snapshot = {
  id: string;
  label: string;
  at: number;
  entries: SnapshotEntry[];
  totalBytes: number;
};

const MANIFEST = "snapshot.json";

function digest(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export class SnapshotStore implements OsComponent {
  readonly name: string;
  readonly about: string;
  readonly requires: string[] = [];

  private current: ComponentStatus = "stopped";
  private maxSnapshots: number;

  constructor(private readonly scope: string, options: { maxSnapshots?: number } = {}) {
    this.name = `snapshots:${scope}`;
    this.about = `Snapshots and rollback for the ${scope} tree, with version history.`;
    this.maxSnapshots = options.maxSnapshots ?? 25;
  }

  status(): ComponentStatus {
    return this.current;
  }

  async start(): Promise<void> {
    this.current = "running";
    mkdirSync(this.dir(), { recursive: true });
  }

  async stop(): Promise<void> {
    this.current = "stopped";
  }

  private dir(): string {
    return join(ensureOsPaths().snapshots, this.scope);
  }

  /**
   * Take a snapshot of the given files (absolute paths, or paths under the OS
   * data tree). A file that does not exist is recorded as absent, so restoring
   * removes it — that is what makes a restore a true rollback.
   */
  create(label: string, paths: string[]): Snapshot {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const at = Date.now();
    const base = ensureOsPaths().data;
    const entries: SnapshotEntry[] = [];
    let totalBytes = 0;

    for (const path of paths) {
      const absolute = resolve(path.startsWith("/") ? path : join(base, path));
      const stored = `files/${relative(base, absolute).replace(/\.\./g, "outside").replace(/^\//, "")}`;
      if (!existsSync(absolute)) {
        entries.push({ source: absolute, stored, bytes: 0, sha256: "", existed: false });
        continue;
      }
      const bytes = readFileSync(absolute);
      const target = join(this.dir(), id, stored);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, bytes);
      entries.push({ source: absolute, stored, bytes: bytes.byteLength, sha256: digest(bytes), existed: true });
      totalBytes += bytes.byteLength;
    }

    const snapshot: Snapshot = { id, label, at, entries, totalBytes };
    const manifestPath = join(this.dir(), id, MANIFEST);
    mkdirSync(join(manifestPath, ".."), { recursive: true });
    writeFileSync(manifestPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");

    this.prune();
    log.info("diag", `Snapshot ${id} taken: "${label}" with ${entries.length} file(s).`);
    bus.publish("snapshot.created", this.scope, { id, label, entries: entries.length });
    return snapshot;
  }

  /** Newest first. */
  history(): Snapshot[] {
    const dir = this.dir();
    if (!existsSync(dir)) return [];
    const found: Snapshot[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "staging") continue;
      const manifest = join(dir, entry.name, MANIFEST);
      if (!existsSync(manifest)) continue;
      try {
        found.push(JSON.parse(readFileSync(manifest, "utf8")) as Snapshot);
      } catch {
        log.warn("diag", `Snapshot ${entry.name} has an unreadable manifest.`);
      }
    }
    return found.sort((a, b) => b.at - a.at);
  }

  get(id: string): Snapshot | null {
    return this.history().find((entry) => entry.id === id) ?? null;
  }

  /**
   * Put the files back. Returns exactly which paths changed, so a caller can
   * show what a rollback did rather than just asserting it worked.
   */
  restore(id: string): { ok: boolean; restored: string[]; removed: string[]; detail: string } {
    const snapshot = this.get(id);
    if (!snapshot) return { ok: false, restored: [], removed: [], detail: `There is no snapshot called "${id}" — it may have been pruned by the retention limit.` };

    const restored: string[] = [];
    const removed: string[] = [];
    for (const entry of snapshot.entries) {
      const source = join(this.dir(), snapshot.id, entry.stored);
      if (!entry.existed) {
        if (existsSync(entry.source)) {
          rmSync(entry.source, { force: true });
          removed.push(entry.source);
        }
        continue;
      }
      if (!existsSync(source)) {
        return { ok: false, restored, removed, detail: `Snapshot ${id} is incomplete: ${entry.stored} is missing.` };
      }
      const bytes = readFileSync(source);
      if (digest(bytes) !== entry.sha256) {
        return { ok: false, restored, removed, detail: `Snapshot ${id} has been altered: ${entry.stored} does not match its checksum.` };
      }
      mkdirSync(join(entry.source, ".."), { recursive: true });
      writeFileSync(entry.source, bytes);
      restored.push(entry.source);
    }

    log.warn("diag", `Snapshot ${id} restored: ${restored.length} file(s) put back, ${removed.length} removed.`);
    bus.publish("snapshot.restored", this.scope, { id, restored: restored.length, removed: removed.length });
    return { ok: true, restored, removed, detail: `Restored ${restored.length} file(s) and removed ${removed.length} that the snapshot did not contain.` };
  }

  delete(id: string): boolean {
    const dir = join(this.dir(), id);
    if (!existsSync(dir)) return false;
    rmSync(dir, { recursive: true, force: true });
    return true;
  }

  /** Keep the newest N; drop the rest. Counted, not timed, so it is predictable. */
  private prune(): { removed: string[] } {
    const history = this.history();
    const removed: string[] = [];
    for (const snapshot of history.slice(this.maxSnapshots)) {
      if (this.delete(snapshot.id)) removed.push(snapshot.id);
    }
    return { removed };
  }

  /** How much space the snapshots take, measured from disk. */
  usage(): { snapshots: number; bytes: number } {
    const snapshots = this.history();
    let bytes = 0;
    const walk = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else bytes += statSync(full).size;
      }
    };
    walk(this.dir());
    return { snapshots: snapshots.length, bytes };
  }

  capability() {
    return {
      available: [
        "Content-addressed snapshots of named files, with per-file SHA-256.",
        "Restore that returns the exact paths put back and the paths removed.",
        "Refusal to restore from a snapshot whose contents no longer match its checksums.",
        "Version history with count-based retention.",
      ],
      blocked: [
        {
          what: "A whole-disk, point-in-time snapshot",
          why: "That is the filesystem's job below userspace, not something a process can do portably from above it.",
          fallback: "The image root is configured as btrfs in os/build precisely so whole-system snapshots are a filesystem feature; this component snapshots the OS configuration and system trees, which is what an AI-driven change actually modifies.",
        },
      ],
    };
  }
}

export { statSync };
