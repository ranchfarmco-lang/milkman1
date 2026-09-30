import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { isUnlocked, requireUnlocked } from "./guard";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import type { Id } from "./_generated/dataModel";

/** A heartbeat older than this counts as offline. */
const ONLINE_WINDOW_MS = 45_000;

export type FamilyMember = {
  _id: string;
  name: string;
  email: string | null;
  online: boolean;
  isMe: boolean;
};

/**
 * The family you are in, who is in it, and a roster scoped to it.
 *
 * Nobody outside your family appears here, and the messenger will not return
 * a single message from anyone else's. Everyone in the family is always on the
 * roster, whether they are around or not — each one carries an honest `online`
 * flag, so the contacts can show who is here and who is away instead of hiding
 * people. Only named accounts count; somebody who never said who they are is
 * not in the family yet.
 */
export const mine = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return { me: null, members: [] as FamilyMember[], family: null };
    }

    // Locked accounts get the same empty answer as signed-out ones: no roster,
    // and no way to learn who is in the family.
    if (!(await isUnlocked(ctx))) {
      return { me: null, members: [] as FamilyMember[], family: null };
    }

    const me = await ctx.db.get(userId);
    const familyId = me?.familyId ?? null;
    const family = familyId ? await ctx.db.get(familyId) : null;

    const presences = await ctx.db.query("presence").take(500);
    const lastSeen = new Map<string, number>();
    for (const presence of presences) {
      lastSeen.set(presence.userId, presence.lastSeenAt);
    }

    const now = Date.now();
    const toMember = (user: {
      _id: Id<"users">;
      name?: string;
      email?: string;
    }): FamilyMember => ({
      _id: user._id,
      name: user.name ?? user.email ?? "Guest",
      email: user.email ?? null,
      online: (lastSeen.get(user._id) ?? 0) > now - ONLINE_WINDOW_MS,
      isMe: user._id === userId,
    });

    // A name is the other half of being in the family. Someone who has not said
    // who they are is not in the contacts and has no messenger, whatever else
    // they have done — so only named accounts are on the roster.
    const named = (user: { name?: string }) =>
      (user.name ?? "").trim().length > 0;

    // No family yet means no one to show but yourself.
    //
    // Everyone named stays on the roster, online or not: presence is shown as a
    // status rather than used to hide people, so "who is here" and "who is in
    // the family" are two different things you can both see.
    const members = familyId
      ? (await ctx.db.query("users").collect())
          .filter((user) => user.familyId === familyId)
          .filter(named)
          .map(toMember)
      : me && named(me)
        ? [toMember(me)]
        : [];

    members.sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return {
      me: members.find((member) => member.isMe) ?? null,
      members,
      family: family
        ? {
            code: family.code,
            memberCount: members.length,
          }
        : null,
    };
  },
});

/**
 * There is one family, and everyone who can open the app is in it. It is made
 * on the spot the first time anyone arrives, and everybody after that joins
 * the same one.
 */
const SHARED_CODE = "FAMILY";

/**
 * Take every unnamed account out of the family.
 *
 * Accounts that answered the password but never said who they are used to sit
 * in the contacts as "Guest". This clears their family membership so they drop
 * off the contacts and the messenger — they can come back simply by setting a
 * name, which puts them straight in. Run it once after the rule changes; it is
 * safe to run again, and it only ever touches accounts with no name.
 */
export const purgeUnnamed = internalMutation({
  args: {},
  handler: async (ctx) => {
    const users = await ctx.db.query("users").take(2000);

    let removed = 0;
    for (const user of users) {
      const named =
        typeof user.name === "string" && user.name.trim().length > 0;
      if (!named && user.familyId !== undefined) {
        await ctx.db.patch(user._id, { familyId: undefined });
        removed += 1;
      }
    }

    return { removed };
  },
});

