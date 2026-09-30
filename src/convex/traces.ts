import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, query } from "./_generated/server";
import { isUnlocked } from "./guard";
import { roomValidator, traceStatusValidator, traceStepKindValidator } from "./schema";

/**
 * The thinking pane's own store: one row per turn, written while the turn runs.
 *
 * A turn here is a long, silent thing. The model is asked, tools run, it thinks
 * again and writes its plan down, and only at the very end does one finished
 * reply land in the chat. Without a record that grows as the work happens there
 * is nothing to show in between but a spinner, and the reasoning the agent
 * writes with its `think` tool — the one the prompts ask it for — has nowhere to
 * go but the bin.
 *
 * So the row is created before the first model call and appended to as the turn
 * proceeds. The panel reads it with `latest`, which is a reactive query: each
 * append pushes the pane forward on its own, with no polling and no streaming
 * connection of our own to keep alive.
 *
 * Three sizes are capped, because this is written by a model and read by a
 * person rather than kept forever: one step, one turn, and how many turns are
 * retained. The caps keep the newest text rather than the oldest — while a
 * model is mid-answer the end of the text is the part worth seeing.
 */

/** Characters in one step before it starts dropping the oldest of itself. */
const MAX_STEP_CHARS = 16_000;

/** Characters in one turn across every step. */
const MAX_TRACE_CHARS = 160_000;

/** Steps in one turn. A turn is at most 24 tool rounds, so this is headroom. */
const MAX_STEPS = 400;

/** Turns kept per box. The pane shows the live turn, not a history of them. */
const KEEP_PER_ROOM = 4;

/**
 * Grow a streamed step, keeping the end of it.
 *
 * Reasoning and answers arrive a few characters at a time, so this is called
 * hundreds of times per turn. Once a step is longer than the cap the oldest
 * text is dropped rather than the newest: a reader watching it arrive wants to
 * see what it is saying now, not the first paragraph of a long preamble.
 */
function grow(previous: string, addition: string) {
  const whole = previous + addition;
  if (whole.length <= MAX_STEP_CHARS) return whole;
  return `…\n${whole.slice(-(MAX_STEP_CHARS - 2))}`;
}

/** One step, trimmed to the cap however it was written. */
function capped(text: string) {
  if (text.length <= MAX_STEP_CHARS) return text;
  return `…\n${text.slice(-(MAX_STEP_CHARS - 2))}`;
}

/** Drop what the pane no longer needs, so a long turn stays inside the cap. */
function fit(steps: Doc<"aiTraces">["steps"]) {
  const trimmed = steps.length > MAX_STEPS ? steps.slice(-MAX_STEPS) : steps;

  let total = trimmed.reduce((sum, step) => sum + step.text.length, 0);
  let from = 0;
  while (total > MAX_TRACE_CHARS && from < trimmed.length - 1) {
    total -= trimmed[from]!.text.length;
    from += 1;
  }

  return from === 0 ? [...trimmed] : trimmed.slice(from);
}

/**
 * Open a turn, and tidy up the ones before it.
 *
 * A row still marked `running` belongs to a turn that never finished — a tab
 * closed mid-answer, a deployment restarted under it. It is closed off here, so
 * nothing in the pane spins forever waiting for an answer that is not coming.
 */
export const start = internalMutation({
  args: { room: roomValidator, ownerId: v.id("users") },
  handler: async (ctx, { room, ownerId }) => {
    const now = Date.now();

    const previous = await ctx.db
      .query("aiTraces")
      .withIndex("by_room_owner", (q) =>
        q.eq("room", room).eq("ownerId", ownerId),
      )
      .order("desc")
      .take(KEEP_PER_ROOM + 5);

    for (const row of previous) {
      if (row.status === "running") {
        await ctx.db.patch(row._id, {
          status: "failed",
          error: "That turn stopped before it finished.",
          updatedAt: now,
        });
      }
    }

    for (const row of previous.slice(KEEP_PER_ROOM)) {
      await ctx.db.delete(row._id);
    }

    return await ctx.db.insert("aiTraces", {
      room,
      ownerId,
      status: "running",
      startedAt: now,
      updatedAt: now,
      steps: [],
    });
  },
});

/**
 * Add to the turn.
 *
 * `merge` continues the step above instead of starting a new one, which is what
 * a stream of tokens wants: a hundred appends of three characters are one
 * paragraph of reasoning, not a hundred lines. It only ever merges into a step
 * of the same kind, so a thought arriving after a tool ran starts fresh rather
 * than being welded onto the tool's line.
 */
export const append = internalMutation({
  args: {
    traceId: v.id("aiTraces"),
    kind: traceStepKindValidator,
    text: v.string(),
    merge: v.optional(v.boolean()),
  },
  handler: async (ctx, { traceId, kind, text, merge }) => {
    const trace = await ctx.db.get(traceId);
    if (!trace) return null;
    if (!text) return null;

    const steps = trace.steps;
    const last = steps[steps.length - 1];
    const now = Date.now();

    const next =
      merge === true && last && last.kind === kind
        ? steps
            .slice(0, -1)
            .concat([{ ...last, text: grow(last.text, text), at: now }])
        : steps.concat([{ kind, text: capped(text), at: now }]);

    await ctx.db.patch(traceId, {
      steps: fit(next),
      updatedAt: now,
    });

    return null;
  },
});

/** Close the turn: the pane stops saying it is working. */
export const finish = internalMutation({
  args: {
    traceId: v.id("aiTraces"),
    status: traceStatusValidator,
    by: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { traceId, status, by, error }) => {
    const trace = await ctx.db.get(traceId);
    if (!trace) return null;

    await ctx.db.patch(traceId, {
      status,
      by: by ?? trace.by,
      error: error ? error.slice(0, 600) : undefined,
      updatedAt: Date.now(),
    });

    return null;
  },
});

/**
 * The turn the pane is showing: the newest one for this box, live or finished.
 *
 * Same door as the transcript — signed in and past the family password — so a
 * locked hub shows nothing about what the AI has been doing either.
 */
export const latest = query({
  args: { room: roomValidator },
  handler: async (ctx, { room }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;
    if (!(await isUnlocked(ctx))) return null;

    const rows = await ctx.db
      .query("aiTraces")
      .withIndex("by_room_owner", (q) =>
        q.eq("room", room).eq("ownerId", userId),
      )
      .order("desc")
      .take(1);

    const trace = rows[0];
    if (!trace) return null;

    return {
      status: trace.status,
      by: trace.by ?? null,
      error: trace.error ?? null,
      startedAt: trace.startedAt,
      updatedAt: trace.updatedAt,
      steps: trace.steps,
    };
  },
});
