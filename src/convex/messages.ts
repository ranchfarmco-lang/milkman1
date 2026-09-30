import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import { roomValidator, type TraceStepKind } from "./schema";
import { isUnlocked, requireUnlocked } from "./guard";

const THREAD_LIMIT = 200;

/** How much of a turn's working rides along with its reply. */
const FEED_CHARS = 40_000;

/**
 * The working behind a reply, taken off the turn that produced it.
 *
 * The turn is where the thinking is written while it is happening; this copies
 * it onto the reply so it stays there. Two things are left out on purpose: the
 * `answer` steps, which are the words of the message this is going onto, and
 * anything past the cap — the feed is read with every look at the thread, and a
 * very long job should not make the chat heavy.
 *
 * The system that answered is handed in rather than read off the trace. A reply
 * is written the instant it is finished and the trace is closed immediately
 * after, so at this moment the name of the model is not in it yet — and the
 * kept feed would be the one place the working is not attributed to anything.
 */
async function feedFor(
  ctx: MutationCtx,
  traceId: Id<"aiTraces">,
  by?: string,
) {
  const trace = await ctx.db.get(traceId);
  if (!trace) return undefined;

  const steps: { kind: TraceStepKind; text: string; at: number }[] = [];
  let chars = 0;

  for (const step of trace.steps) {
    if (step.kind === "answer") continue;
    chars += step.text.length;
    if (chars > FEED_CHARS) break;
    steps.push({ kind: step.kind, text: step.text, at: step.at });
  }

  if (!steps.length) return undefined;

  return {
    by: by ?? trace.by,
    ms: Math.max(0, trace.updatedAt - trace.startedAt),
    steps,
  };
}

/** How much conversation the model gets to see. */
const CONTEXT_LIMIT = 24;

function displayName(user: {
  name?: string;
  email?: string;
  isAnonymous?: boolean;
} | null) {
  if (!user) return "Guest";
  return user.name ?? user.email ?? "Guest";
}

/**
 * The transcript for one box.
 *
 * The family messenger is shared: everyone signed in sees the same thread.
 * The two AI boxes are private to whoever is signed in.
 */
export const list = query({
  args: { room: roomValidator },
  handler: async (ctx, { room }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];

    // Locked means locked: no transcript, not even your own.
    if (!(await isUnlocked(ctx))) return [];

    if (room === "messenger") {
      // The messenger belongs to a family and nobody else. Without a family
      // there is nothing to read, and there is no way to reach another one's.
      const me = await ctx.db.get(userId);
      const familyId = me?.familyId;
      if (!familyId) return [];

      const rows = await ctx.db
        .query("messages")
        .withIndex("by_family", (q) => q.eq("familyId", familyId))
        .order("desc")
        .take(THREAD_LIMIT);

      return rows
        .filter((row) => row.room === "messenger")
        .reverse();
    }

    const rows = await ctx.db
      .query("messages")
      .withIndex("by_room_owner", (q) =>
        q.eq("room", room).eq("ownerId", userId),
      )
      .order("desc")
      .take(THREAD_LIMIT);

    return rows.reverse();
  },
});

/** The last few messages, oldest first — used as model context. */
export const history = internalQuery({
  args: {
    room: roomValidator,
    ownerId: v.id("users"),
    // Coding sessions need a longer memory than a quick chat.
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { room, ownerId, limit }) => {
    // The context a model is handed, and therefore the model call itself, is
    // only assembled for an account that is unlocked. `respond` treats an
    // empty history as "nothing to reply to", so a locked account spends no
    // key: this is the guard on the assistant's box.
    if (!(await isUnlocked(ctx))) return [];

    const take = Math.min(60, Math.max(4, Math.round(limit ?? CONTEXT_LIMIT)));

    const rows = await ctx.db
      .query("messages")
      .withIndex("by_room_owner", (q) =>
        q.eq("room", room).eq("ownerId", ownerId),
      )
      .order("desc")
      .take(take);

    return rows.reverse().map((row) => ({
      // A message another AI wrote is part of the conversation, not something
      // the person said.
      role:
        row.role === "member" && row.authorName?.startsWith("AI ")
          ? ("assistant" as const)
          : row.role,
      text: row.text,
      authorName: row.authorName ?? null,
    }));
  },
});

