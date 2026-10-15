/**
 * The prompt studio's agent, walked through every decision it makes.
 *
 * The AI Builder page is meant to be an agent you keep talking to: the first
 * request starts an app, and every request after it is a *change to the app on
 * the bench* rather than a second app appearing beside it. That promise rests
 * on three small decisions, and each one fails quietly if it is wrong — the
 * wrong app is edited, or the crew is told nothing about what it is changing,
 * or the box claims work that never happened.
 *
 * So the rules live in `src/lib/forge/agent.ts` — no database, no sandbox, no
 * model — and this is the script that walks them: the target for every state
 * the page can be in, the context the crew is handed, and the reply for a build
 * that passed, one that did not, and one that wrote nothing. The last two
 * checks are source checks on purpose, in the same spirit as
 * `scripts/access-check.ts`: "there is only one of this rule" is exactly the
 * property an innocuous-looking edit can quietly undo.
 *
 * Run with: bun scripts/builder-agent-check.ts
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  STATIC_APP_RULE,
  appNamedIn,
  benchContext,
  changeReply,
  pickTarget,
  whereItIs,
} from "../src/lib/forge/agent";
import type { AppRow } from "../src/lib/forge/db";

const ROOT = new URL("..", import.meta.url).pathname;

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

/** A real app row, with only what a test cares about overridden. */
function anApp(over: Partial<AppRow> & { id: string; name: string }): AppRow {
  return {
    goal: "A calculator.",
    entry: "index.html",
    files: [
      { path: "index.html", content: "<main></main>" },
      { path: "app.js", content: "// keypad" },
    ],
    build: { ok: true, steps: [], errors: [] },
    sessionId: null,
    at: 0,
    updatedAt: 0,
    runs: 0,
    launchedAt: null,
    sentBackAt: null,
    ...over,
  };
}

const onTheBench = anApp({ id: "bench", name: "Calculator" });
const inTheFrame = anApp({ id: "frame", name: "Score pad", onHome: false });
const newest = anApp({ id: "newest", name: "Timer", onHome: false });
const all = [onTheBench, inTheFrame, newest];

/* ------------------------------------------------------- which app, exactly */

check(
  "a request with an app on the bench changes that app",
  pickTarget({ choice: "auto", apps: all, bench: onTheBench, running: inTheFrame })?.id === "bench",
);
check(
  "…and with an empty bench, the app in the frame",
  pickTarget({ choice: "auto", apps: all, bench: null, running: inTheFrame })?.id === "frame",
);
check(
  "…and with neither, a new app rather than the newest one on the list",
  pickTarget({ choice: "auto", apps: all, bench: null, running: null }) === null,
);
check(
  "a deliberate new app ignores the bench entirely",
  pickTarget({ choice: "new", apps: all, bench: onTheBench, running: inTheFrame }) === null,
);
check(
  "a chosen app wins over the bench",
  pickTarget({ choice: "newest", apps: all, bench: onTheBench, running: inTheFrame })?.id === "newest",
);
check(
  "a chosen app that has since been deleted is a new app, not a crash",
  pickTarget({ choice: "gone", apps: all, bench: onTheBench, running: null }) === null,
);

/* ---------------------------------------------- the app a request names */

const packaged = anApp({ id: "calc", name: "Kitchen calculator" });
check(
  "a request sent back from an icon finds the app it names",
  appNamedIn(
    "Make the keypad bigger.\n“Kitchen calculator” is already in the App Sandbox: 2 file(s) — index.html, app.js.",
    [packaged, newest],
  )?.id === "calc",
);
check(
  "a request that names nothing lands on a new app",
  appNamedIn("Build me a shopping list with quantities.", [packaged, newest]) === null,
);
check(
  "a one-word name is not matched everywhere",
  appNamedIn("Score pad ideas", [anApp({ id: "x", name: "AI" })]) === null,
);

/* ------------------------------------------------ what the crew is told */

const told = benchContext(
  anApp({
    id: "broken",
    name: "Budget tracker",
    files: [{ path: "index.html", content: "" }, { path: "main.js", content: "" }, { path: "style.css", content: "" }],
    build: { ok: false, steps: [], errors: ["main.js: unexpected token", "style.css: missing brace"] },
  }),
);
check("the crew is told which app it is changing", told.includes("Budget tracker"));
check("…and how many files it has", told.includes("3 file(s)"));
check("…and what those files are", told.includes("index.html, main.js, style.css"));
check("…and that the last build reported problems", told.includes("reports 2 problem(s)"));
check(
  "…while a passing build is said to have passed",
  benchContext(onTheBench).includes("passed"),
);
check(
  "every app here is built as a static page",
  STATIC_APP_RULE.includes("No npm install") && STATIC_APP_RULE.includes("index.html"),
);

/* ------------------------------------------------------ what it says back */

