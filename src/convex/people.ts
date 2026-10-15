import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { deviceStandsOpen } from "./device_rule";
import {
  devicesFor,
  hubPassword,
  ownerId,
  requireUnlocked,
  securityRow,
} from "./guard";

/**
 * The people who have come through the door, and what they left behind.
 *
 * Two concerns, one panel in the Control Room, and deliberately close together
 * in the code:
 *
 *   * **Sign-ins.** One row per arrival — who, where from, what happened, when
 *     — in the `signIns` table. The list is meant to be cleared: a family that
 *     hands a phone round can forget the comings and goings without signing
 *     anybody out. Clearing it never touches an account, a device or a
 *     session, so everyone can sign in again; that is why it is a table of its
 *     own rather than more rows in the security log, which is the record of
 *     authorisations and revocations and is not the thing to throw away.
 *
 *   * **A person's data.** Everything one account wrote here — messages,
 *     memories, reminders, calendar entries and replies, shopping items,
 *     builder files, saved pages and downloads — can be gathered into one
 *     file, or removed for good. Neither the account nor the device is part of
 *     that: after a removal the person still has their name, their device and
 *     their way in.
 *
 *   * **A person, taken away whole.** The same writing can be removed together
 *     with the account that produced it. `deleteAccount` takes everything
 *     `purgeUser` takes, and then the devices, the password answer, the
 *     heartbeat, the arrivals, the seats on any call, the sign-in sessions and
 *     the `users` row itself — so the person is gone rather than emptied. It is
 *     the one thing here that cannot be walked back, and the one whose rule is
 *     about who rather than what: anybody may delete their own account, the
 *     owner may delete anybody's, and only the owner may delete the owner's.
 *
 * Available to everybody who is in: every function here is behind
 * `requireUnlocked`, so anyone signed in to the hub on an authorised device,
 * with the family password answered, may see who has come in, clear the
 * history, and save or remove what a person has written. Nothing is hidden
 * behind a screen — the check is the server's, and a locked or unknown device
 * is refused here no matter what the browser renders. Only the things that
 * change the hub's security — authorising a device, reading the security log,
 * the owner's address — stay with the owner, in `security.ts` and `site.ts`.
 * Deleting an account is the one place where who you are decides what the
 * server will do for you, and it says so on itself in `deleteAccount`.
 */

/** At most one "Signed in" row per account and device inside this window. */
const SESSION_GAP_MS = 20 * 60 * 1000;

/** The most rows any one table of an export carries. */
const CAPS = {
  messages: 2000,
  traces: 500,
  attachments: 500,
  calendarEvents: 1000,
  replies: 2000,
  files: 400,
  signIns: 500,
  own: 1000,
} as const;

/**
 * Write one arrival down. Best effort in the sense that it is only ever
 * called after the thing it records actually happened — a new device, a right
 * password, an account opening the app.
 */
export async function logSignIn(
  ctx: MutationCtx,
  entry: {
    userId: Id<"users">;
    name?: string;
    deviceId?: string;
    deviceName?: string;
    platform?: string;
    what: string;
  },
) {
  await ctx.db.insert("signIns", { at: Date.now(), ...entry });
}

/**
 * Note that this account is here on this device.
 *
 * Called by the app once it is open and the device is authorised. The server
 * keeps it to one row per account and device inside a short window, so a
 * reload is not a new visit and a tab left open overnight does not fill the
 * page — but a genuine return the next morning is recorded.
 */
