import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { isUnlocked, requireUnlocked } from "./guard";
import {
  calendarAudienceValidator,
  calendarCostStatusValidator,
  calendarKindValidator,
  calendarLayerValidator,
  calendarPriorityValidator,
  type CalendarAudience,
  type CalendarKind,
  type CalendarLayer,
} from "./schema";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { insertReminder } from "./reminders";
import type { AuctionEvent, Briefing, Source } from "./briefing";

/**
 * The family calendar.
 *
 * Everything here is stored as an instant in milliseconds, never as a
 * wall-clock string. A timezone is therefore a way of reading the same rows,
 * not a property of them: switch the page to another city and every card moves
 * with it, and nothing has to be rewritten.
 *
 * The shape of an entry is deliberately flat rather than a union of a dozen
 * row types. A dinner and a request for a ride are the same row with different
 * `layer` and `kind`, which is what lets the page show them in one grid, filter
 * them by layer, and let the assistant write both with one call.
 */

export const DEFAULT_TIME_ZONE = "America/Denver";
export const LAYERS: CalendarLayer[] = [
  "personal",
  "community",
  "meals",
  "bulletin",
  "assistant",
];
/** Nothing is ever read further than this from the range asked for. */
const RANGE_PAD_MS = 36 * 60 * 60 * 1000;
const MAX_RANGE_DAYS = 400;
const MAX_EVENTS = 600;
const MAX_INGREDIENTS = 40;
const DIGEST_DAYS = 7;

/* ------------------------------------------------------------ timezones */

type ZoneParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: string;
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function fallbackParts(instant: number): ZoneParts {
  const date = new Date(instant);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
    weekday: WEEKDAYS[date.getUTCDay()],
  };
}

/**
 * The wall clock in a named zone at a given instant.
 *
 * Convex runs a full V8 isolate, so `Intl` knows the world's timezones. It is
 * still wrapped, because a bad zone name must never take down a calendar read
 * or an AI turn — an unknown zone simply reads as UTC.
 */
function partsInZone(instant: number, timeZone: string): ZoneParts {
  try {
    const format = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });

    const out: Record<string, string> = {};
    for (const part of format.formatToParts(new Date(instant))) {
      if (part.type !== "literal") out[part.type] = part.value;
    }

    const year = Number(out.year);
    if (!Number.isFinite(year)) return fallbackParts(instant);

    return {
      year,
      month: Number(out.month),
      day: Number(out.day),
      // en-GB with hour12:false can hand back 24 for midnight.
      hour: Number(out.hour) % 24,
      minute: Number(out.minute),
      second: Number(out.second),
      weekday: out.weekday ?? WEEKDAYS[new Date(instant).getUTCDay()],
    };
  } catch {
    return fallbackParts(instant);
  }
}

/** How far ahead of UTC a zone is at a given instant, in milliseconds. */
function zoneOffset(instant: number, timeZone: string) {
  const parts = partsInZone(instant, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - instant;
}

/**
 * The instant at which a given wall clock happens in a zone.
 *
 * Done twice, because the offset itself depends on the instant: the first guess
 * picks the right side of a daylight-saving change, the second settles it.
 */
function instantFromWall(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
) {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  const first = wall - zoneOffset(wall, timeZone);
  const settled = wall - zoneOffset(first, timeZone);
  return Number.isFinite(settled) ? settled : wall;
}

function startOfDay(instant: number, timeZone: string) {
  const parts = partsInZone(instant, timeZone);
  return instantFromWall(
    parts.year,
    parts.month,
    parts.day,
    0,
    0,
    0,
    timeZone,
  );
}

function clockText(instant: number, timeZone: string, withDate = false) {
  const parts = partsInZone(instant, timeZone);
  const hour12 = parts.hour % 12 === 0 ? 12 : parts.hour % 12;
  const clock = `${hour12}:${String(parts.minute).padStart(2, "0")} ${
    parts.hour < 12 ? "AM" : "PM"
  }`;
  if (!withDate) return clock;
  return `${parts.weekday} ${MONTHS[parts.month - 1]} ${parts.day} at ${clock}`;
}

/* --------------------------------------------------------- bulletin cards */

/**
 * The words a request turns into. This is where a plain "I need a ride to the
 * clinic for a scan at 9" becomes the card the rest of the family sees.
 */
export function bulletinTitle(input: {
  kind: CalendarKind;
  place?: string | null;
  appointmentType?: string | null;
  notes?: string | null;
  at: string;
  meal?: string | null;
}) {
  const place = (input.place ?? "").trim() || "the appointment";
  const type = (input.appointmentType ?? "").trim();

  switch (input.kind) {
    case "ride":
      return `I need a ride to ${place}${
        type ? ` for ${type}` : ""
      } starting at ${input.at}. Is anyone available?`;
    case "moving":
      return `I need a hand moving at ${input.at} — is anyone available?`;
    case "babysitting":
      return `Can someone sit with the kids${type ? ` ${type}` : ""} at ${input.at}?`;
    case "delivery":
      return `Can someone run something to ${place} at ${input.at}?`;
    case "pickup":
      return `Can someone do a pickup at ${place} at ${input.at}?`;
    case "dropoff":
      return `Can someone do a drop-off at ${place} at ${input.at}?`;
    case "hauling":
      return `I have a carriage/horse driving job this afternoon at ${
        input.at
      } — is anyone available?`;
    case "childcare":
      return `Can someone watch the kids today / pick them up from school at ${input.at}?`;
    case "help":
      return `I could use a hand${
        type ? ` with ${type}` : ""
      } at ${input.at} — is anyone available?`;
    default:
      return (input.notes ?? "").trim() || "Something on the calendar";
  }
}

/** The buttons a request card offers, so the page and the AI agree. */
export function replyOptions(kind: CalendarKind) {
  switch (kind) {
    case "ride":
      return ["I can drive", "I can help"];
    case "hauling":
      return ["I can help", "I have a trailer"];
    case "childcare":
      return ["I can watch the kids", "I can do the pickup"];
    case "help":
      return ["I can help"];
    case "moving":
      return ["I can help move", "I have a truck"];
    case "babysitting":
      return ["I can babysit"];
    case "delivery":
      return ["I can run it over"];
    case "pickup":
      return ["I can do the pickup"];
    case "dropoff":
      return ["I can do the drop-off"];
    default:
      return [];
  }
}

/** Meals, and the shopping that feeds them. */
const MEAL_KINDS = new Set<CalendarKind>([
  "meal",
  "meal_prep",
  "breakfast",
  "lunch",
  "dinner",
  "snack",
  "baking",
  "potluck",
  "grocery",
]);

/** The kinds that ask the family for a hand. */
const REQUEST_KINDS = new Set<CalendarKind>([
  "ride",
  "childcare",
  "hauling",
  "help",
  "moving",
  "babysitting",
  "delivery",
  "pickup",
  "dropoff",
]);

/** Work, school and the shared things a household does together. */
const COMMUNITY_KINDS = new Set<CalendarKind>([
  "work",
  "shift",
  "meeting",
  "training",
  "volunteering",
  "school",
  "school_event",
  "parent_teacher",
  "class",
  "exam",
  "sports",
  "practice",
  "game",
  "lesson",
  "church",
  "worship",
  "community_event",
]);

/** Which layer an entry belongs in when nobody said. */
function layerForKind(kind: CalendarKind): CalendarLayer {
  if (MEAL_KINDS.has(kind)) return "meals";
  if (REQUEST_KINDS.has(kind)) return "bulletin";
  if (COMMUNITY_KINDS.has(kind)) return "community";
  return "personal";
}

/* ------------------------------------------------------------ reading back */

const eventArgs = {
  title: v.optional(v.string()),
  layer: v.optional(calendarLayerValidator),
  // who it is for, and — for a group — the people it is for
  audience: v.optional(calendarAudienceValidator),
  attendees: v.optional(v.array(v.id("users"))),
  attendeeNames: v.optional(v.array(v.string())),
  kind: calendarKindValidator,
  startsAt: v.number(),
  endsAt: v.optional(v.number()),
  allDay: v.optional(v.boolean()),
  timeZone: v.optional(v.string()),
  location: v.optional(v.string()),
  notes: v.optional(v.string()),
  recipeUrl: v.optional(v.string()),
  ingredients: v.optional(v.array(v.string())),
  place: v.optional(v.string()),
  appointmentType: v.optional(v.string()),
  // how much it wants to be noticed, and the money side of it
  priority: v.optional(calendarPriorityValidator),
  cost: v.optional(v.number()),
  costStatus: v.optional(calendarCostStatusValidator),
  paidBy: v.optional(v.string()),
  // a booking portal, a video call, or the recipe a meal came from
  link: v.optional(v.string()),
  // a single emoji beside the title, and how long before the start the alarm
  // rings (0 at the start; absent is no alarm)
  emoji: v.optional(v.string()),
  alarmMinutes: v.optional(v.number()),
  shared: v.optional(v.boolean()),
  source: v.optional(v.union(v.literal("manual"), v.literal("ai"))),
};

function clean(value: string | undefined | null, max: number) {
  const trimmed = (value ?? "").trim().replace(/\s+/g, " ");
  return trimmed ? trimmed.slice(0, max) : null;
}

/** A money amount, to the cent, or nothing if it was not a real one. */
function costOf(value: number | undefined | null) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.round(Math.min(value, 1_000_000) * 100) / 100;
}

/** An alarm lead time, capped at a week; anything else means there is none. */
function alarmOf(value: number | undefined | null) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.round(Math.min(value, 7 * 24 * 60));
}

/** A date in a zone, written the way the family writes one: MM/DD/YYYY. */
function mdy(instant: number, timeZone: string) {
  const parts = partsInZone(instant, timeZone);
  return `${String(parts.month).padStart(2, "0")}/${String(parts.day).padStart(
    2,
    "0",
  )}/${parts.year}`;
}

/**
 * The alarm an entry carries, as a reminder that rings ahead of it. Whatever
 * reminder the entry had before is removed first, so moving a time or clearing
 * an alarm can never leave a stray one behind.
 */
