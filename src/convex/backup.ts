import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { requireUnlocked } from "./guard";
import { SELF_SNAPSHOT_AT, SELF_SOURCE } from "./self_source";

/**
 * Handing the hub back to the person who owns it.
 *
 * The Control Room's Backup panel asks for two things here: the app's own
 * source, and everything the family has written down. Both are gated the same
 * way as the rest of the hub — signed in, and past the family password — so a
 * locked account cannot walk out with the house.
 *
 * These are queries rather than files on a server: there is no filesystem
 * behind Convex, and the source already lives here as `self_source.ts`. The
 * browser does the packing (`src/lib/backup.ts`), which is why these hand back
 * plain data and nothing else.
 *
 * WHY THE CAPS
 * A return value cannot exceed 16 MiB, and reading without a bound is how a
 * query turns into a stall. Every table is read with an honest limit and the
 * limits are stated in `notes`, so a backup says what it left out instead of
 * pretending to be complete.
 */

/** The most recent rows of each table a backup will carry. */
const CAPS = {
  members: 200,
  messages: 5000,
  attachments: 2000,
  calendarEvents: 4000,
  calendarReplies: 6000,
  shoppingItems: 3000,
  own: 2000,
} as const;

const NOTES = [
  `Messages: the most recent ${CAPS.messages.toLocaleString()}, which is the family room plus your own AI threads.`,
  `Calendar: the most recent ${CAPS.calendarEvents.toLocaleString()} shared entries plus your own.`,
  "Attachments are listed with a link to each file; the bytes themselves stay in the hub's file storage, so re-download them from the hub.",
  "Presence heartbeats, call handshakes and password answers are deliberately left out — they are plumbing, not anything anyone wrote.",
];

/**
 * When the copy of the app shipped beside this page was taken, in milliseconds.
 *
 * `SELF_SNAPSHOT_AT` is written by `bun run snapshot:self` and checked to be a
 * real date by `bun run verify:self`, so it parses. If it somehow did not, this
 * is `Infinity`: no bench file can ever be newer than that, so nothing rides on
 * the copy and a download is the app itself rather than something older wearing
 * its name.
 */
const SHIPPED_AT = Number.isFinite(Date.parse(SELF_SNAPSHOT_AT))
  ? Date.parse(SELF_SNAPSHOT_AT)
  : Number.POSITIVE_INFINITY;

/**
 * What a download carries: the shipped app, and only work newer than it.
 *
 * The whole promise of every download in the hub — the Control Room's backups,
 * the Offline Brain's editions — is that what comes out is *this app*. The one
 * thing that can make it something else is the builder's bench: a working copy
 * of a file the AI Builder wrote, which a download merges over the shipped copy
 * so a change made a moment ago travels with it.
 *
 * That merge has a rule, and this is it: a bench file rides on the copy only
 * when it was written *after* the copy was taken. Work written before then is
 * older than the app itself — the app has moved on since, and a download must
 * be the current app, not a mix of it and a superseded copy. Those older files
 * are neither lost nor hidden: they are named in `superseded` (and the Control
 * Room's workshop can still export the whole bench), but they cannot silently
 * overwrite newer code with older code.
 *
 * A scratch file the builder wrote — a path that is not part of the app — is
 * never carried either way.
 *
 * Pure on purpose: `scripts/this-app-check.ts` walks it, so the rule can be
 * read, changed and proven without a database.
 */
export function carryBenchFiles(
  shipped: Record<string, string>,
  bench: { path: string; content: string; updatedAt: number }[],
  shippedAt: number,
): {
  files: Record<string, string>;
  patched: string[];
  superseded: string[];
} {
  const files: Record<string, string> = { ...shipped };
  const patched: string[] = [];
  const superseded: string[] = [];

  for (const row of bench) {
    // Only a real project path is merged; a scratch file stays on the bench.
    if (!(row.path in shipped)) continue;
    if (files[row.path] === row.content) continue;
    if (!(row.updatedAt > shippedAt)) {
      superseded.push(row.path);
      continue;
    }
    files[row.path] = row.content;
    patched.push(row.path);
  }

  return {
    files,
    patched: patched.sort(),
    superseded: superseded.sort(),
  };
}

