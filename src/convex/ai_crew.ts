/**
 * The crew the AI Builder works as.
 *
 * The builder was always several jobs wearing one name — reading the brief,
 * planning the shape of a thing, finding what already exists, looking the rest
 * of the world up, writing the code, and checking it afterwards — but none of
 * it was visible: the pane showed a stream of steps with nothing saying who was
 * acting. This file is the roster, the attribution, and the words the builder
 * is given about it.
 *
 * Attribution is derived from what actually ran rather than from a claim the
 * model makes about itself: a `write_file` was the implementation, a
 * `web_search` was the research, a review round was the reviewer. The builder is
 * invited to name the crew member it is acting as when it thinks, and that name
 * is shown when it does — but the badge beside a step is never the model's word
 * for what it just did, it is this file's.
 *
 * Six roles, deliberately: a director that holds the plan, a planner that
 * decides the shape, a file-and-context reader, a researcher, the implementer,
 * and the reviewer. Fewer than that and two jobs share a badge; more and the
 * roster is theatre.
 */

export type CrewId =
  | "director"
  | "planner"
  | "files"
  | "research"
  | "implement"
  | "review";

export type CrewMember = {
  id: CrewId;
  /** What the step is prefixed with, and what the pane shows as a chip. */
  handle: string;
  name: string;
  /** One line, for the roster in the Control Room and in the prompt. */
  role: string;
};

export const CREW: CrewMember[] = [
  {
    id: "director",
    handle: "@Director",
    name: "Director",
    role: "Reads the brief, holds the plan, and decides what happens next.",
  },
  {
    id: "planner",
    handle: "@Planner",
    name: "Planner",
    role: "Shapes the work: what files it needs, what the data looks like, what order things go in.",
  },
  {
    id: "files",
    handle: "@Files",
    name: "File & context",
    role: "Reads the bench, the project's own source and the hub's context — what already exists before anything is written.",
  },
  {
    id: "research",
    handle: "@Research",
    name: "Research",
    role: "Looks the outside world up: documentation, SDKs, other AI systems, the live web.",
  },
  {
    id: "implement",
    handle: "@Implement",
    name: "Implementation",
    role: "Writes, edits, moves and deletes files, runs the code, and builds the replica.",
  },
  {
    id: "review",
    handle: "@Review",
    name: "Review & debug",
    role: "Checks the answer before the person sees it — wrong claims, code that would not run, the case that was missed.",
  },
];

const BY_ID = new Map(CREW.map((member) => [member.id, member] as const));

export function crewMember(id: CrewId): CrewMember {
  return BY_ID.get(id) ?? CREW[0];
}

export function crewHandle(id: CrewId): string {
  return crewMember(id).handle;
}

/**
 * Which crew member a tool call belongs to.
 *
 * Anything unrecognised belongs to the director rather than to nobody: an
 * unknown tool is still a decision somebody made, and the roster has to have
 * an answer for every step the loop can write.
 */
export function crewForTool(tool: string): CrewId {
  switch (tool) {
    case "think":
    case "ask_agent":
    case "act":
      return "director";

    case "list_files":
    case "read_file":
    case "search_files":
    case "read_own_code":
    case "scaffold_project":
    case "read_family":
    case "read_briefing":
    case "read_rundown":
      return "files";

    case "web_search":
    case "fetch_url":
    case "ask_ai":
    case "list_ai":
      return "research";

    case "write_file":
    case "edit_file":
    case "move_file":
    case "delete_file":
    case "run_code":
    case "build_app":
    case "patch_own_code":
    case "install_box":
    case "remove_box":
      return "implement";

    default:
      return "director";
  }
}

/**
 * A step, prefixed with the crew member it belongs to — or left exactly as it
 * was when there is no crew to attribute it to.
 *
 * The prefix is deliberately machine-written: `@Files Looked over its bench`.
 * The pane reads it back off the front of the line and shows it as a chip, so
 * the badge and the line can never disagree about who acted.
 */
export function tagCrew(id: CrewId | null, text: string): string {
  if (!id) return text;
  const body = text.trim();
  if (!body) return text;
  return `${crewHandle(id)} ${body}`;
}

/**
 * Pull the crew handle off the front of a line, when one is there.
 *
 * Used by the pane rather than by anything that acts on the work: a badge is a
 * presentation of a line, and the line itself is never rewritten to get one.
 */
export function splitCrew(text: string): { handle: string | null; body: string } {
  const match = /^(@[A-Za-z]+)\s+/.exec(text);
  if (!match) return { handle: null, body: text };
  const handle = match[1];
  const known = CREW.some((member) => member.handle === handle);
  return known
    ? { handle, body: text.slice(match[0].length) }
    : { handle: null, body: text };
}

/**
 * What the builder is told about the crew.
 *
 * Kept short: the roster matters to the person reading the pane and to the
 * model deciding which hat it is wearing, and neither of them needs the
 * reasoning behind the split spelled out in the prompt.
 */
export const CREW_PROMPT = `You work as a crew of six, and the person watching sees which one is acting on every line:
- ${crewHandle("director")} — reads the brief, holds the plan, decides what happens next
- ${crewHandle("planner")} — shapes the work: the files it needs, the shape of the data, the order things go in
- ${crewHandle("files")} — reads the bench, this app's own source and what the hub already knows, before anything is written
- ${crewHandle("research")} — looks the outside world up: docs, SDKs, other AI systems, the live web
- ${crewHandle("implement")} — writes, edits, moves and deletes files, runs the code, builds the replica
- ${crewHandle("review")} — checks the work before the person ever sees it

When you use the think tool, open the thought with the crew member you are acting as, in its own words: "@Planner — the two files this needs are the form and the store, so the store first." The badge beside every other line is worked out from what actually ran, so it never depends on you saying anything.

Start as the Director: read the brief back in one line, then plan. Hand each step to the crew member it belongs to, one tool per turn as always, and finish with the Reviewer reading the answer before it goes out. Say plainly when a step is one person wearing several hats — a small job does not need six of them.`;
