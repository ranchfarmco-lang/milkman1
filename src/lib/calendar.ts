/**
 * Reading and writing a calendar in a chosen timezone, in the browser.
 *
 * Every entry is stored as an instant, so a timezone is only ever a way of
 * looking at the same rows. That is the whole job of this file: turn an instant
 * into the wall clock somebody in a named zone would see, and turn a wall clock
 * back into an instant, correctly across a daylight-saving change.
 *
 * It is done with `Intl` rather than with a date library, because that is what
 * the platform already knows the world's timezone rules with — and it means the
 * same rows can be read at the same time from the server (`convex/calendar.ts`)
 * and from here.
 */

import type { CalendarKind, CalendarLayer } from "@/convex/schema";

export const DEFAULT_TIME_ZONE = "America/Denver";

export const FALLBACK_ZONES = [
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Chicago",
  "America/New_York",
  "America/Anchorage",
  "Pacific/Honolulu",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Madrid",
  "Africa/Johannesburg",
  "Asia/Jerusalem",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Auckland",
  "UTC",
];

/** Every zone the browser knows, or a sensible short list if it will not say. */
export function timeZones(): string[] {
  try {
    const supported = (
      Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
    ).supportedValuesOf?.("timeZone");
    if (supported?.length) {
      // The common ones first, so the list opens somewhere useful.
      const preferred = FALLBACK_ZONES.filter((zone) => supported.includes(zone));
      const rest = supported.filter((zone) => !preferred.includes(zone));
      return [...preferred, ...rest];
    }
  } catch {
    // Older browsers do not offer it; the short list is still correct.
  }
  return FALLBACK_ZONES;
}

export type ZoneParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 is Sunday. */
  weekday: number;
};

export const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function utcParts(instant: number): ZoneParts {
  const date = new Date(instant);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
    weekday: date.getUTCDay(),
  };
}

/** The wall clock a person in this zone would read at this instant. */
export function partsInZone(instant: number, timeZone: string): ZoneParts {
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

    const found: Record<string, string> = {};
    for (const part of format.formatToParts(new Date(instant))) {
      if (part.type !== "literal") found[part.type] = part.value;
    }

    const year = Number(found.year);
    if (!Number.isFinite(year)) return utcParts(instant);

    const weekday =
      found.weekday === undefined
        ? utcParts(instant).weekday
        : WEEKDAY_NAMES.indexOf(found.weekday.slice(0, 3));

    return {
      year,
      month: Number(found.month),
      day: Number(found.day),
      hour: Number(found.hour) % 24,
      minute: Number(found.minute),
      second: Number(found.second),
      weekday: weekday === -1 ? utcParts(instant).weekday : weekday,
    };
  } catch {
    return utcParts(instant);
  }
}

function zoneOffset(instant: number, timeZone: string) {
  const parts = partsInZone(instant, timeZone);
  return (
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    ) - instant
  );
}

/**
 * The instant at which this wall clock happens in this zone.
 *
 * Twice, because the offset depends on the instant: the first pass lands on the
 * right side of a daylight-saving change, the second settles the exact second.
 */
export function instantFromWall(
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

export function startOfDay(instant: number, timeZone: string) {
  const parts = partsInZone(instant, timeZone);
  return instantFromWall(parts.year, parts.month, parts.day, 0, 0, 0, timeZone);
}

export function startOfMonth(
  year: number,
  month: number,
  timeZone: string,
) {
  return instantFromWall(year, month, 1, 0, 0, 0, timeZone);
}

/** Midnight on the first of the month after this one. */
export function startOfNextMonth(year: number, month: number, timeZone: string) {
  const rolled = new Date(Date.UTC(year, month, 1));
  return startOfMonth(
    rolled.getUTCFullYear(),
    rolled.getUTCMonth() + 1,
    timeZone,
  );
}

/** A date with no time in it, as the calendar grid thinks of one. */
export type CalendarDate = { year: number; month: number; day: number };

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

/**
 * The one way a date is written where a person reads it: MM/DD/YYYY, the way
 * the family writes a date. Technical ISO strings never reach the screen — the
 * few places that genuinely need one (a date input's value, which the browser
 * re-formats anyway) use `isoKey` instead.
 */
export function dateKey(date: CalendarDate) {
  return `${pad2(date.month)}/${pad2(date.day)}/${date.year}`;
}

/** The ISO form, for input values the browser never shows as-is. */
function isoKey(date: CalendarDate) {
  return `${date.year}-${pad2(date.month)}-${pad2(date.day)}`;
}

export function keyOfInstant(instant: number, timeZone: string): string {
  const parts = partsInZone(instant, timeZone);
  return dateKey(parts);
}

/** Shift a plain date by whole days. */
export function shiftDate(date: CalendarDate, days: number): CalendarDate {
  const moved = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: moved.getUTCFullYear(),
    month: moved.getUTCMonth() + 1,
    day: moved.getUTCDate(),
  };
}