/**
 * The app as it stands, with only newer work from the builder's bench on top.
 *
 * The builder keeps a working copy of this project on its bench (`files`), and
 * when it fixes a bug or reworks a file it writes the whole changed file there.
 * That is the one place the builder's changes to *this app* actually land, so a
 * download that ignored the bench would miss a change made a moment ago — and a
 * download that took the bench unconditionally would hand back older files
 * under the app's name. `carryBenchFiles` above holds the one rule between
 * those two; this simply reads the bench and asks it.
 */
async function mergedSource(ctx: QueryCtx, userId: Id<"users">) {
  const rows = await ctx.db
    .query("files")
    .withIndex("by_owner", (q) => q.eq("ownerId", userId))
    .collect();

  return carryBenchFiles(SELF_SOURCE, rows, SHIPPED_AT);
}

/**
 * The shape of the source: how many files, how much text, when the app's own
 * copy was taken, how many files the AI Builder has changed *since* then (those
 * ride into every download), and how many working files are older than it (those
 * do not). Small enough to keep the panel's numbers live without pulling the
 * whole thing across on every render.
 */
export const manifest = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;
    await requireUnlocked(ctx);

    const { files, patched, superseded } = await mergedSource(ctx, userId);
    const paths = Object.keys(files);
    let bytes = 0;
    for (const path of paths) bytes += files[path].length;

    return {
      at: SELF_SNAPSHOT_AT,
      files: paths.length,
      bytes,
      // Changes newer than the copy: they ride on top of every download.
      changed: patched.length,
      // Working copies older than the copy: they are not in any download, and
      // the panel says so rather than leaving their absence unexplained.
      superseded: superseded.length,
    };
  },
});

/**
 * Exactly which of this app's own files the AI has changed *since the app's
 * own copy was taken* — the files that are in every download, and the files a
 * push or a save from the AI Builder's mirror would carry.
 *
 * `manifest` above counts them; a person who is about to carry a change into
 * the app needs the list, not the number — it is the answer to "what did it
 * actually do to this app?", which is otherwise a diff nobody can see. Same
 * walk as the merge, names only: no contents, so this stays cheap enough to
 * leave live on the page while the AI is writing.
 */
export const changed = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;
    await requireUnlocked(ctx);

    const { files, patched } = await mergedSource(ctx, userId);
    return {
      at: SELF_SNAPSHOT_AT,
      paths: [...patched].sort(),
      total: Object.keys(files).length,
    };
  },
});

/* ------------------------------------------------------------------ the funnel */

/**
 * The app's source, one capped page at a time.
 *
 * This used to be a single query that handed back the whole snapshot: about
 * four megabytes in one answer — a frame the browser has to hold whole, and
 * one Convex re-sends from scratch the moment the Builder writes a file.
 * Everything else in this file is capped for exactly that reason (`WHY THE
 * CAPS`, above), and the source was the last thing that was not.
 *
 * So it comes through a funnel instead — sorted paths, a byte budget, and a
 * cursor pointing at the last path handed over. The caller walks it at whatever
 * pace it wants, and no single answer can exceed `SOURCE_PAGE_CHARS` however
 * the args are shaped.
 */
const SOURCE_PAGE_CHARS = 200_000;

/** Even a page of one huge file still has to be a page, so a floor applies. */
const MIN_PAGE_CHARS = 8_000;

/**
 * Slice one capped page out of the snapshot, and say where the next one starts.
 *
 * Kept as a plain function rather than written into the handler so the walk can
 * be tested on its own — the whole job of this thing is to hand back every file
 * exactly once, in order, without any single answer getting big.
 *
 * Three rules it will not bend:
 *
 *   - **a page is never empty.** The biggest file always fits, so a file larger
 *     than the budget can never stall the cursor on it forever.
 *   - **the cursor is the last path handed over**, never an index. The Builder
 *     can add or change files between pages; paths stay ordered, so the walk
 *     keeps its place even when the contents shift underneath it.
 *   - **`null` means done**, and only `null` means done.
 */
