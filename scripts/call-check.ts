/**
 * The call surfaces, walked through the cases that decide where a call is.
 *
 * Three things went wrong often enough in one draft of this to be worth a check
 * of their own, and all three are decided by pure functions in
 * `src/lib/call-surfaces.ts`:
 *
 *   1. **what a tab may show.** A live call row is not a call this tab is in. A
 *      closed tab, a killed browser or the same account open on a second device
 *      leaves a membership behind, and treating that as "a call" is what put a
 *      call panel over the whole hub the moment it was opened.
 *   2. **where the picture goes.** The Messenger's own portals while that page
 *      is open, a movable box on every other page, and a panel that is only ever
 *      a ring or the picker. Closing the panel must never be a hang-up.
 *   3. **where a box may sit.** Dragged to the edge, on a phone, with a window
 *      smaller than the box itself — the box has to stay reachable, title bar
 *      included, or it can never be dragged back.
 *
 * The last section reads the wiring out of the source, in the same spirit as
 * `scripts/access-check.ts`: "there is only one of this" is exactly the property
 * an innocuous-looking edit can quietly undo.
 *
 * Ringing somebody *into* a call is walked for real, through the handler the
 * deployment runs (`calls.invite`), against a context that stands in for the
 * database — the same trick `scripts/relay-check.ts` uses on the relay. The
 * rules there are the ones a person feels at once if they are wrong: somebody
 * already on the call is not rung twice, a call holds four, only somebody on it
 * can open it, and nobody outside the family is pulled in.
 *
 * Run with: bun scripts/call-check.ts
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { invite } from "../src/convex/calls";

import {
  callBoxSize,
  callPanel,
  callSurface,
  clampSpot,
  heldCall,
  isMine,
  notYetOn,
  onCall,
  ringLine,
  screenBoxSize,
  screenLabel,
  shareLine,
  startSpot,
} from "../src/lib/call-surfaces";

const ROOT = new URL("..", import.meta.url).pathname;

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

async function source(path: string) {
  return await readFile(join(ROOT, path), "utf8");
}

/* ------------------------------------------- what this tab may show at all */

/** A live call, as the server reports it, with a name for the tab that joined. */
function live(over: Partial<{ callId: string; incoming: boolean }> = {}) {
  return { callId: "c1", incoming: false, ...over };
}

check("a call this tab joined is this tab's", isMine(live(), "c1"));
check(
  "a call ringing at this tab is this tab's",
  isMine(live({ incoming: true }), null),
);
check(
  "a membership a closed tab left is not this tab's",
  !isMine(live(), null),
);
check("nor is the same account on another call", !isMine(live({ callId: "c2" }), "c1"));
check(
  "a tab with nothing live has nothing",
  !isMine(null, "c1") && !isMine(undefined, "c1"),
);
check(
  "the name of a call that is over is not a call",
  !isMine(live({ callId: "c1" }), "c0"),
);

check(
  "a membership left behind is offered as a line",
  heldCall(live(), null)?.callId === "c1",
);
check(
  "and not once it is the call this tab is in",
  heldCall(live(), "c1") === null,
);
check("a ring is never a line behind the panel", heldCall(live({ incoming: true }), null) === null);

/* ----------------------------------------------------- where it is drawn */

const onMessenger = { inCall: true, kind: "video" as const, onMessenger: true, poppedOut: false };

check(
  "a video call on the Messenger is the page's own portals",
  callSurface(onMessenger) === "page",
);
check(
  "taken out of the page it is the movable box",
  callSurface({ ...onMessenger, poppedOut: true }) === "box",
);
check(
  "a voice call is the box even on the Messenger",
  callSurface({ ...onMessenger, kind: "audio" }) === "box",
);
check(
  "any other page is the box",
  callSurface({ ...onMessenger, onMessenger: false }) === "box",
);
check(
  "and no call is no surface at all",
  callSurface({ ...onMessenger, inCall: false }) === "none",
);

/* --------------------------------------------------------- what it shows */

check(
  "a ring raises the panel",
  callPanel({ incoming: true, picker: false, ringInRoom: false }) === "incoming",
);
check(
  "a ring beats a picker that is already open",
  callPanel({ incoming: true, picker: true, ringInRoom: false }) === "incoming",
);
check(
  "on the Messenger a video ring is answered in the room itself",
  callPanel({ incoming: true, picker: false, ringInRoom: true }) === "none",
);
check(
  "the picker is the panel when nothing is ringing",
  callPanel({ incoming: false, picker: true, ringInRoom: false }) === "picker",
);
check(
  "nothing raises nothing",
  callPanel({ incoming: false, picker: false, ringInRoom: false }) === "none",
);

/* ------------------------------------------------------- where a box sits */