export function weekdayOf(date: CalendarDate) {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

export function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Six whole weeks beginning on the Sunday on or before the first of the month,
 * so every month is the same height and the grid never jumps.
 */
export function monthGrid(year: number, month: number): (CalendarDate & {
  inMonth: boolean;
})[] {
  const first: CalendarDate = { year, month, day: 1 };
  const start = shiftDate(first, -weekdayOf(first));
  return Array.from({ length: 42 }, (_, index) => {
    const date = shiftDate(start, index);
    return {
      ...date,
      inMonth: date.month === month && date.year === year,
    };
  });
}

/* --------------------------------------------------------------- printing */

export function clockText(instant: number, timeZone: string) {
  const parts = partsInZone(instant, timeZone);
  const hour = parts.hour % 12 === 0 ? 12 : parts.hour % 12;
  const suffix = parts.hour < 12 ? "AM" : "PM";
  return `${hour}:${String(parts.minute).padStart(2, "0")} ${suffix}`;
}

export function clockWithSeconds(instant: number, timeZone: string) {
  const parts = partsInZone(instant, timeZone);
  return `${String(parts.hour).padStart(2, "0")}:${String(
    parts.minute,
  ).padStart(2, "0")}:${String(parts.second).padStart(2, "0")}`;
}

/**
 * MM/DD/YYYY, always — the same reading everywhere a date is shown, headings
 * included. `longDate` is kept as the name a heading reads better with, but it
 * returns the same thing: there is one date format in this app.
 */
export function longDate(instant: number, timeZone: string) {
  return dateKey(partsInZone(instant, timeZone));
}

/** MM/DD/YYYY, the short way. */
export function shortDate(instant: number, timeZone: string) {
  return dateKey(partsInZone(instant, timeZone));
}

/**
 * How a timezone reads to somebody who does not think in IANA names — the
 * abbreviation and how far it is from UTC, right now.
 */
export function zoneLabel(instant: number, timeZone: string) {
  try {
    const format = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      timeZoneName: "short",
    });
    const name = format
      .formatToParts(new Date(instant))
      .find((part) => part.type === "timeZoneName")?.value;
    if (name) return name;
  } catch {
    // Fall through to the offset.
  }

  const offset = zoneOffset(instant, timeZone);
  const sign = offset < 0 ? "-" : "+";
  const hours = Math.floor(Math.abs(offset) / 3_600_000);
  const minutes = Math.round((Math.abs(offset) % 3_600_000) / 60_000);
  return `UTC${sign}${hours}${minutes ? `:${String(minutes).padStart(2, "0")}` : ""}`;
}

/** What a `<input type="datetime-local">` needs, and what it gives back. */
export function toLocalInput(instant: number, timeZone: string) {
  const parts = partsInZone(instant, timeZone);
  return `${isoKey(parts)}T${pad2(parts.hour)}:${pad2(parts.minute)}`;
}

export function fromLocalInput(value: string, timeZone: string) {
  const match = value
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/);
  if (!match) return null;

  const [, y, mo, d, h, mi] = match;
  return instantFromWall(
    Number(y),
    Number(mo),
    Number(d),
    h === undefined ? 0 : Number(h),
    mi === undefined ? 0 : Number(mi),
    0,
    timeZone,
  );
}

/* ------------------------------------------------------ who is who, and what */

/**
 * A hue per person, worked out from their id so it is the same on every device
 * and never has to be stored. Kept low in saturation: it has to be tellable
 * apart at a glance without shouting over a page that is otherwise black and
 * white.
 */
export function hueFor(id: string) {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) % 100_000;
  }
  const hues = [8, 32, 52, 96, 160, 190, 214, 246, 276, 316, 340];
  return hues[hash % hues.length];
}