async function setAlarm(
  ctx: MutationCtx,
  args: {
    userId: Id<"users">;
    eventId: Id<"calendarEvents">;
    title: string;
    startsAt: number;
    timeZone: string;
    alarmMinutes: number | undefined;
    previousId: Id<"reminders"> | null;
  },
): Promise<Id<"reminders"> | undefined> {
  if (args.previousId) {
    const previous = await ctx.db.get(args.previousId);
    if (previous) await ctx.db.delete(args.previousId);
  }

  if (args.alarmMinutes === undefined) return undefined;

  return await insertReminder(ctx, {
    userId: args.userId,
    text: `${args.title} — ${mdy(args.startsAt, args.timeZone)} ${clockText(
      args.startsAt,
      args.timeZone,
    )}`,
    kind: "reminder",
    dueAt: args.startsAt - args.alarmMinutes * 60_000,
  });
}

/**
 * Who an entry is for, read back off what was written.
 *
 * The three tiers are the whole point of this file's privacy story. The old
 * `shared` flag still means something — an entry with it turned off has always
 * been one person's, so it keeps reading as private — and anything not said
 * out loud is the family's, which is what this box has always done.
 */
function audienceOf(args: {
  audience?: CalendarAudience;
  shared?: boolean;
}): CalendarAudience {
  if (args.audience) return args.audience;
  return args.shared === false ? "private" : "family";
}

/** The people named on an entry, ids and names, at most thirty of them. */
function attendeesOf(args: {
  attendees?: Id<"users">[];
  attendeeNames?: string[];
}) {
  const ids = Array.from(new Set(args.attendees ?? [])).slice(0, 30);
  const names = Array.from(
    new Set((args.attendeeNames ?? []).map((name) => clean(name, 80))),
  )
    .filter((name): name is string => name !== null)
    .slice(0, 30);

  return { ids, names };
}

/**
 * Names for the people named on an entry by id.
 *
 * A page picks people from the family list, so it hands over ids and the names
 * are read back here. That keeps a card from carrying a name that was right
 * when it was written and wrong after somebody renamed themselves.
 */
async function namesForIds(
  ctx: QueryCtx | MutationCtx,
  ids: Id<"users">[],
): Promise<string[]> {
  const names: string[] = [];

  for (const id of ids.slice(0, 30)) {
    const user = await ctx.db.get(id);
    if (user) names.push(user.name ?? user.email ?? "Guest");
  }

  return names;
}

/**
 * Is this entry the person reading is allowed to see?
 *
 * Enforced here, on the server, and not only on the page: a private entry is
 * its owner's alone, a group one belongs to the people named on it, and a
 * family one belongs to everyone in the household. An entry written before the
 * tiers existed has no `audience`, and its `shared` flag decides as it always
 * did.
 */
function visibleTo(
  row: Doc<"calendarEvents">,
  userId: Id<"users">,
): boolean {
  if (row.ownerId === userId) return true;

  const audience =
    row.audience ?? (row.shared ? "family" : "private");
  if (audience === "private") return false;
  if (audience === "group") return (row.attendees ?? []).includes(userId);
  return true;
}

async function viewer(ctx: QueryCtx | MutationCtx) {
  const userId = await getAuthUserId(ctx);
  if (userId === null) return null;
  const me = await ctx.db.get(userId);
  if (!me) return null;
  return {
    id: userId,
    name: me.name ?? me.email ?? "Someone",
    familyId: me.familyId ?? null,
  };
}

/**
 * Every entry the person can see in a window: what the family shares, plus
 * their own — which is what keeps an imported work feed off everyone else's
 * page without needing a second grid.
 */
async function eventsInRange(
  ctx: QueryCtx | MutationCtx,
  args: {
    userId: Id<"users">;
    familyId: Id<"families"> | null;
    from: number;
    to: number;
  },
) {
  const from = args.from - RANGE_PAD_MS;
  const to = args.to + RANGE_PAD_MS;
  const found = new Map<string, Doc<"calendarEvents">>();
  // Held in a local so the narrowing survives into the index callback.
  const familyId = args.familyId;

  if (familyId) {
    const shared = await ctx.db
      .query("calendarEvents")
      .withIndex("by_family_start", (q) =>
        q.eq("familyId", familyId).gte("startsAt", from).lt("startsAt", to),
      )
      .take(MAX_EVENTS);
    for (const row of shared) {
      if (visibleTo(row, args.userId)) found.set(row._id, row);
    }
  }

  const mine = await ctx.db
    .query("calendarEvents")
    .withIndex("by_owner_start", (q) =>
      q.eq("ownerId", args.userId).gte("startsAt", from).lt("startsAt", to),
    )
    .take(MAX_EVENTS);
  for (const row of mine) found.set(row._id, row);

  return [...found.values()]
    .filter((row) => row.endsAt >= args.from && row.startsAt <= args.to)
    .sort((a, b) => a.startsAt - b.startsAt);
}

function toCard(
  row: Doc<"calendarEvents">,
  args: {
    userId: Id<"users">;
    replies: Doc<"calendarReplies">[];
  },
) {
  return {
    _id: row._id,
    title: row.title,
    layer: row.layer,
    kind: row.kind,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    allDay: row.allDay,
    timeZone: row.timeZone,
    location: row.location ?? null,
    notes: row.notes ?? null,
    recipeUrl: row.recipeUrl ?? null,
    ingredients: row.ingredients ?? [],
    place: row.place ?? null,
    appointmentType: row.appointmentType ?? null,
    priority: row.priority ?? null,
    cost: row.cost ?? null,
    costStatus: row.costStatus ?? null,
    paidBy: row.paidBy ?? null,
    link: row.link ?? null,
    emoji: row.emoji ?? null,
    alarmMinutes: row.alarmMinutes ?? null,
    ownerId: row.ownerId,
    ownerName: row.ownerName,
    mine: row.ownerId === args.userId,
    shared: row.shared,
    audience: row.audience ?? (row.shared ? "family" : "private"),
    // The names are what a card shows; the ids are what the page sends back
    // when somebody edits who an entry is for.
    attendees: (row.attendeeNames ?? []).filter(Boolean),
    attendeeIds: row.attendees ?? [],
    source: row.source,
    // An imported row belongs to the feed that wrote it, so the page offers no
    // edit or delete on it — re-syncing would only put it back.
    readOnly: row.source === "import",
    replies: args.replies.map((reply) => ({
      userId: reply.userId,
      name: reply.name,
      answer: reply.answer,
      mine: reply.userId === args.userId,
    })),
    options: replyOptions(row.kind),
  };
}

/**
 * Everything the page needs, in one reactive read: the entries in the window,
 * the offers of help against them, the feeds, the shopping list and the
 * preferences. One query means one subscription, and nothing on the page can
 * disagree with anything else on it.
 */
export const state = query({
  args: { from: v.number(), to: v.number() },
  handler: async (ctx, { from, to }) => {
    const who = await viewer(ctx);
    // A locked account gets the same empty answer as a signed-out one: no
    // entries, no feeds, and no way to learn what the family has planned.
    const allowed = who !== null && (await isUnlocked(ctx));

    const prefs =
      allowed && who
        ? await ctx.db
            .query("calendarPrefs")
            .withIndex("by_user", (q) => q.eq("userId", who.id))
            .unique()
        : null;

    let events: ReturnType<typeof toCard>[] = [];
    if (allowed && who) {
      const span = Math.min(to - from, MAX_RANGE_DAYS * 24 * 60 * 60 * 1000);
      const rows = await eventsInRange(ctx, {
        userId: who.id,
        familyId: who.familyId,
        from,
        to: from + Math.max(span, 0),
      });

      events = [];
      for (const row of rows) {
        // Answers only ever exist against a request card, and only a request
        // card draws them — so the read is skipped for everything else instead
        // of running once per entry. On a year's view that was hundreds of
        // index reads to fill a list nobody was going to look at.
        const options = replyOptions(row.kind);
        const replies = options.length
          ? await ctx.db
              .query("calendarReplies")
              .withIndex("by_event", (q) => q.eq("eventId", row._id))
              .take(50)
          : [];
        events.push(toCard(row, { userId: who.id, replies }));
      }
    }

    const feeds =
      allowed && who
        ? await ctx.db
            .query("calendarFeeds")
            .withIndex("by_owner", (q) => q.eq("ownerId", who.id))
            .take(20)
        : [];

    const shopping =
      allowed && who
        ? await ctx.db
            .query("shoppingItems")
            .withIndex("by_owner", (q) => q.eq("ownerId", who.id))
            .order("desc")
            .take(120)
        : [];

    return {
      me: allowed && who ? { id: who.id, name: who.name } : null,
      familyId: allowed && who ? who.familyId : null,
      prefs: {
        timeZone: prefs?.timeZone ?? DEFAULT_TIME_ZONE,
        hiddenLayers: prefs?.hiddenLayers ?? [],
      },
      events,
      feeds: feeds.map((feed) => ({
        _id: feed._id,
        name: feed.name,
        url: feed.url,
        provider: feed.provider,
        enabled: feed.enabled,
        lastSyncedAt: feed.lastSyncedAt ?? null,
        lastError: feed.lastError ?? null,
      })),
      shopping: shopping.map((item) => ({
        _id: item._id,
        text: item.text,
        done: item.done,
        createdAt: item.createdAt,
      })),
    };
  },
});

/* ------------------------------------------------------------- exporting */

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

/** The 75-octet line folding the format asks for. */
function foldLine(line: string) {
  if (line.length <= 73) return line;
  const parts: string[] = [line.slice(0, 73)];
  let rest = line.slice(73);
  while (rest.length) {
    parts.push(` ${rest.slice(0, 72)}`);
    rest = rest.slice(72);
  }
  return parts.join("\r\n");
}

/** Text escaping, so a comma in a note does not break the file. */
function icsText(value: string) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

function utcStamp(instant: number) {
  const date = new Date(instant);
  return `${date.getUTCFullYear()}${pad2(date.getUTCMonth() + 1)}${pad2(
    date.getUTCDate(),
  )}T${pad2(date.getUTCHours())}${pad2(date.getUTCMinutes())}${pad2(
    date.getUTCSeconds(),
  )}Z`;
}

function dateStamp(instant: number, timeZone: string) {
  const parts = partsInZone(instant, timeZone);
  return `${parts.year}${pad2(parts.month)}${pad2(parts.day)}`;
}

