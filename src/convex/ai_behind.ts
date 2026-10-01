/**
 * The work nobody asked for, written down as it happens.
 *
 * The preview box shows a turn: what a person asked, and everything done to
 * answer it. This is the other half — what the hub does when nobody has asked
 * anything at all:
 *
 *   - the assistant speaking up about a real alert;
 *   - the [LIVE] board going out to every feed on its timer;
 *   - the morning job copying the board onto the calendar.
 *
 * None of it is triggered by a person, and until this existed none of it left a
 * mark anyone could see. The hub would go quiet, then show up with a fresh board
 * or a new line, and there was no way to tell what had run in between — or that
 * anything had.
 *
 * Two rules shape what goes in here:
 *
 *   1. **It is real.** A row exists because a job started, and it says
 *      "running" only while that job is genuinely in flight. Nothing is
 *      animated to look busy, and no step is invented.
 *   2. **It is short-lived.** Rows older than a day are pruned as new ones are
 *      written, because this is a window on what is happening now rather than a
 *      history to scroll through.
 */

import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { isUnlocked } from "./guard";
import { internalMutation, query, type MutationCtx } from "./_generated/server";

/** The longest a detail line may be kept. */
const DETAIL_LIMIT = 600;

/** How long a row is worth keeping. A day, because this is a window. */
const KEEP_MS = 24 * 60 * 60 * 1000;

/** How many rows the feed shows at once. */
const FEED_LIMIT = 60;

/** How many stale rows one write is willing to clean up. */
const PRUNE_BATCH = 50;

/**
 * Drop yesterday's rows.
 *
 * Done on write rather than on a timer of its own: the work of tidying is then
 * paid for exactly when there is something to tidy, and a hub nobody is using
 * costs nothing at all.
 */
async function prune(ctx: MutationCtx) {
  const stale = await ctx.db
    .query("aiBehind")
    .withIndex("by_at", (q) => q.lt("at", Date.now() - KEEP_MS))
    .take(PRUNE_BATCH);

  for (const row of stale) await ctx.db.delete(row._id);
}

/**
 * Start a job that takes long enough to be worth watching.
 *
 * The row is written before the work begins and stays "running" until it is
 * closed, which is what lets the page spin on it. The label should read as a
 * sentence about the hub, never as a job name.
 */
export const open = internalMutation({
  args: {
    source: v.string(),
    label: v.string(),
    detail: v.optional(v.string()),
    ownerId: v.optional(v.id("users")),
  },
  handler: async (ctx, { source, label, detail, ownerId }) => {
    await prune(ctx);

    return await ctx.db.insert("aiBehind", {
      at: Date.now(),
      source: source.slice(0, 40),
      label: label.slice(0, 300),
      detail: detail?.slice(0, DETAIL_LIMIT),
      status: "running" as const,
      ownerId,
    });
  },
});

/**
 * Finish a job: how it went, and what came of it.
 *
 * A job that failed keeps its row. A failure is part of what happened and the
 * most useful line in the feed — hiding it would leave a gap where somebody
 * should be reading why the board did not refresh.
 */
export const close = internalMutation({
  args: {
    id: v.id("aiBehind"),
    status: v.union(v.literal("done"), v.literal("failed")),
    detail: v.optional(v.string()),
  },
  handler: async (ctx, { id, status, detail }) => {
    const row = await ctx.db.get(id);
    if (!row) return null;

    await ctx.db.patch(id, {
      status,
      endedAt: Date.now(),
      // What it was opened with stays when there is nothing better to say.
      ...(detail ? { detail: detail.slice(0, DETAIL_LIMIT) } : {}),
    });

    return null;
  },
});

/** Something that was over before a spinner would have been worth drawing. */
export const note = internalMutation({
  args: {
    source: v.string(),
    label: v.string(),
    detail: v.optional(v.string()),
    failed: v.optional(v.boolean()),
    ownerId: v.optional(v.id("users")),
  },
  handler: async (ctx, { source, label, detail, failed, ownerId }) => {
    await prune(ctx);
    const at = Date.now();

    await ctx.db.insert("aiBehind", {
      at,
      source: source.slice(0, 40),
      label: label.slice(0, 300),
      detail: detail?.slice(0, DETAIL_LIMIT),
      status: failed ? ("failed" as const) : ("done" as const),
      endedAt: at,
      ownerId,
    });

    return null;
  },
});

/**
 * What has been running behind the scenes, newest first.
 *
 * A nudge belongs to one person and says something about them, so a row with an
 * owner is only ever shown to that owner; the board and the calendar belong to
 * the hub and are shown to everybody. A locked account sees nothing here, for
 * the same reason it sees no conversation.
 */
export const recent = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    if (!(await isUnlocked(ctx))) return [];

    const rows = await ctx.db
      .query("aiBehind")
      .withIndex("by_at")
      .order("desc")
      .take(FEED_LIMIT);

    return rows
      .filter((row) => row.ownerId === undefined || row.ownerId === userId)
      .map((row) => ({
        id: row._id,
        at: row.at,
        source: row.source,
        label: row.label,
        detail: row.detail ?? null,
        status: row.status,
        endedAt: row.endedAt ?? null,
      }));
  },
});
