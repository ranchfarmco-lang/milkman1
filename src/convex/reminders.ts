import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";

const PENDING_LIMIT = 25;
const TEXT_LIMIT = 200;

/**
 * The one place a timer or reminder is written down.
 *
 * The assistant's own timers and the calendar's "the shopping list is ready
 * before you leave" nudge both come through here, so the two can never drift
 * apart into different shapes.
 */
export async function insertReminder(
  ctx: MutationCtx,
  args: {
    userId: Id<"users">;
    text: string;
    kind: "timer" | "reminder";
    dueAt: number;
  },
): Promise<Id<"reminders">> {
  return await ctx.db.insert("reminders", {
    userId: args.userId,
    text:
      args.text.trim().slice(0, TEXT_LIMIT) ||
      (args.kind === "timer" ? "Timer" : "Reminder"),
    kind: args.kind,
    dueAt: args.dueAt,
    done: false,
    createdAt: Date.now(),
  });
}

/** Timers and reminders that have not gone off yet. */
export const pending = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];

    const rows = await ctx.db
      .query("reminders")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(PENDING_LIMIT);

    return rows
      .filter((row) => !row.done)
      .sort((a, b) => a.dueAt - b.dueAt)
      .map((row) => ({
        _id: row._id,
        text: row.text,
        kind: row.kind,
        dueAt: row.dueAt,
      }));
  },
});

/** Created by the assistant when it sets a timer or a reminder. */
export const create = internalMutation({
  args: {
    userId: v.id("users"),
    text: v.string(),
    kind: v.union(v.literal("timer"), v.literal("reminder")),
    dueAt: v.number(),
  },
  handler: async (ctx, { userId, text, kind, dueAt }) => {
    await insertReminder(ctx, { userId, text, kind, dueAt });
    return null;
  },
});

/** Called by the page once it has actually rung. */
export const complete = mutation({
  args: { id: v.id("reminders") },
  handler: async (ctx, { id }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Sign in to update a reminder");

    const row = await ctx.db.get(id);
    if (!row || row.userId !== userId) return null;

    await ctx.db.patch(id, { done: true });
    return null;
  },
});

/** Wipe every pending timer and reminder. */
export const clear = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Sign in to clear reminders");

    const rows = await ctx.db
      .query("reminders")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(PENDING_LIMIT);

    for (const row of rows) {
      await ctx.db.delete(row._id);
    }

    return null;
  },
});
