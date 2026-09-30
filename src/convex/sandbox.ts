/**
 * The workshop: a real machine, out on Daytona, that the builder codes on.
 *
 * Everything else in this app runs on Convex, which has no filesystem and no
 * shell. `workspace.ts` is a filesystem made out of documents and
 * `self_source.ts` is a read-only copy of this app's own source — and neither
 * of them can *run* anything. This is the other half: a sandbox with a real
 * shell, a real filesystem and the network, so the AI Builder can write a file,
 * execute it, read the actual output and fix what broke, instead of describing
 * what should happen.
 *
 * Nothing here is required. With no `DAYTONA_API_KEY`, or with Daytona
 * unreachable, every function answers null/false, every caller falls back to
 * what it did before, and the app behaves exactly as it does today.
 *
 * Two bases are at work, both documented at https://daytona.io/docs:
 *  - the control plane (`/sandbox`) which creates, finds and starts a sandbox;
 *  - the toolbox (`…/toolbox/{id}`) which executes commands inside one and
 *    moves files in and out of it.
 */

import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import {
  action,
  internalAction,
  internalQuery,
  query,
} from "./_generated/server";
import { SELF_SOURCE } from "./self_source";

const DEFAULT_API = "https://app.daytona.io/api";
const DEFAULT_TOOLBOX = "https://proxy.app.daytona.io/toolbox";

/** Enough to find our own sandbox again, and nothing that identifies anyone. */
const NAMES = { app: "family-hub", role: "workshop" };
const SANDBOX_NAME = "family-hub-workshop";

/**
 * 2 vCPU, 4GiB memory, 8GiB disk. `daytona-small` runs commands perfectly well,
 * but its 1GiB of memory is thin for installing packages and typechecking a real
 * project, which is the whole point of the workshop. Override with
 * `DAYTONA_SNAPSHOT` if you would rather trade speed for headroom.
 */
const DEFAULT_SNAPSHOT = "daytona-medium";

function snapshot() {
  return (process.env.DAYTONA_SNAPSHOT ?? "").trim() || DEFAULT_SNAPSHOT;
}

/** Where things live inside the sandbox, relative to its home directory. */
const ROOT = "workshop";
const RUN_ROOT = "runs";

/**
 * `$HOME/workshop` is not a scratch folder — it is a replica of this app.
 *
 * Every file of the running app is written into it (`seed`), and every file the
 * AI Builder puts on its bench is mirrored in (`mirror`) so that a patched copy
 * of one of ours is the version standing. That is what makes the workshop safe
 * to break: it is another machine and another tree from the hub anyone is
 * actually using, so a change that will not compile takes down a copy and
 * nothing else, and the family never sees it.
 *
 * Three files in the replica's own root are about the replica rather than part
 * of it, and they are the whole reason a build can say what it changed:
 *
 *   .seeded     the fingerprint of the app version it was written from
 *   .manifest   an md5 of every file as it was seeded
 *   .deps       the package.json the installed node_modules belong to
 */
const SEEDED = ".seeded";
const MANIFEST = ".manifest";
const DEPS = ".deps";

/**
 * What is in a replica that is not the app, and so is never part of the
 * comparison: the packages that were installed into it, the scratch a program
 * ran in, whatever a build left behind, and the three files above.
 */
const NOT_APP = [
  "-not -path './node_modules/*'",
  "-not -path './runs/*'",
  "-not -path './dist/*'",
  "-not -path './.git/*'",
  `-not -name '${MANIFEST}'`,
  `-not -name '${DEPS}'`,
  `-not -name '${SEEDED}'`,
].join(" ");

const CALL_TIMEOUT_MS = 25_000;
const RUN_TIMEOUT_S = 60;

/**
 * How long a shell command may take. Longer than a program, because the reason
 * to reach for a shell is the work around the program: installing, building,
 * typechecking, running a whole test suite.
 */
const SHELL_TIMEOUT_S = 240;
const MAX_FILE_CHARS = 200_000;

/** One shell command cannot carry the world, so files go up in pieces. */
const CHUNK_CHARS = 24_000;

export type CommandResult = {
  ok: boolean;
  output: string;
  exitCode: number | null;
};

function apiKey() {
  return (process.env.DAYTONA_API_KEY ?? "").trim();
}

function apiBase() {
  const configured = (process.env.DAYTONA_SERVER_URL ?? "").trim();
  return (configured || DEFAULT_API).replace(/\/+$/, "");
}

