import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { mutation, query, type MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { roomValidator } from "./schema";

/** More than anyone scrolls through in one box. */
const LIMIT = 40;

/** The biggest file a box will take. Convex storage allows far more, but a hub
 *  is not a file server and a phone upload on a bad signal is the wrong place to
 *  find that out. */
const MAX_BYTES = 25 * 1024 * 1024;

/**
 * Throw the bytes away, but only once nothing points at them any more.
 *
 * A file shared into another box is two rows over one storageId, so deleting
 * the row a person removed must not take the picture out from under the copy
 * sitting in the other box.
 */
async function dropStorageIfUnused(
  ctx: MutationCtx,
  storageId: Id<"_storage">,
) {
  const stillUsed = await ctx.db
    .query("attachments")
    .withIndex("by_storage", (q) => q.eq("storageId", storageId))
    .take(1);

  if (stillUsed.length === 0) await ctx.storage.delete(storageId);
}

/**
 * Where the browser posts a file. The upload itself goes straight to storage,
 * not through a function, so a big file never has to fit in a request body.
 */
export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Sign in to add a file");
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * Label a file that has just landed in storage, so a box can list it.
 *
 * The family room holds one family's files; the two AI boxes hold yours. That is
 * the same rule the messages follow, and it is enforced here rather than trusted
 * from the client.
 */
export const attach = mutation({
  args: {
    room: roomValidator,
    storageId: v.id("_storage"),
    name: v.string(),
    contentType: v.string(),
    size: v.number(),
  },
  handler: async (ctx, { room, storageId, name, contentType, size }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Sign in to add a file");

    const me = await ctx.db.get(userId);
    const familyId = me?.familyId;
    if (room === "messenger" && !familyId) {
      throw new Error("Join a family first to add a file");
    }

    if (size > MAX_BYTES) {
      // Nothing should have got this far, but an oversized row is not worth
      // keeping either way.
      await ctx.storage.delete(storageId);
      throw new Error("That file is too big to attach. Keep it under 25 MB.");
    }

    await ctx.db.insert("attachments", {
      room,
      ownerId: userId,
      familyId: room === "messenger" ? familyId : undefined,
      storageId,
      name: name.trim().slice(0, 120) || "file",
      contentType: contentType.trim().slice(0, 120) || "application/octet-stream",
      size: Math.max(0, Math.round(size)),
      createdAt: Date.now(),
    });

    return null;
  },
});

/** The files attached to one box, newest last, each with a link to open it. */
export const list = query({
  args: { room: roomValidator },
  handler: async (ctx, { room }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];

    const me = await ctx.db.get(userId);
    const familyId = me?.familyId;

    // The family room is shared and the AI boxes are private, exactly like the
    // messages beside them.
    const rows =
      room === "messenger"
        ? familyId
          ? (
              await ctx.db
                .query("attachments")
                .withIndex("by_family", (q) => q.eq("familyId", familyId))
                .order("desc")
                .take(LIMIT)
            ).filter((row) => row.room === "messenger")
          : []
        : await ctx.db
            .query("attachments")
            .withIndex("by_room_owner", (q) =>
              q.eq("room", room).eq("ownerId", userId),
            )
            .order("desc")
            .take(LIMIT);

    const out = [];
    for (const row of rows.reverse()) {
      out.push({
        _id: row._id,
        name: row.name,
        contentType: row.contentType,
        size: row.size,
        createdAt: row.createdAt,
        url: await ctx.storage.getUrl(row.storageId),
      });
    }
    return out;
  },
});

/** Empty a box of its files, storage included. */
export const clear = mutation({
  args: { room: roomValidator },
  handler: async (ctx, { room }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Sign in to clear a box");

    const me = await ctx.db.get(userId);
    const familyId = me?.familyId;

    const rows =
      room === "messenger"
        ? familyId
          ? (
              await ctx.db
                .query("attachments")
                .withIndex("by_family", (q) => q.eq("familyId", familyId))
                .take(LIMIT)
            ).filter((row) => row.room === "messenger")
          : []
        : await ctx.db
            .query("attachments")
            .withIndex("by_room_owner", (q) =>
              q.eq("room", room).eq("ownerId", userId),
            )
            .take(LIMIT);

    // Drop the rows first, so a file shared into another box is no longer
    // counted as used by the row being cleared.
    const storageIds = new Set<Id<"_storage">>();
    for (const row of rows) {
      storageIds.add(row.storageId);
      await ctx.db.delete(row._id);
    }

    for (const storageId of storageIds) {
      await dropStorageIfUnused(ctx, storageId);
    }

    return null;
  },
});

/**
 * Send a file from one box to another — a picture from the assistant into the
 * family room, or the other way round.
 *
 * The bytes are never copied: the target gets its own row over the same
 * storageId, so a picture shared into the messenger is one picture, not two.
 * Permission is the same as everywhere else — the family room is the family's,
 * the two AI boxes are yours alone.
 */
export const share = mutation({
  args: { id: v.id("attachments"), room: roomValidator },
  handler: async (ctx, { id, room }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Sign in to share a file");

    const source = await ctx.db.get(id);
    if (!source) throw new Error("That file is no longer here.");

    const me = await ctx.db.get(userId);
    const familyId = me?.familyId;

    // You may send anything you can already see.
    const mine = source.ownerId === userId;
    const familyShared =
      source.room === "messenger" &&
      !!source.familyId &&
      source.familyId === familyId;
    if (!mine && !familyShared) {
      throw new Error("That file is not yours to share.");
    }

    if (room === "messenger" && !familyId) {
      throw new Error("Join a family first to share a file");
    }

    await ctx.db.insert("attachments", {
      room,
      ownerId: userId,
      familyId: room === "messenger" ? familyId : undefined,
      storageId: source.storageId,
      name: source.name,
      contentType: source.contentType,
      size: source.size,
      createdAt: Date.now(),
    });

    return null;
  },
});

/** Take a file out of a box, and out of storage with it. */
export const remove = mutation({
  args: { id: v.id("attachments") },
  handler: async (ctx, { id }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Sign in to remove a file");

    const row = await ctx.db.get(id);
    if (!row) return null;

    const me = await ctx.db.get(userId);
    const mine = row.ownerId === userId;
    const shared =
      row.room === "messenger" && !!row.familyId && row.familyId === me?.familyId;

    if (!mine && !shared) throw new Error("That file is not yours to remove");

    await ctx.db.delete(id);
    await dropStorageIfUnused(ctx, row.storageId);
    return null;
  },
});
