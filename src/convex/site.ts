import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { ownerId } from "./guard";

/** The single row that holds the hub's own identity. */
const SITE_KEY = "hub";

/**
 * Turn whatever was typed into one clean address.
 *
 * People write these every way there is — with no scheme, with a space that
 * slipped in from somewhere, with a trailing slash — so all of that is handled
 * here rather than refused. Anything left that is not an `http(s)` address is
 * refused, because an address the hub cannot open is worse than none.
 */
export function normaliseHubAddress(raw: string): string {
  const trimmed = String(raw ?? "")
    .replace(/\s+/g, "")
    .replace(/\/+$/, "");
  if (!trimmed) return "";
  const withScheme = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return withScheme;
  } catch {
    return "";
  }
}

/** The address the hub calls itself, or null when it uses its own page origin. */
export const address = query({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db
      .query("site")
      .withIndex("by_key", (q) => q.eq("key", SITE_KEY))
      .unique();
    return row?.address ?? null;
  },
});

/**
 * Name the hub. The owner does this; before the hub has an owner (during
 * first-run setup) whoever is setting it up may, so there is no chicken-and-egg
 * where the address cannot be set until an owner exists.
 *
 * An empty address is a real answer — it means "use this page's own address",
 * which is how a hub that has never been named behaves.
 */
export const setAddress = mutation({
  args: { address: v.string() },
  handler: async (ctx, { address: raw }) => {
    const current = await ownerId(ctx);
    if (current !== null) {
      const userId = await getAuthUserId(ctx);
      if (userId !== current) {
        throw new Error("Only the hub's owner can set the hub's address.");
      }
    }

    const clean = normaliseHubAddress(raw);
    if (raw.trim() && !clean) {
      throw new Error(
        "That is not an address the hub can open. Use something like http://hub.ranch.com",
      );
    }

    const now = Date.now();
    const row = await ctx.db
      .query("site")
      .withIndex("by_key", (q) => q.eq("key", SITE_KEY))
      .unique();

    if (row) {
      await ctx.db.patch(row._id, { address: clean || undefined, updatedAt: now });
    } else {
      await ctx.db.insert("site", {
        key: SITE_KEY,
        address: clean || undefined,
        updatedAt: now,
      });
    }

    return clean;
  },
});

/**
 * Set the hub's address from the command line, where there is no signed-in
 * user at all — used once during setup so the hub is named before anyone is
 * around to name it.
 */
export const seed = internalMutation({
  args: { address: v.string() },
  handler: async (ctx, { address: raw }) => {
    const clean = normaliseHubAddress(raw);
    const now = Date.now();
    const row = await ctx.db
      .query("site")
      .withIndex("by_key", (q) => q.eq("key", SITE_KEY))
      .unique();
    if (row) {
      await ctx.db.patch(row._id, { address: clean || undefined, updatedAt: now });
    } else {
      await ctx.db.insert("site", {
        key: SITE_KEY,
        address: clean || undefined,
        updatedAt: now,
      });
    }
    return clean;
  },
});
