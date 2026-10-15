/**
 * Where a call is drawn, and how the boxes that carry it are placed.
 *
 * These used to be decided inside the provider, tangled up with the query that
 * says a call is live on the server. They are pulled out because they are the
 * two things a person notices immediately and cannot debug from the outside:
 *
 *   1. **What this tab may show.** A live call row is not the same thing as a
 *      call this tab is in. A closed tab, a killed browser, or the same account
 *      open on a second device leaves a membership behind, and treating that as
 *      "a call" is what put a call panel over the hub the moment it was opened.
 *      A tab is in a call it started, joined or answered itself — or one ringing
 *      at it, which it has to see in order to answer.
 *   2. **Where the picture goes.** In the Messenger the call belongs to the
 *      page's portals, beside the chat. The moment that page is left — or the
 *      call is asked to come out of the page — the same live call is drawn in a
 *      box that follows you across the hub, and dragging it puts it wherever it
 *      is out of the way. Nothing about that changes the media: the call is
 *      held by the shell, so the picture, the sound and a shared screen all
 *      survive every tab change.
 *
 * Both are pure functions of what the provider knows. That is what makes the
 * awkward cases — a box wider than the window, a second box stacked above the
 * first, a ring arriving while the picker is already open — checkable without a
 * browser. `bun run test:calls` walks them.
 */

/** Where a live call is drawn right now. */
export type CallSurface = "page" | "box" | "none";

/** The momentary panel a tab may raise: a ring, or the list of who to call. */
export type CallPanel = "incoming" | "picker" | "none";

/** A position in the window, in pixels from its top-left corner. */
export type Spot = { left: number; top: number };

/** How big something is, in pixels. */
export type Size = { width: number; height: number };

/** The gap between a box and the edge, and between one box and the next. */
export const BOX_EDGE = 14;
export const BOX_GAP = 12;

/** The bar along the top of a box: enough to hold its name and its buttons. */
const BOX_BAR = 40;

function clamp(value: number, low: number, high: number) {
  return Math.min(Math.max(value, low), Math.max(low, high));
}

/**
 * Whether a live call belongs to this tab.
 *
 * `joinedHere` is the call this tab itself started, joined or answered. The one
 * other thing a tab shows is a call ringing at it: a ring is somebody waiting,
 * and it cannot be answered by a tab that pretends not to see it.
 */
export function isMine(
  current: { callId: string; incoming: boolean } | null | undefined,
  joinedHere: string | null,
): boolean {
  if (!current) return false;
  return current.incoming || current.callId === joinedHere;
}

/**
 * The live call a closed tab left behind: this account is still a member of
 * something this tab never joined. It belongs in the Messenger as a plain line
 * — "you are still on it, get back on or leave it" — never as a panel over
 * whatever page is open.
 */
export function heldCall<T extends { callId: string; incoming: boolean }>(
  current: T | null | undefined,
  joinedHere: string | null,
): T | null {
  if (!current || isMine(current, joinedHere)) return null;
  return current;
}

/**
 * The surface a live call is drawn on. A video call on the Messenger is the
 * page's own four portals; everything else — a call on any other page, a voice
 * call, a page that has handed the call to its box — is the movable box, which
 * is the only shape that lets the calendar, the assistant and the browser stay
 * usable underneath.
 */
export function callSurface({
  inCall,
  kind,
  onMessenger,
  poppedOut,
}: {
  inCall: boolean;
  kind: "audio" | "video";
  onMessenger: boolean;
  poppedOut: boolean;
}): CallSurface {
  if (!inCall) return "none";
  if (kind === "video" && onMessenger && !poppedOut) return "page";
  return "box";
}

/**
 * The panel to raise, if any. A ring beats a picker that happens to be open —
 * somebody is waiting to be answered, and the picker will still be there.
 *
 * On the Messenger a video ring is answered in the room's own portals, so no
 * panel is raised there: that page already shows who is calling and the button
 * that joins them.
 */