/** Priority, mapped onto the 1 (highest) to 9 (lowest) the format uses. */
function icsPriority(priority: string | undefined) {
  switch (priority) {
    case "urgent":
      return 1;
    case "high":
      return 3;
    case "medium":
      return 5;
    case "low":
      return 9;
    default:
      return undefined;
  }
}

/**
 * The family's own calendar as an .ics file, ready to import into Google,
 * Outlook or Apple. Everything the person can already see is included, and
 * nothing they cannot — it reads behind exactly the same gate the page does.
 *
 * Alarms travel with it as VALARM entries, so an entry's reminder lands in the
 * other calendar too.
 */
export const exportIcs = query({
  args: { from: v.number(), to: v.number() },
  handler: async (ctx, { from, to }) => {
    const who = await viewer(ctx);
    const allowed = who !== null && (await isUnlocked(ctx));
    if (!allowed || !who) return null;

    const span = Math.min(to - from, MAX_RANGE_DAYS * 24 * 60 * 60 * 1000);
    const rows = await eventsInRange(ctx, {
      userId: who.id,
      familyId: who.familyId,
      from,
      to: from + Math.max(span, 0),
    });

    const stamp = utcStamp(Date.now());
    const lines: string[] = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Family Chat Hub//Calendar//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      `X-WR-CALNAME:${icsText("Family Chat Hub")}`,
    ];

    for (const row of rows.slice(0, MAX_EVENTS)) {
      const title = row.emoji ? `${row.emoji} ${row.title}` : row.title;

      lines.push("BEGIN:VEVENT");
      lines.push(`UID:${row._id}@family-chat-hub`);
      lines.push(`DTSTAMP:${stamp}`);

      if (row.allDay) {
        lines.push(
          `DTSTART;VALUE=DATE:${dateStamp(row.startsAt, row.timeZone)}`,
        );
        lines.push(`DTEND;VALUE=DATE:${dateStamp(row.endsAt, row.timeZone)}`);
      } else {
        lines.push(`DTSTART:${utcStamp(row.startsAt)}`);
        lines.push(`DTEND:${utcStamp(row.endsAt)}`);
      }

      lines.push(`SUMMARY:${icsText(title)}`);
      if (row.location) lines.push(`LOCATION:${icsText(row.location)}`);

      const description: string[] = [];
      if (row.notes) description.push(row.notes);
      if (row.place) description.push(`Where: ${row.place}`);
      if (row.appointmentType) description.push(`What for: ${row.appointmentType}`);
      if (row.recipeUrl) description.push(`Recipe: ${row.recipeUrl}`);
      if (row.link) description.push(`Link: ${row.link}`);
      if (typeof row.cost === "number") {
        const settled =
          row.costStatus === "paid"
            ? "paid"
            : row.costStatus === "reimbursement"
              ? "reimbursement requested"
              : "unpaid";
        description.push(
          `Cost: ${row.cost.toFixed(2)} (${settled})${
            row.paidBy ? ` — paid by ${row.paidBy}` : ""
          }`,
        );
      }
      if (description.length) {
        lines.push(`DESCRIPTION:${icsText(description.join("\n"))}`);
      }

      lines.push(`CATEGORIES:${icsText(row.kind)}`);
      const priority = icsPriority(row.priority);
      if (priority !== undefined) lines.push(`PRIORITY:${priority}`);

      if (typeof row.alarmMinutes === "number") {
        lines.push("BEGIN:VALARM");
        lines.push("ACTION:DISPLAY");
        lines.push(`DESCRIPTION:${icsText(title)}`);
        lines.push(`TRIGGER:-PT${row.alarmMinutes}M`);
        lines.push("END:VALARM");
      }

      lines.push("END:VEVENT");
    }

    lines.push("END:VCALENDAR");

    const today = new Date();
    return {
      filename: `family-calendar-${today.getFullYear()}-${pad2(
        today.getMonth() + 1,
      )}-${pad2(today.getDate())}.ics`,
      text: `${lines.map(foldLine).join("\r\n")}\r\n`,
    };
  },
});

/* ------------------------------------------------------------- writing it */

function finish(
  args: {
    startsAt: number;
    endsAt?: number;
    allDay?: boolean;
    timeZone?: string;
  },
) {
  const timeZone = args.timeZone?.trim() || DEFAULT_TIME_ZONE;
  const allDay = args.allDay === true;
  let startsAt = args.startsAt;
  let endsAt = args.endsAt ?? startsAt + 60 * 60 * 1000;

  if (allDay) {
    startsAt = startOfDay(startsAt, timeZone);
    endsAt = endsAt > startsAt ? endsAt : startsAt + 24 * 60 * 60 * 1000;
    // An all-day entry covers whole days, so snap the end to the next midnight.
    const endParts = partsInZone(endsAt - 1, timeZone);
    endsAt = instantFromWall(
      endParts.year,
      endParts.month,
      endParts.day,
      0,
      0,
      0,
      timeZone,
    ) + 24 * 60 * 60 * 1000;
  }

  if (endsAt <= startsAt) endsAt = startsAt + 30 * 60 * 1000;

  return { startsAt, endsAt, allDay, timeZone };
}

/** Write one entry. The assistant uses this too, through the page. */
export const create = mutation({
  args: { ...eventArgs },
  handler: async (ctx, args) => {
    await requireUnlocked(ctx);
    const who = await viewer(ctx);
    if (!who) throw new Error("Sign in to add to the calendar");

    const when = finish(args);
    const kind = args.kind;
    const people = attendeesOf(args);
    const peopleNames = people.names.length
      ? people.names
      : await namesForIds(ctx, people.ids);
    // A "group" that names nobody would be visible to its owner alone, which
    // is never what was meant, so it falls back to the family.
    const asked = audienceOf(args);
    const audience: CalendarAudience =
      asked === "group" && !people.ids.length ? "family" : asked;
    // Only a family entry belongs to the household; the other two are the
    // owner's, so they never enter the family index at all.
    const shared = audience !== "private";
    const layer = args.layer ?? layerForKind(kind);
    const place = clean(args.place, 120);
    const appointmentType = clean(args.appointmentType, 120);
    const notes = clean(args.notes, 800);

    // A request writes its own headline, in the words the rest of the family
    // is meant to read, so the card says what is needed rather than a label.
    const isRequest = replyOptions(kind).length > 0;
    const at = clockText(when.startsAt, when.timeZone, false);
    const title =
      clean(args.title, 160) ??
      (isRequest
        ? bulletinTitle({
            kind,
            place,
            appointmentType,
            notes,
            at,
          })
        : `${kind === "meal" ? "Dinner" : kind === "work" ? "Shift" : "Event"}: ${
            notes ?? place ?? at
          }`);

    const eventId = await ctx.db.insert("calendarEvents", {
      ownerId: who.id,
      ownerName: who.name,
      familyId: shared ? (who.familyId ?? undefined) : undefined,
      shared,
      audience,
      attendees: people.ids.length ? people.ids : undefined,
      attendeeNames: peopleNames.length ? peopleNames : undefined,
      layer,
      kind,
      title,
      ...when,
      location: clean(args.location, 160) ?? undefined,
      notes: notes ?? undefined,
      recipeUrl: clean(args.recipeUrl, 600) ?? undefined,
      ingredients: normalizeIngredients(args.ingredients),
      place: place ?? undefined,
      appointmentType: appointmentType ?? undefined,
      priority: args.priority ?? undefined,
      cost: costOf(args.cost),
      costStatus: args.costStatus ?? undefined,
      paidBy: clean(args.paidBy, 80) ?? undefined,
      link: clean(args.link, 600) ?? undefined,
      emoji: clean(args.emoji, 8) ?? undefined,
      alarmMinutes: alarmOf(args.alarmMinutes),
      source: args.source ?? "manual",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const reminderId = await setAlarm(ctx, {
      userId: who.id,
      eventId,
      title,
      startsAt: when.startsAt,
      timeZone: when.timeZone,
      alarmMinutes: alarmOf(args.alarmMinutes),
      previousId: null,
    });
    if (reminderId) await ctx.db.patch(eventId, { reminderId });

    return eventId;
  },
});

function normalizeIngredients(list: string[] | undefined) {
  if (!Array.isArray(list)) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const item = clean(raw, 80);
    if (!item) continue;
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= MAX_INGREDIENTS) break;
  }
  return out.length ? out : undefined;
}

export const update = mutation({
  args: { id: v.id("calendarEvents"), ...eventArgs },
  handler: async (ctx, args) => {
    await requireUnlocked(ctx);
    const who = await viewer(ctx);
    if (!who) throw new Error("Sign in to change the calendar");

    const row = await ctx.db.get(args.id);
    if (!row) throw new Error("That entry is no longer here");
    // You may change your own entries and anything the family shares. Owner-only
    // used to mean a shared entry was frozen for everyone but the one account
    // that wrote it — which, after a re-sign-in made a new account, was nobody
    // the person could reach.
    const existingAudience =
      row.audience ?? (row.shared ? "family" : "private");
    if (row.ownerId !== who.id && existingAudience !== "family") {
      throw new Error("That is not yours to change");
    }
    // An imported row belongs to its feed; editing it here would be undone by
    // the next sync, so the page does not offer it and this refuses it.
    if (row.source === "import") {
      throw new Error("Imported entries are changed at the feed, not here");
    }

    const when = finish(args);
    const kind = args.kind;
    const people = attendeesOf(args);
    const peopleNames = people.names.length
      ? people.names
      : await namesForIds(ctx, people.ids);
    const asked = audienceOf(args);
    const audience: CalendarAudience =
      asked === "group" && !people.ids.length ? "family" : asked;
    const shared = audience !== "private";

    const reminderId = await setAlarm(ctx, {
      // The alarm belongs with the entry, so it stays on whoever owns it even
      // when somebody else in the family is the one changing it.
      userId: row.ownerId,
      eventId: args.id,
      title: clean(args.title, 160) ?? row.title,
      startsAt: when.startsAt,
      timeZone: when.timeZone,
      alarmMinutes: alarmOf(args.alarmMinutes),
      previousId: row.reminderId ?? null,
    });

    await ctx.db.patch(args.id, {
      title: clean(args.title, 160) ?? row.title,
      layer: args.layer ?? row.layer,
      kind,
      ...when,
      location: clean(args.location, 160) ?? undefined,
      notes: clean(args.notes, 800) ?? undefined,
      recipeUrl: clean(args.recipeUrl, 600) ?? undefined,
      ingredients: normalizeIngredients(args.ingredients),
      place: clean(args.place, 120) ?? undefined,
      appointmentType: clean(args.appointmentType, 120) ?? undefined,
      priority: args.priority ?? undefined,
      cost: costOf(args.cost),
      costStatus: args.costStatus ?? undefined,
      paidBy: clean(args.paidBy, 80) ?? undefined,
      link: clean(args.link, 600) ?? undefined,
      emoji: clean(args.emoji, 8) ?? undefined,
      alarmMinutes: alarmOf(args.alarmMinutes),
      reminderId: reminderId ?? undefined,
      shared,
      audience,
      attendees: people.ids.length ? people.ids : undefined,
      attendeeNames: peopleNames.length ? peopleNames : undefined,
      familyId: shared ? (who.familyId ?? undefined) : undefined,
      updatedAt: Date.now(),
    });

    return null;
  },
});

