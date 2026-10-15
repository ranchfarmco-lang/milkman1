import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type ActionCtx,
} from "./_generated/server";

/**
 * The bridge between this deployment and the model running on the family's own
 * machine.
 *
 * A model server on `127.0.0.1` is reachable only from `127.0.0.1`, and this
 * deployment is not that machine — which is why asking it for Ollama used to
 * come back with `tcp connect error: Connection refused` from a data centre that
 * will never run one. The browser *is* that machine, so the question is written
 * into a row, a page of the hub carries it out over there, and the answer comes
 * back the same way. The turn itself, and every tool it runs, stays here.
 *
 * The row is deliberately narrow: a loopback address nobody chose at runtime,
 * the request as JSON, and a short life. Nothing else travels, and only the
 * pages signed in as the person who opened it can see one.
 */

/** An address on this machine, and nowhere else. */
const LOOPBACK =
  /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?([/?#].*)?$/i;

export function isLoopback(url: string) {
  return LOOPBACK.test(url);
}

/**
 * What every request in the model layer hands back.
 *
 * The same shape `Response` has of the four things those call sites use, so a
 * relayed answer and a direct one are interchangeable at the call — without
 * having to build a `Response` here, which is not something this runtime owes.
 */
export type HttpResult = {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
};

export type RelayTarget = {
  /** The system being asked, so a failure can name it. */
  label: string;
  /** Where the model server listens. Loopback, always. */
  url: string;
  headers: Record<string, string>;
  /** The request body, as JSON text. */
  body: string;
  /** How long the whole exchange may take. */
  timeoutMs: number;
};

export type Relay = {
  send(target: RelayTarget): Promise<HttpResult>;
};

/** How often the row is looked at while somebody carries it out. */
const POLL_MS = 300;
/** Nothing waits on a row this long, so anything older is swept. */
const SWEEP_AFTER_MS = 10 * 60_000;
/** A relayed answer is a model reply; two million characters is past any. */
const MAX_ANSWER_CHARS = 2_000_000;
/** The shortest wait, so a thin timeout cannot make a row arrive too late to read. */
const MIN_TTL_MS = 5_000;

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function answered(status: number, body: string): HttpResult {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    json: async () => JSON.parse(body) as unknown,
  };
}

/**
 * Open a row, wait for a page to carry it out, hand the answer back.
 *
 * Made once per action and carried on the providers themselves, so every model
 * call inside that action relays the same way without each one being threaded
 * a context. A failure here is thrown, which the model layer already turns into
 * the sentence the person reads — so what is written below is written for them.
 */
export function makeRelay(
  ctx: ActionCtx,
  ownerId: Id<"users">,
): Relay {
  return {
    async send({ label, url, headers, body, timeoutMs }) {
      if (!isLoopback(url)) {
        throw new Error(`${label} is not on this machine, so there is nothing to relay to it.`);
      }

      const ttlMs = Math.max(MIN_TTL_MS, timeoutMs);
      const id = await ctx.runMutation(internal.localRelays.open, {
        ownerId,
        url,
        headers: JSON.stringify(headers),
        body,
        ttlMs,
      });

      const deadline = Date.now() + ttlMs;
      let taken = false;

      for (;;) {
        const row = await ctx.runQuery(internal.localRelays.wait, { id });

        // A row that was is a row somebody disposed of: waiting out the clock
        // would only turn a decided outcome into a slow one.
        if (!row) {
          throw new Error(
            `${label} was asked on this machine, and the question was dropped before an answer came back.`,
          );
        }

        if (row.status === "answered") {
          return answered(row.answerStatus ?? 200, row.answerBody ?? "");
        }
        if (row.status === "failed") {
          throw new Error(
            row.answerError ?? `${label} did not answer on this machine.`,
          );
        }
        if (row.status === "taken") taken = true;

        if (Date.now() >= deadline) {
          await ctx.runMutation(internal.localRelays.giveUp, { id });
          throw new Error(
            taken
              ? `${label} did not answer within ${Math.round(ttlMs / 1000)} seconds on this machine.`
              : `Local AI answers on this machine, and no page of the hub is open over there to carry the question. Open the hub in a browser on that machine and ask again.`,
          );
        }

        await sleep(POLL_MS);
      }
    },
  };
}

/**
 * Write one question down. Internal: only an action that has already proved who
 * it is acting for may open a row, and only for loopback — which is checked
 * here as well as by the caller, because this is the last place that can say no.
 */
export const open = internalMutation({
  args: {
    ownerId: v.id("users"),
    url: v.string(),
    headers: v.string(),
    body: v.string(),
    ttlMs: v.number(),
  },
  handler: async (ctx, args) => {
    if (!isLoopback(args.url)) {
      throw new Error("Only a model server on this machine is relayed.");
    }

    // Rows nobody ever collected, or whose caller has long stopped waiting.
    // Swept on the next write rather than on a schedule, so a hub with no
    // traffic pays nothing for having a table at all.
    const now = Date.now();
    const stale = await ctx.db
      .query("localRelays")
      .withIndex("by_expires", (q) => q.lt("expiresAt", now - SWEEP_AFTER_MS))
      .take(25);
    for (const row of stale) await ctx.db.delete(row._id);

    return await ctx.db.insert("localRelays", {
      ownerId: args.ownerId,
      url: args.url,
      headers: args.headers,
      body: args.body,
      status: "pending",
      createdAt: now,
      expiresAt: now + Math.max(MIN_TTL_MS, args.ttlMs),
    });
  },
});

/** What the waiting action reads, every third of a second. */
export const wait = internalQuery({
  args: { id: v.id("localRelays") },
  handler: async (ctx, { id }) => await ctx.db.get(id),
});

/** The caller has stopped waiting. The row is finished either way. */
export const giveUp = internalMutation({
  args: { id: v.id("localRelays") },
  handler: async (ctx, { id }) => {
    const row = await ctx.db.get(id);
    if (!row) return;
    if (row.status === "pending" || row.status === "taken") {
      await ctx.db.patch(id, { status: "failed" });
    }
  },
});

/**
 * The questions this person's pages may carry out.
 *
 * Oldest first: a turn is waiting on the first one, and answering a newer
 * question while an older one sits uncollected would be answering out of order.
 */
export const next = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];

    const rows = await ctx.db
      .query("localRelays")
      .withIndex("by_owner_status", (q) =>
        q.eq("ownerId", userId).eq("status", "pending"),
      )
      .take(4);

    return rows.map((row) => ({
      _id: row._id,
      url: row.url,
      headers: row.headers,
      body: row.body,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
    }));
  },
});

