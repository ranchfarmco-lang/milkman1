import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import {
  DEFAULT_DELIVERY,
  DELIVERY_LIMITS,
  isKnownVoiceId,
  voiceLabel,
  type VoiceDelivery,
} from "../lib/voices";
import { internalMutation, mutation, query } from "./_generated/server";

/**
 * Which of the eight voices the assistant speaks with for this person, and how
 * she says it.
 *
 * The roster itself lives one level up, in `src/lib/voices.ts`, and is imported
 * here rather than copied: a second list is a second answer to "which voice is
 * it", and the two would drift the first time somebody renamed one. What this
 * file owns is the pair of things the server has to know — *is this the id of a
 * real voice*, and *is this a number a slider can produce* — plus the two
 * columns they are written to.
 */

function known(id: string) {
  return isKnownVoiceId(id);
}

/** Bring four numbers into the ranges the Control Room's sliders produce. */
function tidy(raw: {
  speed: number;
  warmth: number;
  volume: number;
  expressiveness: number;
}): VoiceDelivery {
  const one = (key: keyof VoiceDelivery) => {
    const limits = DELIVERY_LIMITS[key];
    const value = raw[key];
    if (!Number.isFinite(value)) return DEFAULT_DELIVERY[key];
    return Number(Math.min(limits.max, Math.max(limits.min, value)).toFixed(3));
  };

  return {
    speed: one("speed"),
    warmth: one("warmth"),
    volume: one("volume"),
    expressiveness: one("expressiveness"),
  };
}

/** Which voice this person chose, and how she says it. */
export const mine = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;

    const me = await ctx.db.get(userId);
    return {
      id: me?.voice ?? null,
      delivery: me?.voiceDelivery ?? null,
    };
  },
});

/** Choose a voice. Only the eight real ones are accepted. */
export const set = mutation({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Sign in to change the voice");
    if (!known(id)) throw new Error("That is not one of the voices");

    const wanted = id.trim().toLowerCase();
    await ctx.db.patch(userId, { voice: wanted });
    return wanted;
  },
});

/**
 * How she speaks — speed, warmth, volume and expressiveness.
 *
 * Stored with the account rather than the device, for the same reason the voice
 * itself is: she is one person, and a phone and a laptop should not describe her
 * differently. The numbers are clamped here as well as on the slider, so an
 * out-of-range value cannot arrive through the API and be spoken.
 */
export const setDelivery = mutation({
  args: {
    speed: v.number(),
    warmth: v.number(),
    volume: v.number(),
    expressiveness: v.number(),
  },
  handler: async (ctx, raw) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Sign in to change the voice");

    const delivery = tidy(raw);
    await ctx.db.patch(userId, { voiceDelivery: delivery });
    return delivery;
  },
});

/** Back to her own defaults, which is what the slider's Reset does. */
export const resetDelivery = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Sign in to change the voice");

    await ctx.db.patch(userId, { voiceDelivery: undefined });
    return DEFAULT_DELIVERY;
  },
});

/** Used when the AI is asked to change its own voice. */
export const setForUser = internalMutation({
  args: { userId: v.id("users"), id: v.string() },
  handler: async (ctx, { userId, id }) => {
    if (!known(id)) return { ok: false as const, reason: "unknown" as const };

    const wanted = id.trim().toLowerCase();
    await ctx.db.patch(userId, { voice: wanted });
    return { ok: true as const, label: voiceLabel(wanted) };
  },
});