export function callPanel({
  incoming,
  picker,
  ringInRoom,
}: {
  incoming: boolean;
  picker: boolean;
  ringInRoom: boolean;
}): CallPanel {
  if (incoming) return ringInRoom ? "none" : "incoming";
  return picker ? "picker" : "none";
}

/** How big the call box is, for the kind of call and the window it sits in. */
export function callBoxSize(
  kind: "audio" | "video",
  viewport: Size,
  collapsed: boolean,
): Size {
  const width = Math.min(kind === "video" ? 360 : 320, viewport.width - BOX_EDGE * 2);
  if (collapsed) return { width, height: BOX_BAR };
  const height =
    kind === "video"
      ? Math.min(300, viewport.height - BOX_EDGE * 2)
      : Math.min(168, viewport.height - BOX_EDGE * 2);
  return { width, height: Math.max(BOX_BAR, height) };
}

/** How big the portal that carries a shared screen is. */
export function screenBoxSize(viewport: Size): Size {
  return {
    width: Math.min(560, viewport.width - BOX_EDGE * 2),
    height: Math.min(380, viewport.height - BOX_EDGE * 2),
  };
}

/**
 * Where a box starts: bottom-right, and stacked upward from there so a second
 * box (a shared screen, say) does not land on top of the call it belongs to.
 */
export function startSpot(size: Size, viewport: Size, index = 0): Spot {
  return {
    left: Math.max(0, viewport.width - size.width - BOX_EDGE),
    top: Math.max(
      0,
      viewport.height - size.height - BOX_EDGE - index * (size.height + BOX_GAP),
    ),
  };
}

/**
 * Keep a box inside the window. A box bigger than the window is pinned to the
 * top-left rather than pushed off it, which is the difference between a screen
 * too wide to fit and a screen with its title bar somewhere off the edge and no
 * way to drag it back.
 */
export function clampSpot(spot: Spot, size: Size, viewport: Size): Spot {
  return {
    left: clamp(spot.left, 0, viewport.width - size.width),
    top: clamp(spot.top, 0, viewport.height - size.height),
  };
}

/** Where somebody stands on a call, as the picker and the seats read it. */
export type OnCall = "joined" | "ringing" | "none";

/**
 * Where a person stands on a call: on it, being rung, or neither.
 *
 * `people` is the call's own list, which leaves out anybody who turned it down
 * or stepped out — so "none" is exactly the person a ring would reach, and the
 * one the picker leaves enabled.
 */
export function onCall(
  people: { userId: string; state: string }[],
  userId: string,
): OnCall {
  const them = people.find((one) => one.userId === userId);
  if (!them) return "none";
  return them.state === "joined" || them.state === "ringing" ? them.state : "none";
}

/**
 * The people a ring would actually reach: everybody asked for who is not
 * already on the call and not already being rung. Ringing the same person twice
 * is a no-op on the server, so this is the list worth reporting a count for.
 */
export function notYetOn(
  people: { userId: string; state: string }[],
  ids: string[],
): string[] {
  return ids.filter((id) => onCall(people, id) === "none");
}

/** "Ringing Ana…", "Ringing Ana and Dan…", or a count — and nothing for nobody. */
export function ringLine(names: (string | null | undefined)[]): string | null {
  const who = names.filter((name): name is string => Boolean(name));
  if (who.length === 0) return null;
  if (who.length === 1) return `Ringing ${who[0]}…`;
  if (who.length === 2) return `Ringing ${who[0]} and ${who[1]}…`;
  return `Ringing ${who.length} people…`;
}

/** What a shared screen is called in its portal's title bar. */
export function screenLabel(
  name: string | null | undefined,
  mine: boolean,
): string {
  if (mine) return "Your screen";
  const who = name?.trim();
  return who ? `${who}'s screen` : "Their screen";
}

/** The line under a seat whose screen is on: who is sharing, in plain words. */
export function shareLine(name: string | null | undefined, mine: boolean) {
  if (mine) return "Your screen is on";
  const who = name?.trim() || "They";
  return `${who} is sharing their screen`;
}