const changed = changeReply({
  summary: "The keypad is bigger and a percent button was added.",
  written: ["index.html", "app.js", "style.css"],
  app: anApp({ id: "calc", name: "Kitchen calculator" }),
});
check("the reply carries the run's own summary", changed.includes("percent button"));
check("…names how many files changed", changed.includes("Changed 3 files"));
check("…lists them", changed.includes("index.html, app.js, style.css"));
check("…and says the build passed", changed.includes("The build passes."));

const failed = changeReply({
  summary: "Tried to add the percent button.",
  written: ["app.js"],
  app: anApp({
    id: "calc",
    name: "Kitchen calculator",
    build: { ok: false, steps: [], errors: ["app.js: unexpected token", "app.js: missing )"] },
  }),
});
check("a build that failed says so", failed.includes("The build still reports 2 problem(s)"));
check("…with the first of the problems", failed.includes("app.js: unexpected token"));
check("…and never claims it passed", !failed.includes("The build passes."));

const nothing = changeReply({ summary: "Nothing to change there.", written: [], app: null });
check("a run that wrote nothing says exactly that", nothing.includes("Nothing was written"));
check("…and does not list a change", !nothing.includes("Changed"));

const silent = changeReply({ summary: "   ", written: [], app: null });
check(
  "a silent run still answers with the truth",
  silent.includes("Nothing was written") && silent.length > 30,
);

/* --------------------------------------------- and where the app now is */

const asDraft = changeReply({
  summary: "Built a to-do list.",
  written: ["index.html"],
  app: anApp({ id: "todo", name: "To-do list", onHome: false }),
});
check("a new app is said to be in Saved Projects", asDraft.includes("Saved Projects"));
check("…and how it reaches the home screen", asDraft.includes("Publish to Home Screen"));

const onTheHome = changeReply({
  summary: "Made the keypad bigger.",
  written: ["app.js"],
  app: anApp({ id: "calc", name: "Kitchen calculator" }),
});
check(
  "an app already on the home screen is not told to publish itself again",
  !onTheHome.includes("Saved Projects"),
);

/* ------------------------------------------------------ where an app is */

check(
  "the picker says an app is on the bench",
  whereItIs(onTheBench, "bench", "frame") === "on the bench · home screen",
);
check(
  "…and that the one in the frame is both running and a draft",
  whereItIs(inTheFrame, "bench", "frame") === "running in the preview · draft",
);

/* --------------------------------------------------- one rule, not two */

const panel = await readFile(join(ROOT, "src/components/BuilderCrewPanel.tsx"), "utf8");
check(
  "the box reads its target from the one rule",
  panel.includes("pickTarget({") && !panel.includes("const workingOn = useMemo(() => {\n    if (target"),
);
check(
  "…and writes its reply from the one rule",
  panel.includes("changeReply({"),
);
check(
  "…and tells the crew which app it is changing",
  panel.includes("context: input.context ?? (already ? benchContext(already) : undefined)"),
);

const apps = await readFile(join(ROOT, "src/lib/forge/apps.ts"), "utf8");
check(
  "a continuation updates the app it names rather than publishing another",
  apps.includes("id: existing.id") && apps.includes("appId?: string"),
);
check(
  "…and a build with no app behind it is published as a new one",
  apps.includes("await publishFromSandbox({"),
);
check(
  "…which waits in Saved Projects rather than appearing on the home screen",
  apps.includes("onHome: input.onHome ?? false"),
);

/* ------------------------------------------- the bench knows its own app */

const sandbox = await readFile(join(ROOT, "src/lib/forge/sandbox.ts"), "utf8");
check(
  "mounting an app records which app the bench holds",
  sandbox.includes("writeConfig({ benchAppId: projectId })"),
);
check(
  "…and a reload reads it back, so a project is not anonymous files",
  sandbox.includes("config.benchAppId && this.vfs.size"),
);
check(
  "an emptied bench forgets the app it was holding",
  sandbox.includes("writeConfig({ benchAppId: null })"),
);
check(
  "a deliberate new app starts from an empty bench",
  panel.includes("sandbox.engine.clear()") && panel.includes('fresh: target === "new"'),
);
check(
  "…and so does a packaged request that names no app",
  panel.includes("fresh: named === null"),
);

/* --------------------------------------- a draft can be run and seen */

const preview = await readFile(join(ROOT, "src/components/BuilderApps.tsx"), "utf8");
check(
  "Run it in the preview works when everything is still a draft",
  preview.includes("runner.all.find(onTheHomeScreen) ?? runner.all[0]"),
);

const workbench = await readFile(join(ROOT, "src/components/BuilderWorkbench.tsx"), "utf8");
check(
  "a draft carries a Run of its own, without publishing it",
  workbench.includes("{ runner }: { runner?: AppRunner }") &&
    workbench.includes("await runner.launch(app)"),
);

const page = await readFile(join(ROOT, "src/pages/BoxPage.tsx"), "utf8");
check(
  "…and the page hands the runner to it",
  page.includes("<BuilderWorkbench runner={runner} />"),
);

