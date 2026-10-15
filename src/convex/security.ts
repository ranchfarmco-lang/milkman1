import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import {
  devicesFor,
  hubPassword,
  isOwner,
  ownerId,
  securityRow,
  SECURITY_KEY,
} from "./guard";
import { logSignIn } from "./people";

/**
 * The private side of Sugar.
 *
 * Everything in this file is the architecture the app is meant to be, written
 * down as server code rather than as screens:
 *
 *   * one owner, recorded once, who alone may authorise devices;
 *   * devices — not the PWA, not a URL — as the unit of access;
 *   * a security log the owner can read;
 *   * no public registration and no anonymous administration.
 *
 * Device authorisation is enforced in `guard.isUnlocked`, which every private
 * function funnels through, so a screen cannot be the thing that grants access:
 * a pending or revoked device is refused by the server no matter what the
 * browser renders.
 */

/** The events worth keeping a record of, as a small closed set. */
const EVENTS = {
  owner: "owner.claimed",
  registered: "device.registered",
  authorized: "device.authorized",
  revoked: "device.revoked",
  terminated: "session.terminated",
  settings: "security.settings",
} as const;

/** Write one line to the private security log. Best effort — never fatal. */
export async function logSecurityEvent(
  ctx: MutationCtx,
  entry: {
    event: string;
    detail?: string;
    actorId?: Id<"users">;
    actorName?: string;
    deviceId?: string;
    deviceName?: string;
  },
) {
  await ctx.db.insert("securityLog", { at: Date.now(), ...entry });
}

/** Internal alias so the call sites below still read `record`. */
const record = logSecurityEvent;

/** Whether this account has answered the family password yet. */
async function passwordAnswered(ctx: QueryCtx | MutationCtx, userId: Id<"users">) {
  const row = await ctx.db
    .query("access")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
  return row?.unlockedAt !== undefined;
}

/** The device row for one account's installation, if it exists. */
async function deviceRow(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  deviceId: string,
): Promise<Doc<"devices"> | undefined> {
  const rows = await ctx.db
    .query("devices")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  return rows.find((row) => row.deviceId === deviceId);
}

/* -------------------------------------------------------------- registering */

/**
 * Register this installation, and claim the hub if it has no owner yet.
 *
 * Called by the app once it is signed in and before any private surface opens.
 * The first account that claims the hub becomes its owner. When the hub has a
 * password configured, claiming also requires having answered it, so the first
 * person to reach a fresh hub cannot take ownership without knowing the
 * password. Any later installation is registered `pending` and stays shut out
 * until the owner authorises it.
 */