export const record = mutation({
  args: { deviceId: v.string() },
  handler: async (ctx, { deviceId }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;

    const device = (await devicesFor(ctx, userId)).find(
      (row) => row.deviceId === deviceId,
    );
    // Only a device the hub knows and this account may actually use. The
    // question is the shared rule's, not a second copy of it: a device that
    // stands open — including a `pending` row on a hub with no password left to
    // answer — really is in, and its arrival belongs in the history. Only a
    // revoked (or unknown) installation has nothing to record here; a wrong
    // password is written to the security log instead.
    if (!device || !deviceStandsOpen(device.status, hubPassword() !== null)) {
      return null;
    }

    const last = await ctx.db
      .query("signIns")
      .withIndex("by_user_device", (q) =>
        q.eq("userId", userId).eq("deviceId", deviceId),
      )
      .order("desc")
      .first();
    if (last && Date.now() - last.at < SESSION_GAP_MS) return null;

    const user = await ctx.db.get(userId);
    await logSignIn(ctx, {
      userId,
      name: user?.name,
      deviceId,
      deviceName: device.name,
      platform: device.platform,
      what: "Signed in",
    });
    return null;
  },
});

/** The sign-in history, newest first. Readable by anybody who is in. */
export const list = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    await requireUnlocked(ctx);
    const take = Math.min(Math.max(limit ?? 100, 1), 300);
    const rows = await ctx.db
      .query("signIns")
      .withIndex("by_at")
      .order("desc")
      .take(take);

    // The name as it is now, so renaming yourself does not leave the list
    // saying what you used to be called. The captured name is the fallback for
    // the one case a lookup cannot answer.
    const names = new Map<string, string | null>();
    return await Promise.all(
      rows.map(async (row) => {
        if (!names.has(row.userId)) {
          const user = await ctx.db.get(row.userId);
          names.set(row.userId, user?.name ?? null);
        }
        return {
          _id: row._id,
          userId: row.userId,
          name: names.get(row.userId) ?? row.name ?? null,
          deviceId: row.deviceId ?? null,
          deviceName: row.deviceName ?? null,
          platform: row.platform ?? null,
          what: row.what,
          at: row.at,
        };
      }),
    );
  },
});

/**
 * Delete one sign-in. The history only — the account and its device stay, and
 * so does the person's way in. The security log keeps its own record untouched.
 */
export const remove = mutation({
  args: { id: v.id("signIns") },
  handler: async (ctx, { id }) => {
    await requireUnlocked(ctx);
    await ctx.db.delete(id);
    return { ok: true as const };
  },
});

/**
 * How many rows one pass of a clear removes.
 *
 * Each pass is its own call, and therefore its own transaction: a history of
 * any length clears without ever piling the whole table into a single
 * mutation. The caller is told whether anything is left rather than having to
 * guess how much there was.
 */
const CLEAR_BATCH = 500;

/**
 * Clear the sign-in history, one bounded batch at a time.
 *
 * Nothing but `signIns` rows is touched: no account, no device, no session, no
 * family membership, and none of the security log. Everyone can sign in again
 * — their next arrival is the first row of the new list. Each pass is noted in
 * the security log, because losing a history is worth being able to account
 * for, and `remaining` says whether the caller should ask again: the Control
 * Room's Clear all loops until it answers false, so the whole list goes rather
 * than only the first batch.
 */
export const clear = mutation({
  args: {},
  handler: async (ctx) => {
    await requireUnlocked(ctx);
    const actor = await getAuthUserId(ctx);

    // Oldest first, so what goes is the part a person read long ago.
    const rows = await ctx.db
      .query("signIns")
      .withIndex("by_at")
      .take(CLEAR_BATCH);
    for (const row of rows) await ctx.db.delete(row._id);

    // One probe of what is left, rather than a count of the whole table.
    const remaining =
      (await ctx.db.query("signIns").withIndex("by_at").take(1)).length > 0;

    if (rows.length > 0) {
      await ctx.db.insert("securityLog", {
        at: Date.now(),
        event: "signins.cleared",
        detail: `The sign-in history was cleared (${rows.length} ${
          rows.length === 1 ? "entry" : "entries"
        }${remaining ? ", with more still to clear" : ""}). No account, device or session was touched.`,
        actorId: actor ?? undefined,
      });
    }

    return { removed: rows.length, remaining };
  },
});

