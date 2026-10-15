import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import {
  DEFAULT_STUDIO_VOICE,
  STUDIO_PROVIDERS,
  isKnownStudioVoice,
  pickStudioProvider,
  splitStudioVoice,
  studioClip,
  studioRequestBody,
} from "../lib/voice-studio";
import { internal } from "./_generated/api";
import { action, internalAction, mutation, query } from "./_generated/server";
import { lockedMessage } from "./guard";

/**
 * The studio voice: a real text-to-speech model, reached with a key this hub
 * already has.
 *
 * The device's own engine is the floor, not the ceiling — see
 * `src/lib/voice-studio.ts` for why the feature exists and what it sounds like.
 * What lives here is the part that needs a server: the key never leaves this
 * deployment, the words being spoken do leave it (to the provider, only while
 * the studio voice is switched on), and nothing is written down. No audio is
 * stored, no text is logged, and there is no table for any of it.
 *
 * Two functions do the work. `status` says which providers could answer — by
 * *name* of the variable, never its value — and `say` turns one piece of a
 * reply into one clip of audio. The client cuts the reply to the provider's
 * limit, because only it knows what she is about to say; the server clips again
 * anyway, because a client is not a guarantee.
 */

/** Which providers have a key, and which voice this person chose. */
export const status = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    const me = userId === null ? null : await ctx.db.get(userId);

    // Reading a variable's *presence* is what makes this honest: a key that was
    // revoked last week looks exactly like a working one from here, so the page
    // says "keyed", never "working" — the first reply that comes back is what
    // proves it, and if it fails the device voice carries on.
    const providers = STUDIO_PROVIDERS.map((provider) => ({
      id: provider.id,
      label: provider.label,
      keyEnv: provider.keyEnv,
      models: provider.models,
      voices: provider.voices,
      maxChars: provider.maxChars,
      format: provider.format,
      instructions: provider.instructions,
      docs: provider.docs,
      note: provider.note,
      keyed: Boolean(process.env[provider.keyEnv]),
    }));

    const keyed = providers.filter((provider) => provider.keyed).map((one) => one.id);
    const chosen = me?.studioVoice ?? DEFAULT_STUDIO_VOICE;

    return {
      signedIn: userId !== null,
      providers,
      keyed,
      choice: isKnownStudioVoice(chosen) ? chosen : DEFAULT_STUDIO_VOICE,
      available: keyed.length > 0,
      /** Which of them would actually answer, in order of preference. */
      preferred: pickStudioProvider(splitStudioVoice(chosen).providerId, keyed)?.id ?? null,
    };
  },
});

/** Choose the studio voice. Only a real provider-and-voice pair is accepted. */
export const choose = mutation({
  args: { value: v.string() },
  handler: async (ctx, { value }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Sign in to change the voice");
    if (!isKnownStudioVoice(value)) throw new Error("That is not one of the studio voices");

    await ctx.db.patch(userId, { studioVoice: value });
    return value;
  },
});

export type SayResult =
  | {
      ok: true;
      audio: string;
      mimeType: string;
      provider: string;
      model: string;
      bytes: number;
    }
  | {
      ok: false;
      error: string;
      /** The variable that would fix it, when one would. */
      missing?: string;
      docs?: string;
      detail?: string;
    };