/** Post one of your own messages into a box. */
export const send = mutation({
  args: { room: roomValidator, text: v.string() },
  handler: async (ctx, { room, text }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Sign in to send a message");

    // Nothing goes into a box until the family password has been answered.
    await requireUnlocked(ctx);

    const trimmed = text.trim();
    if (!trimmed) return null;

    const user = await ctx.db.get(userId);

    // You can only add to a family thread you are actually part of.
    const familyId = user?.familyId;
    if (room === "messenger" && !familyId) {
      throw new Error("Join a family first to send a message");
    }

    await ctx.db.insert("messages", {
      room,
      role: room === "messenger" ? "member" : "user",
      text: trimmed,
      familyId: room === "messenger" ? familyId : undefined,
      ownerId: userId,
      authorId: userId,
      authorName: displayName(user),
      createdAt: Date.now(),
    });

    return null;
  },
});

/**
 * The family's recent messages, oldest last, plus who is around.
 * This is what an AI reads when asked what the family has been saying — the
 * same room the people in that family can already read, and nobody else's.
 */
export const familyRecent = internalQuery({
  args: { userId: v.id("users"), limit: v.optional(v.number()) },
  handler: async (ctx, { userId, limit }) => {
    const me = await ctx.db.get(userId);
    const familyId = me?.familyId;
    if (!familyId) return null;

    const take = Math.min(60, Math.max(2, Math.round(limit ?? 20)));
    const rows = await ctx.db
      .query("messages")
      .withIndex("by_family", (q) => q.eq("familyId", familyId))
      .order("desc")
      .take(take);

    const messages = rows
      .filter((row) => row.room === "messenger")
      .reverse()
      .map((row) => ({
        author:
          row.authorId === userId ? "You" : (row.authorName ?? "Family"),
        text: row.text,
      }));

    // Only named accounts are really in the family, so they are the ones the
    // assistant counts when it talks about who is around.
    const people = (await ctx.db.query("users").collect()).filter(
      (user) =>
        user.familyId === familyId && (user.name ?? "").trim().length > 0,
    );
    const presences = await ctx.db.query("presence").take(500);
    const lastSeen = new Map<string, number>();
    for (const presence of presences) {
      lastSeen.set(presence.userId, presence.lastSeenAt);
    }
    const now = Date.now();
    const online = people.filter(
      (user) => (lastSeen.get(user._id) ?? 0) > now - 45_000,
    ).length;

    return { messages, members: people.length, online };
  },
});

/**
 * How the assistant's own thread is timed: when they last said anything, and
 * how many assistant messages have piled up since. A normal exchange ends with
 * one reply, so anything past that is the assistant having spoken up on its
 * own — which is how it knows not to do it twice in the same silence.
 */
export const assistantTiming = internalQuery({
  args: { ownerId: v.id("users") },
  handler: async (ctx, { ownerId }) => {
    // Same door as `history`, for the assistant speaking up on its own: with no
    // history it finds nothing to say, so `nudge` spends no key either.
    if (!(await isUnlocked(ctx))) {
      return { hasHistory: false, lastUserAt: null, assistantSinceUser: 0 };
    }

    const rows = await ctx.db
      .query("messages")
      .withIndex("by_room_owner", (q) =>
        q.eq("room", "assistant").eq("ownerId", ownerId),
      )
      .order("desc")
      .take(30);

    const lastUserAt =
      rows.find((row) => row.role === "user")?.createdAt ?? null;
    const assistantSinceUser = lastUserAt
      ? rows.filter(
          (row) => row.role === "assistant" && row.createdAt >= lastUserAt,
        ).length
      : 0;

    return { hasHistory: rows.length > 0, lastUserAt, assistantSinceUser };
  },
});

/**
 * Put something into the family's shared room — used when an AI shares a note
 * with the family for you. Without a family there is nobody to tell.
 */
export const postToFamily = internalMutation({
  args: {
    userId: v.id("users"),
    text: v.string(),
    /** Who it should look like it came from; the person by default. */
    authoredBy: v.optional(v.string()),
  },
  handler: async (ctx, { userId, text, authoredBy }) => {
    const user = await ctx.db.get(userId);
    const familyId = user?.familyId;
    if (!familyId) return { ok: false as const, reason: "no-family" };

    const trimmed = text.trim().slice(0, 2000);
    if (!trimmed) return { ok: false as const, reason: "empty" };

    await ctx.db.insert("messages", {
      room: "messenger",
      role: "member",
      text: trimmed,
      familyId,
      ownerId: userId,
      authorId: userId,
      authorName: authoredBy?.trim() || displayName(user),
      createdAt: Date.now(),
    });

    return { ok: true as const };
  },
});

