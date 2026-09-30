import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import {
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";

/**
 * The signaling half of a call. The audio and video go straight between the
 * devices over WebRTC, encrypted end to end; this only carries the handshake
 * that lets them find each other, so nothing said in a call ever passes through
 * here.
 */

/** A call nobody ever answered or ended is treated as dead after this. */
const STALE_MS = 2 * 60 * 60 * 1000;

/**
 * Four people is the ceiling — that is what the grid in the messenger draws.
 * Everyone connects straight to everyone else, so three other people is already
 * six links across the callers.
 */
const MAX_CALL_PARTICIPANTS = 4;

type MemberDoc = Doc<"callMembers">;

/** The live call this person is in, if any, newest first. */
async function liveFor(ctx: QueryCtx | MutationCtx, userId: Id<"users">) {
  const memberships = await ctx.db
    .query("callMembers")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(20);

  const now = Date.now();
  const live: { membership: MemberDoc; call: Doc<"calls"> }[] = [];

  for (const membership of memberships) {
    if (membership.state === "declined" || membership.state === "left") {
      continue;
    }
    const call = await ctx.db.get(membership.callId);
    if (!call || call.state === "ended") continue;
    if (now - call.createdAt > STALE_MS) continue;
    live.push({ membership, call });
  }

  live.sort((a, b) => b.call.createdAt - a.call.createdAt);
  return live[0] ?? null;
}

async function membersOf(ctx: QueryCtx | MutationCtx, callId: Id<"calls">) {
  return await ctx.db
    .query("callMembers")
    .withIndex("by_call", (q) => q.eq("callId", callId))
    .take(50);
}

/** The family's standing video room, if one is open right now. */
async function liveRoomForFamily(
  ctx: QueryCtx | MutationCtx,
  familyId: Id<"families">,
) {
  const now = Date.now();

  // The family row names the room, so two people joining at once settle on the
  // same one instead of each opening their own.
  const family = await ctx.db.get(familyId);
  if (family?.roomCallId) {
    const pointed = await ctx.db.get(family.roomCallId);
    if (
      pointed &&
      pointed.room === true &&
      pointed.state !== "ended" &&
      now - pointed.createdAt <= STALE_MS
    ) {
      return pointed;
    }
  }

  // Fall back to a scan for a room opened before the family row named one.
  const rows = await ctx.db
    .query("calls")
    .withIndex("by_family", (q) => q.eq("familyId", familyId))
    .order("desc")
    .take(10);

  return (
    rows.find(
      (call) =>
        call.room === true &&
        call.state !== "ended" &&
        now - call.createdAt <= STALE_MS,
    ) ?? null
  );
}

/** End a call for everybody, and drop the handshake it left behind. */
async function closeCall(ctx: MutationCtx, callId: Id<"calls">) {
  const call = await ctx.db.get(callId);
  if (!call || call.state === "ended") return;

  await ctx.db.patch(callId, { state: "ended", endedAt: Date.now() });

  // A standing room also stops being the family's room, so the next join opens
  // a fresh one rather than reaching for this ended one.
  if (call.room === true) {
    const family = await ctx.db.get(call.familyId);
    if (family?.roomCallId === callId) {
      await ctx.db.patch(call.familyId, { roomCallId: undefined });
    }
  }

  for (const membership of await membersOf(ctx, callId)) {
    if (membership.state !== "left") {
      await ctx.db.patch(membership._id, { state: "left", at: Date.now() });
    }
  }

  const signals = await ctx.db
    .query("callSignals")
    .withIndex("by_call_to", (q) => q.eq("callId", callId))
    .take(500);
  for (const signal of signals) {
    await ctx.db.delete(signal._id);
  }
}

/**
 * The call you are in, who else is on it, and whether it is still ringing at
 * you. This is everything the page needs to show the call panel.
 */
export const current = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;

    const live = await liveFor(ctx, userId);
    if (!live) return null;

    const { call, membership } = live;
    const members = await membersOf(ctx, call._id);
    const starter = await ctx.db.get(call.startedBy);

    const people = await Promise.all(
      members
        .filter((one) => one.state !== "declined" && one.state !== "left")
        .map(async (one) => {
          const user = await ctx.db.get(one.userId);
          return {
            userId: one.userId,
            name: user?.name ?? user?.email ?? "Guest",
            state: one.state,
            isMe: one.userId === userId,
          };
        }),
    );

    return {
      callId: call._id,
      kind: call.kind,
      /** A standing room: joined, not rung, and nobody to answer. */
      room: call.room === true,
      state: call.state,
      startedBy: call.startedBy,
      startedByName: starter?.name ?? starter?.email ?? "Someone",
      myState: membership.state,
      /** Still ringing at me, so it needs an answer or a decline. */
      incoming:
        membership.state === "ringing" && call.startedBy !== userId,
      people,
      joined: people.filter((one) => one.state === "joined").length,
    };
  },
});

