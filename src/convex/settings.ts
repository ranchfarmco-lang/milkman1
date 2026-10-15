import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";

/**
 * The switches this app actually owns. Anything outside this list is refused,
 * so an AI can never write a setting that does not exist.
 */
const TOGGLE_KEYS = new Set([
  "silence",
  "vibrate_messages",
  "alert_tone",
  "notify_messages",
  "notification_preview",
  "do_not_disturb",
  "fullscreen",
  "screen_rotation",
  "keep_screen_awake",
  "assistant_speak_up",
  "ai_auto_refresh",
  // Whether the models running on this machine are asked before anything on
  // the internet. A choice about order, not about a device — it lives here
  // because every switch the Control Room flips is validated against this list,
  // and because the assistant flips switches with the same call.
  "local_ai_first",
  "vpn",
  // The AI Builder's two switches: whether it works as the six-person crew,
  // and whether it may reach the outside world (web_search, fetch_url, the
  // other AI systems). Both are on until the Control Room takes them off.
  "builder_crew",
  "builder_research",
  // The companion in the corner: how it hears them, whether it offers anything
  // unasked, and whether it reads its answers out. The switch that turns the
  // microphone on is a setting rather than local state on purpose — it is the
  // one thing about the little box that has to survive a reload, and to be the
  // same on the phone and the laptop.
  "companion_hands_free",
  "companion_hints",
  "companion_speak",
]);

/**
 * The Control Room switches, stored per person.
 * Only the switches that have been touched are stored; the app supplies the
 * defaults for anything missing.
 */
export const get = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return {} as Record<string, boolean>;

    const row = await ctx.db
      .query("settings")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();

    return (row?.values ?? {}) as Record<string, boolean>;
  },
});

/** Flip one switch. */
export const set = mutation({
  args: { key: v.string(), value: v.boolean() },
  handler: async (ctx, { key, value }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Sign in to change a setting");

    const row = await ctx.db
      .query("settings")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();

    const now = Date.now();
    if (row) {
      await ctx.db.patch(row._id, {
        values: { ...row.values, [key]: value },
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("settings", {
        userId,
        values: { [key]: value },
        updatedAt: now,
      });
    }

    return null;
  },
});

/**
 * Flip one switch for someone, on their behalf — used when they ask an AI to
 * silence the app, hold notifications, and so on. The Control Room is reading
 * the same row, so its switch moves the moment this lands.
 */
export const setForUser = internalMutation({
  args: { userId: v.id("users"), key: v.string(), value: v.boolean() },
  handler: async (ctx, { userId, key, value }) => {
    if (!TOGGLE_KEYS.has(key)) return { ok: false as const, reason: "unknown" };

    const row = await ctx.db
      .query("settings")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();

    const now = Date.now();
    if (row) {
      await ctx.db.patch(row._id, {
        values: { ...row.values, [key]: value },
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("settings", {
        userId,
        values: { [key]: value },
        updatedAt: now,
      });
    }

    return { ok: true as const };
  },
});