export const register = mutation({
  args: {
    deviceId: v.string(),
    installationId: v.string(),
    name: v.string(),
    platform: v.string(),
    kind: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return { ok: false as const, reason: "signed_out" as const };

    const now = Date.now();
    const user = await ctx.db.get(userId);
    const actorName = user?.name;

    const security = await securityRow(ctx);
    const answered = await passwordAnswered(ctx, userId);
    // The password in force, not merely the one in the environment: a
    // guests-only hub registers devices as though none were configured, which
    // is what lets a guest in on any device.
    const passwordSet = hubPassword() !== null;

    // A hub nobody can administer has to be recoverable by whoever holds the
    // password, or the account meant to run it can lock everyone — itself
    // included — out of their own hub. So the hub counts as ownerless when
    // there is no owner, and also when the owner's own account no longer has an
    // authorised device: a lost browser, a cleared profile, an account that can
    // no longer be reached.
    const currentOwner = security?.ownerUserId ?? null;
    const ownerCanAct = currentOwner
      ? (await devicesFor(ctx, currentOwner)).some(
          (row) => row.status === "authorized",
        )
      : false;
    const ownerless = currentOwner === null || !ownerCanAct;

    // Claiming the hub needs no owner already able to act, and — when there is
    // a password — that password having been answered.
    const canClaim = ownerless && (!passwordSet || answered);

    if (!security) {
      await ctx.db.insert("security", {
        key: SECURITY_KEY,
        ownerUserId: canClaim ? userId : undefined,
        ownerName: canClaim ? actorName : undefined,
        registrationOpen: !canClaim,
        createdAt: now,
        updatedAt: now,
      });
      if (canClaim) {
        await record(ctx, {
          event: EVENTS.owner,
          detail: "This account became the hub's owner.",
          actorId: userId,
          actorName,
          deviceId: args.deviceId,
          deviceName: args.name,
        });
      }
    } else if (canClaim && security.ownerUserId !== userId) {
      await ctx.db.patch(security._id, {
        ownerUserId: userId,
        ownerName: actorName,
        registrationOpen: false,
        updatedAt: now,
      });
      await record(ctx, {
        event: EVENTS.owner,
        detail: "This account took over as the hub's owner.",
        actorId: userId,
        actorName,
        deviceId: args.deviceId,
        deviceName: args.name,
      });
    }

    const owner = await ownerId(ctx);
    const isOwnersDevice = owner === userId;
    // What a brand-new device's status is:
    //   * the owner's own device — authorised;
    //   * anybody else's — authorised once the account has answered the family
    //     password, because that password is the family's shared authorisation,
    //     and the owner can revoke a device at any time;
    //   * still `pending` only while there is a password left to answer.
    //
    // A hub with no password at all is the deliberately open case, so its
    // devices are authorised on registration rather than bricking the only
    // person using it — the same "open until `HUB_PASSWORD` is set" behaviour
    // the rest of the app has always had.
    const status: "authorized" | "pending" = isOwnersDevice
      ? "authorized"
      : !passwordSet || answered
        ? "authorized"
        : "pending";

    const existing = await deviceRow(ctx, userId, args.deviceId);
    if (existing) {
      await ctx.db.patch(existing._id, {
        installationId: args.installationId,
        name: args.name,
        platform: args.platform,
        kind: args.kind,
        lastSeenAt: now,
        // A device revoked by the owner stays revoked. Otherwise the device is
        // (re)authorised the moment it qualifies — the owner's own device, or
        // one whose account has now answered the password.
        ...(existing.status === "revoked"
          ? {}
          : isOwnersDevice || status === "authorized"
            ? {
                status: "authorized" as const,
                authorizedAt: existing.authorizedAt ?? now,
                authorizedBy: existing.authorizedBy ?? userId,
              }
            : {}),
      });
    } else {
      await ctx.db.insert("devices", {
        deviceId: args.deviceId,
        installationId: args.installationId,
        userId,
        name: args.name,
        platform: args.platform,
        kind: args.kind,
        status,
        createdAt: now,
        lastSeenAt: now,
        authorizedAt: status === "authorized" ? now : undefined,
        authorizedBy: status === "authorized" ? userId : undefined,
      });
      await record(ctx, {
        event: EVENTS.registered,
        detail:
          status === "authorized"
            ? "Registered and authorised."
            : "Registered; waiting for the owner to authorise it.",
        actorId: userId,
        actorName,
        deviceId: args.deviceId,
        deviceName: args.name,
      });

      // A brand-new installation is a first arrival, so it belongs in the
      // sign-in history too — the list that gets cleared, kept apart from the
      // security log above on purpose.
      await logSignIn(ctx, {
        userId,
        name: actorName,
        deviceId: args.deviceId,
        deviceName: args.name,
        platform: args.platform,
        what: "New device — first time here",
      });

      // The password may have been answered on this device a moment before it
      // was registered — the sign-in page comes first — which left that row
      // without a "where". Now that the device is known, fill it in.
      const earlier = await ctx.db
        .query("signIns")
        .withIndex("by_user_device", (q) =>
          q.eq("userId", userId).eq("deviceId", args.deviceId),
        )
        .collect();
      for (const row of earlier) {
        if (row.deviceName === undefined) {
          await ctx.db.patch(row._id, {
            deviceName: args.name,
            platform: args.platform,
          });
        }
      }
    }

    return { ok: true as const, isOwner: await isOwner(ctx), ownerExists: (await ownerId(ctx)) !== null };
  },
});