/**
 * Forget one person's arrivals, leaving everyone else's list alone.
 *
 * The same bounded batches as `clear`, one account's rows at a time: a
 * `remaining` of true means the caller should ask again, which is what the
 * "Clear their sign-ins" button does until that account's list is empty.
 */
export const removeForUser = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    await requireUnlocked(ctx);
    const rows = await ctx.db
      .query("signIns")
      .withIndex("by_user_device", (q) => q.eq("userId", userId))
      .take(CLEAR_BATCH);
    for (const row of rows) await ctx.db.delete(row._id);

    const remaining =
      (
        await ctx.db
          .query("signIns")
          .withIndex("by_user_device", (q) => q.eq("userId", userId))
          .take(1)
      ).length > 0;

    return { removed: rows.length, remaining };
  },
});

/**
 * Every account, with where and when it was last seen.
 *
 * The people the panel acts on: each row is one account, whether or not it has
 * anything written down, so "save or remove their data" is offered for
 * everyone rather than only for whoever happens to be in the sign-in list.
 *
 * `isMe` and `canDelete` are here as well: `canDelete` is the rule
 * `deleteAccount` enforces, read before the button is drawn, so nobody is
 * offered a press the server is going to refuse. The server still checks — a
 * hidden button is presentation, not permission.
 */
export const accounts = query({
  args: {},
  handler: async (ctx) => {
    await requireUnlocked(ctx);
    const actor = await getAuthUserId(ctx);
    const owner = await ownerId(ctx);
    const users = await ctx.db.query("users").collect();
    const signIns = await ctx.db.query("signIns").collect();

    const summary = new Map<
      string,
      {
        count: number;
        lastAt: number | null;
        lastDeviceName: string | null;
        lastPlatform: string | null;
      }
    >();
    for (const row of signIns) {
      const entry = summary.get(row.userId) ?? {
        count: 0,
        lastAt: null,
        lastDeviceName: null,
        lastPlatform: null,
      };
      entry.count += 1;
      if (entry.lastAt === null || row.at > entry.lastAt) {
        entry.lastAt = row.at;
        entry.lastDeviceName = row.deviceName ?? null;
        entry.lastPlatform = row.platform ?? null;
      }
      summary.set(row.userId, entry);
    }

    return users
      .map((user) => {
        const entry = summary.get(user._id) ?? {
          count: 0,
          lastAt: null,
          lastDeviceName: null,
          lastPlatform: null,
        };
        return {
          userId: user._id,
          name: user.name ?? null,
          // Whether this row is the account reading the list.
          isMe: user._id === actor,
          // Mirrors the rule in `deleteAccount`: your own account, anybody's if
          // you are the owner, and nobody else's if you are not.
          canDelete: user._id === actor || owner === actor || owner !== user._id,
          signIns: entry.count,
          lastAt: entry.lastAt,
          lastDeviceName: entry.lastDeviceName,
          lastPlatform: entry.lastPlatform,
        };
      })
      .sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0));
  },
});

/**
 * Everything one account has written here, as plain JSON for a file.
 *
 * Read on demand, when the Save button is pressed, rather than kept live — the
 * Control Room should not drag a person's whole history across the wire just
 * because the page is open. Each table is capped and says so if anything was
 * left out, the same honesty the hub's own backup uses.
 */