const desktop = { width: 1280, height: 720 };
const video = callBoxSize("video", desktop, false);
const audio = callBoxSize("audio", desktop, false);

check("the call box fits the window it is in", video.width <= 1280 && video.height <= 720);
check("a voice call takes less room than a face", audio.height < video.height);
check(
  "folded away, a call is a title bar and nothing else",
  callBoxSize("video", desktop, true).height <= 40,
);
check(
  "on a phone the box is the phone's width, not wider",
  callBoxSize("video", { width: 320, height: 640 }, false).width <= 320,
);
check(
  "the screen portal is wider than the call it belongs to",
  screenBoxSize(desktop).width > video.width,
);

const start = startSpot(video, desktop, 0);
check(
  "a box starts out of the way, bottom-right",
  start.left > desktop.width / 2 && start.top > desktop.height / 2,
);
check(
  "a second box stacks above the first instead of covering it",
  startSpot(screenBoxSize(desktop), desktop, 1).top < start.top,
);

const draggedOff = clampSpot({ left: -4000, top: 4000 }, video, desktop);
check(
  "dragged hard at the corner, a box stops at the edge",
  draggedOff.left === 0 && draggedOff.top === desktop.height - video.height,
);
const tooBig = clampSpot({ left: 60, top: 60 }, { width: 2000, height: 900 }, desktop);
check(
  "a box bigger than the window is pinned to the top-left, not pushed off it",
  tooBig.left === 0 && tooBig.top === 0,
);

/* -------------------------------------------------------- ringing somebody */

/** A call with two on it and one being rung. */
const onTheCall = [
  { userId: "me", state: "joined" },
  { userId: "ana", state: "ringing" },
  { userId: "dan", state: "joined" },
];

check("somebody on the call reads as on it", onCall(onTheCall, "dan") === "joined");
check(
  "somebody being rung reads as being rung",
  onCall(onTheCall, "ana") === "ringing",
);
check(
  "and somebody who is not on it reads as neither",
  onCall(onTheCall, "kim") === "none",
);
check(
  "a ring only reaches the people it can reach",
  notYetOn(onTheCall, ["ana", "dan", "kim"]).join(",") === "kim",
  "ringing somebody twice is not a ring",
);
check(
  "the ring says who, or how many — and nothing when there is nobody",
  ringLine(["Ana"]) === "Ringing Ana…" &&
    ringLine(["Ana", "Dan"]) === "Ringing Ana and Dan…" &&
    ringLine(["a", "b", "c"])?.includes("3") === true &&
    ringLine([]) === null,
);

/* -------------------------------------------- ringing, as the server runs it */

type Row = Record<string, unknown>;

/**
 * A deployment, as far as `calls.invite` is concerned: rows in tables, and the
 * one query it makes (`by_call`, compared field by field). Ids carry their
 * table, so `get` needs nothing else.
 */
function harness() {
  const tables = new Map<string, Map<string, Row>>();
  let seq = 0;

  const table = (name: string) => {
    let rows = tables.get(name);
    if (!rows) {
      rows = new Map();
      tables.set(name, rows);
    }
    return rows;
  };

  const db = {
    get: async (id: string) => table(id.split(":")[0]).get(id) ?? null,
    insert: async (name: string, doc: Row) => {
      const id = `${name}:${++seq}`;
      table(name).set(id, { _id: id, ...doc });
      return id;
    },
    patch: async (id: string, fields: Row) => {
      const row = table(id.split(":")[0]).get(id);
      if (!row) throw new Error(`no row ${id}`);
      Object.assign(row, fields);
      return null;
    },
    query: (name: string) => ({
      withIndex: (
        _index: string,
        build: (q: { eq: (field: string, value: unknown) => unknown }) => unknown,
      ) => {
        const wanted: Row = {};
        const builder = {
          eq: (field: string, value: unknown) => {
            wanted[field] = value;
            return builder;
          },
        };
        build(builder);
        return {
          take: async (limit: number) =>
            [...table(name).values()]
              .filter((row) =>
                Object.entries(wanted).every(
                  ([field, value]) => row[field] === value,
                ),
              )
              .slice(0, limit),
        };
      },
    }),
  };

  return {
    db,
    rows: (name: string) => [...table(name).values()],
    add: (name: string, id: string, row: Row) => {
      table(name).set(id, { _id: id, ...row });
      return id;
    },
  };
}

/** The handler the deployment registers, called with a context of our own. */
const inviteHandler = (
  invite as unknown as {
    _handler: (
      ctx: unknown,
      args: { callId: string; to: string[] },
    ) => Promise<number>;
  }
)._handler;