async function sharedFamily(ctx: MutationCtx, userId: Id<"users">) {
  const existing = await ctx.db
    .query("families")
    .withIndex("by_code", (q) => q.eq("code", SHARED_CODE))
    .collect();

  // If two people arrive at the very same moment, both pick the same, oldest
  // one, so nobody ends up in a family of their own.
  const oldest = existing.sort((a, b) => a.createdAt - b.createdAt)[0];
  if (oldest) return oldest;

  const familyId = await ctx.db.insert("families", {
    code: SHARED_CODE,
    createdBy: userId,
    createdAt: Date.now(),
  });

  return await ctx.db.get(familyId);
}

/**
 * Put whoever is signed in into the shared family, if they are not already in
 * it. Nothing outside the app can reach it, and nothing inside it is visible to
 * anyone who cannot open the app.
 */
export const ensure = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;

    // The one door into a family. Nothing else hands out a familyId, so keeping
    // it shut keeps a locked account out of everything the family shares.
    await requireUnlocked(ctx);

    // The other half of the door: a name. Someone who has answered the password
    // but never said who they are has no familyId, so they are not in the
    // contacts and have no messenger — and nobody sees a "Guest" spot. This runs
    // again the moment a name is set, which is when they join.
    const me = await ctx.db.get(userId);
    const name = typeof me?.name === "string" ? me.name.trim() : "";
    if (!name) return null;

    const family = await sharedFamily(ctx, userId);
    if (!family) return null;

    if (me?.familyId !== family._id) {
      await ctx.db.patch(userId, { familyId: family._id });
    }

    return family.code;
  },
});

/** Just enough about a person for the assistant to talk to them properly. */
export const profile = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const user = await ctx.db.get(userId);
    return {
      name: user?.name ?? null,
      email: user?.email ?? null,
    };
  },
});

/** Called on a timer by the client so the family box knows who is around. */
export const heartbeat = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;

    const existing = await ctx.db
      .query("presence")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();

    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, { lastSeenAt: now });
    } else {
      await ctx.db.insert("presence", { userId, lastSeenAt: now });
    }

    // Coming back puts you back. If this browser was taken off the roster when
    // it went away, simply being here again rejoins the family — the same gate
    // as anywhere else: unlocked, and named. So leaving is always reversible
    // and a device that was only away for a moment is back before anyone
    // notices, while one that really left stays gone.
    const me = await ctx.db.get(userId);
    const named = typeof me?.name === "string" && me.name.trim().length > 0;
    if (me && !me.familyId && named && (await isUnlocked(ctx))) {
      const family = await sharedFamily(ctx, userId);
      if (family) await ctx.db.patch(userId, { familyId: family._id });
    }

    return null;
  },
});

/**
 * Leaving the hub.
 *
 * Called before sign-out and as the tab closes, so someone who leaves stops
 * being in the family straight away instead of lingering as a name nobody can
 * reach: their presence goes and their family membership is cleared. Nothing is
 * destroyed — the moment they open the hub again, `ensure` (or the next
 * heartbeat) puts them back, exactly like a fresh arrival.
 */
export const leave = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;

    const me = await ctx.db.get(userId);
    if (me?.familyId !== undefined) {
      await ctx.db.patch(userId, { familyId: undefined });
    }

    const presence = await ctx.db
      .query("presence")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (presence) await ctx.db.delete(presence._id);

    return null;
  },
});

/**
 * Signing out for good: leave the family *and* give up the name.
 *
 * A name is what puts you in the family, so someone who signs out without
 * giving it up would leave a named account behind — a second copy of you that
 * stays on the roster under the name you just stopped using. This is only ever
 * called from the sign-out button, never when a tab simply closes: closing the
 * tab is `leave`, and coming back restores you exactly as you were.
 */