export const exportData = query({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    await requireUnlocked(ctx);
    const user = await ctx.db.get(userId);
    if (!user) throw new Error("That account no longer exists.");

    const tables: Record<string, unknown[]> = {};

    /* Their own writing in every box: their private threads and everything
       they said in the family room. */
    const recent = await ctx.db
      .query("messages")
      .order("desc")
      .take(CAPS.messages);
    tables.messages = recent
      .filter((row) => row.ownerId === userId || row.authorId === userId)
      .reverse();

    const traces = await ctx.db.query("aiTraces").order("desc").take(CAPS.traces);
    tables.aiTraces = traces.filter((row) => row.ownerId === userId);

    const attachments = await ctx.db
      .query("attachments")
      .take(CAPS.attachments);
    tables.attachments = await Promise.all(
      attachments
        .filter((row) => row.ownerId === userId)
        .map(async (row) => ({
          _id: row._id,
          name: row.name,
          contentType: row.contentType,
          size: row.size,
          room: row.room,
          createdAt: row.createdAt,
          // A link that works while the bytes are still in storage, so the
          // file itself can be taken back out even though this is text.
          url: await ctx.storage.getUrl(row.storageId),
        })),
    );

    tables.memories = await ctx.db
      .query("memories")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();

    tables.reminders = await ctx.db
      .query("reminders")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(CAPS.own);

    tables.files = await ctx.db
      .query("files")
      .withIndex("by_owner", (q) => q.eq("ownerId", userId))
      .take(CAPS.files);

    tables.calendarEvents = await ctx.db
      .query("calendarEvents")
      .withIndex("by_owner_start", (q) => q.eq("ownerId", userId))
      .take(CAPS.calendarEvents);

    const replies = await ctx.db
      .query("calendarReplies")
      .take(CAPS.replies);
    tables.calendarReplies = replies.filter((row) => row.userId === userId);

    tables.calendarFeeds = await ctx.db
      .query("calendarFeeds")
      .withIndex("by_owner", (q) => q.eq("ownerId", userId))
      .take(CAPS.own);

    tables.calendarPrefs = await ctx.db
      .query("calendarPrefs")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(CAPS.own);

    tables.shoppingItems = await ctx.db
      .query("shoppingItems")
      .withIndex("by_owner", (q) => q.eq("ownerId", userId))
      .take(CAPS.own);

    tables.browserBookmarks = await ctx.db
      .query("browserBookmarks")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(CAPS.own);

    tables.browserDownloads = await ctx.db
      .query("browserDownloads")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(CAPS.own);

    tables.settings = await ctx.db
      .query("settings")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(CAPS.own);

    tables.liveBoxes = await ctx.db
      .query("liveBoxes")
      .withIndex("by_owner", (q) => q.eq("ownerId", userId))
      .take(CAPS.own);

    tables.signIns = await ctx.db
      .query("signIns")
      .withIndex("by_user_device", (q) => q.eq("userId", userId))
      .take(CAPS.signIns);

    const capped =
      recent.length >= CAPS.messages ||
      traces.length >= CAPS.traces ||
      attachments.length >= CAPS.attachments ||
      replies.length >= CAPS.replies;

    const counts = Object.fromEntries(
      Object.entries(tables).map(([table, rows]) => [table, rows.length]),
    );

    return {
      at: new Date().toISOString(),
      account: {
        userId,
        name: user.name ?? null,
        email: user.email ?? null,
        role: user.role ?? null,
        voice: user.voice ?? null,
      },
      counts,
      notes: capped
        ? [
            "A table with more rows than the cap keeps its most recent ones, so a very long history still fits in one file.",
          ]
        : [],
      tables,
    };
  },
});

/**
 * Everything one account wrote here, row by row.
 *
 * The shared half of the two clean-ups below, so the list of tables lives in
 * one place rather than in two that can drift apart: `purgeUser` takes the
 * writing and leaves the account standing, `deleteAccount` takes the writing
 * and then the account on top of it. It returns what it removed, counted per
 * table, for the log line each of those writes afterwards.
 *
 * Call rows are not in here either way — a call is a handshake in transit
 * between two devices rather than something a person wrote, and it expires on
 * its own. A seat on a call belongs to an account rather than to a call, so
 * `deleteAccount` takes those.
 */