export const remove = mutation({
  args: { id: v.id("calendarEvents") },
  handler: async (ctx, { id }) => {
    await requireUnlocked(ctx);
    const who = await viewer(ctx);
    if (!who) throw new Error("Sign in to change the calendar");

    const row = await ctx.db.get(id);
    // Already gone is the outcome that was wanted.
    if (!row) return null;
    // You may take off your own entries and anything the family shares. This
    // used to be owner-only and returned null in silence, so the page said
    // "taken off the calendar" while the entry stayed exactly where it was.
    const audience = row.audience ?? (row.shared ? "family" : "private");
    if (row.ownerId !== who.id && audience !== "family") {
      throw new Error("That is not yours to remove");
    }
    if (row.source === "import") {
      throw new Error("Imported entries are removed at the feed, not here");
    }

    // The alarm goes with the entry; otherwise it would ring for something that
    // is no longer on the calendar.
    if (row.reminderId) {
      const alarm = await ctx.db.get(row.reminderId);
      if (alarm) await ctx.db.delete(row.reminderId);
    }

    const replies = await ctx.db
      .query("calendarReplies")
      .withIndex("by_event", (q) => q.eq("eventId", id))
      .take(50);
    for (const reply of replies) await ctx.db.delete(reply._id);

    const items = await ctx.db
      .query("shoppingItems")
      .withIndex("by_owner", (q) => q.eq("ownerId", who.id))
      .take(120);
    for (const item of items) {
      if (item.fromEventId === id) await ctx.db.delete(item._id);
    }

    await ctx.db.delete(id);
    return null;
  },
});

/** Offer a hand on a request card: "I can drive". */
export const reply = mutation({
  args: { id: v.id("calendarEvents"), answer: v.string() },
  handler: async (ctx, { id, answer }) => {
    await requireUnlocked(ctx);
    const who = await viewer(ctx);
    if (!who) throw new Error("Sign in to answer that");

    const event = await ctx.db.get(id);
    if (!event) return null;

    const text = clean(answer, 60);
    if (!text) return null;

    const existing = await ctx.db
      .query("calendarReplies")
      .withIndex("by_event_user", (q) =>
        q.eq("eventId", id).eq("userId", who.id),
      )
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, { answer: text, createdAt: Date.now() });
    } else {
      await ctx.db.insert("calendarReplies", {
        eventId: id,
        userId: who.id,
        name: who.name,
        answer: text,
        createdAt: Date.now(),
      });
    }

    return null;
  },
});

export const savePrefs = mutation({
  args: {
    timeZone: v.optional(v.string()),
    hiddenLayers: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const who = await viewer(ctx);
    if (!who) throw new Error("Sign in to change the calendar view");

    const timeZone = args.timeZone?.trim() || DEFAULT_TIME_ZONE;
    const hidden = (args.hiddenLayers ?? []).filter((layer) =>
      (LAYERS as string[]).includes(layer),
    );

    const existing = await ctx.db
      .query("calendarPrefs")
      .withIndex("by_user", (q) => q.eq("userId", who.id))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        timeZone: args.timeZone ? timeZone : existing.timeZone,
        hiddenLayers: args.hiddenLayers ? hidden : existing.hiddenLayers,
        updatedAt: Date.now(),
      });
    } else {
      await ctx.db.insert("calendarPrefs", {
        userId: who.id,
        timeZone,
        hiddenLayers: hidden,
        updatedAt: Date.now(),
      });
    }

    return null;
  },
});

/* ------------------------------------------------------------ the shopping */

export const addShoppingItem = mutation({
  args: { text: v.string() },
  handler: async (ctx, { text }) => {
    const who = await viewer(ctx);
    if (!who) throw new Error("Sign in to change the list");

    const item = clean(text, 80);
    if (!item) return null;

    await ctx.db.insert("shoppingItems", {
      ownerId: who.id,
      familyId: who.familyId ?? undefined,
      text: item,
      done: false,
      createdAt: Date.now(),
    });

    return null;
  },
});

export const toggleShoppingItem = mutation({
  args: { id: v.id("shoppingItems") },
  handler: async (ctx, { id }) => {
    const who = await viewer(ctx);
    if (!who) return null;

    const row = await ctx.db.get(id);
    if (!row || row.ownerId !== who.id) return null;

    await ctx.db.patch(id, { done: !row.done });
    return null;
  },
});

export const removeShoppingItem = mutation({
  args: { id: v.id("shoppingItems") },
  handler: async (ctx, { id }) => {
    const who = await viewer(ctx);
    if (!who) return null;

    const row = await ctx.db.get(id);
    if (!row || row.ownerId !== who.id) return null;

    await ctx.db.delete(id);
    return null;
  },
});

export const clearShopping = mutation({
  args: { doneOnly: v.optional(v.boolean()) },
  handler: async (ctx, { doneOnly }) => {
    const who = await viewer(ctx);
    if (!who) return null;

    const rows = await ctx.db
      .query("shoppingItems")
      .withIndex("by_owner", (q) => q.eq("ownerId", who.id))
      .take(120);

    for (const row of rows) {
      if (doneOnly && !row.done) continue;
      await ctx.db.delete(row._id);
    }

    return null;
  },
});

/**
 * Turn the meals planned in a window into one shopping list, and — when they
 * have said when they are going to the store — put the trip on the calendar
 * with a reminder that fires before it.
 */