/**
 * Whether a named person is allowed to be on this call right now.
 *
 * The relay token is minted behind this, so a token is only ever handed to
 * someone the call already includes — nobody can walk into another family's
 * room by guessing its name.
 */
export const canJoin = internalQuery({
  args: { callId: v.id("calls"), userId: v.id("users") },
  handler: async (ctx, { callId, userId }) => {
    const call = await ctx.db.get(callId);
    if (!call || call.state === "ended") return false;
    if (Date.now() - call.createdAt > STALE_MS) return false;

    const mine = (await membersOf(ctx, callId)).find(
      (one) => one.userId === userId,
    );
    return Boolean(mine && mine.state !== "left" && mine.state !== "declined");
  },
});

/**
 * The handshake messages waiting for me on this call. The page keeps track of
 * the ones it has already handled, so this can stay a plain reactive read.
 */
export const signals = query({
  args: { callId: v.id("calls") },
  handler: async (ctx, { callId }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];

    const rows = await ctx.db
      .query("callSignals")
      .withIndex("by_call_to", (q) =>
        q.eq("callId", callId).eq("toId", userId),
      )
      .take(200);

    return rows.map((row) => ({
      _id: row._id,
      fromId: row.fromId,
      kind: row.kind,
      payload: row.payload,
    }));
  },
});

/** Ring someone — one person, or everyone else in the family. */
export const start = mutation({
  args: {
    kind: v.union(v.literal("audio"), v.literal("video")),
    to: v.array(v.id("users")),
  },
  handler: async (ctx, { kind, to }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Sign in to start a call");

    const me = await ctx.db.get(userId);
    const familyId = me?.familyId;
    if (!familyId) throw new Error("Nobody to call yet");

    // One call at a time: whatever I was in is over.
    const live = await liveFor(ctx, userId);
    if (live) await closeCall(ctx, live.call._id);

    const callId = await ctx.db.insert("calls", {
      familyId,
      kind,
      startedBy: userId,
      state: "ringing",
      createdAt: Date.now(),
    });

    await ctx.db.insert("callMembers", {
      callId,
      userId,
      state: "joined",
      at: Date.now(),
    });

    let invited = 0;
    for (const other of new Set(to)) {
      if (other === userId) continue;
      if (invited >= MAX_CALL_PARTICIPANTS - 1) break;
      const user = await ctx.db.get(other);
      if (!user || user.familyId !== familyId) continue;
      invited += 1;
      await ctx.db.insert("callMembers", {
        callId,
        userId: other,
        state: "ringing",
        at: Date.now(),
      });
    }

    return callId;
  },
});

/**
 * Get on the family's video room and wait.
 *
 * There is no ringing and nobody to invite — the room is the same one for
 * everybody, and it opens the moment the first person joins. Whoever turns up
 * next finds it already open, and every device connects straight to every other
 * on its own. Leaving does not shut it down while anyone is still in it.
 */
