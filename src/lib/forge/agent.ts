/**
 * The agent's own rules, kept apart from the page that shows them.
 *
 * The prompt studio is an agent you keep talking to, and three questions decide
 * what it actually does. Each one is answered here rather than inside a
 * component, so it can be read — and checked — on its own:
 *
 *  * **Which app is this request about?** `pickTarget`: the app on the bench
 *    first, because that is where the crew's files are, then the app in the
 *    preview frame, because that is the one somebody is looking at, and
 *    otherwise nothing at all — which means a new app rather than a change to
 *    whichever old one happens to be newest. A person's own choice, or a
 *    packaged request naming its app, overrides all of it.
 *  * **What is it told about that app?** `benchContext`, in the same words an
 *    app sent back from an icon carries, and `STATIC_APP_RULE`, which is the
 *    shape every app in this sandbox is built in.
 *  * **What does it say back?** `changeReply` — the Director's own summary,
 *    then the facts: which files changed, and whether the build passed. A run
 *    that wrote nothing says exactly that instead of implying work.
 *
 * Nothing here touches IndexedDB, the sandbox or a model: an app row is a plain
 * object here, which is what makes this the one part of the builder that an
 * ordinary script can walk through end to end —
 * `bun scripts/builder-agent-check.ts`.
 */
import type { AppRow } from "./db";

/**
 * The rule every app in this sandbox is built under: a static page, nothing to
 * install. Shared rather than written twice, so a request packaged by the
 * Assistant and a change asked for in the prompt studio arrive with the same
 * constraints.
 */
export const STATIC_APP_RULE =
  "It has to keep running as a static app: index.html at the root, plain HTML, CSS and JavaScript, and libraries from CDN URLs when they are needed. No npm install.";

/**
 * What the crew should know about an app that is already on the bench.
 *
 * Naming the app, counting its files, listing what they are and saying how its
 * last build went is what turns "make the buttons bigger" into a change to a
 * known app rather than a fresh guess.
 */
export function benchContext(app: AppRow): string {
  return `“${app.name}” is already in the App Sandbox: ${app.files.length} file(s) — ${app.files
    .map((file) => file.path)
    .slice(0, 20)
    .join(", ")}. Its last build ${
    app.build.ok ? "passed" : `reports ${app.build.errors.length} problem(s)`
  }. Change what is asked for and leave the parts that already work alone.`;
}

/**
 * The app a packaged request is about.
 *
 * A request sent back from an icon names the app it came from in its brief or
 * its context, and a request row has no id to point at. Matching the name is
 * what keeps such a request from landing on whatever happens to be on the bench
 * — the crew arrives at the bench the sentence was written about. A name of two
 * characters or fewer is ignored rather than matched everywhere.
 */
export function appNamedIn(text: string, apps: AppRow[]): AppRow | null {
  const haystack = text.toLowerCase();
  return (
    apps.find((app) => app.name.trim().length > 2 && haystack.includes(app.name.toLowerCase())) ??
    null
  );
}

/** What the box above the prompt is pointed at. */
export type TargetChoice = "auto" | "new" | (string & {});

/**
 * The app a request will be sent to, or `null` for a new one.
 *
 * `auto` is the honest reading of the page rather than a guess: the bench if
 * there is anything on it, then the app in the frame, then nothing.
 */
export function pickTarget(input: {
  choice: TargetChoice;
  apps: AppRow[];
  /** The app the sandbox says it is holding, if any. */
  bench: AppRow | null;
  /** The app in the Preview frame, if any. */
  running: AppRow | null;
}): AppRow | null {
  if (input.choice === "new") return null;
  if (input.choice !== "auto") {
    return input.apps.find((app) => app.id === input.choice) ?? null;
  }
  return input.bench ?? input.running ?? null;
}

/**
 * The agent's turn: what it understood, what changed, and what the build said.
 *
 * The summary is the run's own words, not a second opinion written here. The
 * facts under it are the ones a person cannot see from a spinner: which files
 * the run touched, whether the sandbox build passed, and where the app is now —
 * a run that produced a draft says so, because "it worked" and "I cannot see it
 * on the home screen" are two sentences a person should never have to reconcile
 * on their own.
 */
export function changeReply(input: {
  summary: string;
  /** Every file the run wrote, in the order it wrote them. */
  written: string[];
  /** The app that was published or updated, or null when nothing was. */
  app: AppRow | null;
}): string {
  const facts: string[] = [];

  if (input.app) {
    if (input.written.length) {
      facts.push(
        `Changed ${input.written.length} file${input.written.length === 1 ? "" : "s"} — ${input.written
          .slice(0, 8)
          .join(", ")}${input.written.length > 8 ? "…" : ""}.`,
      );
    }
    facts.push(
      input.app.build.ok
        ? "The build passes."
        : `The build still reports ${input.app.build.errors.length} problem(s): ${input.app.build.errors
            .slice(0, 3)
            .join(" / ")}`,
    );
    // Where it went, said plainly: a new app waits in Projects rather than
    // appearing among the icons, and the box should not leave anybody hunting
    // for something they never lost.
    if (input.app.onHome === false) {
      facts.push(
        "It is in Saved Projects, not on the home screen yet — Publish to Home Screen puts it among the icons when it is finished.",
      );
    }
  } else {
    facts.push("Nothing was written, so the bench is exactly as it was.");
  }

  return (
    [input.summary.trim(), ...facts].filter(Boolean).join("\n") ||
    "That run finished without saying anything, and without writing a file."
  );
}

/** Where an app stands, in the few words the picker has room for. */
export function whereItIs(app: AppRow, mounted: string | null, running: string | null): string {
  const places: string[] = [];
  if (app.id === mounted) places.push("on the bench");
  if (app.id === running) places.push("running in the preview");
  places.push(app.onHome === false ? "draft" : "home screen");
  return places.join(" · ");
}
