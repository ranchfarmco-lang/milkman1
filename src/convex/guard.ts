import { getAuthUserId } from "@convex-dev/auth/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";

/**
 * Whether this account has answered the family password.
 *
 * This is what makes "password only" true rather than just true on screen. The
 * gate in the browser stops the app being read, but anyone can call these
 * functions directly — so the answer has to be enforced here too, against the
 * same row the gate reads.
 *
 * All of the family's data is reached through a `familyId`, and a `familyId` is
 * only ever handed out by `family.ensure`. Guarding that one door keeps a locked
 * account out of the messenger, the roster, the shared files and the calls.
 *
 * The AI boxes are the account's own, but they are still part of the hub, so
 * `messages` refuses to read or write a thread and `access.unlocked` lets the
 * AI actions — which have no database of their own — ask the same question,
 * which is what stops a locked account spending the family's keys.
 *
 * With no `HUB_PASSWORD` configured this is always true, so the hub behaves as
 * it did before the password existed.
 */
export async function isUnlocked(ctx: QueryCtx | MutationCtx) {
  if (!process.env.HUB_PASSWORD) return true;

  const userId = await getAuthUserId(ctx);
  if (userId === null) return false;

  const row = await ctx.db
    .query("access")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();

  return row?.unlockedAt !== undefined;
}

/** Throws unless the family password has been answered on this account. */
export async function requireUnlocked(ctx: QueryCtx | MutationCtx) {
  if (await isUnlocked(ctx)) return;
  throw new Error("This hub is locked. Enter the family password to continue.");
}