/**
 * Store an AI reply in the thread it belongs to.
 *
 * `oncePerSilence` is for the unprompted lines. The hub can be open in several
 * tabs or on more than one device, and each one asks for its own nudge;
 * because reading the timing and writing the line are separated by a model
 * call that takes seconds, every one of them sees the same "nothing said yet"
 * and they all land together. Asking for the write itself to re-check makes it
 * atomic: the first one through is kept and the rest are dropped, so one
 * silence still gets exactly one remark.
 *
 * The check counts lines carrying the *same note* — which is what marks a line
 * as unprompted — rather than every assistant line. Putting the ordinary reply
 * to the person in that count would read a handled question as one the
 * assistant had already chimed in on, and it would never speak up at all.
 */
export const appendReply = internalMutation({
  args: {
    room: roomValidator,
    ownerId: v.id("users"),
    text: v.string(),
    note: v.optional(v.string()),
    oncePerSilence: v.optional(v.boolean()),
    /** The turn that produced this reply, for the working kept with it. */
    traceId: v.optional(v.id("aiTraces")),
    /** Which system answered, which the trace has not been told yet. */
    by: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { room, ownerId, text, note, oncePerSilence, traceId, by },
  ) => {
    if (oncePerSilence) {
      const recent = await ctx.db
        .query("messages")
        .withIndex("by_room_owner", (q) =>
          q.eq("room", room).eq("ownerId", ownerId),
        )
        .order("desc")
        .take(30);

      const lastUserAt =
        recent.find((row) => row.role === "user")?.createdAt ?? null;
      const alreadySpoken = recent.filter(
        (row) =>
          row.role === "assistant" &&
          (lastUserAt === null || row.createdAt >= lastUserAt) &&
          (note === undefined || row.note === note),
      ).length;

      // One unprompted line per silence, however many tabs asked for it.
      if (alreadySpoken > 0) return { written: false as const };
    }

    await ctx.db.insert("messages", {
      room,
      role: "assistant",
      text,
      note,
      feed: traceId ? await feedFor(ctx, traceId, by) : undefined,
      ownerId,
      authorName: "Assistant",
      createdAt: Date.now(),
    });

    return { written: true as const };
  },
});

/** Store something the other AI said, so the person can see it too. */
export const appendFromAgent = internalMutation({
  args: {
    room: roomValidator,
    ownerId: v.id("users"),
    authorName: v.string(),
    text: v.string(),
  },
  handler: async (ctx, { room, ownerId, authorName, text }) => {
    await ctx.db.insert("messages", {
      room,
      role: "member",
      text,
      ownerId,
      authorName,
      createdAt: Date.now(),
    });
  },
});

/** Empty one box. AI threads are cleared for you only; the messenger is shared. */
export const clear = mutation({
  args: { room: roomValidator },
  handler: async (ctx, { room }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Sign in to clear a box");

    const me = await ctx.db.get(userId);
    const rows =
      room === "messenger"
        ? me?.familyId
          ? await ctx.db
              .query("messages")
              .withIndex("by_family", (q) => q.eq("familyId", me.familyId))
              .take(THREAD_LIMIT)
          : []
        : await ctx.db
            .query("messages")
            .withIndex("by_room_owner", (q) =>
              q.eq("room", room).eq("ownerId", userId),
            )
            .take(THREAD_LIMIT);

    for (const row of rows) {
      await ctx.db.delete(row._id);
    }

    // The thinking pane goes with the transcript. Emptying a box and leaving
    // the last turn's reasoning sitting beside it would read as a box that did
    // not clear.
    const traces = await ctx.db
      .query("aiTraces")
      .withIndex("by_room_owner", (q) =>
        q.eq("room", room).eq("ownerId", userId),
      )
      .take(20);

    for (const trace of traces) {
      await ctx.db.delete(trace._id);
    }

    return null;
  },
});
