import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";

const MEMORY_LIMIT = 60;
const CONTEXT_LIMIT = 40;

/** Everything the assistant has been told to remember, newest first. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];

    const rows = await ctx.db
      .query("memories")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(MEMORY_LIMIT);

    return rows.map((row) => ({ _id: row._id, text: row.text }));
  },
});

/**
 * What gets handed to the model: the family calendar as it stands right now,
 * and then everything the assistant has been told to remember, newest last.
 *
 * The calendar is read here rather than stored as a memory, so it is always
 * current — an entry added a second ago is in the very next prompt, and there
 * is nothing left behind when a date passes. It is what lets either agent
 * answer "what is on tomorrow" without guessing, and put a new appointment
 * next to the right one.
 */
export const context = internalQuery({
  args: { userId: v.id("users") },
  // The return type is written out rather than inferred: this handler reaches
  // into another module through the generated api, and leaving TypeScript to
  // work the shape out from there makes the two depend on each other.
  handler: async (ctx, { userId }): Promise<string[]> => {
    const rows = await ctx.db
      .query("memories")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(CONTEXT_LIMIT);

    const memories: string[] = rows.reverse().map((row) => row.text);
    const calendar: string | null = await ctx.runQuery(
      internal.calendar.digest,
      { userId },
    );

    return calendar ? [calendar, ...memories] : memories;
  },
});

export const add = internalMutation({
  args: { userId: v.id("users"), text: v.string() },
  handler: async (ctx, { userId, text }) => {
    const clean = text.trim().slice(0, 400);
    if (!clean) return null;

    // Never store the same fact twice.
    const existing = await ctx.db
      .query("memories")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(MEMORY_LIMIT);

    const already = existing.some(
      (row) => row.text.toLowerCase() === clean.toLowerCase(),
    );
    if (already) return null;

    await ctx.db.insert("memories", {
      userId,
      text: clean,
      createdAt: Date.now(),
    });

    return null;
  },
});

/** Forget the memories that match a phrase. Returns how many were dropped. */
export const forget = internalMutation({
  args: { userId: v.id("users"), match: v.string() },
  handler: async (ctx, { userId, match }) => {
    const needle = match.trim().toLowerCase();
    const rows = await ctx.db
      .query("memories")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(MEMORY_LIMIT);

    const hits = needle
      ? rows.filter((row) => row.text.toLowerCase().includes(needle))
      : rows;

    for (const row of hits) {
      await ctx.db.delete(row._id);
    }

    return hits.length;
  },
});

/**
 * Forget one thing, by its row. Nobody forgets anybody else's — a memory that
 * belongs to another account is simply left alone.
 */
export const remove = mutation({
  args: { id: v.id("memories") },
  handler: async (ctx, { id }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Sign in to change memories");

    const row = await ctx.db.get(id);
    if (!row || row.userId !== userId) return null;

    await ctx.db.delete(id);
    return null;
  },
});

/** Clear everything the assistant remembers about you. */
export const forgetAll = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Sign in to clear memories");

    const rows = await ctx.db
      .query("memories")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(MEMORY_LIMIT);

    for (const row of rows) {
      await ctx.db.delete(row._id);
    }

    return null;
  },
});