async function purgeWrittenRows(
  ctx: MutationCtx,
  userId: Id<"users">,
): Promise<{ removed: Record<string, number>; total: number }> {
  const removed: Record<string, number> = {};
  const drop = (table: string) => {
    removed[table] = (removed[table] ?? 0) + 1;
  };

  /* Their own writing, in every box. */
  for (const row of await ctx.db.query("messages").collect()) {
    if (row.ownerId === userId || row.authorId === userId) {
      await ctx.db.delete(row._id);
      drop("messages");
    }
  }

  for (const row of await ctx.db.query("aiTraces").collect()) {
    if (row.ownerId === userId) {
      await ctx.db.delete(row._id);
      drop("aiTraces");
    }
  }

  /* The files they attached: the bytes go too, once no other row points at
     them, so nothing is left in storage that nothing refers to. */
  for (const row of await ctx.db.query("attachments").collect()) {
    if (row.ownerId !== userId) continue;
    const sharers = await ctx.db
      .query("attachments")
      .withIndex("by_storage", (q) => q.eq("storageId", row.storageId))
      .collect();
    if (sharers.length <= 1) await ctx.storage.delete(row.storageId);
    await ctx.db.delete(row._id);
    drop("attachments");
  }

  /* What the assistant kept for them, and their timers. */
  for (const row of await ctx.db
    .query("memories")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect()) {
    await ctx.db.delete(row._id);
    drop("memories");
  }
  for (const row of await ctx.db
    .query("reminders")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect()) {
    await ctx.db.delete(row._id);
    drop("reminders");
  }

  /* The bench the AI Builder wrote on. */
  for (const row of await ctx.db
    .query("files")
    .withIndex("by_owner", (q) => q.eq("ownerId", userId))
    .collect()) {
    await ctx.db.delete(row._id);
    drop("files");
  }

  /* The calendar: their entries, everyone's replies to those entries, their
     own replies on other people's, their feeds and their timezone. */
  for (const event of await ctx.db
    .query("calendarEvents")
    .withIndex("by_owner_start", (q) => q.eq("ownerId", userId))
    .collect()) {
    for (const reply of await ctx.db
      .query("calendarReplies")
      .withIndex("by_event", (q) => q.eq("eventId", event._id))
      .collect()) {
      await ctx.db.delete(reply._id);
      drop("calendarReplies");
    }
    await ctx.db.delete(event._id);
    drop("calendarEvents");
  }
  for (const row of await ctx.db.query("calendarReplies").collect()) {
    if (row.userId !== userId) continue;
    await ctx.db.delete(row._id);
    drop("calendarReplies");
  }
  for (const row of await ctx.db
    .query("calendarFeeds")
    .withIndex("by_owner", (q) => q.eq("ownerId", userId))
    .collect()) {
    await ctx.db.delete(row._id);
    drop("calendarFeeds");
  }
  for (const row of await ctx.db
    .query("calendarPrefs")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect()) {
    await ctx.db.delete(row._id);
    drop("calendarPrefs");
  }

  /* The shopping list. */
  for (const row of await ctx.db
    .query("shoppingItems")
    .withIndex("by_owner", (q) => q.eq("ownerId", userId))
    .collect()) {
    await ctx.db.delete(row._id);
    drop("shoppingItems");
  }

  /* The browser's saved pages, and downloads with their bytes. */
  for (const row of await ctx.db
    .query("browserBookmarks")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect()) {
    await ctx.db.delete(row._id);
    drop("browserBookmarks");
  }
  const downloads = await ctx.db.query("browserDownloads").collect();
  for (const row of downloads) {
    if (row.userId !== userId) continue;
    // The bytes go only when no other row still points at them.
    const shared = downloads.some(
      (other) => other._id !== row._id && other.storageId === row.storageId,
    );
    if (!shared) await ctx.storage.delete(row.storageId);
    await ctx.db.delete(row._id);
    drop("browserDownloads");
  }

  /* Their switches, their heartbeat, any [LIVE] boxes they installed, and the
     relays their own pages opened to a model server on this machine. */
  for (const row of await ctx.db
    .query("settings")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect()) {
    await ctx.db.delete(row._id);
    drop("settings");
  }
  for (const row of await ctx.db
    .query("presence")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect()) {
    await ctx.db.delete(row._id);
    drop("presence");
  }
  for (const row of await ctx.db
    .query("liveBoxes")
    .withIndex("by_owner", (q) => q.eq("ownerId", userId))
    .collect()) {
    await ctx.db.delete(row._id);
    drop("liveBoxes");
  }
  for (const row of await ctx.db
    .query("localRelays")
    .withIndex("by_owner_status", (q) => q.eq("ownerId", userId))
    .collect()) {
    await ctx.db.delete(row._id);
    drop("localRelays");
  }

  const total = Object.values(removed).reduce((sum, n) => sum + n, 0);
  return { removed, total };
}