export const planShopping = mutation({
  args: {
    from: v.number(),
    to: v.number(),
    storeAt: v.optional(v.number()),
    leadMinutes: v.optional(v.number()),
  },
  handler: async (ctx, { from, to, storeAt, leadMinutes }) => {
    await requireUnlocked(ctx);
    const who = await viewer(ctx);
    if (!who) throw new Error("Sign in to plan the shopping");

    const rows = await eventsInRange(ctx, {
      userId: who.id,
      familyId: who.familyId,
      from: Math.min(from, to),
      to: Math.max(from, to),
    });

    // Every kind of meal, not just the one labelled "meal": a dinner or a
    // lunch carries ingredients in exactly the same field.
    const meals = rows.filter((row) => MEAL_KINDS.has(row.kind));
    const existing = await ctx.db
      .query("shoppingItems")
      .withIndex("by_owner", (q) => q.eq("ownerId", who.id))
      .take(120);
    const known = new Set(existing.map((item) => item.text.toLowerCase()));

    let added = 0;
    for (const meal of meals) {
      for (const raw of meal.ingredients ?? []) {
        const text = clean(raw, 80);
        if (!text) continue;
        const key = text.toLowerCase();
        if (known.has(key)) continue;
        known.add(key);
        await ctx.db.insert("shoppingItems", {
          ownerId: who.id,
          familyId: who.familyId ?? undefined,
          text,
          done: false,
          fromEventId: meal._id,
          createdAt: Date.now(),
        });
        added += 1;
      }
    }

    let reminderAt: number | null = null;
    if (storeAt !== undefined) {
      const lead = Math.min(Math.max(leadMinutes ?? 30, 5), 240);
      reminderAt = storeAt - lead * 60_000;

      // The trip itself goes on the calendar...
      const when = finish({
        startsAt: storeAt,
        endsAt: storeAt + 45 * 60_000,
        timeZone: DEFAULT_TIME_ZONE,
      });
      await ctx.db.insert("calendarEvents", {
        ownerId: who.id,
        ownerName: who.name,
        familyId: who.familyId ?? undefined,
        shared: true,
        layer: "personal",
        kind: "other",
        title: "Shopping trip",
        ...when,
        notes: added
          ? `${added} thing${added === 1 ? "" : "s"} on the list`
          : "Shopping list",
        source: "manual",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      // ...and the nudge comes before the trip, not during it.
      await insertReminder(ctx, {
        userId: who.id,
        text: added
          ? `Shopping list ready — ${added} thing${
              added === 1 ? "" : "s"
            } to pick up`
          : "Shopping list ready — check it before you go",
        kind: "reminder",
        dueAt: reminderAt,
      });
    }

    return { added, meals: meals.length, reminderAt };
  },
});

/* ---------------------------------------------------------------- the feeds */

function guessProvider(url: string) {
  const lower = url.toLowerCase();
  if (lower.includes("outlook") || lower.includes("office365")) {
    return "outlook" as const;
  }
  if (lower.includes("google")) return "google" as const;
  return "ics" as const;
}

export const addFeed = mutation({
  args: { name: v.string(), url: v.string() },
  handler: async (ctx, { name, url }) => {
    await requireUnlocked(ctx);
    const who = await viewer(ctx);
    if (!who) throw new Error("Sign in to add a feed");

    const address = (url ?? "").trim();
    const label = clean(name, 60) ?? "Imported calendar";
    if (!address) throw new Error("Paste the calendar's address first");

    const existing = await ctx.db
      .query("calendarFeeds")
      .withIndex("by_owner", (q) => q.eq("ownerId", who.id))
      .take(20);
    if (existing.length >= 10) {
      throw new Error("That is as many feeds as this hub will hold");
    }

    return await ctx.db.insert("calendarFeeds", {
      ownerId: who.id,
      name: label,
      url: address.slice(0, 600),
      provider: guessProvider(address),
      enabled: true,
      createdAt: Date.now(),
    });
  },
});

export const removeFeed = mutation({
  args: { id: v.id("calendarFeeds") },
  handler: async (ctx, { id }) => {
    const who = await viewer(ctx);
    if (!who) return null;

    const feed = await ctx.db.get(id);
    if (!feed || feed.ownerId !== who.id) return null;

    const rows = await ctx.db
      .query("calendarEvents")
      .withIndex("by_external", (q) => q.eq("feedId", id))
      .take(MAX_EVENTS);
    for (const row of rows) await ctx.db.delete(row._id);

    await ctx.db.delete(id);
    return null;
  },
});

export const feedFor = internalQuery({
  args: { id: v.id("calendarFeeds") },
  handler: async (ctx, { id }) => {
    const feed = await ctx.db.get(id);
    if (!feed) return null;
    return {
      ownerId: feed.ownerId,
      name: feed.name,
      url: feed.url,
      provider: feed.provider,
    };
  },
});

export const replaceFeedEvents = internalMutation({
  args: {
    feedId: v.id("calendarFeeds"),
    userId: v.id("users"),
    events: v.array(
      v.object({
        externalId: v.optional(v.string()),
        title: v.string(),
        location: v.optional(v.string()),
        notes: v.optional(v.string()),
        startsAt: v.number(),
        endsAt: v.number(),
        allDay: v.boolean(),
      }),
    ),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { feedId, userId, events, error }) => {
    const old = await ctx.db
      .query("calendarEvents")
      .withIndex("by_external", (q) => q.eq("feedId", feedId))
      .take(MAX_EVENTS);
    for (const row of old) await ctx.db.delete(row._id);

    const user = await ctx.db.get(userId);
    const name = user?.name ?? user?.email ?? "Someone";

    for (const event of events.slice(0, MAX_EVENTS)) {
      await ctx.db.insert("calendarEvents", {
        ownerId: userId,
        ownerName: name,
        // An import is personal by design: a work roster should not appear on
        // everyone else's calendar.
        shared: false,
        layer: "personal",
        kind: "other",
        title: event.title.slice(0, 160),
        startsAt: event.startsAt,
        endsAt: event.endsAt,
        allDay: event.allDay,
        timeZone: DEFAULT_TIME_ZONE,
        location: event.location,
        notes: event.notes,
        source: "import",
        feedId,
        externalId: event.externalId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }

    await ctx.db.patch(feedId, {
      lastSyncedAt: Date.now(),
      lastError: error,
    });

    return { imported: events.length };
  },
});

/** Bring every live feed up to date. Called from the page. */
export const syncFeeds = action({
  args: { id: v.optional(v.id("calendarFeeds")) },
  handler: async (ctx, { id }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Sign in to sync a feed");

    const ids = id
      ? [id]
      : await ctx.runQuery(internal.calendar.myFeedIds, { userId });

    const results: { id: string; ok: boolean; imported: number; error?: string }[] =
      [];

    for (const feedId of ids) {
      const feed = await ctx.runQuery(internal.calendar.feedFor, { id: feedId });
      if (!feed || feed.ownerId !== userId) continue;

      // A feed with no web address (an uploaded file, a row from before this
      // guard) has nothing to read. Skipping it keeps a failed fetch from
      // clearing the entries it brought in.
      if (!/^https?:\/\//i.test(feed.url)) {
        results.push({
          id: feedId,
          ok: false,
          imported: 0,
          error: "That calendar has no web address to read — it was a file.",
        });
        continue;
      }

      try {
        const response = await fetch(feed.url, {
          headers: { Accept: "text/calendar, text/plain, */*" },
        });
        if (!response.ok) {
          const error = `The calendar answered ${response.status}.`;
          await ctx.runMutation(internal.calendar.replaceFeedEvents, {
            feedId,
            userId,
            events: [],
            error,
          });
          results.push({ id: feedId, ok: false, imported: 0, error });
          continue;
        }

        const text = await response.text();
        const events = parseIcs(text);
        const done = await ctx.runMutation(internal.calendar.replaceFeedEvents, {
          feedId,
          userId,
          events,
        });
        results.push({ id: feedId, ok: true, imported: done.imported });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "That address did not answer.";
        await ctx.runMutation(internal.calendar.replaceFeedEvents, {
          feedId,
          userId,
          events: [],
          error: message.slice(0, 200),
        });
        results.push({ id: feedId, ok: false, imported: 0, error: message });
      }
    }

    return results;
  },
});

export const myFeedIds = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const feeds = await ctx.db
      .query("calendarFeeds")
      .withIndex("by_owner", (q) => q.eq("ownerId", userId))
      .take(20);
    return feeds.filter((feed) => feed.enabled).map((feed) => feed._id);
  },
});

/**
 * Paste or upload a `.ics` file. It is the same reader the live feeds use, so
 * a file and a URL behave identically once they are in.
 */
export const importIcs = mutation({
  args: { name: v.string(), text: v.string() },
  handler: async (ctx, { name, text }) => {
    await requireUnlocked(ctx);
    const who = await viewer(ctx);
    if (!who) throw new Error("Sign in to import a calendar");

    if (!text.trim()) throw new Error("That file was empty");

    // A file is read once, here, and has no address to ask again later. It is
    // written as a feed with `enabled: false` so the next "Sync" does not try
    // to fetch "(file)", fail, and wipe everything this import just put in.
    const feedId = await ctx.db.insert("calendarFeeds", {
      ownerId: who.id,
      name: clean(name, 60) ?? "Imported file",
      url: "(file)",
      provider: "ics",
      enabled: false,
      lastSyncedAt: Date.now(),
      createdAt: Date.now(),
    });

    const events = parseIcs(text.slice(0, 2_000_000));

    for (const event of events.slice(0, MAX_EVENTS)) {
      await ctx.db.insert("calendarEvents", {
        ownerId: who.id,
        ownerName: who.name,
        shared: false,
        layer: "personal",
        kind: "other",
        title: event.title.slice(0, 160),
        startsAt: event.startsAt,
        endsAt: event.endsAt,
        allDay: event.allDay,
        timeZone: DEFAULT_TIME_ZONE,
        location: event.location,
        notes: event.notes,
        source: "import",
        feedId,
        externalId: event.externalId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }

    return { imported: Math.min(events.length, MAX_EVENTS) };
  },
});

/* --------------------------------------------------------------- .ics reader */

type IcsEvent = {
  externalId?: string;
  title: string;
  location?: string;
  notes?: string;
  startsAt: number;
  endsAt: number;
  allDay: boolean;
};

/** Long lines are folded onto the next with a leading space. */
function unfold(text: string) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n[ \t]/g, "");
}

function icsStamp(value: string, params: string) {
  const clean = value.trim();

  // A whole date, no time: an all-day entry.
  if (/^\d{8}$/.test(clean)) {
    const year = Number(clean.slice(0, 4));
    const month = Number(clean.slice(4, 6));
    const day = Number(clean.slice(6, 8));
    return { at: Date.UTC(year, month - 1, day), allDay: true };
  }

  const match = clean.match(
    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/,
  );
  if (!match) return null;

  const [, y, mo, d, h, mi, s, z] = match;
  const wall = {
    year: Number(y),
    month: Number(mo),
    day: Number(d),
    hour: Number(h),
    minute: Number(mi),
    second: Number(s),
  };

  const tzid = params.match(/TZID=([^;:]+)/i)?.[1];
  const at =
    z === "Z" || !tzid
      ? Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second)
      : instantFromWall(
          wall.year,
          wall.month,
          wall.day,
          wall.hour,
          wall.minute,
          wall.second,
          tzid,
        );

  return { at, allDay: false };
}

function unescapeIcs(value: string) {
  return value
    .replace(/\\n/gi, " ")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .trim();
}

/**
 * A small, forgiving reader for the `.ics` that Google, Outlook and Apple all
 * export. It takes the fields the calendar can actually show and leaves the
 * rest — alarms, attendees, recurrence rules — where they are, rather than
 * pretending to honour them.
 *
 * A recurring event is imported as its first occurrence. That is a real
 * limitation and it is stated plainly on the page rather than hidden.
 */
function parseIcs(text: string): IcsEvent[] {
  const lines = unfold(text).split("\n");
  const events: IcsEvent[] = [];

  let current: Record<string, { value: string; params: string }> | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed === "BEGIN:VEVENT") {
      current = {};
      continue;
    }
    if (trimmed === "END:VEVENT") {
      if (current) {
        const built = buildIcsEvent(current);
        if (built) events.push(built);
      }
      current = null;
      continue;
    }
    if (!current) continue;

    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;

    const left = trimmed.slice(0, colon);
    const value = trimmed.slice(colon + 1);
    const semicolon = left.indexOf(";");
    const key = (semicolon === -1 ? left : left.slice(0, semicolon))
      .trim()
      .toUpperCase();
    const params = semicolon === -1 ? "" : left.slice(semicolon + 1);

    if (key) current[key] = { value, params };
  }

  return events
    .filter((event) => Number.isFinite(event.startsAt))
    .sort((a, b) => a.startsAt - b.startsAt);
}

function buildIcsEvent(
  fields: Record<string, { value: string; params: string }>,
): IcsEvent | null {
  const start = fields.DTSTART
    ? icsStamp(fields.DTSTART.value, fields.DTSTART.params)
    : null;
  if (!start) return null;

  const end = fields.DTEND
    ? icsStamp(fields.DTEND.value, fields.DTEND.params)
    : null;

  const title =
    unescapeIcs(fields.SUMMARY?.value ?? "") ||
    unescapeIcs(fields.DESCRIPTION?.value ?? "").slice(0, 80) ||
    "Imported entry";

  let endsAt: number;
  if (!end) {
    endsAt = start.allDay
      ? start.at + 24 * 60 * 60 * 1000
      : start.at + 60 * 60 * 1000;
  } else if (start.allDay) {
    // An all-day DTEND is the first moment *after* the last day.
    const span = end.at - start.at;
    endsAt =
      span > 0 ? end.at : start.at + 24 * 60 * 60 * 1000;
  } else {
    endsAt = end.at > start.at ? end.at : start.at + 30 * 60 * 1000;
  }

  return {
    externalId: unescapeIcs(fields.UID?.value ?? "") || undefined,
    title,
    location: unescapeIcs(fields.LOCATION?.value ?? "") || undefined,
    notes: unescapeIcs(fields.DESCRIPTION?.value ?? "").slice(0, 400) || undefined,
    startsAt: start.at,
    endsAt,
    allDay: start.allDay,
  };
}

