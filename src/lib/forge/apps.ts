/**
 * The App Sandbox: the home of every app the builder has made.
 *
 * The sandbox is one working bench. Whatever is in it is what the crew is
 * building *now*, and the next brief writes over it — so a finished app that
 * only existed there would be gone the moment somebody asked for something
 * else. This module is the door out of the bench and into a home: a build that
 * stands up is published as an app, with its own name, its own files and its
 * own build report, and from then on it can be launched, rebuilt, downloaded,
 * or sent back to the builder with a note.
 *
 * Three properties are worth stating, because they are the whole point:
 *
 * * **An app is self-contained.** Its files travel with it, so it runs whether
 *   or not the sandbox has been booted since, and whether or not the crew is
 *   busy with something else.
 * * **Running one is done in a frame with no way back to this page.**
 *   `assemblePreview` folds the app's own stylesheet and scripts into one
 *   document, and the frame runs it with `allow-scripts` and without
 *   `allow-same-origin` — so an app the family built can be run without being
 *   trusted with the hub's session, its storage or its database.
 * * **Nothing here builds on its own.** Sending an app back for work writes a
 *   request the person can read first; the crew is only ever started by a
 *   press, exactly as the rest of the forge is.
 */
import { STATIC_APP_RULE, benchContext } from "./agent";
import { ensureSession } from "./chat";
import { readConfig } from "./config";
import {
  forgeDb,
  forgeId,
  recordError,
  setLight,
  type AppRow,
  type BuildStepRow,
  type RequestRow,
} from "./db";
import { postForge } from "./events";
import { PROVIDERS, type ProviderId } from "./llm";
import { runPipeline } from "./pipeline";
import { sendBuildRequest } from "./requests";
import { assemblePreview, resolveLocalPath, sandbox, type BuildResult } from "./sandbox";
import { downloadZip } from "./zip-io";

/**
 * The provider the crew will talk to, or null when none has been chosen.
 *
 * The stored value is a plain string as far as the database is concerned, so
 * it is checked against the router's own list here rather than trusted: a
 * provider that no longer exists should say so, not be sent a request.
 */
function chosenProvider(config: { aiProvider: string | null }): ProviderId | null {
  return PROVIDERS.find((one) => one.id === config.aiProvider)?.id ?? null;
}

/** The page an app opens on: its own index.html, else the first HTML in it. */
export function appEntry(files: { path: string; content: string }[]): string | null {
  const paths = files.map((file) => file.path);
  return (
    (paths.includes("index.html") ? "index.html" : null) ??
    [...paths].sort().find((path) => path.endsWith(".html")) ??
    null
  );
}