/** One piece of a reply, spoken by a model, handed back as base64 audio. */
export const say = action({
  args: {
    text: v.string(),
    /** "openrouter:sage" — the same string the Control Room stores. */
    voice: v.string(),
    /** Forced provider, when the caller wants a specific one. */
    providerId: v.optional(v.string()),
  },
  handler: async (ctx, { text, voice, providerId }): Promise<SayResult> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return { ok: false, error: "Sign in to hear her in the studio voice." };
    }
    // An action has no database of its own, so the hub's own answer to "is this
    // account unlocked" is asked for through the query built for exactly this.
    if (!(await ctx.runQuery(internal.access.unlocked, {}))) {
      return { ok: false, error: lockedMessage() };
    }

    const said = text.trim();
    if (!said) return { ok: false, error: "There was nothing to say." };

    const wanted = splitStudioVoice(voice);
    const keyed = STUDIO_PROVIDERS.filter((one) => Boolean(process.env[one.keyEnv])).map(
      (one) => one.id,
    );
    const provider =
      providerId && keyed.includes(providerId)
        ? (STUDIO_PROVIDERS.find((one) => one.id === providerId) ?? null)
        : pickStudioProvider(wanted.providerId, keyed);

    if (!provider) {
      const first = STUDIO_PROVIDERS[0];
      return {
        ok: false,
        error: `No speech model is connected — set ${first.keyEnv} and she will speak with it.`,
        missing: first.keyEnv,
        docs: first.docs,
      };
    }

    const key = process.env[provider.keyEnv];
    if (!key) {
      return {
        ok: false,
        error: `${provider.label} is not connected — its key is ${provider.keyEnv}.`,
        missing: provider.keyEnv,
        docs: provider.docs,
      };
    }

    let response: Response;
    try {
      response = await fetch(`${provider.baseUrl}/audio/speech`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        // The body is built by the shared, pure builder: the model, the words
        // clipped to what this provider accepts, the voice it really has and the
        // delivery instruction — only for the provider that honours one.
        body: JSON.stringify(studioRequestBody(provider, said, wanted.voiceId)),
      });
    } catch (error) {
      return {
        ok: false,
        error: `${provider.label} could not be reached.`,
        detail: error instanceof Error ? error.message : String(error),
      };
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      return {
        ok: false,
        error: `${provider.label} answered ${response.status}.`,
        detail: detail.slice(0, 300),
        missing: response.status === 401 || response.status === 403 ? provider.keyEnv : undefined,
        docs: provider.docs,
      };
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length) {
      return { ok: false, error: `${provider.label} sent back an empty file.` };
    }

    const clip = studioClip(bytes, response.headers.get("content-type"));
    return {
      ok: true,
      audio: clip.audio,
      mimeType: clip.mimeType,
      provider: provider.label,
      model: provider.models[0],
      bytes: clip.bytes,
    };
  },
});

/**
 * The same call, on the deployment's own behalf.
 *
 * This exists so the studio voice can be proved rather than assumed: run it
 * with `bunx convex run speech:probe` after setting a key, and it answers with
 * which provider spoke, how many bytes came back, and — when something is wrong
 * — exactly what the provider said. It writes nothing and stores nothing, and
 * it is not reachable from the app.
 */
export const probe = internalAction({
  args: { text: v.optional(v.string()) },
  handler: async (_ctx, { text }) => {
    const said = (text ?? "Hello. This is the studio voice, and this is what I sound like.").slice(
      0,
      190,
    );

    const results: Record<string, unknown>[] = [];
    for (const provider of STUDIO_PROVIDERS) {
      const key = process.env[provider.keyEnv];
      if (!key) {
        results.push({ provider: provider.id, keyed: false, keyEnv: provider.keyEnv });
        continue;
      }

      const voice = provider.voices[0];
      try {
        const response = await fetch(`${provider.baseUrl}/audio/speech`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(studioRequestBody(provider, said, voice.id)),
        });

        const contentType = response.headers.get("content-type") ?? "";
        const bytes = new Uint8Array(await response.arrayBuffer());
        results.push({
          provider: provider.id,
          keyed: true,
          model: provider.models[0],
          voice: voice.id,
          status: response.status,
          contentType,
          bytes: bytes.length,
          head: bytes.length ? studioClip(bytes.slice(0, 4), null).audio : "",
          detail: response.ok ? undefined : new TextDecoder().decode(bytes).slice(0, 300),
        });
      } catch (error) {
        results.push({
          provider: provider.id,
          keyed: true,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { checkedAt: Date.now(), results };
  },
});
