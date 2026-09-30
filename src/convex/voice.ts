import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";

/** The eight voices, exactly as they are named in the app. */
const VOICE_ID = /^(female|male)-[1-4]$/;

/** Which of the eight voices this person has chosen, if any. */
export const mine = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;

    const me = await ctx.db.get(userId);
    return me?.voice ?? null;
  },
});

/** Choose a voice. Only the eight real ones are accepted. */
export const set = mutation({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Sign in to change the voice");
    if (!VOICE_ID.test(id)) throw new Error("That is not one of the voices");

    await ctx.db.patch(userId, { voice: id });
    return id;
  },
});

/** Used when the AI is asked to change its own voice. */
export const setForUser = internalMutation({
  args: { userId: v.id("users"), id: v.string() },
  handler: async (ctx, { userId, id }) => {
    if (!VOICE_ID.test(id)) return { ok: false as const, reason: "unknown" };

    await ctx.db.patch(userId, { voice: id });
    return { ok: true as const };
  },
});
