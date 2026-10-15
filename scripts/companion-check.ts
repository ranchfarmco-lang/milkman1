/**
 * The companion in the corner, walked through what can be walked through.
 *
 * The little box is mostly glue: it shows a conversation the server keeps, it
 * describes the page it is sitting on, it hears a voice, and it offers a line of
 * its own now and then. Glue is exactly the kind of code that fails quietly —
 * a setting one side of the app accepts and the other refuses, a screen digest
 * that is written but never sent, a note that is raised and then cannot be
 * cleared, a hint that forgets which note it was counting.
 *
 * So this walks two things:
 *
 *   * **The notes store, for real.** It is plain code with no DOM and no
 *     network, so it is imported and used: deduplication, the length cap, links
 *     that are refused, reading, dismissing, emptying and the cap on how many
 *     are kept.
 *   * **The wiring, in the source.** The rest needs a browser and a live model,
 *     neither of which exists here — so the invariants that hold it together
 *     are read out of the files themselves, the same way `access-check` and
 *     `builder-agent-check` do it. A screen digest nothing attaches to a turn,
 *     or a room the schema does not accept, would pass a typecheck and still be
 *     a box that never works.
 *
 * Run with: bun scripts/companion-check.ts
 */
import { readFile } from "node:fs/promises";

import { localCommand } from "../src/hooks/use-companion";
import {
  clearNotes,
  dismissNote,
  markNotesRead,
  notesSnapshot,
  pushNote,
  subscribeNotes,
  unreadNotes,
} from "../src/lib/companion/notes";
import { spellsProse } from "../src/lib/spellcheck";