/* --------------------------------- a rebuild is a run like any other */

// Rebuild starts a crew run from the home screen rather than from the prompt
// studio, and the Build Code Log shows its Stop button for as long as any agent
// is running. If that run is not registered as the one in front, Stop answers
// "Nothing is running to stop" over a rebuild that plainly is — so the two
// things every run needs are checked here: a wire for Stop to pull, and a
// session the log is actually reading.
check(
  "a rebuild takes a stop wire and a session to write into",
  apps.includes("options: { signal?: AbortSignal; sessionId?: string } = {}") &&
    apps.includes("signal: options.signal"),
);
check(
  "…and asks for this page's own session when the app carries none",
  apps.includes('(await ensureSession("builder")).id'),
);
check(
  "…and says whether it was stopped, so a half-run is not reported as finished",
  apps.includes("stopped: result.stopped") && preview.includes("result.stopped"),
);
check(
  "the home screen registers that run, and takes it back off the wire",
  preview.includes("beginRun(stop)") &&
    preview.includes("endRun(stop)") &&
    preview.includes("rebuildApp(app, { signal: stop.signal })"),
);/* ------------------------------------------------- the chain, in order */

const log = await readFile(join(ROOT, "src/components/BuilderBuildLog.tsx"), "utf8");
const events = await readFile(join(ROOT, "src/lib/forge/events.ts"), "utf8");

// The page is read top to bottom as one job, so the order the boxes are
// rendered in *is* the flow. Checking the order rather than trusting the
// comment above it is the whole point: a box moved in an unrelated edit is
// exactly how "ask, watch, run, keep, publish" quietly stops being true.
const flow = [
  "BuilderCrewPanel",
  "BuilderBuildLog",
  "BuilderSandboxPreview",
  "BuilderWorkbench",
  "BuilderAppsPanel",
];
const order = flow.map((name) => page.indexOf(`<${name}`));
check(
  "the boxes are rendered in the order the work happens",
  order.every((at, index) => at > 0 && (index === 0 || at > order[index - 1])),
  order.join(" < "),
);
check(
  "…the top of the page says so, and links to every box",
  ["builder-studio", "builder-log", "builder-preview", "builder-projects", "builder-apps"].every(
    (id) => page.includes(`"${id}"`),
  ),
);
check(
  "every box a link points at carries that id",
  panel.includes('id="builder-studio"') &&
    log.includes('id="builder-log"') &&
    preview.includes('id="builder-preview"') &&
    workbench.includes('id="builder-projects"') &&
    preview.includes('id="builder-apps"'),
);
check(
  "the steps between the boxes link to the next one",
  page.includes('<ChainStep to="builder-log">') &&
    page.includes('<ChainStep to="builder-preview">') &&
    page.includes('<ChainStep to="builder-apps">'),
);
check(
  "each box carries the number of its step",
  [panel, log, preview, workbench].filter((source) =>
    source.includes("place-items-center rounded-full border border-white/30"),
  ).length === 4,
  "studio, log, preview and projects",
);

/* ---------------------------------- and the information travels both ways */

check(
  "the log names the app it is building",
  log.includes("app.id === sandbox.mounted") && log.includes('href="#builder-preview"'),
);
check(
  "the preview says what the build reported, and links to the log",
  preview.includes('href="#builder-log"'),
);
check(
  "one box can hand another a request",
  events.includes('| "preset"') && events.includes("text?: string"),
);
check(
  "…the prompt box listens for one, chooses the app and focuses the box",
  panel.includes('event.type !== "preset"') &&
    panel.includes('getElementById("builder-studio")') &&
    panel.includes('scrollIntoView({ behavior: "smooth", block: "start" })') &&
    panel.includes("box.current?.focus()"),
);
check(
  "…and the running app's inspector sends the element that was picked",
  preview.includes('type: "preset"') && preview.includes("Ask for a change"),
);
check(
  "…and an icon on the home screen can ask for one too",
  preview.includes("postForge({ type: \"preset\", id: app.id })"),
);

/* ------------------------------------ and the conversation can be emptied */

// The studio is a conversation you keep coming back to, so it needs the same
// thing every other box has: a way to be cleared. Deleting takes the thread
// alone — the app on the bench, its files and the Build Code Log are separate
// records — and it asks first, because a deleted conversation cannot be put
// back.
check(
  "the conversation can be deleted, and only the conversation",
  panel.includes("clearSessionMessages(session.id)") &&
    panel.includes("Delete this conversation?") &&
    panel.includes("The app on the bench,") &&
    panel.includes("AlertDialogTrigger"),
);

console.log(
  failures === 0
    ? "\nEvery builder-agent check passed."
    : `\n${failures} builder-agent check(s) failed.`,
);

// An explicit status, rather than the event loop draining: a script that only
// exited on failure would hang here with every check green.
process.exit(failures === 0 ? 0 : 1);