export function initialsOf(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export const LAYER_META: {
  key: CalendarLayer;
  label: string;
  blurb: string;
}[] = [
  {
    key: "personal",
    label: "Personal & feeds",
    blurb: "Your own entries, and anything imported from Google, Outlook or a file",
  },
  {
    key: "community",
    label: "Community schedule",
    blurb: "Work shifts, jobs, and appointments the family shares",
  },
  {
    key: "meals",
    label: "Meals & shopping",
    blurb: "What is for dinner, with the recipes and the list they feed",
  },
  {
    key: "bulletin",
    label: "Bulletin & help",
    blurb: "Rides, childcare, hauling and anything someone needs a hand with",
  },
  {
    key: "assistant",
    label: "Assistant & LIVE",
    blurb:
      "Everything the AI Assistant and the [LIVE] board put here — switch it off to hide the lot",
  },
];

/**
 * Everything an entry can be, in the order the page offers it. The groups are
 * only for reading the list; the picker flattens them.
 */
export const CALENDAR_KINDS: CalendarKind[] = [
  // health
  "appointment",
  "medical",
  "dentist",
  "therapy",
  "medication",
  "veterinary",
  // work and school
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
  // kids and family
  "kids_activity",
  "sports",
  "practice",
  "game",
  "lesson",
  "playdate",
  "sleepover",
  "camp",
  "family_time",
  "date_night",
  "adult_time",
  "birthday",
  "party",
  "holiday",
  // meals
  "meal",
  "meal_prep",
  "breakfast",
  "lunch",
  "dinner",
  "snack",
  "baking",
  "potluck",
  // the house
  "chores",
  "cleaning",
  "laundry",
  "repairs",
  "maintenance",
  "yard_work",
  "garden",
  // animals
  "livestock",
  "horse_care",
  "pet_care",
  "feeding",
  // travel and errands
  "travel",
  "flight",
  "road_trip",
  "camping",
  "vacation",
  "errand",
  "shopping",
  "grocery",
  // getting people and things around
  "delivery",
  "pickup",
  "dropoff",
  "fuel",
  // requests for a hand
  "ride",
  "childcare",
  "hauling",
  "help",
  "moving",
  "babysitting",
  // faith and community
  "church",
  "worship",
  "community_event",
  // money
  "bill",
  "payday",
  "budget",
  "expense",
  // everything else
  "other",
  "quiet_time",
  "rest",
];

export const KIND_LABELS: Record<string, string> = {
  appointment: "Appointment",
  medical: "Medical",
  dentist: "Dentist",
  therapy: "Therapy",
  medication: "Medication",
  veterinary: "Vet visit",
  work: "Work",
  shift: "Shift",
  meeting: "Meeting",
  training: "Training",
  volunteering: "Volunteering",
  school: "School",
  school_event: "School event",
  parent_teacher: "Parent–teacher",
  class: "Class",
  exam: "Exam",
  kids_activity: "Kids' activity",
  sports: "Sports",
  practice: "Practice",
  game: "Game",
  lesson: "Lesson",
  playdate: "Playdate",
  sleepover: "Sleepover",
  camp: "Camp",
  family_time: "Family time",
  date_night: "Date night",
  adult_time: "Adult time",
  birthday: "Birthday",
  party: "Party",
  holiday: "Holiday",
  meal: "Meal",
  meal_prep: "Meal prep",
  breakfast: "Breakfast",
  lunch: "Lunch",
  dinner: "Dinner",
  snack: "Snack",
  baking: "Baking",
  potluck: "Potluck",
  chores: "Chores",
  cleaning: "Cleaning",
  laundry: "Laundry",
  repairs: "Repairs",
  maintenance: "Maintenance",
  yard_work: "Yard work",
  garden: "Garden",
  livestock: "Livestock",
  horse_care: "Horse care",
  pet_care: "Pet care",
  feeding: "Feeding",
  travel: "Travel",
  flight: "Flight",
  road_trip: "Road trip",
  camping: "Camping",
  vacation: "Vacation",
  errand: "Errand",
  shopping: "Shopping",
  grocery: "Groceries",
  delivery: "Delivery",
  pickup: "Pickup",
  dropoff: "Drop-off",
  fuel: "Fuel",
  ride: "Ride needed",
  childcare: "Childcare",
  hauling: "Hauling job",
  help: "Help wanted",
  moving: "Moving help",
  babysitting: "Babysitting",
  church: "Church",
  worship: "Worship",
  community_event: "Community event",
  bill: "Bill",
  payday: "Payday",
  budget: "Budget",
  expense: "Expense",
  other: "Entry",
  quiet_time: "Quiet time",
  rest: "Rest",
};

/** Meals, and the shopping that feeds them, live on the meals layer. */
const MEAL_KINDS = new Set<string>([
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

/**
 * Is this kind a meal?
 *
 * The page asks so it knows whether to offer the recipe and the ingredients,
 * and the server asks so it knows what to gather into the shopping list. Those
 * two used to disagree with the list itself: only a plain "meal" counted, so a
 * family planning "Dinner" got no ingredient fields and a shopping list that
 * never filled.
 */
export function isMealKind(kind: string) {
  return MEAL_KINDS.has(kind);
}

/** The kinds that ask the family for a hand: they get answer buttons. */
export const REQUEST_KINDS = new Set<string>([
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
const COMMUNITY_KINDS = new Set<string>([
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

/** Which layer a kind falls into when nobody chooses one by hand. */
export function layerForKind(kind: string): CalendarLayer {
  if (MEAL_KINDS.has(kind)) return "meals";
  if (REQUEST_KINDS.has(kind)) return "bulletin";
  if (COMMUNITY_KINDS.has(kind)) return "community";
  return "personal";
}

/** Days an entry covers, so a card shows on every day it spans. */
export function daysCovered(
  event: { startsAt: number; endsAt: number; allDay: boolean },
  timeZone: string,
) {
  const first = partsInZone(event.startsAt, timeZone);
  const last = partsInZone(
    event.allDay ? Math.max(event.endsAt - 1, event.startsAt) : event.endsAt,
    timeZone,
  );

  const days: string[] = [];
  let cursor: CalendarDate = {
    year: first.year,
    month: first.month,
    day: first.day,
  };
  // A runaway span would be a bug, not a calendar; fifty days is plenty.
  for (let guard = 0; guard < 50; guard += 1) {
    days.push(dateKey(cursor));
    if (
      cursor.year === last.year &&
      cursor.month === last.month &&
      cursor.day === last.day
    ) {
      break;
    }
    cursor = shiftDate(cursor, 1);
  }

  return days;
}