function callContext(store: ReturnType<typeof harness>, me: string | null) {
  return {
    auth: { getUserIdentity: async () => (me ? { subject: me } : null) },
    db: store.db,
  };
}

/** A family, a call going on, and whoever is on it. */
function ringingSetup() {
  const store = harness();
  store.add("users", "users:me", { familyId: "families:1" });
  store.add("users", "users:ana", { familyId: "families:1" });
  store.add("users", "users:dan", { familyId: "families:1" });
  store.add("users", "users:kim", { familyId: "families:1" });
  store.add("users", "users:out", { familyId: "families:2" });
  store.add("calls", "calls:1", {
    familyId: "families:1",
    kind: "video",
    startedBy: "users:me",
    state: "active",
    createdAt: Date.now(),
  });
  store.add("callMembers", "callMembers:me", {
    callId: "calls:1",
    userId: "users:me",
    state: "joined",
    at: Date.now(),
  });
  store.add("callMembers", "callMembers:dan", {
    callId: "calls:1",
    userId: "users:dan",
    state: "joined",
    at: Date.now(),
  });
  return store;
}

const memberRow = (store: ReturnType<typeof harness>, userId: string) =>
  store
    .rows("callMembers")
    .find((row) => row.userId === userId && row.callId === "calls:1");

const ring = (store: ReturnType<typeof harness>, me: string, to: string[]) =>
  inviteHandler(callContext(store, me), { callId: "calls:1", to });

{
  const store = ringingSetup();
  check(
    "ringing somebody into a call that is up really rings them",
    (await ring(store, "users:me", ["users:ana"])) === 1 &&
      memberRow(store, "users:ana")?.state === "ringing",
  );
  check(
    "and asking again asks once",
    (await ring(store, "users:me", ["users:ana"])) === 0 &&
      store.rows("callMembers").filter((row) => row.userId === "users:ana")
        .length === 1,
    "a double tap must not produce two rings",
  );
  check(
    "somebody already on the call is left exactly as they are",
    (await ring(store, "users:me", ["users:dan"])) === 0 &&
      memberRow(store, "users:dan")?.state === "joined",
  );
  check(
    "the caller does not ring themselves",
    (await ring(store, "users:me", ["users:me"])) === 0,
  );
  check(
    "somebody outside the family cannot be pulled in",
    (await ring(store, "users:me", ["users:out"])) === 0 &&
      memberRow(store, "users:out") === undefined,
  );

  // Asked back rather than left out: a person who stepped out is ringable again.
  await store.db.patch("callMembers:dan", { state: "left" });
  check(
    "somebody who stepped out is asked back",
    (await ring(store, "users:me", ["users:dan"])) === 1 &&
      memberRow(store, "users:dan")?.state === "ringing",
  );

  let refused = "";
  try {
    await ring(store, "users:ana", ["users:kim"]);
  } catch (error) {
    refused = error instanceof Error ? error.message : String(error);
  }
  check(
    "only somebody on the call can ring into it",
    refused.includes("Only somebody on the call"),
    refused || "nobody was refused",
  );

  // Four is the ceiling: two joined and two being rung is a full call.
  const full = ringingSetup();
  for (const [id, who] of [
    ["callMembers:ana", "users:ana"],
    ["callMembers:kim", "users:kim"],
  ] as const) {
    full.add("callMembers", id, {
      callId: "calls:1",
      userId: who,
      state: "ringing",
      at: Date.now(),
    });
  }
  full.db.patch("callMembers:dan", { state: "joined" });
  full.add("users", "users:li", { familyId: "families:1" });
  check(
    "a fifth person cannot be rung into a full call",
    (await ring(full, "users:me", ["users:li"])) === 0 &&
      memberRow(full, "users:li") === undefined,
    "me, dan joined and ana, kim ringing is four already",
  );

  await store.db.patch("calls:1", { state: "ended" });
  let over = "";
  try {
    await ring(store, "users:me", ["users:kim"]);
  } catch (error) {
    over = error instanceof Error ? error.message : String(error);
  }
  check("a call that is over cannot be rung into", over.includes("over"), over);
}

/* --------------------------------------------------------- what it's called */

check("my own screen says so", screenLabel("Ana", true) === "Your screen");
check("somebody else's screen carries their name", screenLabel("Ana", false) === "Ana's screen");
check(
  "a nameless sharer still reads",
  screenLabel("", false) === "Their screen" &&
    screenLabel(undefined, false) === "Their screen",
);
check(
  "a share line says who is sharing",
  shareLine("Ana", false).includes("Ana") && shareLine(null, false).includes("They"),
);

/* --------------------------------------------------- the wiring, in source */