/**
 * Where commands are actually sent. Normally the public toolbox proxy; a
 * self-hosted Daytona sets `DAYTONA_TOOLBOX_URL` and this follows it.
 */
function toolboxBase() {
  const configured = (process.env.DAYTONA_TOOLBOX_URL ?? "").trim();
  return (configured || DEFAULT_TOOLBOX).replace(/\/+$/, "");
}

/** Is there a workshop to talk to at all? */
export function connected(): boolean {
  return apiKey().length > 0;
}

/* ------------------------------------------------------------- the plumbing */

type Reply = {
  ok: boolean;
  status: number;
  text: string;
};

/** One request, with a timeout, and never an exception — only a bad reply. */
async function send(
  url: string,
  init: RequestInit = {},
  timeoutMs = CALL_TIMEOUT_MS,
): Promise<Reply> {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...init,
      signal: stop.signal,
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        ...(init.headers ?? {}),
      },
    });

    return { ok: response.ok, status: response.status, text: await response.text() };
  } catch (caught) {
    return {
      ok: false,
      status: 0,
      text: caught instanceof Error ? caught.message : "network error",
    };
  } finally {
    clearTimeout(timer);
  }
}

function asJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function firstId(value: unknown): string | null {
  const one = Array.isArray(value) ? value[0] : value;
  if (!one || typeof one !== "object") return null;
  const id = (one as { id?: unknown }).id;
  return typeof id === "string" && id ? id : null;
}

/* ---------------------------------------------------------------- the sandbox */

let remembered: string | null = null;

/**
 * Is this sandbox still there — and awake?
 *
 * A sandbox puts itself to sleep after fifteen minutes of quiet, which is most
 * of the gap between two turns of a conversation, so "still there" is rarely
 * the whole question. Starting it here costs one request when it is already up,
 * and spares a command that was only ever going to fail.
 */
async function ready(id: string): Promise<boolean> {
  const reply = await send(`${apiBase()}/sandbox/${id}`);
  if (!reply.ok) return false;

  const state = (asJson(reply.text) as { state?: unknown } | null)?.state;
  if (typeof state === "string" && state !== "started") await wake(id);

  return true;
}

/** The workshop we already made, if it is still there. */
async function find(): Promise<string | null> {
  const reply = await send(`${apiBase()}/sandbox`);
  if (!reply.ok) return null;

  const parsed = asJson(reply.text);
  const rows = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { items?: unknown })?.items)
      ? ((parsed as { items: unknown[] }).items ?? [])
      : [];

  const mine = rows.filter((row) => {
    if (!row || typeof row !== "object") return false;
    const one = row as { name?: unknown; labels?: unknown };
    if (one.name === SANDBOX_NAME) return true;
    if (!one.labels || typeof one.labels !== "object") return false;
    const labels = one.labels as Record<string, unknown>;
    return labels.app === NAMES.app && labels.role === NAMES.role;
  });

  // Only by name or label, never "the only one there is": a hub has exactly
  // one workshop, but the account may hold other people's sandboxes, and
  // seizing one of those would be both wrong and destructive.
  return firstId(mine[0]);
}

async function create(): Promise<string | null> {
  const labelled = await send(`${apiBase()}/sandbox`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      snapshot: snapshot(),
      name: SANDBOX_NAME,
      labels: NAMES,
    }),
  });

  if (labelled.ok) return firstId(asJson(labelled.text));

  // Older builds of the API take a snapshot and nothing else.
  const plain = await send(`${apiBase()}/sandbox`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ snapshot: snapshot() }),
  });

  if (plain.ok) return firstId(asJson(plain.text));

  // A sandbox of that name may already exist, which the API refuses rather
  // than handing back. Look once more before giving up on it.
  return find();
}

/** Start one that has gone to sleep. Harmless when it never did. */
async function wake(id: string) {
  await send(`${apiBase()}/sandbox/${id}/start`, { method: "POST" });
}

/** The workshop's id, made on first use and reused after that. */
async function workshop(): Promise<string | null> {
  if (!connected()) return null;
  if (remembered && (await ready(remembered))) return remembered;

  // One we find again is very likely asleep, since that is what it does after
  // fifteen minutes of quiet, so it is woken before anything is sent to it.
  // One we have just made is already up.
  const found = await find();
  if (found) await ready(found);

  remembered = found ?? (await create());
  return remembered;
}

/* ------------------------------------------------------------------ the shell */