/** Keep this installation's `lastSeenAt` honest while the app is open. */
export const touch = mutation({
  args: { deviceId: v.string() },
  handler: async (ctx, { deviceId }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;
    const row = await deviceRow(ctx, userId, deviceId);
    if (row) await ctx.db.patch(row._id, { lastSeenAt: Date.now() });
    return null;
  },
});

/* -------------------------------------------------------------------- state */

/**
 * What this device and account are, for the gate in front of the app.
 *
 * Deliberately small and non-secret: whether an owner exists, whether this
 * device is authorised, and whether a password is configured. Nothing about
 * anybody else's devices is here — that is the owner's query below.
 */
export const state = query({
  args: { deviceId: v.string() },
  handler: async (ctx, { deviceId }) => {
    const userId = await getAuthUserId(ctx);
    const security = await securityRow(ctx);
    const owner = security?.ownerUserId ?? null;

    if (userId === null) {
      return {
        signedIn: false,
        isOwner: false,
        ownerExists: owner !== null,
        ownerName: security?.ownerName ?? null,
        registrationOpen: security?.registrationOpen ?? true,
        passwordRequired: hubPassword() !== null,
        device: null,
      };
    }

    const row = await deviceRow(ctx, userId, deviceId);

    return {
      signedIn: true,
      isOwner: owner === userId,
      ownerExists: owner !== null,
      ownerName: security?.ownerName ?? null,
      registrationOpen: security?.registrationOpen ?? true,
      passwordRequired: hubPassword() !== null,
      device: row
        ? {
            status: row.status,
            name: row.name,
            platform: row.platform,
            kind: row.kind,
            lastSeenAt: row.lastSeenAt,
          }
        : null,
    };
  },
});

/* --------------------------------------------------------------- owner only */

/** Every device that has ever registered, newest first. Owner-readable only. */
export const devices = query({
  args: {},
  handler: async (ctx) => {
    if (!(await isOwner(ctx))) {
      throw new Error("Only the hub's owner can see the device list.");
    }
    const owner = await ownerId(ctx);

    const rows = await ctx.db.query("devices").collect();
    const withNames = await Promise.all(
      rows.map(async (row) => {
        const user = await ctx.db.get(row.userId);
        return {
          deviceId: row.deviceId,
          name: row.name,
          platform: row.platform,
          kind: row.kind,
          status: row.status,
          ownerName: user?.name ?? "Unnamed account",
          isOwner: row.userId === owner,
          createdAt: row.createdAt,
          lastSeenAt: row.lastSeenAt,
          authorizedAt: row.authorizedAt ?? null,
          revokedAt: row.revokedAt ?? null,
          note: row.note ?? null,
        };
      }),
    );

    return withNames.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  },
});

/** The private security log, newest first. Owner-readable only. */
export const log = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    if (!(await isOwner(ctx))) {
      throw new Error("Only the hub's owner can read the security log.");
    }
    const take = Math.min(Math.max(limit ?? 100, 1), 300);
    return await ctx.db
      .query("securityLog")
      .withIndex("by_at")
      .order("desc")
      .take(take);
  },
});

/** A small real-state summary for the Control Room security panel. */
export const summary = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    const owner = await ownerId(ctx);
    const ownerRow = owner ? await ctx.db.get(owner) : null;

    const rows = await ctx.db.query("devices").collect();
    const authorized = rows.filter((row) => row.status === "authorized").length;
    const pending = rows.filter((row) => row.status === "pending").length;
    const revoked = rows.filter((row) => row.status === "revoked").length;
    // How much is in the sign-in history, for the reading beside the
    // Sign-ins & people category. Only the count is here, so a signed-out
    // caller learns nothing; the rows themselves are in `people.list`, which
    // is open to anybody the hub has let in.
    const signIns = (await ctx.db.query("signIns").collect()).length;

    const me = userId
      ? rows.find((row) => row.userId === userId) ?? null
      : null;

    return {
      signedIn: userId !== null,
      isOwner: owner !== null && owner === userId,
      ownerName: ownerRow?.name ?? (await securityRow(ctx))?.ownerName ?? null,
      passwordRequired: hubPassword() !== null,
      registrationOpen: (await securityRow(ctx))?.registrationOpen ?? true,
      devices: { total: rows.length, authorized, pending, revoked },
      signIns,
      deviceStatus: me?.status ?? null,
    };
  },
});