/**
 * Remove everything one account wrote here, for good.
 *
 * The account itself is untouched on purpose — its name, its devices, its
 * password answer and its place in the family all stay — so the person can
 * open the hub again and start with a clean page. Deleting the person rather
 * than only the writing is `deleteAccount` below. Either way the removal is
 * written to the security log, because something being destroyed is worth
 * being able to account for even after it is gone.
 */
export const purgeUser = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    await requireUnlocked(ctx);
    const actor = await getAuthUserId(ctx);
    const account = await ctx.db.get(userId);

    const { removed, total } = await purgeWrittenRows(ctx, userId);

    const actorUser = actor ? await ctx.db.get(actor) : null;
    await ctx.db.insert("securityLog", {
      at: Date.now(),
      event: "data.purged",
      detail: `Everything ${account?.name ?? "an account"} had written was removed (${total} ${
        total === 1 ? "row" : "rows"
      }). The account, its devices and its access are untouched.`,
      actorId: actor ?? undefined,
      actorName: actorUser?.name,
    });

    return { removed, total };
  },
});

/**
 * Delete an account itself — the person, not only what they wrote.
 *
 * Everything `purgeUser` removes goes first (the shared `purgeWrittenRows`
 * above), and then everything that made this account a way into the hub:
 *
 *   * **devices** — no installation of this hub is theirs any more;
 *   * **access** — the record that the family password was answered on it;
 *   * **sign-ins** — every arrival written against them;
 *   * **call seats and signals** — a call is a live negotiation between
 *     accounts, and one of them has just stopped existing;
 *   * **sessions, refresh tokens, accounts and verification codes** — every
 *     row of the four auth tables, so a browser still holding this person's
 *     access token can refresh nothing.
 *
 * The token in that browser stays good until it expires — it is a signed JWT
 * and no server can take back a signature — which is an hour at the very most.
 * After that there is nothing left to come back to: the next sign-in there
 * makes a brand-new account, exactly as it would for a stranger.
 *
 * Who may press it is the one thing here decided by who rather than what:
 *
 *   * anybody may delete their own account — it is theirs to throw away;
 *   * the hub's owner may delete anybody's;
 *   * nobody else may delete the owner's. Without that last rule a family
 *     member could remove the owner's account and then answer the family
 *     password to claim the hub for themselves, which is a takeover wearing
 *     tidying-up clothes.
 *
 * When the owner's account is the one deleted, the hub is left ownerless —
 * the state it is in before anybody has claimed it. `registrationOpen` goes
 * back to true and the next person to answer the family password becomes the
 * owner, which is the same recovery a lost owner's device already has.
 *
 * A call the deleted account started stays in the record with its starter
 * gone; the name reads "Someone" and nothing else about the call changes.
 */