const ROOT = new URL("..", import.meta.url).pathname;

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`,
  );
  if (!ok) failures += 1;
}

async function read(path: string): Promise<string> {
  return readFile(`${ROOT}${path}`, "utf8");
}

/** The file's text, or null when there is no such file — a deletion is a fact
 *  worth asserting, and reading it would otherwise throw. */
async function readOrNull(path: string): Promise<string | null> {
  try {
    return await read(path);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------ the notes, for real */

clearNotes();

{
  const heard: (string | null)[] = [];
  const stop = subscribeNotes((note) => {
    heard.push(note?.text ?? null);
  });

  const written = pushNote({
    kind: "note",
    text: "Two words to put right.",
  });
  check("a note is kept", notesSnapshot().length === 1 && written !== null);
  check(
    "…and the listener is handed the note itself",
    heard[0] === "Two words to put right.",
    String(heard[0]),
  );
  check("…and it arrives unread", unreadNotes(notesSnapshot()) === 1);

  // A box that has been taken off the page must not keep being woken by notes.
  stop();
  const unheard = pushNote({
    kind: "note",
    text: "Nobody is listening for this one.",
  });
  check(
    "a listener that has gone hears nothing more",
    heard.length === 1,
    `${heard.length}`,
  );
  // Taken back out, so the counts below are about the notes this block meant.
  if (unheard) dismissNote(unheard.id);
  check(
    "…and clearing it up leaves the box as it was",
    notesSnapshot().length === 1,
  );

  // The same notice twice is what a page asking on every keystroke produces.
  pushNote({ kind: "note", text: "Two words to put right." });
  check(
    "the same note twice is one note",
    notesSnapshot().length === 1,
    `${notesSnapshot().length}`,
  );

  pushNote({ kind: "alert", text: "Timer finished: kettle" });
  check(
    "…but the same words from another kind are their own note",
    notesSnapshot().length === 2,
    `${notesSnapshot().length}`,
  );
  check(
    "…and a note with nothing in it is refused",
    pushNote({ kind: "note", text: "   " }) === null,
  );

  markNotesRead();
  check("reading them clears the count", unreadNotes(notesSnapshot()) === 0);

  const first = notesSnapshot()[0]!;
  dismissNote(first.id);
  check("dismissing one takes that one out", notesSnapshot().length === 1);
}

/* --------------------------------------------------------------- the limits */

clearNotes();

{
  const long = "x".repeat(5000);
  const written = pushNote({ kind: "note", text: long });
  check(
    "a very long note is cut down",
    (written?.text.length ?? 0) === 800,
    `${written?.text.length}`,
  );

  const linked = pushNote({
    kind: "note",
    text: "Found it.",
    links: [
      "https://example.com/thing",
      "javascript:alert(1)",
      "not a url at all",
      "http://still-fine.test/x",
      "https://example.com/thing",
    ],
  });
  check(
    "only real http(s) pages are kept, once each",
    JSON.stringify(linked?.links) ===
      JSON.stringify(["https://example.com/thing", "http://still-fine.test/x"]),
    JSON.stringify(linked?.links),
  );

  for (let index = 0; index < 40; index += 1) {
    pushNote({ kind: "note", text: `Note number ${index}` });
  }
  check(
    "the box keeps the last thirty and no more",
    notesSnapshot().length === 30,
    `${notesSnapshot().length}`,
  );
  check(
    "…and what it keeps is the newest",
    notesSnapshot()[29]?.text === "Note number 39",
    notesSnapshot()[29]?.text,
  );

  clearNotes();
  check("emptying it leaves nothing", notesSnapshot().length === 0);
}

/* ------------------------------------------------------ what is said to it */

/*
 * Three things are answered on the device rather than by the model. The risk of
 * doing that is entirely in the matching: a phrase that fires on a longer
 * sentence takes half a job and silently drops the rest. So these walk real
 * sentences through the rule, and the interesting ones are the sentences that
 * must NOT match.
 */

check(
  // Spelling is not one of the box's jobs any more — the browser's own checker
  // does it, in the field being typed in — so "fix my spelling" is a sentence it
  // has nothing local to do with, and it must not pretend otherwise.
  "‘fix my spelling’ is not a thing this box does",
  localCommand("Fix my spelling") === null,
  String(localCommand("Fix my spelling")),
);
check(
  "‘stop listening’ turns the microphone off",
  localCommand("Stop listening.")?.kind === "stop",
);
check(
  "…and a real question about music is not mistaken for it",
  localCommand("stop listening to music and play the news") === null,
);

{
  const calendar = localCommand("open the calendar");
  check(
    "‘open the calendar’ goes there without asking anyone",
    calendar?.kind === "go" && calendar.to === "/calendar",
    JSON.stringify(calendar),
  );

  const room = localCommand("Show me the control room page");
  check(
    "…however politely it is said",
    room?.kind === "go" && room.to === "/control-room",
    JSON.stringify(room),
  );

  check(
    "…but ‘open the calendar and add a dentist appointment’ is a job for the model",
    localCommand(
      "open the calendar and add a dentist appointment on Tuesday",
    ) === null,
    String(
      localCommand(
        "open the calendar and add a dentist appointment on Tuesday",
      ),
    ),
  );

  check(
    "…and an ordinary question is never a command",
    localCommand("what is on this page?") === null &&
      localCommand("how much is a cord of wood") === null,
  );
}

/* ---------------------------------------- the room, the prompt and the hint */

const ai = await read("src/convex/ai.ts");
const schema = await read("src/convex/schema.ts");
const turn = await read("src/convex/ai_turn.ts");
const messages = await read("src/convex/messages.ts");
const prompts = await read("src/convex/ai_prompts.ts");
const settings = await read("src/convex/settings.ts");
const devices = await read("src/lib/device-settings.ts");

check(
  "the database accepts a companion room",
  /roomValidator[\s\S]{0,400}v\.literal\("companion"\)/.test(schema),
);
check(
  "the companion has a prompt of its own",
  prompts.includes("export function companionSystemPrompt"),
);
check(
  "…which is told what is on the screen, and told not to read it back",
  prompts.includes("What is on their screen right now") &&
    prompts.includes("never mention that you can see their screen"),
);
check(
  "…and told that a link is worth breaking the brevity rule for",
  prompts.includes("give the link plainly"),
);
check(
  "the turn reads what is on the screen and nothing else",
  turn.includes("screen: context") &&
    turn.includes("context: v.optional(v.string())"),
);
check(
  "the little box answers in the spoken shape, not the builder's prose",
  /const chatty = isAssistant \|\| room === "companion"/.test(turn),
);
check(
  "…and is handed the assistant's whole shelf of tools, not an empty one",
  /if \(system\.includes\("You are the companion"\)\) return "assistant"/.test(
    ai,
  ),
);

check(
  "it can speak first, in its own action",
  turn.includes("export const hint = action"),
);
check(
  "…writing into the companion's own thread, marked as unprompted",
  /appendReply,\s*\{\s*room: "companion",\s*ownerId: userId,\s*text: say,\s*note: HINT_NOTE,/.test(
    turn.replace(/\n\s+/g, "\n"),
  ),
);
check(
  "…refusing inside its own quiet gap",
  turn.includes("HINT_GAP_MS") && turn.includes("timing.lastUnpromptedAt"),
);
check(
  "…and silence is allowed to be its answer",
  turn.includes('{"say":"","actions":[]}') &&
    turn.includes("Nothing worth saying"),
);
check(
  "the clock it refuses on is read from the same note it writes",
  messages.includes("export const unpromptedTiming") &&
    messages.includes("row.note === note") &&
    turn.includes(
      'room: "companion",\n        ownerId: userId,\n        note: HINT_NOTE,',
    ),
);
check(
  "a locked account is handed nothing, so a hint spends no key",
  /unpromptedTiming[\s\S]{0,900}isUnlocked/.test(messages),
);

/* ------------------------------------------- the switches, on both sides of it */

const companionKeys = [
  "companion_hands_free",
  "companion_hints",
  "companion_speak",
];

check(
  "the Control Room offers all three companion switches",
  companionKeys.every((key) => devices.includes(`id: "${key}"`)),
);
check(
  "…and the server accepts exactly those three",
  companionKeys.every((key) => settings.includes(`"${key}"`)),
);
check(
  "the assistant is allowed to flip them by voice too",
  companionKeys.every((key) => turn.includes(`${key}:`)),
);

/* ------------------------------------------------- the page it is standing on */

const companion = await read("src/hooks/use-companion.ts");
const screen = await read("src/lib/companion/screen.ts");
const report = await read("src/hooks/use-screen-report.ts");
const chat = await read("src/hooks/use-chat.ts");
const box = await read("src/components/CompanionBox.tsx");
const shell = await read("src/pages/AppShell.tsx");
const main = await read("src/main.tsx");
const spell = await read("src/lib/spellcheck.ts");
const nudge = await read("src/hooks/use-nudge.ts");
const share = await read("src/lib/internal-share.ts");

check(
  "the digest is written by the document, not by a screenshot",
  screen.includes("document.activeElement") &&
    !/toDataURL|canvas|getDisplayMedia/.test(screen),
);
check(
  "…and a field that is not prose is looked away from",
  // The one rule, kept in one place (`src/lib/spellcheck.ts`) and read here
  // rather than restated: a password field is refused because it is not prose,
  // and so is a key or a path that says so with `data-spell="off"`.
  screen.includes("proseField(") && !screen.includes("PROSE_INPUT_TYPES"),
);
check(
  "…and every part of it is capped",
  screen.includes("TEXT_LIMIT") &&
    screen.includes("SELECTION_LIMIT") &&
    screen.includes("LABEL_LIMIT"),
);
check(
  "the page reports itself as they type, move and select",
  ["focusin", "focusout", "input", "selectionchange"].every((event) =>
    report.includes(`"${event}"`),
  ),
);
check(
  "…and it reports at once on arrival",
  report.includes("writeScreen(readScreen(pathname))"),
);
check(
  // The digest is what the companion's prompt reads; `focus` rides in the same
  // call and means nothing to this box — the mirror in the AI Builder's sandbox
  // is the only one that sets it — so the promise being checked is that the
  // screen still travels.
  "what was written travels with the turn",
  chat.includes("respond({ room, context, focus })") &&
    companion.includes("context: describeScreen"),
);

check(
  "the box is on the page it is standing on",
  box.includes("useScreenReport()") && box.includes("useCompanion()"),
);
check(
  "…and it is mounted once, for the whole signed-in app",
  shell.includes("<CompanionBox />"),
);
check(
  "…and not on the public pages, which are opened without a session",
  !main.includes("CompanionBox"),
);
check(
  "it is opened by a hand and by news, never by a timer",
  box.includes("box.openBox") &&
    box.includes("box.markSeen") &&
    companion.includes("subscribeNotes((note)"),
);

/* ------------------------------------------------------------- hearing, saying */

check(
  "hands-free leaves the microphone open wherever they go",
  box.includes("box.setHandsFree") && box.includes("box.handsFree"),
);
check(
  "…and it is shut while the model is thinking or talking",
  companion.includes("muted: thinking || speaking"),
);
check(
  "the things said most often are answered without a model",
  companion.includes("function localCommand") &&
    companion.includes('kind: "stop"') &&
    companion.includes('kind: "go"') &&
    !companion.includes('kind: "fix"'),
);

/* ------------------------------------------------- spelling, in the browser */

// There is no checker of this app's own, and there used to be: Hunspell in
// `nspell`, a dictionary served from `public/spell/`, and a layer that mirrored
// each field over itself to mark the words. Spelling is the browser's now, in
// whatever field is being typed in, and the one thing left for this app to get
// right is *which* fields those are. So these hold up both halves: that the
// checker this app carried is gone rather than merely unused, and that the one
// rule which replaced it is wired into the fields and read by the digest.
const input = await read("src/components/ui/input.tsx");
const textarea = await read("src/components/ui/textarea.tsx");
const manifest = await read("package.json");

check(
  "a spelling is dealt with in the field, not in the little box",
  !companion.includes("spellingProblems") &&
    !companion.includes("fixSpelling") &&
    !companion.includes("applyFixes") &&
    !box.includes('"spelling"') &&
    !box.includes("fixWords"),
);
check(
  "…and everything that used to do it is gone, not merely unused",
  (await readOrNull("src/lib/companion/fix.ts")) === null &&
    (await readOrNull("src/components/SpellCheckLayer.tsx")) === null &&
    (await readOrNull("src/hooks/use-spellcheck.ts")) === null &&
    (await readOrNull("public/spell/en.dic")) === null &&
    !manifest.includes('"nspell"'),
);
check(
  "the one rule is which fields hold prose, and it is stated once",
  spell.includes("export function spellsProse") &&
    spell.includes("export function proseField") &&
    spell.includes('element.dataset.spell === "off"') &&
    spell.includes('new Set(["text", "search"])'),
);
check(
  // The rule itself, walked rather than read: which kinds of field the browser
  // is allowed to spell. It is the one decision this app still makes about
  // spelling, so it is the one thing here worth walking case by case.
  "…and it answers for each kind of field, prose and value alike",
  spellsProse("text") &&
    spellsProse("search") &&
    spellsProse(undefined) && // an input with no type
    spellsProse(null) && // a <textarea>, which has no type at all
    !spellsProse("password") &&
    !spellsProse("email") &&
    !spellsProse("number") &&
    !spellsProse("text", "off") &&
    !spellsProse(null, "off"),
);
check(
  "…and the fields turn it into the browser's own checker",
  input.includes("spellCheck={spellCheck ?? prose}") &&
    textarea.includes("spellCheck={spellCheck ?? prose}") &&
    // Nothing may be left with the browser's checker off by default: that was
    // the arrangement this replaced, and it is the difference between a field
    // that is spelled and one that only looks spelled.
    !input.includes("spellCheck ?? false") &&
    !textarea.includes("spellCheck ?? false"),
);
check(
  "…and a field that holds a value says so, wherever it lives",
  (await read("src/components/HubAddressPanel.tsx")).includes(
    'data-spell="off"',
  ) &&
    (await read("src/components/forge/IntegrationBoxes.tsx")).includes(
      'data-spell="off"',
    ) &&
    (await read("src/components/BuilderMirror.tsx")).includes(
      'data-spell="off"',
    ),
);
check(
  "a real alert reaches the box even with no key at all",
  nudge.includes('pushNote({ kind: "alert"') &&
    nudge.includes('from "@/lib/companion/notes"'),
);
check(
  "the companion is not offered as a place to share to — it has no page",
  chat.includes('Exclude<ChatRoom, "companion">') &&
    share.includes("Record<BoxRoom, string>") &&
    !share.includes("companion:"),
);

console.log(
  failures === 0
    ? "\nEvery companion check passed."
    : `\n${failures} companion check(s) failed.`,
);

// An explicit status, rather than the event loop draining: a script that only
// exited on failure would hang here with every check green.
process.exit(failures === 0 ? 0 : 1);