function quote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The workshop, as an absolute path with the sandbox's home directory filled
 * in. Double quotes, not single: the point is for `$HOME` to expand. That is
 * safe here and only here because `cleanPath` has already thrown away every
 * character the shell could act on.
 */
const HOME = '"$HOME"';

/**
 * Folders this isolate has already made, so the common case is one request.
 * Losing the set is harmless — it only means one redundant `mkdir`.
 */
const made = new Set<string>();

/**
 * Make a folder for a command to run in.
 *
 * The toolbox refuses a `cwd` that is not there: it execs a shell that the
 * stock image does not carry and the whole command dies with `fork/exec
 * /usr/bin/zsh: no such file or directory`, which reads like a broken sandbox
 * and is really just a missing folder. So the folder is created first.
 */
async function mkdir(id: string, folder: string) {
  const key = `${id}:${folder}`;
  if (made.has(key)) return;

  const reply = await send(
    `${toolboxBase()}/${id}/process/execute`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: `mkdir -p ${HOME}/${folder}` }),
    },
    30_000,
  );

  // Only remembered once it actually worked, so a failure is retried rather
  // than cached into every later command.
  if (reply.ok) made.add(key);
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Base64 of a UTF-8 string, written out by hand: this runtime is not Node, so
 * there is no Buffer to reach for, and a file has to survive the shell. Base64
 * uses no character the shell treats specially, which is the point.
 */
function toBase64(text: string) {
  const bytes: number[] = [];

  for (let index = 0; index < text.length; index += 1) {
    let code = text.charCodeAt(index);

    if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        index += 1;
      }
    }

    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    else if (code < 0x10000) {
      bytes.push(
        0xe0 | (code >> 12),
        0x80 | ((code >> 6) & 63),
        0x80 | (code & 63),
      );
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 63),
        0x80 | ((code >> 6) & 63),
        0x80 | (code & 63),
      );
    }
  }

  let out = "";
  for (let at = 0; at < bytes.length; at += 3) {
    const triple =
      (bytes[at] << 16) | ((bytes[at + 1] ?? 0) << 8) | (bytes[at + 2] ?? 0);
    out += B64[(triple >> 18) & 63] + B64[(triple >> 12) & 63];
    out += at + 1 < bytes.length ? B64[(triple >> 6) & 63] : "=";
    out += at + 2 < bytes.length ? B64[triple & 63] : "=";
  }

  return out;
}

/** A path that can only mean one thing, whatever the model wrote. */
function cleanPath(raw: string) {
  const parts: string[] = [];
  for (const segment of raw.trim().replace(/\\/g, "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      parts.pop();
      continue;
    }
    parts.push(segment.replace(/[^A-Za-z0-9._@+-]/g, "_").slice(0, 80));
  }
  return parts.join("/").slice(0, 200);
}