const provider = await source("src/components/CallProvider.tsx");
check("the provider draws the movable windows", provider.includes("<CallWindows />"));
check(
  "where a call is drawn is the pure decision, not a condition here",
  provider.includes("callSurface({") && provider.includes("callPanel({"),
);
check(
  "closing the panel turns down a ring and nothing else",
  provider.includes("if (incoming) call.decline();"),
);
check(
  "the panel has no way to hang a call up in it",
  !provider.includes("call.hangUp"),
  "hanging up belongs to the call's own windows",
);

const engine = await source("src/hooks/use-call.ts");
check("a screen is really captured", engine.includes("getDisplayMedia("));
check(
  "the relay is told outright that a track is a screen",
  engine.includes("source: Track.Source.ScreenShare"),
);
check(
  "the direct path labels the stream a screen travels on",
  engine.includes('"screen-off"') && engine.includes("screenStreamsRef"),
);
check(
  "what a tab may show is the pure rule, and the tab records what it joined",
  engine.includes("isMine(live, session)") &&
    engine.includes("heldCall(live, session)") &&
    engine.includes("setJoinedHere("),
);

const stage = await source("src/components/VideoStage.tsx");
check(
  "every seat carries its own share option",
  stage.includes("onShareScreen") && stage.includes("onWatchScreen"),
);
check(
  "the call can be taken out of the page from the stage",
  stage.includes("In a box") && stage.includes("api.popOut"),
);

const room = await source("src/components/ConferenceRoom.tsx");
check(
  "a call a closed tab left behind is offered back, not popped over the app",
  room.includes("Get back on") && room.includes("Leave it"),
);

const shell = await source("src/pages/AppShell.tsx");
check(
  "the shell holds the call, so leaving a page cannot unmount it",
  shell.includes("<CallProvider>"),
  "a call belongs to the app, not to the page it started on",
);

const windows = await source("src/components/CallWindows.tsx");
check(
  "both boxes are draggable",
  windows.includes("setPointerCapture") && windows.includes("clampSpot("),
);
check(
  "a shared screen opens in a portal of its own",
  windows.includes("function ScreenPortal") && windows.includes("requestFullscreen"),
);
check(
  "the portal is drawn whatever the call's own surface is",
  windows.includes("const watching = api.screenOpen") &&
    windows.includes("{watching ? ("),
  "a screen beside the portals on the Messenger, and beside the box everywhere else",
);
check(
  "a live call is never a dialog: the page underneath stays usable",
  !windows.includes("Dialog") && provider.includes('open={panel !== "none"}'),
);
check(
  "hanging up is offered where the call is drawn, and nowhere else",
  windows.includes("onClick={call.hangUp}") &&
    stage.includes("call.hangUp") &&
    !provider.includes("call.hangUp"),
);
check(
  "navigating is not a hang-up: nothing on a route change ends a call",
  !shell.includes("call.hangUp") &&
    !shell.includes("leaveCall") &&
    !(await source("src/main.tsx")).includes("hangUp"),
);

const backend = await source("src/convex/calls.ts");
check(
  "the backend accepts the two lines that label a screen",
  backend.includes('v.literal("screen")') && backend.includes('v.literal("screen-off")'),
);
check(
  "the backend can ring people into a call that is already up",
  backend.includes("export const invite = mutation("),
  "ringing again must not end the call you are on",
);
check(
  "and only somebody already on the call can",
  backend.includes('mine.state !== "joined"') &&
    backend.includes("user.familyId !== call.familyId"),
);
check(
  "ringing into a call is capped at the four the grid draws",
  backend.includes("MAX_CALL_PARTICIPANTS - joined - ringing"),
);
check(
  "somebody already being rung is asked once, not twice",
  backend.includes('existing.state === "ringing" || existing.state === "joined"'),
);

const messenger = await source("src/components/MessengerCall.tsx");
check(
  "the messenger header rings the others once you are on a call",
  messenger.includes("Ring someone into the call") &&
    messenger.includes("openPicker(kind)"),
);
check(
  "the picker rings into the live call instead of starting another",
  provider.includes("ringInto(") &&
    provider.includes("notYetOn(people") &&
    provider.includes("Ring someone into this call"),
);
check(
  "each portal in the room rings its own person",
  room.includes("Ring ${member.name}") &&
    room.includes('ringOne("video", member._id)'),
);
check(
  "a person being rung is drawn as rung, never as a blank seat",
  stage.includes("Ringing…") && stage.includes("ringLine(ringing.map"),
);
check(
  "an empty seat is where the rest are rung from",
  stage.includes("Ring someone"),
);
check(
  "the call's own box can ring somebody in from any page",
  windows.includes("Ring someone into the call") &&
    windows.includes("api.openPicker(call.kind)"),
);

console.log(
  failures === 0
    ? "\nEvery call-surface check passed."
    : `\n${failures} call-surface check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