export function takePage(
  files: Record<string, string>,
  cursor: string | undefined,
  budget: number,
) {
  const paths = Object.keys(files).sort();

  let start = 0;
  if (cursor) {
    const found = paths.findIndex((path) => path > cursor);
    start = found < 0 ? paths.length : found;
  }

  const page: Record<string, string> = {};
  let used = 0;
  let end = start;

  while (end < paths.length) {
    const path = paths[end];
    if (end > start && used + files[path].length > budget) break;
    page[path] = files[path];
    used += files[path].length;
    end += 1;
  }

  return {
    files: page,
    /** Where the next page starts, or `null` when the walk is done. */
    cursor: end < paths.length && end > start ? paths[end - 1] : null,
    bytes: used,
  };
}

/**
 * One capped page of the app's source, plus the cursor for the next one.
 *
 * Ask with no cursor for the first page; when `cursor` comes back `null` the
 * walk is finished. `files` is always sorted, and `patched` is carried on every
 * page so any page on its own still says what the Builder changed.
 */
export const sourcePage = query({
  args: {
    cursor: v.optional(v.string()),
    chars: v.optional(v.float64()),
  },
  handler: async (ctx, { cursor, chars }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Sign in to take a backup.");
    await requireUnlocked(ctx);

    const { files, patched } = await mergedSource(ctx, userId);

    // Requested size, floored and ceilinged: the caller may ask for less, never
    // for more than the funnel will give.
    const budget = Number.isFinite(chars)
      ? Math.min(
          Math.max(Math.floor(chars as number), MIN_PAGE_CHARS),
          SOURCE_PAGE_CHARS,
        )
      : SOURCE_PAGE_CHARS;

    const {
      files: page,
      cursor: next,
      bytes,
    } = takePage(files, cursor, budget);

    return {
      at: SELF_SNAPSHOT_AT,
      files: page,
      patched,
      cursor: next,
      /** How many files the whole snapshot holds, so progress can be shown. */
      total: Object.keys(files).length,
      /** Characters this page carried. */
      bytes,
    };
  },
});

/**
 * What the family has written down, table by table.
 *
 * Shared things — the messenger, the calendar, the shopping list, the files —
 * are read through the viewer's `familyId`, so a backup is this family's and no
 * one else's. Personal things — the AI threads, what the assistant remembers,
 * reminders, feeds, the Builder's bench — are read by owner, so they are only
 * ever your own.
 */