export const forget = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;

    await ctx.db.patch(userId, { familyId: undefined, name: undefined });

    const presence = await ctx.db
      .query("presence")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (presence) await ctx.db.delete(presence._id);

    // Off any call they were on, so the room does not hold a seat for a name
    // that no longer exists.
    const memberships = await ctx.db
      .query("callMembers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(20);
    for (const membership of memberships) {
      if (membership.state !== "left" && membership.state !== "declined") {
        await ctx.db.patch(membership._id, { state: "left", at: Date.now() });
      }
    }

    return null;
  },
});

/**
 * Clear the old, silent contacts out of the family.
 *
 * Anyone who has not been seen for a while stops being a member, so the roster
 * is only ever the living family. Nothing is destroyed: the moment they sign in
 * again they are put back by `ensure`, exactly like a fresh arrival. Safe to run
 * again; it only ever touches accounts that are not around.
 */
export const purgeOffline = internalMutation({
  args: { olderThanMs: v.optional(v.number()) },
  handler: async (ctx, { olderThanMs }) => {
    const window = Math.max(ONLINE_WINDOW_MS, olderThanMs ?? 60 * 60 * 1000);
    const now = Date.now();

    const presences = await ctx.db.query("presence").take(2000);
    const lastSeen = new Map<string, number>();
    for (const presence of presences) {
      lastSeen.set(presence.userId, presence.lastSeenAt);
    }

    const users = await ctx.db.query("users").take(2000);
    let removed = 0;
    for (const user of users) {
      if (user.familyId === undefined) continue;
      const seen = lastSeen.get(user._id) ?? 0;
      if (now - seen > window) {
        await ctx.db.patch(user._id, { familyId: undefined });
        removed += 1;
      }
    }

    return { removed };
  },
});

/**
 * Take a contact out of the family — the delete button beside a contact.
 *
 * Their name stays on the messages they already sent, but they drop off the
 * contacts and lose the messenger. Nothing is destroyed: they rejoin the same
 * way anyone does, by signing in and being named, so this is a clean-up and not
 * a lock-out.
 */
export const removeMember = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const meId = await getAuthUserId(ctx);
    if (meId === null) throw new Error("Sign in to remove a contact");
    await requireUnlocked(ctx);

    const me = await ctx.db.get(meId);
    const familyId = me?.familyId;
    if (!familyId) throw new Error("Join a family first");
    if (userId === meId) throw new Error("You cannot remove yourself");

    const them = await ctx.db.get(userId);
    if (!them || them.familyId !== familyId) {
      throw new Error("That is not a contact in your family");
    }

    await ctx.db.patch(userId, { familyId: undefined });

    // Off the roster at once, not just after their heartbeat goes stale.
    const presence = await ctx.db
      .query("presence")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (presence) await ctx.db.delete(presence._id);

    // Their own heartbeat puts a named, unlocked account straight back in — so
    // clearing the membership alone would undo this within seconds. Clearing the
    // password answer too is what makes a removal actually hold: they come back
    // by answering the family password again, the same as anyone arriving.
    const access = await ctx.db
      .query("access")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (access) await ctx.db.patch(access._id, { unlockedAt: undefined });

    return null;
  },
});

/** Set (or rename) the name your family sees in the roster and the messenger. */
export const setDisplayName = mutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Sign in to set your name");

    const clean = name.trim().replace(/\s+/g, " ").slice(0, 40);
    if (!clean) throw new Error("Enter a name first");

    await ctx.db.patch(userId, { name: clean });

    // Carry the new name onto what you already sent. Messages keep the name
    // they were sent under, so a rename would otherwise leave the old name
    // sitting in the transcript. This is the account you are on, so it is
    // genuinely your own words being relabelled — never anyone else's.
    const sent = await ctx.db
      .query("messages")
      .withIndex("by_author", (q) => q.eq("authorId", userId))
      .take(500);
    for (const message of sent) {
      if (message.authorName !== clean) {
        await ctx.db.patch(message._id, { authorName: clean });
      }
    }

    return clean;
  },
});