/** Run one shell command inside the workshop. */
export async function run(
  command: string,
  options: { cwd?: string; timeoutSeconds?: number } = {},
): Promise<CommandResult | null> {
  const id = await workshop();
  if (!id) return null;

  const folder = options.cwd ? cleanPath(options.cwd) : "";
  if (folder) await mkdir(id, folder);

  const body = JSON.stringify({
    command,
    cwd: folder || undefined,
    timeout: options.timeoutSeconds ?? RUN_TIMEOUT_S,
  });

  const call = () =>
    send(`${toolboxBase()}/${id}/process/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    }, (options.timeoutSeconds ?? RUN_TIMEOUT_S) * 1000 + 15_000);

  let reply = await call();
  if (!reply.ok && reply.status >= 400) {
    // Most likely it was asleep: wake it and ask once more.
    await wake(id);
    reply = await call();
  }

  if (!reply.ok) return null;

  const parsed = asJson(reply.text) as {
    result?: unknown;
    exitCode?: unknown;
    exit_code?: unknown;
  } | null;

  const output =
    parsed && typeof parsed.result === "string" ? parsed.result : reply.text;
  const code = parsed?.exitCode ?? parsed?.exit_code;

  return {
    ok: true,
    output,
    exitCode: typeof code === "number" ? code : null,
  };
}

/* ----------------------------------------------------------------- the files */

/**
 * The shell steps that put one file where it belongs, and how much command they
 * take up. Split out from `writeFile` because a re-seed writes hundreds of
 * files and they belong in the same handful of commands, not one each.
 *
 * Every file is written by absolute path with the home directory spelled out,
 * so nothing depends on where a command happens to start, and the contents ride
 * as base64 so a file can hold anything at all without the shell acting on it.
 */
function writeSteps(path: string, content: string) {
  const clean = cleanPath(path);
  if (!clean) return null;

  const encoded = toBase64(content.slice(0, MAX_FILE_CHARS));
  const pieces: string[] = [];
  for (let at = 0; at < encoded.length; at += CHUNK_CHARS) {
    pieces.push(encoded.slice(at, at + CHUNK_CHARS));
  }

  const full = `${HOME}/${cleanPath(ROOT)}/${clean}`;
  const folder = full.slice(0, full.lastIndexOf("/"));

  return {
    size: encoded.length,
    steps: [
      `mkdir -p ${folder}`,
      ...pieces.map(
        (piece, index) =>
          `printf %s ${quote(piece)} | base64 -d ${index === 0 ? ">" : ">>"} ${full}`,
      ),
    ],
  };
}

/** Write one file, in one command when it fits and in pieces when it does not. */
export async function writeFile(path: string, content: string): Promise<boolean> {
  const one = writeSteps(path, content);
  if (!one) return false;

  const done = await run(one.steps.join(" && "), { timeoutSeconds: 30 });
  return done !== null;
}

/**
 * How large one command may get before it is cut and the next one started.
 *
 * The app is a couple of megabytes of source and base64 makes it larger still,
 * and a single request that big is a request that gets refused — but a file at
 * a time is 262 round trips, which is minutes of nothing on every re-seed. This
 * is the middle: as many files as one command will hold.
 */
const BATCH_CHARS = 400_000;

/**
 * Write many files in as few commands as the shell will take, and say how many
 * landed. Best-effort like `writeFile`: a batch that fails takes its own files
 * down with it and no others.
 */
async function writeMany(
  files: { path: string; content: string }[],
): Promise<number> {
  let written = 0;
  let steps: string[] = [];
  let held = 0;
  let size = 0;

  const flush = async () => {
    if (!steps.length) return;

    const done = await run(steps.join(" && "), { timeoutSeconds: 120 });
    if (done?.ok && done.exitCode === 0) written += held;

    steps = [];
    held = 0;
    size = 0;
  };

  for (const file of files) {
    const one = writeSteps(file.path, file.content);
    if (!one) continue;

    steps.push(...one.steps);
    held += 1;
    size += one.size;

    if (size >= BATCH_CHARS) await flush();
  }

  await flush();
  return written;
}

/** Read one file back out of the workshop. */
export async function readFile(path: string): Promise<string | null> {
  const id = await workshop();
  if (!id) return null;

  const clean = cleanPath(path);
  if (!clean) return null;

  const reply = await send(
    `${toolboxBase()}/${id}/files/download?path=${encodeURIComponent(
      `${cleanPath(ROOT)}/${clean}`,
    )}`,
  );

  return reply.ok ? reply.text : null;
}

/** Delete a file or a folder, inside the workshop only. */
export async function removeFile(path: string, recursive = false) {
  const id = await workshop();
  if (!id) return false;

  const clean = cleanPath(path);
  if (!clean) return false;

  const reply = await send(
    `${toolboxBase()}/${id}/files?path=${encodeURIComponent(
      `${cleanPath(ROOT)}/${clean}`,
    )}&recursive=${recursive}`,
    { method: "DELETE" },
  );

  return reply.ok;
}

/* ------------------------------------------------------- this app's own source */

/**
 * A fingerprint of everything in the snapshot. Built to change when any file's
 * name or contents change and to be cheap enough to compute on every write, so
 * a workshop seeded from last week's source does not silently stay that way.
 */
function snapshotPrint(): string {
  let hash = 0x811c9dc5;
  const names = Object.keys(SELF_SOURCE).sort();

  for (const name of names) {
    const text = `${name}\u0000${SELF_SOURCE[name]}\u0000`;
    for (let at = 0; at < text.length; at += 1) {
      hash ^= text.charCodeAt(at);
      hash = Math.imul(hash, 0x01000193);
    }
  }

  return `${names.length}-${(hash >>> 0).toString(16)}`;
}

/**
 * Put every file of the snapshot into the workshop, once per version of it.
 * The marker holds the fingerprint rather than a date, so editing this app
 * re-seeds the workshop on the next write instead of leaving the builder
 * reading and patching a copy that no longer matches what is running.
 */
export async function seed(): Promise<{ files: number; ok: boolean }> {
  const print = snapshotPrint();
  const marker = await readFile(SEEDED);
  if (marker !== null && marker.trim() === print) return { files: 0, ok: true };

  // A re-seed is a new version of the app arriving underneath a copy the
  // builder may already have changed. Its own work is kept — a file it has made
  // different is left exactly as it is right now — and every other file is
  // refreshed, so what stands in the replica afterwards is the running app plus
  // the builder's changes and nothing else. Without this, a deploy part-way
  // through a job would quietly undo everything the builder had done.
  const keep = new Set((await changed()) ?? []);
  const names = Object.keys(SELF_SOURCE).filter((name) => !keep.has(name));
  const files = await writeMany(
    names.map((name) => ({ path: name, content: SELF_SOURCE[name] })),
  );

  await writeFile(SEEDED, print);
  // After the files, never before: the manifest is what "unchanged" is measured
  // against, and writing it first would make every seeded file read as edited.
  await fingerprint();

  return { files, ok: files === names.length };
}

/** Throw the workshop away. The next call builds a fresh one. */
export async function destroy(): Promise<boolean> {
  const id = await workshop();
  if (!id) return false;

  const reply = await send(`${apiBase()}/sandbox/${id}`, { method: "DELETE" });
  remembered = null;
  return reply.ok;
}

/* ------------------------------------------------------- building the replica */

/** One command's worth of a build, and what came back. */
export type BuildStep = {
  name: string;
  ok: boolean;
  seconds: number;
  detail: string;
};

/** Everything a build found out, in one answer. */
export type BuildReport = {
  ok: boolean;
  steps: BuildStep[];
  /** How many files the replica was (re)written from, when it was. */
  seededFiles: number;
  /**
   * Files that are not what the app shipped — changed, or added. `null` means
   * the comparison itself could not be made.
   */
  changed: string[] | null;
  /** Set only when there was nothing to build on at all. */
  error?: string;
};

/**
 * Record an md5 of every file just seeded.
 *
 * `md5sum -c` against this is how "what has the duplicate changed?" is answered
 * — and doing it with the shell's own tools is deliberate: the same command
 * writes the manifest and reads it back, so there is one opinion about what a
 * file's fingerprint is rather than two.
 */
async function fingerprint(): Promise<number | null> {
  const result = await run(
    [
      `cd ${HOME}/${cleanPath(ROOT)}`,
      `find . -type f ${NOT_APP} | sort | sed 's|^\\./||' | while IFS= read -r f; do [ -f "$f" ] && md5sum "$f"; done > ${MANIFEST}`,
      `wc -l < ${MANIFEST}`,
    ].join(" && "),
    { timeoutSeconds: 150 },
  );

  if (!result?.ok || result.exitCode !== 0) return null;

  const counted = Number.parseInt(
    result.output.trim().split("\n").pop() ?? "",
    10,
  );
  return Number.isFinite(counted) ? counted : null;
}

/**
 * Every file in the replica that is not what the app shipped: one that has been
 * changed, and one that has been added since.
 *
 * This is the answer to the question the whole arrangement exists for — what did
 * the duplicate do differently from the real app — and it is worked out from the
 * tree rather than from a list of writes, so a file edited by hand in a shell is
 * caught exactly as surely as one written through the bench.
 */
async function changed(): Promise<string[] | null> {
  const result = await run(
    [
      // Nothing to compare against yet — the very first seed — leaves the
      // question unanswered rather than answered wrongly, so this stops before
      // it can list the sandbox's own home directory as if it were the app.
      `cd ${HOME}/${cleanPath(ROOT)} 2>/dev/null || exit 0`,
      `md5sum -c ${MANIFEST} 2>/dev/null | grep -v ': OK$' | sed 's/: *FAILED$//' > /tmp/hub-changed.txt`,
      `awk '{print $2}' ${MANIFEST} | sort > /tmp/hub-known.txt`,
      `find . -type f ${NOT_APP} | sed 's|^\\./||' | sort > /tmp/hub-have.txt`,
      `comm -13 /tmp/hub-known.txt /tmp/hub-have.txt >> /tmp/hub-changed.txt`,
      `sort -u /tmp/hub-changed.txt | head -40`,
    ].join(" ; "),
    { timeoutSeconds: 90 },
  );

  if (!result?.ok) return null;

  return result.output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 40);
}

/**
 * Give the replica its dependencies, once per version of its package.json.
 *
 * Without this a build cannot run at all: a fresh replica is source and nothing
 * else, so there is no `tsc` to run and the builder reads a wall of "command not
 * found" as though it had broken something. Installing is also the slowest
 * thing a build does, which is why it is the one thing skipped when it has
 * already been done — the marker holds the md5 of package.json, so a patched
 * package.json installs again and an untouched one does not.
 */
async function ensureDeps(): Promise<BuildStep> {
  const started = Date.now();
  const seconds = () => Math.round((Date.now() - started) / 1000);

  if (!(await ensureBun())) {
    return {
      name: "install",
      ok: false,
      seconds: seconds(),
      detail:
        "There is no Bun on the workshop machine and it would not install, so nothing can be installed or built in the replica.",
    };
  }

  const result = await run(
    [
      `cd ${HOME}/${cleanPath(ROOT)}`,
      `if [ ! -f package.json ]; then echo 'The replica has no package.json, so there is nothing to install.'; exit 3; fi`,
      `want=$(md5sum package.json | cut -d' ' -f1)`,
      `have=$(cat ${DEPS} 2>/dev/null || true)`,
      `if [ "$want" = "$have" ] && [ -d node_modules ]; then echo 'Already installed, for this exact package.json.'; exit 0; fi`,
      `${BUN} install 2>&1 | tail -n 15`,
      `echo "$want" > ${DEPS}`,
    ].join(" ; "),
    { timeoutSeconds: 210 },
  );

  if (!result) {
    return {
      name: "install",
      ok: false,
      seconds: seconds(),
      detail: "The workshop machine did not answer.",
    };
  }

  return {
    name: "install",
    ok: result.exitCode === 0,
    seconds: seconds(),
    detail: result.output.trim().slice(0, 2000) || "It printed nothing.",
  };
}

/** One command in the replica, reported the way a build step needs reporting. */
async function step(
  name: string,
  command: string,
  timeoutSeconds: number,
): Promise<BuildStep> {
  const started = Date.now();
  const result = await run(command, { cwd: ROOT, timeoutSeconds });
  const seconds = Math.round((Date.now() - started) / 1000);

  if (!result) {
    return {
      name,
      ok: false,
      seconds,
      detail: "The workshop machine did not answer.",
    };
  }

  const output = result.output.trim();
  if (!output) {
    return {
      name,
      ok: result.exitCode === 0,
      seconds,
      detail: `Exit code ${result.exitCode ?? "unknown"}, and it printed nothing.`,
    };
  }

  // Both ends of the output, because the two ways a build fails are at opposite
  // ends of it: a typecheck lists every error and then stops, while a bundler
  // prints what it was doing and puts the failure at the bottom.
  const detail =
    output.length > 4000
      ? `${output.slice(0, 2000)}\n\n…\n\n${output.slice(-2000)}`
      : output;

  return { name, ok: result.exitCode === 0, seconds, detail };
}

/**
 * Build the replica the way this app is built, and say what happened.
 *
 * The order is the order a person would use: seed it from the running app, give
 * it its dependencies, typecheck it, build it, and then say which files in it
 * are no longer the app's own. `quick` stops after the typecheck, which is the
 * check that settles most questions in a fraction of the time; reach for the
 * whole build when the change touches the bundler, an import that has to
 * resolve, or anything that only fails at the end.
 *
 * It never throws and it never touches the real app: a workshop that cannot be
 * reached is a report that says so, and the hub the family is using is a
 * different machine, a different tree and a different deployment. That is the
 * entire point of building here rather than there.
 */
export async function build(quick = false): Promise<BuildReport> {
  if (!connected()) {
    return {
      ok: false,
      steps: [],
      seededFiles: 0,
      changed: null,
      error:
        "No workshop machine is configured on this hub (DAYTONA_API_KEY is unset), so there is nothing to build the replica on. Everything else about this app works without one.",
    };
  }

  const seeded = await seed();
  const filesChanged = await changed();

  const steps: BuildStep[] = [];
  const deps = await ensureDeps();
  steps.push(deps);
  if (!deps.ok) {
    return { ok: false, steps, seededFiles: seeded.files, changed: filesChanged };
  }

  const typecheck = await step("typecheck", `${BUN} x tsc -b --noEmit`, 150);
  steps.push(typecheck);
  if (!typecheck.ok || quick) {
    return {
      ok: typecheck.ok,
      steps,
      seededFiles: seeded.files,
      changed: filesChanged,
    };
  }

  // The app's own build command, so what is proven here is what runs there:
  // `bun run build` is `tsc -b && vite build` in this project's package.json.
  const built = await step("build", `${BUN} run build`, 180);
  steps.push(built);

  return { ok: built.ok, steps, seededFiles: seeded.files, changed: filesChanged };
}

/* --------------------------------------------------------------- running code */

/** The interpreter to use for a language, and the file it expects. */
const RUNNERS: { file: string; command: string }[] = [
  { file: "main.py", command: "python3 main.py" },
  { file: "main.js", command: "node main.js" },
  { file: "main.ts", command: "bun main.ts" },
  { file: "main.sh", command: "bash main.sh" },
];

function runnerFor(language: string): { file: string; command: string } | null {
  const wanted = language.trim().toLowerCase();
  const pick = (index: number) => ({ ...RUNNERS[index] });

  if (["python", "python3", "py"].includes(wanted)) return pick(0);
  if (["javascript", "js", "node", "nodejs"].includes(wanted)) return pick(1);
  if (["typescript", "ts", "deno", "tsx"].includes(wanted)) return pick(2);
  if (["bash", "sh", "shell", "zsh"].includes(wanted)) return pick(3);
  return null;
}

/**
 * Bun, as a command word: on the PATH when the image carries it, and out of the
 * home directory when it had to be installed by hand. Spelled this way rather
 * than resolved once because every command is a separate shell.
 */
const BUN = '"$(command -v bun 2>/dev/null || echo "$HOME"/.bun/bin/bun)"';

/**
 * Bun is what this project is written in, so the workshop keeps a copy — and
 * nothing can be installed or built in the replica without it. The test is
 * whether it actually runs, not whether an install script exited zero.
 */
async function ensureBun(): Promise<boolean> {
  const present = await run(`${BUN} --version`, { timeoutSeconds: 60 });
  if (present?.ok && present.exitCode === 0) return true;

  const installed = await run(
    'curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1 ; "$HOME"/.bun/bin/bun --version',
    { timeoutSeconds: 180 },
  );
  return Boolean(installed?.ok && installed.exitCode === 0);
}

/**
 * Shell is handled differently from the other languages, and deliberately.
 *
 * A program is written fresh and run in a folder of its own, because it should
 * not care what came before it. Commands are the opposite: `install this`,
 * `typecheck that`, `search the other` only mean anything in the project they
 * are about, so they run in the workshop's project folder with the ceiling an
 * install needs, and what they leave behind is still there next turn.
 */
async function runCommands(commands: string): Promise<string | null> {
  // The script runs in the project folder, so the project has to be there.
  // Seeding on demand rather than waiting for someone to warm the workshop
  // first is what makes `cd src && ls` mean something on the very first turn;
  // it is a single read once the fingerprint already matches.
  await seed();

  const stamp = `s${Date.now().toString(36)}`;
  const script = `${RUN_ROOT}/${stamp}.sh`;
  if (!(await writeFile(script, commands))) return null;

  const started = Date.now();
  const result = await run(`bash "$HOME/${cleanPath(ROOT)}/${script}"`, {
    cwd: ROOT,
    timeoutSeconds: SHELL_TIMEOUT_S,
  });

  // The script is scratch: its output is the point, and it has been captured.
  await removeFile(script);

  if (!result) return null;

  const seconds = ((Date.now() - started) / 1000).toFixed(2);
  const output = result.output.trim();
  const code = result.exitCode;

  const verdict =
    code === 0
      ? "Every command succeeded."
      : "Something in there failed. Read the output before changing anything.";

  const parts = [
    `Ran those commands on the workshop machine in ${seconds}s, in ${cleanPath(
      ROOT,
    )}/, exit code ${code ?? "unknown"}.`,
    verdict,
  ];

  if (output) parts.push(`Output:\n${output.slice(0, 8000)}`);
  else if (code === 0) parts.push("It printed nothing.");

  return parts.join("\n\n");
}

/**
 * Run a program in the workshop and describe what happened, in the same shape
 * the outside code runner answers in. `null` means "not this way" — either
 * there is no workshop, or this language is not one it runs — and the caller
 * should fall back to the public runner.
 */
export async function runProgram(
  language: string,
  code: string,
  files: { path: string; code: string }[] = [],
): Promise<string | null> {
  if (!connected()) return null;

  const runner = runnerFor(language);
  if (!runner) return null;

  // Shell means commands, not a program. See runCommands above.
  if (runner.file === "main.sh") return await runCommands(code);

  if (runner.file === "main.ts") {
    const ready = await ensureBun();
    if (!ready) return null;
    runner.command = `${BUN} main.ts`;
  }

  // Run from the folder the program was written into, by absolute path, so the
  // program's own relative imports mean what they look like.

  const stamp = `r${Date.now().toString(36)}`;
  const folder = `${RUN_ROOT}/${stamp}`;

  await writeFile(`${folder}/${runner.file}`, code);
  for (const file of files.slice(0, 12)) {
    const clean = cleanPath(file.path);
    if (!clean) continue;
    await writeFile(`${folder}/${clean}`, file.code);
  }

  const started = Date.now();
  const result = await run(
    `cd "$HOME/${cleanPath(ROOT)}/${folder}" && ${runner.command}`,
    { timeoutSeconds: 60 },
  );

  if (!result) return null;

  const seconds = ((Date.now() - started) / 1000).toFixed(2);
  const output = result.output.trim();

  const parts = [
    `Ran it in the workshop (${language}) in ${seconds}s, exit code ${
      result.exitCode ?? "unknown"
    }.`,
  ];

  if (output) parts.push(`Output:\n${output.slice(0, 6000)}`);
  else if (result.exitCode === 0) parts.push("It ran and printed nothing.");

  return parts.join("\n\n");
}

/* ----------------------------------------------------------- Convex entry points */

/**
 * Whether a workshop is configured. Queries cannot call out to the network, so
 * this reports the key and the id we last used, and nothing about its health.
 */
export const status = internalQuery({
  args: {},
  handler: async () => ({
    connected: connected(),
    sandboxId: remembered,
    root: cleanPath(ROOT),
  }),
});

/**
 * Put one file on the bench into the workshop as well, so a program the builder
 * wrote can import it. Best-effort: a failure here never fails the write that
 * triggered it.
 */
export const mirror = internalAction({
  args: { path: v.string(), content: v.optional(v.string()) },
  handler: async (_ctx, { path, content }) => {
    if (!connected()) return { ok: false as const, reason: "not connected" };

    // This app's own source goes up first, so that a file which is a patched
    // copy of one of ours is the version left standing.
    await seed();

    if (typeof content === "string") {
      const written = await writeFile(path, content);
      return written ? { ok: true as const } : { ok: false as const };
    }

    await removeFile(path);
    return { ok: false as const };
  },
});

/** Put the whole snapshot into the workshop, on demand. Slow, and once. */
export const warm = internalAction({
  args: {},
  handler: async () => seed(),
});

/** Run one command, for anything that has a Convex context to call from. */
export const check = internalAction({
  args: { command: v.string(), cwd: v.optional(v.string()) },
  handler: async (_ctx, { command, cwd }) => {
    const result = await run(command, { cwd: cwd ?? ROOT, timeoutSeconds: 120 });
    if (!result) return null;
    return { output: result.output.slice(0, 12_000), exitCode: result.exitCode };
  },
});

/** Start over with a clean machine. */
export const reset = internalAction({
  args: {},
  handler: async () => ({ destroyed: await destroy() }),
});

/** Build the replica, for anything with a Convex context to call from. */
export const buildReplica = internalAction({
  args: { quick: v.optional(v.boolean()) },
  handler: async (_ctx, { quick }) => build(Boolean(quick)),
});

/**
 * What the workshop is, for a page to show.
 *
 * A query, so it can only report what is known without asking anybody: whether
 * a machine is configured and where the replica lives inside it. Whether that
 * machine is awake, and whether the replica builds, are questions only a real
 * request can answer — and the page asks them by pressing the button.
 */
export const state = query({
  args: {},
  handler: async () => ({
    connected: connected(),
    replica: `${cleanPath(ROOT)}/`,
    runs: `${cleanPath(ROOT)}/${cleanPath(RUN_ROOT)}/`,
  }),
});

/**
 * Build the replica from a page, on the family's own say-so.
 *
 * Signed in and unlocked, the same as everything else that reaches outside the
 * hub — this spends real minutes on a real machine. What it cannot do is touch
 * the app in front of the person: it is a copy, in a sandbox, on another
 * machine, and the worst a bad edit can do here is make the copy fail to build.
 */
export const buildNow = action({
  args: { quick: v.optional(v.boolean()) },
  handler: async (ctx, { quick }): Promise<BuildReport> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return {
        ok: false,
        steps: [],
        seededFiles: 0,
        changed: null,
        error: "Sign in first.",
      };
    }

    if (!(await ctx.runQuery(internal.access.unlocked, {}))) {
      return {
        ok: false,
        steps: [],
        seededFiles: 0,
        changed: null,
        error: "This hub is locked.",
      };
    }

    return await build(Boolean(quick));
  },
});
