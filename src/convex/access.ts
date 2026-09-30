import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { isUnlocked } from "./guard";
import { internalQuery, mutation, query } from "./_generated/server";

/**
 * The one password everyone in the family types to get in.
 *
 * It lives in the deployment's environment as `HUB_PASSWORD` — never in this
 * code, never in the browser bundle, and never returned by anything here. These
 * functions only ever answer yes or no.
 *
 * Nothing is unlocked until it is unlocked on the server: the browser alone
 * deciding would mean anyone could edit a flag in devtools and read the family's
 * messages. So a correct answer is written down as a row in `access`, against
 * the account that answered it, and every later visit reads that row.
 *
 * With `HUB_PASSWORD` unset the hub behaves exactly as it did before — open —
 * so this can be switched on simply by setting the variable.
 */

/** Wrong guesses allowed before a short wait. */
const MAX_ATTEMPTS = 5;

/** How long the wait is, in milliseconds. */
const COOLDOWN_MS = 30_000;

/** The shared password, or null when none is configured. */
function sharedPassword(): string | null {
  const raw = process.env.HUB_PASSWORD;
  const clean = typeof raw === "string" ? raw.trim() : "";
  return clean.length > 0 ? clean : null;
}

/**
 * Same password or not, without returning early on the first wrong character.
 * Not a substitute for a real constant-time comparison, but it does not hand the
 * answer out one letter at a time either.
 */
function matches(given: string, expected: string) {
  if (given.length !== expected.length) return false;

  let diff = 0;
  for (let i = 0; i < given.length; i += 1) {
    diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Whether this account still has to enter the password.
 *
 * `required` is whether a password is configured at all; `unlocked` is whether
 * this account has already answered it. Both are safe for the browser to know.
 */
export const state = query({
  args: {},
  handler: async (ctx) => {
    if (sharedPassword() === null) {
      return { required: false, unlocked: true, waiting: 0 };
    }

    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return { required: true, unlocked: false, waiting: 0 };
    }

    const row = await ctx.db
      .query("access")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    const waiting = Math.max(0, (row?.blockedUntil ?? 0) - Date.now());

    return {
      required: true,
      unlocked: row?.unlockedAt !== undefined,
      waiting,
    };
  },
});

/**
 * The same answer `state` gives, in the form an action can ask for.
 *
 * Actions have no database of their own, so anything that spends an AI key asks
 * this first rather than reading the row directly.
 */
export const unlocked = internalQuery({
  args: {},
  handler: async (ctx) => isUnlocked(ctx),
});

/**
 * Check the password and write down that this account got it right.
 *
 * Must be called signed in — the record is kept against the account, which is
 * the thing that actually reads the family's data afterwards.
 */
export const unlock = mutation({
  args: { password: v.string() },
  handler: async (ctx, { password }) => {
    const expected = sharedPassword();
    // Nothing to answer: leave everything as it was.
    if (expected === null) return { ok: true, waiting: 0 };

    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return { ok: false, waiting: 0, needsSignIn: true };
    }

    const row = await ctx.db
      .query("access")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    const now = Date.now();

    if (row?.blockedUntil !== undefined && row.blockedUntil > now) {
      return { ok: false, waiting: row.blockedUntil - now, needsSignIn: false };
    }

    if (matches(password.trim(), expected)) {
      if (row) {
        await ctx.db.patch(row._id, {
          unlockedAt: now,
          attempts: 0,
          blockedUntil: undefined,
        });
      } else {
        await ctx.db.insert("access", { userId, unlockedAt: now, attempts: 0 });
      }
      return { ok: true, waiting: 0, needsSignIn: false };
    }

    // A wrong answer. Count it, and after enough of them make the person wait,
    // so a short password is not something to sit and guess at.
    const attempts = (row?.attempts ?? 0) + 1;
    const blocked = attempts >= MAX_ATTEMPTS;
    const patch = {
      attempts: blocked ? 0 : attempts,
      blockedUntil: blocked ? now + COOLDOWN_MS : undefined,
    };

    if (row) await ctx.db.patch(row._id, patch);
    else await ctx.db.insert("access", { userId, ...patch });

    return {
      ok: false,
      waiting: blocked ? COOLDOWN_MS : 0,
      needsSignIn: false,
    };
  },
});

/**
 * Forget this device: the password is asked for again the next time.
 *
 * For a phone that gets handed round, or a shared computer. Only this account's
 * record goes — nobody else is signed out.
 *
 * Locking also takes the account out of the family it was in. Being in the
 * family and appearing on the roster is the same thing as having answered the
 * password, so a locked device drops off the messenger until the password is
 * answered again — `family.ensure` puts them straight back the moment the app
 * opens. Nothing they wrote is lost; the messages keep their own copy of the
 * family.
 */
export const lock = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;

    const row = await ctx.db
      .query("access")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (row) await ctx.db.patch(row._id, { unlockedAt: undefined });

    const user = await ctx.db.get(userId);
    if (user?.familyId !== undefined) {
      await ctx.db.patch(userId, { familyId: undefined });
    }

    return null;
  },
});
