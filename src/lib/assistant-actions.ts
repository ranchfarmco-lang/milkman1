/**
 * The things the assistant can actually do from the page.
 * Timers, reminders and memories are stored by the server; everything else
 * happens here, on the device, when the reply arrives.
 */

import type { CalendarKind } from "@/convex/schema";
import { buzz, notifyMessage } from "@/lib/alerts";
import { CALENDAR_KINDS } from "@/lib/calendar";

export type AssistantAction = Record<string, unknown> & { type: string };

/** Who an entry the assistant wrote is for. */
export type Audience = "private" | "group" | "family";

/** The kinds the calendar holds. The list lives in the shared helper, so an
 * action can be checked before it is handed to the server, which refuses
 * anything outside the same set. */
export type EventKind = CalendarKind;

export type EventDraft = {
  kind: EventKind;
  title?: string;
  startsAt: string | number;
  endsAt?: string | number;
  allDay?: boolean;
  location?: string;
  notes?: string;
  recipeUrl?: string;
  ingredients?: string[];
  place?: string;
  appointmentType?: string;
  audience: Audience;
  who: string[];
};

export type ActionContext = {
  navigate: (path: string) => void;
  setMyName: (name: string) => Promise<unknown>;
  // The calendar writes stay on the server, where the tiers are enforced and
  // where a name the model used can be matched to a real family member. The
  // page is only the hands that carry them there.
  createEvent: (draft: EventDraft) => Promise<unknown>;
  planShopping: (draft: {
    items: string[];
    storeAt?: string | number;
    leadMinutes?: number;
  }) => Promise<unknown>;
  onProblem?: (message: string) => void;
};

const APP_PAGES = [
  "assistant",
  "builder",
  "family",
  "messenger",
  "calendar",
  "control-room",
];

/** Keep only http(s) links, and add the scheme when it is missing. */
function normalizeUrl(raw: unknown) {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return null;

  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(value)
    ? value
    : `https://${value}`;

  try {
    const url = new URL(withScheme);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function textOf(value: unknown) {
  return typeof value === "string" ? value : "";
}

function numberOf(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * A list out of an action.
 *
 * Written either way round on purpose: the model is told to send a plain
 * comma-separated string, because an action's fields are kept to strings and
 * numbers on the way through the server, but a real array is accepted too so
 * an action written by hand still works.
 */
function listOf(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : typeof value === "string"
      ? value.split(/[,\n;]/)
      : [];

  return raw
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, 60);
}

/** A moment: an absolute number, or a wall-clock string the server reads. */
function momentOf(value: unknown): string | number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) return value.trim();
  return undefined;
}

const EVENT_KINDS: EventKind[] = CALENDAR_KINDS;

/** The kind the model named, or an ordinary appointment if it named none. */
function kindOf(value: unknown): EventKind {
  const wanted = textOf(value).trim().toLowerCase();
  return EVENT_KINDS.includes(wanted as EventKind)
    ? (wanted as EventKind)
    : "appointment";
}

/**
 * Who it is for, from however the model phrased it. Only "not everybody" has
 * to be said deliberately — anything unrecognised goes to the family, which is
 * what the box has always done.
 */
function audienceOf(value: unknown): Audience {
  const wanted = textOf(value).trim().toLowerCase();
  if (["private", "personal", "just_me", "me", "only_me"].includes(wanted)) {
    return "private";
  }
  if (["group", "some", "few", "a_few", "select", "subgroup"].includes(wanted)) {
    return "group";
  }
  return "family";
}

/**
 * Pop a notification, asking for permission the first time. Silence and Do Not
 * Disturb in the Control Room are respected, as is the preview switch.
 */
export async function sendNotification(title: string, body: string) {
  await notifyMessage(title, body);
}

async function setFullscreen(on: boolean) {
  if (on && !document.fullscreenElement) {
    await document.documentElement.requestFullscreen();
  } else if (!on && document.fullscreenElement) {
    await document.exitFullscreen();
  }
}

export function toActions(raw: unknown): AssistantAction[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (item): item is AssistantAction =>
      Boolean(item) &&
      typeof item === "object" &&
      typeof (item as { type?: unknown }).type === "string",
  );
}

/**
 * Run every action the assistant asked for, one at a time, so one failure
 * never blocks the rest.
 */
export async function runActions(
  actions: AssistantAction[],
  context: ActionContext,
) {
  for (const action of actions) {
    try {
      switch (action.type) {
        case "open_url": {
          const url = normalizeUrl(action.url);
          if (url) window.open(url, "_blank", "noopener,noreferrer");
          break;
        }
        case "search_web": {
          const query = textOf(action.query);
          if (query) {
            window.open(
              `https://www.google.com/search?q=${encodeURIComponent(query)}`,
              "_blank",
              "noopener,noreferrer",
            );
          }
          break;
        }
        case "copy": {
          const value = textOf(action.text);
          if (value) await navigator.clipboard.writeText(value);
          break;
        }
        case "notify":
          await sendNotification(
            textOf(action.title) || "Your assistant",
            textOf(action.body),
          );
          break;
        case "go_to": {
          const page = textOf(action.page);
          if (APP_PAGES.includes(page)) context.navigate(`/${page}`);
          break;
        }
        case "add_event": {
          // "starts_at" is what the model is told to write; the other spellings
          // are here because models vary, and a wrong one would otherwise mean
          // silently dropping the entry.
          const startsAt = momentOf(
            action.starts_at ?? action.startsAt ?? action.start ?? action.when,
          );
          if (startsAt === undefined) break;

          await context.createEvent({
            kind: kindOf(action.kind),
            title: textOf(action.title) || undefined,
            startsAt,
            endsAt: momentOf(action.ends_at ?? action.endsAt),
            allDay: action.all_day === true || action.allDay === true,
            location: textOf(action.location) || undefined,
            notes: textOf(action.notes) || undefined,
            recipeUrl: textOf(action.recipe_url ?? action.recipeUrl) || undefined,
            ingredients: listOf(action.ingredients),
            place: textOf(action.place) || undefined,
            appointmentType:
              textOf(action.appointment_type ?? action.appointmentType) ||
              undefined,
            audience: audienceOf(action.audience ?? action.for ?? action.who_sees),
            who: listOf(action.who ?? action.attendees ?? action.for_people),
          });
          break;
        }
        case "shopping": {
          const items = listOf(action.items ?? action.text);
          if (!items.length) break;

          await context.planShopping({
            items,
            storeAt: momentOf(
              action.store_at ?? action.storeAt ?? action.at ?? action.when,
            ),
            leadMinutes: numberOf(
              action.lead_minutes ?? action.leadMinutes,
              30,
            ),
          });
          break;
        }
        case "set_my_name": {
          const name = textOf(action.name).trim();
          if (name) await context.setMyName(name);
          break;
        }
        case "fullscreen":
          await setFullscreen(action.on !== false);
          break;
        case "vibrate": {
          const ms = Math.min(2000, Math.max(50, numberOf(action.milliseconds, 300)));
          buzz(ms);
          break;
        }
        default:
          // timer, reminder, remember and forget are already stored by the server.
          break;
      }
    } catch (error) {
      context.onProblem?.(
        error instanceof Error
          ? error.message
          : "The browser refused that action.",
      );
    }
  }
}
