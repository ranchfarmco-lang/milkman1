import { getAuthUserId } from "@convex-dev/auth/server";
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
 * The app as it stands right now, with anything the AI Builder has changed put
 * on top of the shipped snapshot.
 *
 * The builder keeps a working copy of this project on its bench (`files`), and
 * when it fixes a bug or reworks a file it writes the whole changed file there.
 * That is the one place the builder's changes to *this app* actually land, so a
 * backup that ignored the bench would hand back the un-repaired app. Merging a
 * bench file back over the snapshot, whenever its path is a real project path,
 * is what lets the hub fix itself and hand the person the fixed copy.
 *
 * Only paths that are part of the app are merged — a scratch file the builder
 * wrote is left where it belongs, on the bench, and named in `patched`.
 */
async function mergedSource(ctx: QueryCtx, userId: Id<"users">) {
  const rows = await ctx.db
    .query("files")
    .withIndex("by_owner", (q) => q.eq("ownerId", userId))
    .collect();

  const files: Record<string, string> = { ...SELF_SOURCE };
  const patched: string[] = [];

  for (const row of rows) {
    // Only a real project path is merged; a scratch file stays on the bench.
    if (!(row.path in SELF_SOURCE)) continue;
    if (files[row.path] === row.content) continue;
    files[row.path] = row.content;
    patched.push(row.path);
  }

  return { files, patched };
}

/**
 * The shape of the source: how many files, how much text, when it was taken,
 * and how many files the AI Builder has changed since. Small enough to keep the
 * panel's numbers live without pulling the whole thing across on every render.
 */
export const manifest = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;
    await requireUnlocked(ctx);

    const { files, patched } = await mergedSource(ctx, userId);
    const paths = Object.keys(files);
    let bytes = 0;
    for (const path of paths) bytes += files[path].length;

    return {
      at: SELF_SNAPSHOT_AT,
      files: paths.length,
      bytes,
      changed: patched.length,
    };
  },
});

/**
 * Every file the app is made of, as path → contents, with the AI Builder's own
 * changes merged in. `patched` names the files it changed, so the person knows
 * what came from the builder and what shipped.
 */
export const source = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Sign in to take a backup.");
    await requireUnlocked(ctx);

    const { files, patched } = await mergedSource(ctx, userId);
    return { at: SELF_SNAPSHOT_AT, files, patched };
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
      familyId
        ? await ctx.db.query("users").take(CAPS.members)
        : me
          ? [me]
          : []
    ).filter((row) => (familyId ? row.familyId === familyId : row._id === userId));

    tables.users = members.map((row) => ({
      _id: row._id,
      name: row.name ?? null,
      email: row.email ?? null,
      role: row.role ?? null,
      voice: row.voice ?? null,
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
    for (const row of await ctx.db.query("messages").order("desc").take(CAPS.messages)) {
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

    for (const row of await ctx.db.query("attachments").take(CAPS.attachments)) {
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

    for (const row of await ctx.db.query("calendarEvents").take(CAPS.calendarEvents)) {
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
      for (const row of await ctx.db.query("shoppingItems").take(CAPS.shoppingItems)) {
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