export const deleteAccount = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    await requireUnlocked(ctx);
    const actor = await getAuthUserId(ctx);
    if (actor === null) throw new Error("Sign in first.");

    const account = await ctx.db.get(userId);
    if (!account) throw new Error("That account no longer exists.");

    // Who is allowed to do this, checked here and mirrored in `accounts` below
    // so the button is only ever shown where the server would say yes.
    const owner = await ownerId(ctx);
    const targetIsOwner = owner === userId;
    const actorIsOwner = owner === actor;
    if (targetIsOwner && !actorIsOwner) {
      throw new Error("Only the hub's owner can delete the owner's account.");
    }

    const { removed } = await purgeWrittenRows(ctx, userId);
    const drop = (table: string) => {
      removed[table] = (removed[table] ?? 0) + 1;
    };

    /* The door they came in through. */
    for (const row of await devicesFor(ctx, userId)) {
      await ctx.db.delete(row._id);
      drop("devices");
    }
    for (const row of await ctx.db
      .query("access")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect()) {
      await ctx.db.delete(row._id);
      drop("access");
    }
    for (const row of await ctx.db
      .query("signIns")
      .withIndex("by_user_device", (q) => q.eq("userId", userId))
      .collect()) {
      await ctx.db.delete(row._id);
      drop("signIns");
    }

    /* Their seat on any call, and the handshake in transit to or from them. */
    for (const row of await ctx.db
      .query("callMembers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect()) {
      await ctx.db.delete(row._id);
      drop("callMembers");
    }
    for (const row of await ctx.db.query("callSignals").collect()) {
      if (row.fromId !== userId && row.toId !== userId) continue;
      await ctx.db.delete(row._id);
      drop("callSignals");
    }

    /* Every way in. Sessions first, because a refresh token is only ever a
       thing hanging off a session; the account rows go last, so a sign-in
       cannot find the account it made and hand out a session for a user that
       is about to have its row deleted. */
    const verifiers = await ctx.db.query("authVerifiers").collect();
    for (const session of await ctx.db
      .query("authSessions")
      .withIndex("userId", (q) => q.eq("userId", userId))
      .collect()) {
      for (const row of await ctx.db
        .query("authRefreshTokens")
        .withIndex("sessionId", (q) => q.eq("sessionId", session._id))
        .collect()) {
        await ctx.db.delete(row._id);
        drop("authRefreshTokens");
      }
      for (const row of verifiers) {
        if (row.sessionId !== session._id) continue;
        await ctx.db.delete(row._id);
        drop("authVerifiers");
      }
      await ctx.db.delete(session._id);
      drop("authSessions");
    }
    for (const authAccount of await ctx.db
      .query("authAccounts")
      .withIndex("userIdAndProvider", (q) => q.eq("userId", userId))
      .collect()) {
      for (const row of await ctx.db
        .query("authVerificationCodes")
        .withIndex("accountId", (q) => q.eq("accountId", authAccount._id))
        .collect()) {
        await ctx.db.delete(row._id);
        drop("authVerificationCodes");
      }
      await ctx.db.delete(authAccount._id);
      drop("authAccounts");
    }

    /* The owner is the one record that has to be dealt with by hand: an owner
       who no longer exists would leave a hub nobody can administer and nobody
       can claim, which is exactly the lockout the `register` rules exist to
       avoid. Handing it back to "no owner yet" is the state before anyone
       claimed it. */
    const wasOwner = targetIsOwner;
    const security = await securityRow(ctx);
    if (wasOwner && security) {
      await ctx.db.patch(security._id, {
        ownerUserId: undefined,
        ownerName: undefined,
        registrationOpen: true,
        updatedAt: Date.now(),
      });
    }

    /* Then the person. */
    await ctx.db.delete(userId);

    const total = Object.values(removed).reduce((sum, n) => sum + n, 0);
    const actorUser = await ctx.db.get(actor);
    await ctx.db.insert("securityLog", {
      at: Date.now(),
      event: "account.deleted",
      detail: `The account ${account.name ?? '"Unnamed account"'} was deleted: everything it had written, its ${
        removed.devices ?? 0
      } ${removed.devices === 1 ? "device" : "devices"}, and every way in (${total} ${
        total === 1 ? "row" : "rows"
      }).${
        wasOwner
          ? " It was the owner's account, so the hub has no owner now — the next person to answer the family password takes it over."
          : ""
      }`,
      actorId: actor,
      actorName: actorUser?.name,
    });

    return { removed, total, wasOwner };
  },
});