export const data = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Sign in to take a backup.");
    await requireUnlocked(ctx);

    const me = await ctx.db.get(userId);
    const familyId = me?.familyId ?? null;
    const tables: Record<string, unknown[]> = {};

    // The family itself, and everyone still in it. A person's password answer
    // and presence are not carried — this is the roster, nothing more.
    const family = familyId ? await ctx.db.get(familyId) : null;
    tables.families = family ? [family] : [];

    const members = (
      familyId ? await ctx.db.query("users").take(CAPS.members) : me ? [me] : []
    ).filter((row) =>
      familyId ? row.familyId === familyId : row._id === userId,
    );

    tables.users = members.map((row) => ({
      _id: row._id,
      name: row.name ?? null,
      email: row.email ?? null,
      role: row.role ?? null,
      voice: row.voice ?? null,
      voiceDelivery: row.voiceDelivery ?? null,
      studioVoice: row.studioVoice ?? null,
      familyId: row.familyId ?? null,
    }));

    /* --------------------------------------------------------- the messenger */

    const messages = familyId
      ? await ctx.db
          .query("messages")
          .withIndex("by_family", (q) => q.eq("familyId", familyId))
          .order("desc")
          .take(CAPS.messages)
      : [];
    const messageIds = new Set(messages.map((row) => row._id));

    // Plus your own AI threads, which are private and so carry no familyId.
    for (const row of await ctx.db
      .query("messages")
      .order("desc")
      .take(CAPS.messages)) {
      if (messageIds.has(row._id)) continue;
      if (row.ownerId === userId || row.authorId === userId) {
        messages.push(row);
        messageIds.add(row._id);
      }
    }

    // Oldest first again, so the transcript reads the way it was written.
    tables.messages = messages.sort((a, b) => a.createdAt - b.createdAt);

    /* ----------------------------------------------------------- attachments */

    const attachments = familyId
      ? await ctx.db
          .query("attachments")
          .withIndex("by_family", (q) => q.eq("familyId", familyId))
          .order("desc")
          .take(CAPS.attachments)
      : [];
    const attachmentIds = new Set(attachments.map((row) => row._id));

    for (const row of await ctx.db
      .query("attachments")
      .take(CAPS.attachments)) {
      if (attachmentIds.has(row._id)) continue;
      if (row.ownerId === userId) {
        attachments.push(row);
        attachmentIds.add(row._id);
      }
    }

    tables.attachments = await Promise.all(
      attachments.map(async (row) => ({
        _id: row._id,
        name: row.name,
        contentType: row.contentType,
        size: row.size,
        room: row.room,
        createdAt: row.createdAt,
        // A link that keeps working while the file is still in storage, so the
        // bytes can be taken back out even though this export is text-only.
        url: await ctx.storage.getUrl(row.storageId),
      })),
    );

    /* -------------------------------------------------------------- calendar */

    const events = familyId
      ? await ctx.db
          .query("calendarEvents")
          .withIndex("by_family_start", (q) => q.eq("familyId", familyId))
          .take(CAPS.calendarEvents)
      : [];
    const eventIds = new Set(events.map((row) => row._id));

    for (const row of await ctx.db
      .query("calendarEvents")
      .take(CAPS.calendarEvents)) {
      if (row.ownerId === userId && !eventIds.has(row._id)) {
        events.push(row);
        eventIds.add(row._id);
      }
    }

    tables.calendarEvents = events.sort((a, b) => a.startsAt - b.startsAt);

    // Only replies to entries that are in this backup.
    tables.calendarReplies = (
      await ctx.db.query("calendarReplies").take(CAPS.calendarReplies)
    ).filter((row) => eventIds.has(row.eventId));

    tables.calendarFeeds = (
      await ctx.db.query("calendarFeeds").take(CAPS.own)
    ).filter((row) => row.ownerId === userId);

    const prefs = await ctx.db
      .query("calendarPrefs")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    tables.calendarPrefs = prefs ? [prefs] : [];

    /* ------------------------------------------------------ the shopping list */

    const shopping = await ctx.db
      .query("shoppingItems")
      .withIndex("by_owner", (q) => q.eq("ownerId", userId))
      .take(CAPS.shoppingItems);
    const shoppingIds = new Set(shopping.map((row) => row._id));

    if (familyId) {
      for (const row of await ctx.db
        .query("shoppingItems")
        .take(CAPS.shoppingItems)) {
        if (row.familyId === familyId && !shoppingIds.has(row._id)) {
          shopping.push(row);
          shoppingIds.add(row._id);
        }
      }
    }

    tables.shoppingItems = shopping;

    /* ------------------------------------------------------------- your own */

    tables.memories = await ctx.db
      .query("memories")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(CAPS.own);

    tables.reminders = await ctx.db
      .query("reminders")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(CAPS.own);

    const settings = await ctx.db
      .query("settings")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    tables.settings = settings ? [settings] : [];

    // The AI Builder's bench — the files it wrote for you and kept between turns.
    tables.files = await ctx.db
      .query("files")
      .withIndex("by_owner_time", (q) => q.eq("ownerId", userId))
      .take(CAPS.own);

    // The [LIVE] page's cached briefing. It is rebuilt from public sources
    // every few minutes, so it is carried for interest rather than as record.
    tables.briefings = await ctx.db.query("briefings").take(4);

    return { at: new Date().toISOString(), tables, notes: NOTES };
  },
});