/** Every app, newest first. */
export async function listApps(): Promise<AppRow[]> {
  const rows = await forgeDb.apps.toArray();
  return rows.sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Is this app on the home screen, or still a project being worked on?
 *
 * One predicate, used by both boxes, so "which box holds it" is one answer
 * rather than two that can disagree. Absent counts as the home screen: every
 * app written before projects existed was one the crew had built.
 */
export function onTheHomeScreen(app: AppRow): boolean {
  return app.onHome !== false;
}

/**
 * Move an app between the two places it can live: the home screen, or Projects.
 *
 * This is the person's own switch — an app is put on the home screen when it is
 * ready to be launched, and taken off it while it is still being worked on.
 * Nothing else moves it: publishing from the bench makes a draft.
 */
export async function setAppOnHome(id: string, onHome: boolean): Promise<boolean> {
  const app = await getApp(id);
  if (!app) return false;
  await forgeDb.apps.put({ ...app, onHome, updatedAt: Date.now() });
  postForge({ type: "apps", id });
  return true;
}

/** One app, or null when it has been deleted since it was read. */
export async function getApp(id: string): Promise<AppRow | null> {
  return (await forgeDb.apps.get(id)) ?? null;
}

/**
 * The app, as one document that runs on its own.
 *
 * This is the same assembly the sandbox previews with, so what a person runs
 * from the App Sandbox is what the sandbox showed them while it was built —
 * one opinion about what the app is, rather than two.
 */
export function appDocument(app: AppRow): string | null {
  const entry = app.entry ?? appEntry(app.files);
  if (!entry) return null;
  const vfs = new Map(app.files.map((file) => [file.path, file.content] as [string, string]));
  if (!vfs.has(entry)) return null;
  return assemblePreview(vfs, entry);
}

/**
 * Publish whatever the sandbox holds right now as a named app.
 *
 * What a build produces is a **draft**, in Saved Projects, unless the caller
 * says otherwise. That is the whole difference between the page's two lists,
 * and it is deliberate: an app the crew has just stopped writing has not been
 * looked at yet, so nothing arrives on the home screen already finished. It
 * waits in Projects — where it can be run, changed and published — and the
 * person's own **Publish to Home Screen** is what puts it among the icons.
 */
export async function publishFromSandbox(input: {
  name?: string;
  goal: string;
  sessionId?: string | null;
  build: BuildResult;
  /** `true` puts it straight on the home screen; the default is a draft. */
  onHome?: boolean;
}): Promise<AppRow | null> {
  const files = sandbox.fileList();
  if (!files.length) return null;
  return await publishApp({
    name: input.name,
    goal: input.goal,
    files,
    build: input.build,
    sessionId: input.sessionId ?? null,
    onHome: input.onHome ?? false,
  });
}

/**
 * Put an app in the App Sandbox — or bring an existing one up to date.
 *
 * Passing an `id` updates that app where it stands, which is how a rebuild
 * keeps its place in the list, its name and its run count instead of arriving
 * as a stranger with the same name.
 */
export async function publishApp(input: {
  id?: string;
  name?: string;
  goal: string;
  files: { path: string; content: string }[];
  build: BuildResult;
  sessionId?: string | null;
  /** Which of the two places it belongs in; absent keeps where it already is. */
  onHome?: boolean;
}): Promise<AppRow> {
  const now = Date.now();
  const existing = input.id ? await getApp(input.id) : null;
  const named = (input.name ?? "").trim();
  const name =
    named ||
    existing?.name ||
    `${input.goal.trim().split(/\s+/).slice(0, 6).join(" ") || "Untitled app"}`;

  const row: AppRow = {
    id: existing?.id ?? forgeId(),
    name: name.slice(0, 80),
    goal: input.goal.slice(0, 2000),
    entry: appEntry(input.files),
    files: input.files,
    build: {
      ok: input.build.ok,
      steps: input.build.steps,
      errors: input.build.errors,
    },
    sessionId: input.sessionId ?? existing?.sessionId ?? null,
    at: existing?.at ?? now,
    updatedAt: now,
    runs: existing?.runs ?? 0,
    launchedAt: existing?.launchedAt ?? null,
    sentBackAt: existing?.sentBackAt ?? null,
    onHome: input.onHome ?? existing?.onHome,
  };

  await forgeDb.apps.put(row);
  await setLight(
    "apps",
    row.build.ok ? "good" : "warn",
    `${row.files.length} file(s) published as “${row.name}”${
      row.build.ok ? "" : " — the build still reports problems"
    }.`,
  );
  postForge({ type: "apps", id: row.id });
  return row;
}

/** Count a real launch. The number shown is the number of times it was run. */
export async function recordRun(id: string): Promise<void> {
  const app = await getApp(id);
  if (!app) return;
  await forgeDb.apps.put({ ...app, runs: app.runs + 1, launchedAt: Date.now() });
  postForge({ type: "apps", id });
}

/** Rename an app. An empty name is refused rather than blanking the card. */
export async function renameApp(id: string, name: string): Promise<boolean> {
  const app = await getApp(id);
  const clean = name.trim().slice(0, 80);
  if (!app || !clean) return false;
  await forgeDb.apps.put({ ...app, name: clean, updatedAt: Date.now() });
  postForge({ type: "apps", id });
  return true;
}

/** Take an app away for good. */
export async function deleteApp(id: string): Promise<void> {
  await forgeDb.apps.delete(id);
  postForge({ type: "apps", id });
}

/** A copy of an app, so a change can be tried without risking the original. */
export async function duplicateApp(id: string): Promise<AppRow | null> {
  const app = await getApp(id);
  if (!app) return null;
  const now = Date.now();
  const copy: AppRow = {
    ...app,
    id: forgeId(),
    name: `${app.name} (copy)`.slice(0, 80),
    at: now,
    updatedAt: now,
    runs: 0,
    launchedAt: null,
    sentBackAt: null,
  };
  await forgeDb.apps.put(copy);
  postForge({ type: "apps", id: copy.id });
  return copy;
}

/**
 * Put an app back on the bench, so the crew works on *it* rather than on
 * whatever the last build left behind. Returns how many files it holds.
 */
export async function loadAppIntoSandbox(app: AppRow): Promise<number> {
  await sandbox.mount(app.id, app.files);
  return app.files.length;
}

/**
 * Build the app again from the same brief, from where it stands.
 *
 * The app's own files are put on the bench first, so the crew is looking at
 * this app and can change it — an update, not a fresh start that happens to
 * share a name.
 *
 * It is a crew run like any other, so it takes the same two things a run needs
 * to be part of the page rather than beside it:
 *
 * * **a session to write into.** An app saved from the bench carries no
 *   session, and a rebuild that made one up would print every step of itself
 *   into a session no box on the page reads — the Build Code Log would sit
 *   empty through a run that was happening. Falling back to this page's own
 *   session is what puts the lines where the log is looking. (There is one
 *   builder session, and `newSession` is only ever used for the Assistant, so
 *   this is the same session the log reads.)
 * * **a signal to stop with.** Passed straight through to the pipeline, which
 *   ends at its next check — this is the wire the Build Code Log's Stop pulls.
 *
 * `stopped` is handed back so the caller can say the run was stopped rather
 * than report a half-finished rebuild as a finished one.
 */
export async function rebuildApp(
  app: AppRow,
  options: { signal?: AbortSignal; sessionId?: string } = {},
): Promise<{ app: AppRow; build: BuildResult; stopped: boolean }> {
  const config = await readConfig();
  await loadAppIntoSandbox(app);
  await sandbox.boot().catch(() => undefined);

  const provider = chosenProvider(config);
  if (!provider || !config.aiModel) {
    throw new Error(
      "No model is chosen — pick a provider and a model in the Control Room's BYOK hub, then rebuild.",
    );
  }

  const sessionId =
    options.sessionId ?? app.sessionId ?? (await ensureSession("builder")).id;

  const result = await runPipeline({
    sessionId,
    goal: app.goal,
    provider,
    model: config.aiModel,
    signal: options.signal,
  });

  const build: BuildResult = result.build ?? {
    ok: false,
    steps: [],
    errors: [(result.summary || "The build did not finish.")],
    preview: "none",
  };

  return {
    app: await publishApp({
      id: app.id,
      goal: app.goal,
      files: sandbox.fileList(),
      build,
      // An app with no session of its own takes the one this run wrote into,
      // so the steps of it are still the steps of something on this page.
      sessionId: app.sessionId ?? sessionId,
    }),
    build,
    stopped: result.stopped,
  };
}

/**
 * Send an app back to the builder for work, in the person's own words.
 *
 * It is a request, not a run: it lands where every other build request lands
 * (the Builder's pending list) and can be read before anything spends a model
 * call on it. The sentence says which app it is about, so the crew arrives at
 * the right bench with the right brief.
 */
export async function sendAppBack(app: AppRow, note: string): Promise<RequestRow> {
  const asked = note.trim().slice(0, 1200);
  const composed = `${app.goal}${
    asked
      ? `\n\nWhat needs fixing or changing: ${asked}`
      : "\n\nIt needs another pass — make it work properly."
  }`.slice(0, 2000);
  // The request schema refuses a goal shorter than eight characters, and an app
  // published straight from the bench can carry a one-word brief. Naming the app
  // always clears that, and it is the first thing the crew needs to know.
  const goal =
    composed.trim().length >= 8
      ? composed
      : `Work on “${app.name}”: ${composed}`.slice(0, 2000);

  const request = await sendBuildRequest({
    goal,
    context: benchContext(app),
    constraints: STATIC_APP_RULE,
    priority: "high",
  });

  await forgeDb.apps.put({ ...app, sentBackAt: Date.now() });
  postForge({ type: "apps", id: app.id });
  return request;
}

/**
 * Ask the crew for an app — or for a change to the one already on the bench.
 *
 * This is the path that makes the AI Builder able to build a real app: the
 * six agents write the files, the sandbox builds them, and a build that
 * produces files is published into the App Sandbox — where it can be launched
 * and seen, rather than being a summary in a chat log.
 *
 * Passing an `appId` is what makes the second request a *continuation* rather
 * than a second app: the work lands on that app where it stands, keeping its
 * name, its place and how many times it has been run, exactly as a rebuild
 * does. Without it, a finished build is a new app — and a new app is a draft
 * in Saved Projects, because nothing should reach the home screen without
 * somebody deciding it is finished.
 */
export async function buildAnApp(input: {
  goal: string;
  name?: string;
  sessionId: string;
  signal?: AbortSignal;
  /** Publish even when the build reported problems, so it can be fixed there. */
  publishAnyway?: boolean;
  /** The app this request is a change to, updated in place rather than beside it. */
  appId?: string;
  /** The app's own brief, kept when `goal` is only the change asked for now. */
  keepGoal?: string;
  /** What the crew should know about the app already on the bench. */
  context?: string;
  constraints?: string;
}): Promise<{
  app: AppRow | null;
  summary: string;
  ok: boolean;
  /** Every file the run wrote, in the order it wrote them. */
  written: string[];
}> {
  const config = await readConfig();
  if (config.emergencyStopped) {
    throw new Error("Emergency stop is on — release it in the Control Room before building.");
  }
  const provider = chosenProvider(config);
  if (!provider || !config.aiModel) {
    throw new Error(
      "No model is chosen — pick a provider and a model in the Control Room's BYOK hub, then build.",
    );
  }

  const result = await runPipeline({
    sessionId: input.sessionId,
    goal: input.goal,
    provider,
    model: config.aiModel,
    signal: input.signal,
    context: input.context,
    constraints: input.constraints,
  });

  const build: BuildResult = result.build ?? {
    ok: false,
    steps: [],
    errors: [result.summary || "The build did not run."],
    preview: "none",
  };

  if (!result.written.length || (!build.ok && !input.publishAnyway)) {
    return { app: null, summary: result.summary, ok: false, written: result.written };
  }

  // An update lands on the app it names, keeping its name, place and brief;
  // a build with no app behind it is published as a new one.
  const existing = input.appId ? await getApp(input.appId) : null;
  const app = existing
    ? await publishApp({
        id: existing.id,
        name: input.name || existing.name,
        goal: (input.keepGoal ?? existing.goal).slice(0, 2000),
        files: sandbox.fileList(),
        build,
        sessionId: existing.sessionId ?? input.sessionId,
        onHome: existing.onHome,
      })
    : await publishFromSandbox({
        name: input.name,
        goal: input.goal,
        sessionId: input.sessionId,
        build,
      });

  return { app, summary: result.summary, ok: Boolean(app) && build.ok, written: result.written };
}

/* ------------------------------------------------------------------ taking it away */

/** Save an app as one file that runs wherever it is opened. */
export function appFileName(app: AppRow): string {
  const stem = app.name.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "");
  return `${stem || "app"}.html`;
}

