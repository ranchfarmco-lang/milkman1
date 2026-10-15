import { getAuthUserId } from "@convex-dev/auth/server";
import { deviceStandsOpen } from "./device_rule";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";

/** The name of the single row that holds the hub's security record. */
export const SECURITY_KEY = "hub";

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
 * it did before the password existed. `GUESTS_ONLY` below is the same case on
 * purpose: while it is on, the hub behaves exactly as though no password were
 * configured, and every screen and function that asks about the password reads
 * that from one place — `hubPassword` — rather than each deciding for itself.
 */

/** The hub's security record, or null before the first device claims it. */
export async function securityRow(ctx: QueryCtx | MutationCtx) {
  return await ctx.db
    .query("security")
    .withIndex("by_key", (q) => q.eq("key", SECURITY_KEY))
    .unique();
}

/** Every device row belonging to one account. */
export async function devicesFor(ctx: QueryCtx | MutationCtx, userId: Doc<"users">["_id"]) {
  return await ctx.db
    .query("devices")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
}

/**
 * Whether the signed-in account has at least one device that stands open.
 *
 * This is the device half of access, and it is checked on the server rather
 * than by hiding a screen: a device that has never registered, or that the
 * owner has revoked, reads as not authorised no matter what the browser is
 * showing.
 *
 * What "stands open" means is not decided here — `device_rule.ts` holds the one
 * rule, and the device gate asks it of the row it is looking at, so the screen
 * and the server cannot come to different conclusions about the same device.
 */
export async function isDeviceAuthorized(ctx: QueryCtx | MutationCtx) {
  const userId = await getAuthUserId(ctx);
  if (userId === null) return false;
  const rows = await devicesFor(ctx, userId);
  return rows.some((row) => deviceStandsOpen(row.status, hubPassword() !== null));
}

/**
 * Sign-in is guests-only for now: no family password, just a guest account.
 *
 * `HUB_PASSWORD` is still read and honoured the moment this is false — the
 * whole password path is untouched, it is simply not the one in force. One
 * flip of this line brings the family password back, and the screens, the
 * guards and the device rules follow it because they all ask `hubPassword`
 * rather than reading the environment themselves.
 */
export const GUESTS_ONLY = true;

/**
 * The family password actually in force, or null when none is asked for.
 *
 * The single answer to "is there a password?". The environment holds the
 * password; whether it is being asked for is decided here, so a guests-only
 * hub cannot end up half-open — one screen asking and the server not, or the
 * other way round.
 */
export function hubPassword(): string | null {
  if (GUESTS_ONLY) return null;
  const raw = process.env.HUB_PASSWORD;
  const clean = typeof raw === "string" ? raw.trim() : "";
  return clean.length > 0 ? clean : null;
}

/**
 * Whether the account may use the private surfaces.
 *
 * Three things, and all three must hold: a signed-in user, a device that
 * stands open, and — when the hub has a password in force — that password
 * having been answered. The device check is what makes "a copied app does not
 * get in" true: an installation that has never registered, or that the owner
 * has revoked, is refused by every private function here.
 *
 * On a guests-only hub the password half is already answered for everybody
 * (`hubPassword` answers null), so what is left is the device — and a device
 * that is merely `pending` stands open there, because the only thing a pending
 * row ever waits for is that password. The rule is `device_rule.ts`.
 */
export async function isUnlocked(ctx: QueryCtx | MutationCtx) {
  const userId = await getAuthUserId(ctx);
  if (userId === null) return false;

  if (!(await isDeviceAuthorized(ctx))) return false;

  if (hubPassword() === null) return true;

  const row = await ctx.db
    .query("access")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();

  return row?.unlockedAt !== undefined;
}

/**
 * Why a held-out caller was refused, in the words of whoever has to fix it.
 *
 * Two different failures can wear the same face, and they have different
 * remedies: an account with a password still to answer, and a device the hub
 * does not know or the owner has taken away. Telling them apart matters most on
 * a hub with no password in force — there is nothing to answer there, so
 * pointing the person at a password would send them looking for something that
 * does not exist.
 */
export function lockedMessage(): string {
  if (hubPassword() === null) {
    return "This device is not registered with the hub, or the owner has revoked it. Open the app again so it can register — if it was revoked, only the hub's owner can restore it.";
  }
  return "This device is not authorised for the hub, or the hub is locked. Ask the owner to authorise it, then enter the family password.";
}

/** Throws unless this account may use the private surfaces. */
export async function requireUnlocked(ctx: QueryCtx | MutationCtx) {
  if (await isUnlocked(ctx)) return;
  throw new Error(lockedMessage());
}

/** The owner's account id, or null while the hub has no owner yet. */
export async function ownerId(ctx: QueryCtx | MutationCtx) {
  const row = await securityRow(ctx);
  return row?.ownerUserId ?? null;
}

/**
 * Whether the signed-in account is the hub's owner.
 *
 * The owner is the one account that may authorise and revoke devices, read the
 * security log, and change the hub's security settings. It is the account that
 * claimed the hub first, recorded in the single `security` row.
 */
export async function isOwner(ctx: QueryCtx | MutationCtx) {
  const userId = await getAuthUserId(ctx);
  if (userId === null) return false;
  return (await ownerId(ctx)) === userId;
}

/** Throws unless the signed-in account is the hub's owner. */
export async function requireOwner(ctx: QueryCtx | MutationCtx) {
  const userId = await getAuthUserId(ctx);
  if (userId === null) throw new Error("Sign in first.");
  if (!(await isOwner(ctx))) {
    throw new Error("Only the hub's owner can do that.");
  }
  return userId;
}