/* ------------------------------------------------------------- what the AI sees */

/**
 * The next seven days, in the family's own timezone.
 *
 * This is handed to both agents with everything else they already know, which
 * is what lets them answer "what is on tomorrow" without guessing, and lets
 * them put a new appointment next to the right one.
 */
export const digest = internalQuery({
  args: {
    userId: v.id("users"),
    timeZone: v.optional(v.string()),
    // How far ahead to read. The agents are handed seven days on every turn;
    // a rundown may want further, and this is the one knob that widens it.
    days: v.optional(v.number()),
  },
  // The return type is written out rather than inferred: this handler reaches
  // into another query through the generated api, and leaving TypeScript to
  // work the shape out from there makes the two depend on each other.
  handler: async (ctx, { userId, timeZone, days }): Promise<string> => {
    const zone =
      timeZone ??
      (
        await ctx.db
          .query("calendarPrefs")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .unique()
      )?.timeZone ??
      DEFAULT_TIME_ZONE;

    const user = await ctx.db.get(userId);
    const now = Date.now();
    const from = startOfDay(now, zone);
    const span = Math.min(Math.max(Math.round(days ?? DIGEST_DAYS), 1), 60);
    const ahead = span <= 1 ? "today" : `the next ${span} days`;
    const to = from + span * 24 * 60 * 60 * 1000;

    const rows = await eventsInRange(ctx, {
      userId,
      familyId: user?.familyId ?? null,
      from,
      to,
    });

    const today = partsInZone(from, zone);
    const header = `Today is ${today.weekday} ${today.day} ${
      MONTHS[today.month - 1]
    } ${today.year}, ${clockText(now, zone)} in ${zone}.`;

    if (!rows.length) {
      return `${header} Nothing is on the family calendar for ${ahead}.`;
    }

    const lines = rows.slice(0, 60).map((row) => {
      const start = partsInZone(row.startsAt, zone);
      const day = `${start.weekday} ${start.day} ${MONTHS[start.month - 1]}`;
      const when = row.allDay
        ? "all day"
        : `${clockText(row.startsAt, zone)}–${clockText(row.endsAt, zone)}`;
      const who = row.ownerName ? ` — ${row.ownerName}` : "";
      const extra = [
        row.kind !== "appointment" ? row.kind : null,
        row.location,
        row.place,
      ]
        .filter(Boolean)
        .join(", ");
      return `- ${day} ${when}: ${row.title}${extra ? ` (${extra})` : ""}${who}`;
    });

    // And then the join between them: what is short for the next meal, what is
    // still on the list, and the one errand those add up to. This is what the
    // agents read on every turn, so the stitching is not something they have
    // to remember to go looking for.
    const brief = await ctx.runQuery(internal.calendar.briefing, {
      userId,
      withinHours: 48,
    });
    const stitch = brief.ok ? brief.stitch : "";

    return `${header}\nOn the calendar for ${ahead}:\n${lines.join(
      "\n",
    )}${stitch ? `\n\n${stitch}` : ""}`;
  },
});

/* ------------------------------------------------------------ for the models */

/**
 * A time a model wrote, as an instant.
 *
 * Models write times the way a person does — "2026-09-26T09:00" — and that
 * means a wall clock in somebody's zone, not UTC, so it is turned into an
 * instant the same way a hand-typed one is. An absolute stamp (a number, or a
 * string carrying `Z` or an offset) is already unambiguous and is taken as it
 * stands.
 */
export function instantFromInput(
  value: unknown,
  timeZone: string,
): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Milliseconds everywhere else in this database. A number small enough to
    // be seconds is the same instant counted the other way, and taking it as
    // milliseconds would land the entry in 1970 instead of next Tuesday.
    return value > 0 && value < 100_000_000_000 ? value * 1000 : value;
  }

  if (typeof value !== "string") return null;

  const text = value.trim();
  if (!text) return null;

  if (/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text) && /[Zz]$|[+-]\d{2}:?\d{2}$/.test(text)) {
    const stamp = Date.parse(text);
    return Number.isFinite(stamp) ? stamp : null;
  }

  const parts = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?/.exec(text);
  if (parts) {
    return instantFromWall(
      Number(parts[1]),
      Number(parts[2]),
      Number(parts[3]),
      Number(parts[4] ?? "0"),
      Number(parts[5] ?? "0"),
      0,
      timeZone,
    );
  }

  const stamp = Date.parse(text);
  return Number.isFinite(stamp) ? stamp : null;
}

/** The zone one person reads the calendar in. */
async function zoneForUser(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
): Promise<string> {
  const prefs = await ctx.db
    .query("calendarPrefs")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();

  return prefs?.timeZone ?? DEFAULT_TIME_ZONE;
}

/**
 * Names a model gave, matched back to real people.
 *
 * This is the guard on the whole routing story: a model may write "Sam" or
 * "the parents", and only somebody already in this family can come back out.
 * An unmatched name is dropped rather than invented, which is what stops a
 * sentence about a person from placing an entry on a stranger's page.
 */
async function resolvePeople(
  ctx: QueryCtx | MutationCtx,
  familyId: Id<"families"> | null,
  names: string[] | undefined,
) {
  const wanted = (names ?? [])
    .map((name) => (name ?? "").trim().toLowerCase())
    .filter((name) => name.length > 1)
    .slice(0, 30);

  if (!wanted.length || !familyId) return { ids: [] as Id<"users">[], names: [] as string[] };

  const family = (await ctx.db.query("users").collect()).filter(
    (user) => user.familyId === familyId,
  );

  const ids: Id<"users">[] = [];
  const found: string[] = [];

  for (const name of wanted) {
    const hit = family.find((user) => {
      const label = (user.name ?? user.email ?? "").trim().toLowerCase();
      if (!label) return false;
      return label.includes(name) || name.includes(label);
    });

    if (hit && !ids.includes(hit._id)) {
      ids.push(hit._id);
      found.push(hit.name ?? hit.email ?? "Guest");
    }
  }

  return { ids, names: found };
}

/**
 * Write an entry the assistant asked for, on the person's behalf.
 *
 * The assistant's calendar actions are carried out by the page when its reply
 * lands, the same way `open_url` and `navigate` are, so this is the mutation
 * that page calls. The caller is read off the session like anywhere else — the
 * model is not the person — and that is also what makes the routing real: a
 * name it wrote is matched against *this* family and nobody else's.
 */