export const join = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Sign in to join the call");

    const me = await ctx.db.get(userId);
    const familyId = me?.familyId;
    if (!familyId) throw new Error("Join a family first");

    const room = await liveRoomForFamily(ctx, familyId);
    const callId =
      room?._id ??
      (await ctx.db.insert("calls", {
        familyId,
        kind: "video",
        startedBy: userId,
        state: "active",
        room: true,
        createdAt: Date.now(),
      }));

    // Claim the room on the family row. If someone else was inserting one at
    // the same moment, this write collides with theirs and this mutation is
    // retried, at which point `liveRoomForFamily` finds theirs and we share it
    // instead of leaving two rooms behind.
    if (room === null) {
      await ctx.db.patch(familyId, { roomCallId: callId });
    }

    const members = await membersOf(ctx, callId);
    const mine = members.find((one) => one.userId === userId);
    if (mine) {
      await ctx.db.patch(mine._id, { state: "joined", at: Date.now() });
    } else {
      await ctx.db.insert("callMembers", {
        callId,
        userId,
        state: "joined",
        at: Date.now(),
      });
    }

    return callId;
  },
});

/** Answer. Once two people are in, the call is live. */
export const answer = mutation({
  args: { callId: v.id("calls") },
  handler: async (ctx, { callId }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Sign in to answer");

    const members = await membersOf(ctx, callId);
    const mine = members.find((one) => one.userId === userId);
    if (!mine) throw new Error("That call is not for you");

    await ctx.db.patch(mine._id, { state: "joined", at: Date.now() });

    const joined = members.filter(
      (one) => one.state === "joined" || one._id === mine._id,
    ).length;

    const call = await ctx.db.get(callId);
    if (call && call.state === "ringing" && joined >= 2) {
      await ctx.db.patch(callId, { state: "active" });
    }

    return null;
  },
});

/** No thanks. If nobody is left to pick up, the call is over. */
export const decline = mutation({
  args: { callId: v.id("calls") },
  handler: async (ctx, { callId }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;

    const members = await membersOf(ctx, callId);
    const mine = members.find((one) => one.userId === userId);
    if (!mine) return null;

    await ctx.db.patch(mine._id, { state: "declined", at: Date.now() });

    // Nobody picked up and nobody is still ringing — there is no call left.
    const remaining = members.filter((one) => one._id !== mine._id);
    const anyJoined = remaining.some((one) => one.state === "joined");
    const anyRinging = remaining.some((one) => one.state === "ringing");
    if (!anyJoined && !anyRinging) await closeCall(ctx, callId);

    return null;
  },
});

/** Step out of a call without ending it for anyone else. */
export const leave = mutation({
  args: { callId: v.id("calls") },
  handler: async (ctx, { callId }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;

    const members = await membersOf(ctx, callId);
    const mine = members.find((one) => one.userId === userId);
    if (mine) await ctx.db.patch(mine._id, { state: "left", at: Date.now() });

    const call = await ctx.db.get(callId);
    const others = members.filter(
      (one) => one._id !== mine?._id && one.state === "joined",
    );

    // A standing room stays open for as long as anyone is still in it, so the
    // next person to turn up finds the others waiting. A one-to-one call, on
    // the other hand, is over the moment one side goes.
    if (call?.room === true) {
      if (others.length === 0) await closeCall(ctx, callId);
    } else if (others.length < 2) {
      await closeCall(ctx, callId);
    }

    return null;
  },
});

/** Hang up on everybody. */
export const end = mutation({
  args: { callId: v.id("calls") },
  handler: async (ctx, { callId }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;
    await closeCall(ctx, callId);
    return null;
  },
});

/** Hand a piece of the handshake to one other person. */
export const signal = mutation({
  args: {
    callId: v.id("calls"),
    toId: v.id("users"),
    kind: v.union(
      v.literal("offer"),
      v.literal("answer"),
      v.literal("ice"),
    ),
    payload: v.string(),
  },
  handler: async (ctx, { callId, toId, kind, payload }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;

    const call = await ctx.db.get(callId);
    if (!call || call.state === "ended") return null;

    await ctx.db.insert("callSignals", {
      callId,
      fromId: userId,
      toId,
      kind,
      payload,
      createdAt: Date.now(),
    });

    return null;
  },
});