/** Authorise a device that is waiting. Owner only. */
export const authorize = mutation({
  args: { deviceId: v.string(), note: v.optional(v.string()) },
  handler: async (ctx, { deviceId, note }) => {
    const owner = await getAuthUserId(ctx);
    if (!(await isOwner(ctx))) {
      throw new Error("Only the hub's owner can authorise a device.");
    }
    const row = await ctx.db
      .query("devices")
      .withIndex("by_device", (q) => q.eq("deviceId", deviceId))
      .first();
    if (!row) throw new Error("No such device.");

    await ctx.db.patch(row._id, {
      status: "authorized",
      authorizedAt: Date.now(),
      authorizedBy: owner!,
      revokedAt: undefined,
      note: note ?? undefined,
    });
    await record(ctx, {
      event: EVENTS.authorized,
      detail: "Authorised from the Control Room.",
      actorId: owner!,
      deviceId: row.deviceId,
      deviceName: row.name,
    });
    return { ok: true as const };
  },
});

/**
 * Revoke a device. Owner only.
 *
 * The device's account loses its authorised device immediately, so `isUnlocked`
 * refuses every private function for it on the very next call — reopening the
 * app does not bring it back.
 */
export const revoke = mutation({
  args: { deviceId: v.string(), reason: v.optional(v.string()) },
  handler: async (ctx, { deviceId, reason }) => {
    const owner = await getAuthUserId(ctx);
    if (!(await isOwner(ctx))) {
      throw new Error("Only the hub's owner can revoke a device.");
    }
    const row = await ctx.db
      .query("devices")
      .withIndex("by_device", (q) => q.eq("deviceId", deviceId))
      .first();
    if (!row) throw new Error("No such device.");

    await ctx.db.patch(row._id, {
      status: "revoked",
      revokedAt: Date.now(),
      note: reason ?? row.note,
    });
    await record(ctx, {
      event: EVENTS.revoked,
      detail: reason ?? "Revoked from the Control Room.",
      actorId: owner!,
      deviceId: row.deviceId,
      deviceName: row.name,
    });
    return { ok: true as const };
  },
});

/** Bring a revoked device back. Owner only. */
export const restore = mutation({
  args: { deviceId: v.string() },
  handler: async (ctx, { deviceId }) => {
    const owner = await getAuthUserId(ctx);
    if (!(await isOwner(ctx))) {
      throw new Error("Only the hub's owner can change a device.");
    }
    const row = await ctx.db
      .query("devices")
      .withIndex("by_device", (q) => q.eq("deviceId", deviceId))
      .first();
    if (!row) throw new Error("No such device.");

    await ctx.db.patch(row._id, {
      status: "authorized",
      authorizedAt: Date.now(),
      authorizedBy: owner!,
      revokedAt: undefined,
    });
    await record(ctx, {
      event: EVENTS.authorized,
      detail: "Restored from the Control Room.",
      actorId: owner!,
      deviceId: row.deviceId,
      deviceName: row.name,
    });
    return { ok: true as const };
  },
});

/**
 * End the device's session: the password is asked for again on it.
 *
 * Separate from revoking — a session can be ended while the device stays
 * authorised — which is the "log this one out" button in the device list.
 */
export const terminate = mutation({
  args: { deviceId: v.string() },
  handler: async (ctx, { deviceId }) => {
    if (!(await isOwner(ctx))) {
      throw new Error("Only the hub's owner can end a session.");
    }
    const row = await ctx.db
      .query("devices")
      .withIndex("by_device", (q) => q.eq("deviceId", deviceId))
      .first();
    if (!row) throw new Error("No such device.");

    const access = await ctx.db
      .query("access")
      .withIndex("by_user", (q) => q.eq("userId", row.userId))
      .unique();
    if (access) await ctx.db.patch(access._id, { unlockedAt: undefined });

    await record(ctx, {
      event: EVENTS.terminated,
      detail: "Session ended from the Control Room.",
      deviceId: row.deviceId,
      deviceName: row.name,
    });
    return { ok: true as const };
  },
});
