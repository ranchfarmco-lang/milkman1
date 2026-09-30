"use node";

import { createHmac } from "node:crypto";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

/**
 * The relay token for a call.
 *
 * Our own WebRTC sends the media straight between devices, but two home routers
 * often cannot see each other at all — a strict router, a mobile carrier, a
 * locked-down office. When that happens the packets have to pass through
 * something with a public address. LiveKit is that something: an open-source
 * media server that every device connects *out* to, so there is no router to
 * argue with, and a four-way call stops needing six fragile links between us.
 *
 * This action is the only place the API secret is ever used. It mints a
 * short-lived token naming the room (the call id) and the person (their own
 * account id), and only after checking that the person is really on that call.
 * The secret never reaches the browser, and nothing mints a token for someone
 * who is not already in the room.
 *
 * Point LIVEKIT_URL at your own LiveKit server and the whole path becomes
 * yours, with no code change — the token it mints works there just the same.
 */

/** Sign a LiveKit join token by hand: HS256 over the header and payload. */
function signLiveKitToken(input: {
  apiKey: string;
  apiSecret: string;
  identity: string;
  name: string;
  room: string;
  ttlSeconds: number;
}) {
  const base64url = (value: string | Buffer) =>
    Buffer.from(value)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

  const now = Math.floor(Date.now() / 1000);

  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    // A little clock slack on each side, so a device whose clock is a minute
    // off still connects instead of being refused as "not yet valid".
    nbf: now - 10,
    exp: now + input.ttlSeconds,
    iss: input.apiKey,
    sub: input.identity,
    name: input.name,
    // The room *is* the call: whoever is on this call joins this room, and
    // nobody else has a token that names it.
    video: {
      room: input.room,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    },
  };

  const body = `${base64url(JSON.stringify(header))}.${base64url(
    JSON.stringify(payload),
  )}`;
  const signature = createHmac("sha256", input.apiSecret)
    .update(body)
    .digest();

  return `${body}.${base64url(signature)}`;
}

/**
 * A URL and token for the call you are on — or nothing at all.
 *
 * Returning nothing is a normal answer, not an error: it is what happens when
 * the relay is not configured yet, or somebody asks for a call they are not on.
 * The page reads that as "use our own direct connection instead", so the app
 * keeps working with no relay set up at all.
 */
export const token = action({
  args: { callId: v.id("calls") },
  handler: async (
    ctx,
    { callId },
  ): Promise<{ url: string; token: string } | null> => {
    const identity = await ctx.auth.getUserIdentity();
    if (identity === null) return null;

    // The signed-in account. Convex Auth puts the user's own id in `subject`,
    // so this is the same id the rest of the app calls you by.
    const userId = identity.subject as Id<"users">;

    const allowed = await ctx.runQuery(internal.calls.canJoin, {
      callId,
      userId,
    });
    if (!allowed) return null;

    const url = process.env.LIVEKIT_URL;
    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    if (!url || !apiKey || !apiSecret) return null;

    const profile = await ctx.runQuery(internal.family.profile, { userId });

    return {
      url,
      token: signLiveKitToken({
        apiKey,
        apiSecret,
        // An opaque id, exactly as LiveKit asks: the account id, nothing
        // personal. The name is only for a label inside the room.
        identity: userId,
        name: profile?.name ?? "",
        room: callId,
        // An hour. LiveKit Cloud refreshes a connected client's token on its
        // own, so a long call is never cut off by this.
        ttlSeconds: 60 * 60,
      }),
    };
  },
});

/** The one room the test page uses, so any two devices that open it meet. */
export const TEST_ROOM = "call-test";

/**
 * A token for the test page, on a room that always exists.
 *
 * The test page is about the *server*, so it must be able to try the relay on
 * its own, without a call having been started first. This hands any signed-in
 * person a token for one fixed room; two devices that open the page land in it
 * together and can see and hear each other, which is the cross-location check.
 * Returns nothing when no relay is configured — exactly like `token`, so the
 * page can say plainly that no server is set up.
 */
export const probe = action({
  args: {},
  handler: async (ctx): Promise<{ url: string; token: string; room: string } | null> => {
    const identity = await ctx.auth.getUserIdentity();
    if (identity === null) return null;

    const url = process.env.LIVEKIT_URL;
    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    if (!url || !apiKey || !apiSecret) return null;

    const userId = identity.subject as Id<"users">;
    const profile = await ctx.runQuery(internal.family.profile, { userId });

    return {
      url,
      room: TEST_ROOM,
      token: signLiveKitToken({
        apiKey,
        apiSecret,
        identity: userId,
        name: profile?.name ?? "",
        room: TEST_ROOM,
        ttlSeconds: 60 * 60,
      }),
    };
  },
});