export const fromAssistant = mutation({
  args: {
    kind: calendarKindValidator,
    title: v.optional(v.string()),
    startsAt: v.union(v.number(), v.string()),
    endsAt: v.optional(v.union(v.number(), v.string())),
    allDay: v.optional(v.boolean()),
    location: v.optional(v.string()),
    notes: v.optional(v.string()),
    recipeUrl: v.optional(v.string()),
    ingredients: v.optional(v.array(v.string())),
    place: v.optional(v.string()),
    appointmentType: v.optional(v.string()),
    layer: v.optional(calendarLayerValidator),
    audience: v.optional(calendarAudienceValidator),
    who: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    await requireUnlocked(ctx);
    const who = await viewer(ctx);
    if (!who) return { ok: false as const, reason: "There is nobody to write for." };

    const zone = await zoneForUser(ctx, who.id);
    const startsAt = instantFromInput(args.startsAt, zone);
    if (startsAt === null) {
      return { ok: false as const, reason: "That start time could not be read." };
    }

    const endsAt =
      args.endsAt === undefined ? undefined : instantFromInput(args.endsAt, zone);

    const when = finish({
      startsAt,
      endsAt: endsAt ?? undefined,
      allDay: args.allDay,
      timeZone: zone,
    });

    const kind = args.kind;
    const people = await resolvePeople(ctx, who.familyId ?? null, args.who);
    // The assistant is told to say who something is for. Anything it left out
    // goes to the family rather than disappearing onto one person's page — and
    // a "group" that named nobody would resolve to nobody and be visible to
    // its owner alone, which is never what was meant, so that falls back too.
    const asked = args.audience ?? "family";
    const audience: CalendarAudience =
      asked === "group" && !people.ids.length ? "family" : asked;
    const shared = audience !== "private";
    const place = clean(args.place, 120);
    const appointmentType = clean(args.appointmentType, 120);
    const notes = clean(args.notes, 800);

    const isRequest = replyOptions(kind).length > 0;
    const at = clockText(when.startsAt, when.timeZone, false);
    const title =
      clean(args.title, 160) ??
      (isRequest
        ? bulletinTitle({ kind, place, appointmentType, notes, at })
        : `${kind === "meal" ? "Dinner" : kind === "work" ? "Shift" : "Event"}: ${
            notes ?? place ?? at
          }`);

    const id = await ctx.db.insert("calendarEvents", {
      ownerId: who.id,
      ownerName: who.name,
      familyId: shared ? (who.familyId ?? undefined) : undefined,
      shared,
      audience,
      attendees: people.ids.length ? people.ids : undefined,
      attendeeNames: people.names.length ? people.names : undefined,
      // Everything the assistant writes lands on the one layer the family can
      // switch off in a single tap, unless it names another for a reason.
      layer: args.layer ?? "assistant",
      kind,
      title,
      ...when,
      location: clean(args.location, 160) ?? undefined,
      notes: notes ?? undefined,
      recipeUrl: clean(args.recipeUrl, 600) ?? undefined,
      ingredients: normalizeIngredients(args.ingredients),
      place: place ?? undefined,
      appointmentType: appointmentType ?? undefined,
      source: "ai",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    return {
      ok: true as const,
      id,
      title,
      audience,
      people: people.names,
      startsAt: when.startsAt,
      when: clockText(when.startsAt, zone, true),
    };
  },
});

/**
 * The assistant's shopping action.
 *
 * Anything already on the list is left as it is rather than written twice,
 * because a list with "milk" on it three times is a list nobody uses. When the
 * model was told when they are going, the trip goes on the calendar and the
 * reminder fires before it — the same shape `planShopping` gives a planned
 * week, for a list somebody said out loud.
 */
export const shopFromAssistant = mutation({
  args: {
    items: v.array(v.string()),
    storeAt: v.optional(v.union(v.number(), v.string())),
    leadMinutes: v.optional(v.number()),
    audience: v.optional(calendarAudienceValidator),
    who: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    await requireUnlocked(ctx);
    const me = await viewer(ctx);
    if (!me) return { ok: false as const, reason: "There is nobody to write for." };

    const existing = await ctx.db
      .query("shoppingItems")
      .withIndex("by_owner", (q) => q.eq("ownerId", me.id))
      .take(120);
    const known = new Set(existing.map((item) => item.text.toLowerCase()));

    let added = 0;
    for (const raw of args.items.slice(0, 60)) {
      const text = clean(raw, 80);
      if (!text) continue;
      const key = text.toLowerCase();
      if (known.has(key)) continue;
      known.add(key);
      await ctx.db.insert("shoppingItems", {
        ownerId: me.id,
        familyId: me.familyId ?? undefined,
        text,
        done: false,
        createdAt: Date.now(),
      });
      added += 1;
    }

    let reminderAt: number | null = null;
    if (args.storeAt !== undefined) {
      const zone = await zoneForUser(ctx, me.id);
      const storeAt = instantFromInput(args.storeAt, zone);

      if (storeAt !== null) {
        const lead = Math.min(Math.max(args.leadMinutes ?? 30, 5), 240);
        reminderAt = storeAt - lead * 60_000;

        const audience = args.audience ?? "family";
        const people = await resolvePeople(ctx, me.familyId ?? null, args.who);
        const when = finish({
          startsAt: storeAt,
          endsAt: storeAt + 45 * 60_000,
          timeZone: zone,
        });

        await ctx.db.insert("calendarEvents", {
          ownerId: me.id,
          ownerName: me.name,
          familyId: audience === "private" ? undefined : (me.familyId ?? undefined),
          shared: audience !== "private",
          audience,
          attendees: people.ids.length ? people.ids : undefined,
          attendeeNames: people.names.length ? people.names : undefined,
          layer: "assistant",
          kind: "other",
          title: "Shopping trip",
          ...when,
          notes: added
            ? `${added} thing${added === 1 ? "" : "s"} on the list`
            : "Shopping list",
          source: "ai",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });

        await insertReminder(ctx, {
          userId: me.id,
          text: added
            ? `Shopping list ready — ${added} thing${
                added === 1 ? "" : "s"
              } to pick up`
            : "Shopping list ready — check it before you go",
          kind: "reminder",
          dueAt: reminderAt,
        });
      }
    }

    return { ok: true as const, added, total: known.size, reminderAt };
  },
});

/* --------------------------------------------------------- from the board */

/**
 * The [LIVE] board, turned into calendar entries.
 *
 * The board keeps a shelf of things that matter to a Colorado ranch — horse
 * and draft-horse sales, the farm-equipment auctions, weather alerts, road
 * reports, wildfire, drought and the week's hay trade — but a board is a wall
 * you have to walk up to, and the calendar is where a person actually looks
 * each morning. So the dated things it finds (the sales) are written here as
 * entries on the one layer the family can switch off, and one short "Colorado
 * & national watch" card is refreshed every day for everything that has no
 * date of its own (the alerts, the closures, the drought, the trade).
 *
 * It is written by a timer rather than a person, so it owns its own rows:
 * every one carries a `board:` external id, and the sync only ever touches
 * rows carrying that prefix. Running it again is safe — a sale already on the
 * calendar is left alone, a past one is cleared away, and the day's reminder
 * is moved rather than piled up.
 */
const BOARD_PREFIX = "board:";
const WATCH_TITLE = "Colorado & national watch";
const DAY_MS = 24 * 60 * 60 * 1000;

/** One dated thing the board found, ready to become a calendar entry. */
type BoardEntry = {
  key: string;
  title: string;
  kind: CalendarKind;
  startsAt: number;
  location?: string;
  link?: string;
  notes?: string;
};

/** A month name, an optional day and a year, as the board writes a date. */
function boardInstant(text: string, timeZone: string): number | null {
  const match = text.match(
    /([A-Za-z]{3,})\.?\s*(\d{1,2})?(?:\s*&\s*\d{1,2})?,?\s*(20\d\d)/,
  );
  if (!match) return null;
  const index = MONTHS.findIndex(
    (name) => name.toLowerCase() === match[1].slice(0, 3).toLowerCase(),
  );
  if (index < 0) return null;
  return instantFromWall(
    Number(match[3]),
    index + 1,
    match[2] ? Number(match[2]) : 1,
    0,
    0,
    0,
    timeZone,
  );
}

/** YYYY-MM-DD in a zone, so the day's card is written once and found again. */
function boardDay(instant: number, timeZone: string): string {
  const parts = partsInZone(instant, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(
    parts.day,
  ).padStart(2, "0")}`;
}

/** A stable, readable key, so the same sale is never written twice. */
function boardKey(kind: string, ...bits: string[]) {
  const slug = bits
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);
  return `${BOARD_PREFIX}${kind}:${slug}`;
}

/**
 * The dated sales the board knows about. Horse and draft-horse sales and the
 * farm-equipment auctions both carry a real date; the USDA cattle barn reports
 * do not, so they stay in the watch card rather than pretending to be events.
 */
function boardSales(data: Briefing, timeZone: string): BoardEntry[] {
  const out: BoardEntry[] = [];
  const seen = new Set<string>();
  const floor = startOfDay(Date.now(), timeZone) - DAY_MS;

  const collect = (
    source: Source<AuctionEvent[]>,
    kind: CalendarKind,
    label: string,
  ) => {
    if (!source.ok) return;
    for (const event of source.data) {
      const startsAt = boardInstant(event.date, timeZone);
      if (startsAt === null || startsAt < floor) continue;
      const key = boardKey("sale", kind, event.date, event.title);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        key,
        title: `${label}: ${event.title}`.slice(0, 160),
        kind,
        startsAt,
        location: event.where ?? undefined,
        link: event.href || undefined,
        notes: `From the [LIVE] board${event.date ? ` — ${event.date}` : ""}`,
      });
    }
  };

  collect(data.horseAuctions, "livestock", "Horse sale");
  collect(data.equipmentAuctions, "community_event", "Equipment auction");

  return out.sort((a, b) => a.startsAt - b.startsAt).slice(0, 24);
}

/** The day's card and its one-line reminder, out of everything undated. */
function boardWatch(
  data: Briefing,
  sales: number,
): { notes: string; short: string } {
  const bits: string[] = [];
  const short: string[] = [];

  if (data.weather.ok && data.weather.data.temperature !== null) {
    const temp = Math.round(data.weather.data.temperature);
    const gust = data.weather.data.windGust;
    bits.push(
      `${temp}°F${
        gust !== null && gust >= 35 ? `, gusts ${Math.round(gust)} mph` : ""
      }`,
    );
  }

  const alerts = data.alerts.ok ? data.alerts.data : [];
  if (alerts.length) {
    bits.push(
      `${alerts.length} weather alert${
        alerts.length === 1 ? "" : "s"
      } — ${alerts[0].event}`,
    );
    short.push(`${alerts.length} alert${alerts.length === 1 ? "" : "s"}`);
  }

  const roads = data.roads.ok ? data.roads.data : [];
  if (roads.length) {
    bits.push(
      `${roads.length} road report${roads.length === 1 ? "" : "s"}${
        roads[0].title ? ` — ${roads[0].title}` : ""
      }`,
    );
    short.push(`${roads.length} road report${roads.length === 1 ? "" : "s"}`);
  }

  if (data.wildfire.ok && data.wildfire.data.length) {
    bits.push(
      `${data.wildfire.data.length} wildfire item${
        data.wildfire.data.length === 1 ? "" : "s"
      }`,
    );
  }

  if (data.avalanche.ok && data.avalanche.data.length) {
    bits.push(`avalanche: ${data.avalanche.data[0].title}`);
  }

  if (data.drought.ok) {
    const week = data.drought.data;
    const levels = [week.d1, week.d2, week.d3, week.d4];
    for (let index = levels.length - 1; index >= 0; index -= 1) {
      const percent = levels[index];
      if (percent !== null && percent > 0) {
        bits.push(`drought D${index + 1} over ${Math.round(percent)}%`);
        break;
      }
    }
  }

  if (data.hay.ok && data.hay.data.rows.length) {
    bits.push(
      `${data.hay.data.rows.length} hay trades${
        data.hay.data.week ? ` for ${data.hay.data.week}` : ""
      }`,
    );
  }

  if (data.cattleAuctions.ok && data.cattleAuctions.data.length) {
    short.push(`${data.cattleAuctions.data.length} barn reports`);
  }

  if (sales) {
    bits.push(`${sales} sale${sales === 1 ? "" : "s"} on the calendar`);
    short.push(`${sales} sale${sales === 1 ? "" : "s"}`);
  }

  const news = data.news.ok ? data.news.data : [];
  if (news.length && news[0].title) {
    bits.push(news[0].title.slice(0, 120));
  }

  const body = bits.length
    ? bits.join(" · ")
    : "The board is quiet this morning.";
  return {
    notes:
      `Today on the ${WATCH_TITLE} — ${body}. Open the [LIVE] board for the rest.`.slice(
        0,
        780,
      ),
    short: short.length ? short.join(", ") : "nothing urgent",
  };
}

/** The first member of each family, so a family's rows are written once. */
function boardWriters(users: Doc<"users">[]): Doc<"users">[] {
  const first = new Map<string, Doc<"users">>();
  for (const user of users) {
    if (!user.familyId) continue;
    if (!first.has(user.familyId)) first.set(user.familyId, user);
  }
  return [...first.values()];
}

/**
 * Read the board and write what it found onto the calendar.
 *
 * A timer runs this once a day. The dated sales become all-day entries on the
 * Assistant & LIVE layer; one card is refreshed for the day's alerts, closures
 * and trade; a past sale is cleared away; and each family member is left one
 * reminder for the morning, moved rather than added to, so "informed daily" is
 * a ring rather than a page somebody has to remember to open.
 */
export const syncBoard = internalMutation({
  args: { userId: v.optional(v.id("users")) },
  handler: async (ctx, { userId }) => {
    const shelf = await ctx.runQuery(internal.briefing.snapshot, {});
    if (!shelf) {
      return { ok: false as const, reason: "The board has not been read yet." };
    }
    const data = shelf.data as Briefing;

    await ctx.runMutation(internal.ai_behind.note, {
      source: "calendar",
      label: "Putting the [LIVE] board on the calendar",
      detail:
        "Turning the board's dated sales into all-day entries, its alerts and road reports into one watch card, and leaving everyone a reminder for the morning.",
    });

    const users = await ctx.db.query("users").take(200);
    const owners = userId
      ? users.filter((user) => user._id === userId)
      : boardWriters(users);

    const now = Date.now();
    let written = 0;
    let removed = 0;
    let reminded = 0;

    for (const owner of owners) {
      const zone = await zoneForUser(ctx, owner._id);
      const familyId = owner.familyId ?? null;

      // Everything the board has already put here, in a window wide enough to
      // hold both what is coming and what has just gone by.
      const from = startOfDay(now, zone) - 30 * DAY_MS;
      const to = from + 240 * DAY_MS;

      const found: Doc<"calendarEvents">[] = [];
      if (familyId) {
        const shared = await ctx.db
          .query("calendarEvents")
          .withIndex("by_family_start", (q) =>
            q
              .eq("familyId", familyId)
              .gte("startsAt", from)
              .lt("startsAt", to),
          )
          .take(600);
        found.push(...shared);
      }
      const mine = await ctx.db
        .query("calendarEvents")
        .withIndex("by_owner_start", (q) =>
          q.eq("ownerId", owner._id).gte("startsAt", from).lt("startsAt", to),
        )
        .take(600);
      found.push(...mine);

      const ours = found.filter(
        (row) =>
          row.externalId !== undefined && row.externalId.startsWith(BOARD_PREFIX),
      );

      // A sale that has already happened is not news; clear it away.
      for (const row of ours) {
        if (row.endsAt < now) {
          await ctx.db.delete(row._id);
          removed += 1;
        }
      }
      const byKey = new Map(
        ours
          .filter((row) => row.endsAt >= now)
          .map((row) => [row.externalId as string, row] as const),
      );

      const sales = boardSales(data, zone);
      const watch = boardWatch(data, sales.length);
      const entries: BoardEntry[] = [
        ...sales,
        {
          key: `${BOARD_PREFIX}watch:${boardDay(now, zone)}`,
          title: WATCH_TITLE,
          kind: "other",
          startsAt: now,
          notes: watch.notes,
        },
      ];

      for (const entry of entries) {
        const existing = byKey.get(entry.key);
        if (existing) {
          // Only the day's card changes once it is up; a sale stays put.
          if (entry.title === WATCH_TITLE) {
            await ctx.db.patch(existing._id, {
              notes: entry.notes,
              updatedAt: now,
            });
          }
          continue;
        }

        const when = finish({
          startsAt: entry.startsAt,
          allDay: true,
          timeZone: zone,
        });
        await ctx.db.insert("calendarEvents", {
          ownerId: owner._id,
          ownerName: owner.name ?? owner.email ?? "The hub",
          familyId: owner.familyId ?? undefined,
          shared: true,
          audience: "family",
          layer: "assistant",
          kind: entry.kind,
          title: entry.title,
          ...when,
          location: entry.location,
          notes: entry.notes,
          link: entry.link,
          priority: entry.title === WATCH_TITLE ? "high" : undefined,
          source: "ai",
          externalId: entry.key,
          createdAt: now,
          updatedAt: now,
        });
        written += 1;
      }

      // One reminder each, for the morning. It is the same row every day —
      // moved forward, never piled up — so a week away does not meet a stack
      // of stale "check the board" nudges when the app is next opened.
      const members = familyId
        ? users.filter((user) => user.familyId === familyId)
        : [owner];
      const today = partsInZone(now, zone);
      const seven = instantFromWall(
        today.year,
        today.month,
        today.day,
        7,
        0,
        0,
        zone,
      );
      const dueAt = seven > now ? seven : seven + DAY_MS;
      const text = `${WATCH_TITLE} — ${watch.short}`.slice(0, 180);

      for (const member of members) {
        const theirs = await ctx.db
          .query("reminders")
          .withIndex("by_user", (q) => q.eq("userId", member._id))
          .take(50);
        const standing = theirs.find((row) => row.text.startsWith(WATCH_TITLE));
        if (standing) {
          if (
            standing.dueAt !== dueAt ||
            standing.text !== text ||
            standing.done
          ) {
            await ctx.db.patch(standing._id, { dueAt, text, done: false });
            reminded += 1;
          }
        } else {
          await insertReminder(ctx, {
            userId: member._id,
            text,
            kind: "reminder",
            dueAt,
          });
          reminded += 1;
        }
      }
    }

    return { ok: true as const, written, removed, reminded };
  },
});

/**
 * What is coming, stitched into one errand.
 *
 * This is not a list of entries — the page already shows those, and `digest`
 * already hands the models a week of them. It is the join between the entries
 * that a person would otherwise have to make in their head: the trip out, the
 * meal that needs feeding, and the things on the list that meal is short of,
 * said as one stop rather than three alerts.
 *
 * The rule for "short of" is deliberately conservative: an ingredient only
 * counts as missing when it is already on the shopping list, which is how this
 * family records that they are out of something. Nothing is invented — if the
 * milk is in the fridge and nobody said otherwise, nothing here claims it is
 * not.
 */
export const briefing = internalQuery({
  args: {
    userId: v.id("users"),
    withinHours: v.optional(v.number()),
  },
  handler: async (ctx, { userId, withinHours }) => {
    const me = await ctx.db.get(userId);
    if (!me) return { ok: false as const, reason: "There is nobody to brief." };

    const zone = await zoneForUser(ctx, userId);
    const now = Date.now();
    const hours = Math.min(Math.max(withinHours ?? 36, 1), 24 * 14);
    const to = now + hours * 60 * 60 * 1000;

    const rows = await eventsInRange(ctx, {
      userId,
      familyId: me.familyId ?? null,
      from: now,
      to,
    });

    const list = await ctx.db
      .query("shoppingItems")
      .withIndex("by_owner", (q) => q.eq("ownerId", userId))
      .take(120);
    const undone = list.filter((item) => !item.done);

    const soon = rows.filter((row) => row.startsAt >= now);
    const meals = soon.filter((row) => MEAL_KINDS.has(row.kind));
    const trips = soon.filter(
      (row) => row.kind !== "meal" && row.startsAt <= now + 24 * 60 * 60 * 1000,
    );

    const nextMeal = meals[0] ?? null;
    const shoppingWords = undone.map((item) => item.text.toLowerCase());
    const missing = (nextMeal?.ingredients ?? []).filter((ingredient) => {
      const needle = ingredient.toLowerCase();
      return shoppingWords.some(
        (word) => word.includes(needle) || needle.includes(word),
      );
    });

    // `clockText` already carries the weekday when it carries the date.
    const when = (at: number) => clockText(at, zone, true);

    const coming = soon.slice(0, 12).map((row) => {
      const extra = [row.location, row.place].filter(Boolean).join(", ");
      const forWhom =
        row.audience === "group" && (row.attendeeNames ?? []).length
          ? ` (for ${(row.attendeeNames ?? []).join(", ")})`
          : "";
      return `- ${when(row.startsAt)}: ${row.title}${extra ? ` — ${extra}` : ""}${forWhom}`;
    });

    const errand: string[] = [];
    const nextTrip = trips[0] ?? null;
    const stop =
      missing.length || undone.length
        ? nextTrip && nextTrip.title !== "Shopping trip"
          ? `${nextTrip.title}${nextTrip.location ? ` at ${nextTrip.location}` : ""}`
          : "the store"
        : null;

    if (stop) {
      const because = nextMeal
        ? `${missing.length ? `${missing.join(", ")} for ` : ""}${nextMeal.title}`
        : "the list";
      const extras = undone
        .filter(
          (item) =>
            !missing.some((one) =>
              item.text.toLowerCase().includes(one.toLowerCase()),
            ),
        )
        .map((item) => item.text)
        .slice(0, 8);
      const leaving = nextTrip ? `After ${stop}, stop` : "Stop";
      errand.push(
        `${leaving} at the store for ${because}${
          extras.length ? `, plus ${extras.join(", ")}` : ""
        }.`,
      );
    }

    if (nextMeal && missing.length) {
      errand.push(
        `${nextMeal.title} is ${when(nextMeal.startsAt)} and you are short of ${missing.join(", ")}.`,
      );
    }

    const mealLine = nextMeal
      ? `The next meal planned is ${nextMeal.title} on ${when(nextMeal.startsAt)}.${
          (nextMeal.ingredients ?? []).length
            ? ` It needs ${(nextMeal.ingredients ?? []).join(", ")}.`
            : ""
        }`
      : "No meal is planned yet.";

    const listLine = undone.length
      ? `On the shopping list, not yet bought: ${undone
          .map((item) => item.text)
          .slice(0, 20)
          .join(", ")}.`
      : "The shopping list is empty.";

    const errandLine = errand.length
      ? `Worth joining up:\n${errand.map((line) => `- ${line}`).join("\n")}`
      : "";

    // The join, as opposed to the listing. The weekly digest already carries
    // every entry, so this is the part it appends — and the same three lines
    // are what a model is handed when it asks for a briefing directly.
    const stitch = [mealLine, listLine, errandLine].filter(Boolean).join("\n");

    const summary = [
      `Right now it is ${when(now)} in ${zone}.`,
      coming.length
        ? `Coming up in the next ${hours} hours:\n${coming.join("\n")}`
        : `Nothing of theirs is on the calendar in the next ${hours} hours.`,
      stitch,
    ]
      .filter(Boolean)
      .join("\n\n");

    return {
      ok: true as const,
      now,
      timeZone: zone,
      coming,
      shopping: undone.map((item) => item.text),
      nextMeal: nextMeal
        ? {
            title: nextMeal.title,
            startsAt: nextMeal.startsAt,
            ingredients: nextMeal.ingredients ?? [],
          }
        : null,
      missing,
      errand,
      stitch,
      summary,
    };
  },
});
