/**
 * Copy, paste, and sending something from one box to another.
 *
 * Every one of these stays inside the hub. Copy puts text on the clipboard the
 * same way the browser's own copy does, paste reads it back, and sharing moves
 * content between the boxes with no share sheet, no mail client and no other
 * app involved.
 */
import type { ChatRoom } from "@/hooks/use-chat";

/** Where each box lives, so its link is one string away. */
export const BOX_PATHS: Record<ChatRoom, string> = {
  assistant: "/assistant",
  builder: "/builder",
  messenger: "/messenger",
};

const BOX_TITLES: Record<ChatRoom, string> = {
  assistant: "AI Assistant",
  builder: "AI Builder",
  messenger: "Family Messenger",
};

export function boxTitle(room: ChatRoom) {
  return BOX_TITLES[room];
}

/** The address of one box, for the Link button. */
export function boxLink(room: ChatRoom) {
  if (typeof window === "undefined") return BOX_PATHS[room];
  return `${window.location.origin}${BOX_PATHS[room]}`;
}

/** Every box except this one — the only places a share can be sent. */
export function otherBoxes(room: ChatRoom): ChatRoom[] {
  return (Object.keys(BOX_PATHS) as ChatRoom[]).filter((key) => key !== room);
}

/**
 * Put text on the clipboard. `navigator.clipboard` needs a secure context, so
 * there is a plain textarea fallback for anywhere it is not allowed.
 */
export async function copyText(text: string) {
  const clean = text.trim();
  if (!clean) return false;

  try {
    await navigator.clipboard.writeText(clean);
    return true;
  } catch {
    // Older browsers and plain http: the old trick still works.
  }

  try {
    const field = document.createElement("textarea");
    field.value = clean;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.top = "-1000px";
    document.body.appendChild(field);
    field.select();
    const done = document.execCommand("copy");
    field.remove();
    return done;
  } catch {
    return false;
  }
}

/** What is on the clipboard, or null when the browser will not say. */
export async function readClipboard(): Promise<string | null> {
  try {
    return await navigator.clipboard.readText();
  } catch {
    return null;
  }
}

const HANDOFF_KEY = "family-chat-hub:handoff";
const HANDOFF_MAX_AGE = 10 * 60 * 1000;

/** A box listens for this and picks the content up. */
export const HANDOFF_EVENT = "family-chat-hub:handoff";

/**
 * One parking space per box. With a single shared key, sending something to the
 * assistant and then to the builder before either was opened would quietly lose
 * the first send; this way each box has its own and both arrive.
 */
function handoffKey(room: ChatRoom) {
  return `${HANDOFF_KEY}:${room}`;
}

/**
 * Send content to another box. It is parked for that box to pick up, which is
 * what makes a share work whether the other box is open in another pane or the
 * person walks over to it a minute later.
 */
export function shareToBox(room: ChatRoom, text: string) {
  const clean = text.trim();
  if (!clean) return false;

  try {
    window.localStorage.setItem(
      handoffKey(room),
      JSON.stringify({ room, text: clean, at: Date.now() }),
    );
    window.dispatchEvent(new Event(HANDOFF_EVENT));
    return true;
  } catch {
    // A browser with storage switched off can still be told no.
    return false;
  }
}

/** Take the content waiting for this box, if any. It is claimed only once. */
export function takeHandoff(room: ChatRoom): string | null {
  const key = handoffKey(room);

  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as {
      room?: ChatRoom;
      text?: string;
      at?: number;
    };

    if (parsed.room !== room || !parsed.text) return null;
    if (Date.now() - (parsed.at ?? 0) > HANDOFF_MAX_AGE) {
      window.localStorage.removeItem(key);
      return null;
    }

    window.localStorage.removeItem(key);
    return parsed.text;
  } catch {
    return null;
  }
}