/** Save the app's files as a zip, folder structure and all. */
export function downloadAppZip(app: AppRow): number {
  return downloadZip(appFileName(app).replace(/\.html$/, ""), app.files);
}

/** For the diagnostics box: a failure here must be recorded, not swallowed. */
export async function reportAppError(where: string, error: unknown): Promise<void> {
  await recordError(`app sandbox ${where}`, error);
}

/** Whether an app has a page to open at all. */
export function runnable(app: AppRow): boolean {
  return Boolean(app.entry ?? appEntry(app.files));
}

/** Local files an app's entry asks for that the app does not carry. */
export function appMissingReferences(app: AppRow): string[] {
  const entry = app.entry ?? appEntry(app.files);
  if (!entry) return [];
  const vfs = new Map(app.files.map((file) => [file.path, file.content] as [string, string]));
  const html = vfs.get(entry) ?? "";
  const missing: string[] = [];
  const pattern = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  for (const match of html.matchAll(pattern)) {
    const ref = match[1] ?? "";
    if (!/\.(?:js|mjs|css|png|jpe?g|svg|gif|webp|ico|json)$/i.test(ref)) continue;
    const resolved = resolveLocalPath(ref, entry);
    if (resolved && !vfs.has(resolved)) missing.push(ref);
  }
  return [...new Set(missing)];
}

/** A step list, for the page to print — real steps, in the order they ran. */
export function buildSteps(app: AppRow): BuildStepRow[] {
  return app.build.steps;
}