/**
 * Take one, so two pages open on the same machine cannot both carry it out and
 * answer the same question twice. The check and the write happen in one
 * mutation, which is what makes the race safe rather than hopeful.
 */
export const claim = mutation({
  args: { id: v.id("localRelays"), workerId: v.string() },
  handler: async (ctx, { id, workerId }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return false;

    const row = await ctx.db.get(id);
    if (!row || row.ownerId !== userId || row.status !== "pending") {
      return false;
    }

    await ctx.db.patch(id, { status: "taken", workerId });
    return true;
  },
});

/** The answer — or the reason there is not one. */
export const report = mutation({
  args: {
    id: v.id("localRelays"),
    workerId: v.string(),
    status: v.number(),
    body: v.string(),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return false;

    const row = await ctx.db.get(args.id);
    if (
      !row ||
      row.ownerId !== userId ||
      row.status !== "taken" ||
      row.workerId !== args.workerId
    ) {
      // The caller has stopped waiting, or another page got there first. Both
      // mean this answer is late rather than wrong, so it is simply dropped.
      return false;
    }

    if (args.error) {
      await ctx.db.patch(args.id, {
        status: "failed",
        answerError: args.error.slice(0, 1000),
      });
      return true;
    }

    if (args.body.length > MAX_ANSWER_CHARS) {
      await ctx.db.patch(args.id, {
        status: "failed",
        answerError: `The model on this machine replied with more than ${MAX_ANSWER_CHARS} characters, which is too much to carry back.`,
      });
      return true;
    }

    await ctx.db.patch(args.id, {
      status: "answered",
      answerStatus: args.status,
      answerBody: args.body,
    });
    return true;
  },
});
