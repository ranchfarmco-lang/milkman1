/**
 * The studio voice — a real neural speaker, not the one the device happens to
 * have.
 *
 * The eight accents in `src/lib/voices.ts` are whatever this phone or laptop
 * can say, and on a great many machines that is a decade-old concatenative
 * engine: flat, clicky, and wrong for a personality. This file is the other
 * route: the words are sent to a text-to-speech model and what comes back is
 * audio, played through an `Audio` element. The voice that model speaks with is
 * a genuinely good one, and it can be *directed* — the persona below is the
 * whole reason the delivery sounds like a person rather than a satnav.
 *
 * It is built on the keys this hub already holds, deliberately: OpenRouter
 * serves a speech route with OpenRouter models behind it (`gpt-4o-mini-tts`
 * among them, which is the one that accepts a delivery instruction), and Groq
 * serves Orpheus on the free-ish end. Both are OpenAI-shaped, so one request
 * builder covers them, and neither needed a new account, a new key or a
 * subscription to be switched on. If neither is keyed, nothing here is
 * available, the Control Room says so with a link, and the device's own voice
 * carries on — which is also exactly what happens offline, mid-reply, without
 * an error.
 *
 * Three things are worth being plain about, and all three are said on the page
 * rather than here: the words being spoken are sent to that provider (so an
 * answer said aloud over the internet leaves the hub, unlike one merely shown);
 * the provider bills by the character; and the audio is not stored anywhere.
 */

import { groupUnder, phrasesOf } from "./voices";

export type StudioVoice = {
  id: string;
  label: string;
  about: string;
};

export type StudioProvider = {
  id: string;
  label: string;
  /** The variable that switches it on. Never sent to the page, only its name. */
  keyEnv: string;
  baseUrl: string;
  /** Best first. The first one that exists is the one used. */
  models: string[];
  voices: StudioVoice[];
  /** Characters one request may carry. Groq's Orpheus caps at 200. */
  maxChars: number;
  /** What this provider hands back, and what it is served as. */
  format: "mp3" | "wav";
  /** Whether a delivery instruction is honoured, or the voice is all you get. */
  instructions: boolean;
  docs: string;
  /** One line for the Control Room: what this is, and what it costs. */
  note: string;
};

/**
 * The persona, as an instruction to the model that will speak it.
 *
 * This is the voice the whole feature exists for, written out: an adult woman
 * with a low-mid register and a singer's phrasing, warm and quick rather than
 * sweet. It only reaches providers that accept an instruction, which is why
 * `instructions` is declared per provider rather than assumed.
 */
export const STUDIO_INSTRUCTIONS =
  "A distinctly feminine adult voice with a naturally low-mid register, rich " +
  "smoky warmth, subtle huskiness, beautifully rounded vowels, gentle " +
  "breathiness, musical phrasing, and the resonance of a former singer whose " +
  "voice has matured. She is intelligent, warm, quick-witted, playfully sassy, " +
  "confident, charming and emotionally perceptive. Her humour is dry and sharp " +
  "rather than forced. Her delivery has natural pauses, subtle pitch variation, " +
  "expressive emphasis and conversational rhythm. She sounds premium, " +
  "believable and emotionally nuanced — never shrill, childish, synthetic or " +
  "excessively sweet. American English. Do not rush.";

/**
 * The providers, best first.
 *
 * OpenRouter leads because it carries the model that takes the instruction
 * above, and because its speech route accepts a long piece of text in one call.
 * Groq follows: free on a low tier, one of the best small models around, but its
 * English voice caps a request at two hundred characters, so it is asked in
 * short pieces.
 */
export const STUDIO_PROVIDERS: StudioProvider[] = [
  {
    id: "openrouter",
    label: "OpenRouter",
    keyEnv: "OPENROUTER_API_KEY",
    baseUrl: "https://openrouter.ai/api/v1",
    models: [
      "openai/gpt-4o-mini-tts-2025-12-15",
      "google/gemini-3.8-flash-lite-tts",
      "mistralai/voxtral-mini-tts-2603",
    ],
    voices: [
      {
        id: "sage",
        label: "Sage",
        about: "Low, dry and unhurried — the closest to the persona in the box.",
      },
      {
        id: "coral",
        label: "Coral",
        about: "Warm and easy, a shade brighter, quick to smile.",
      },
      {
        id: "nova",
        label: "Nova",
        about: "Bright and brisk. Still her, but with the lights up.",
      },
      {
        id: "shimmer",
        label: "Shimmer",
        about: "Soft and light, a little breathy. Never childish.",
      },
      {
        id: "marin",
        label: "Marin",
        about: "Newer and cleaner, natural and even — good for long reading.",
      },
    ],
    maxChars: 1200,
    format: "mp3",
    instructions: true,
    docs: "https://openrouter.ai/docs/guides/overview/multimodal/tts",
    note: "One speech model behind your existing OpenRouter key, billed per character by that model.",
  },
  {
    id: "groq",
    label: "Groq",
    keyEnv: "GROQ_API_KEY",
    baseUrl: "https://api.groq.com/openai/v1",
    models: ["canopylabs/orpheus-v1-english"],
    voices: [
      { id: "hannah", label: "Hannah", about: "Warm and level, the steadiest of the three." },
      { id: "diana", label: "Diana", about: "Clear and bright, good on numbers and names." },
      { id: "autumn", label: "Autumn", about: "Softer and lower, a little wistful." },
    ],
    maxChars: 190,
    format: "wav",
    // Orpheus takes the words and the voice and nothing else, so the persona is
    // carried entirely by which voice is chosen. Saying otherwise would be a
    // setting that does nothing.
    instructions: false,
    docs: "https://console.groq.com/docs/text-to-speech/orpheus",
    note: "Groq's own speech model: free on the low tier, about $22 per million characters beyond it, and 200 characters a request.",
  },
];

export const DEFAULT_STUDIO_VOICE = "openrouter:sage";

export function studioProviderById(id: string | null | undefined): StudioProvider {
  return STUDIO_PROVIDERS.find((provider) => provider.id === id) ?? STUDIO_PROVIDERS[0];
}

/** "openrouter:sage" — the provider and the voice, in one stored string. */
export function splitStudioVoice(value: string): { providerId: string; voiceId: string } {
  const [providerId, voiceId] = value.split(":");
  const provider = studioProviderById(providerId);
  return {
    providerId: provider.id,
    voiceId: studioVoiceById(provider, voiceId).id,
  };
}

export function studioVoiceById(
  provider: StudioProvider,
  id: string | null | undefined,
): StudioVoice {
  return (
    provider.voices.find((voice) => voice.id === id) ??
    provider.voices[0] ?? { id: "sage", label: "Sage", about: "" }
  );
}

/** Whether a stored studio choice names a provider and a voice that exist. */
export function isKnownStudioVoice(value: string | null | undefined): boolean {
  if (typeof value !== "string" || !value.includes(":")) return false;
  const [providerId, voiceId] = value.split(":");
  const provider = STUDIO_PROVIDERS.find((one) => one.id === providerId);
  return Boolean(provider && provider.voices.some((voice) => voice.id === voiceId));
}

/** The whole string, for whatever is doing the storing. */
export function studioVoiceValue(providerId: string, voiceId: string): string {
  const provider = studioProviderById(providerId);
  return `${provider.id}:${studioVoiceById(provider, voiceId).id}`;
}

/** The provider to actually use: the chosen one when it is keyed, else the best keyed one. */
export function pickStudioProvider(
  chosenId: string,
  keyed: string[],
): StudioProvider | null {
  const chosen = studioProviderById(chosenId);
  if (keyed.includes(chosen.id)) return chosen;
  const better = STUDIO_PROVIDERS.find(
    (provider) => keyed.includes(provider.id) && provider.instructions,
  );
  if (better) return better;
  return STUDIO_PROVIDERS.find((provider) => keyed.includes(provider.id)) ?? null;
}

/**
 * A reply, cut into the pieces one request may carry.
 *
 * Groq caps a request at 200 characters, so a long answer is several calls —
 * which is fine, because the player queues them and the joins are a breath,
 * not a pause. Sentences are never cut in the middle: the pieces come from the
 * same splitter her own delivery uses.
 */
export function studioChunks(text: string, maxChars: number): string[] {
  return groupUnder(phrasesOf(text), maxChars).filter((piece) => piece.trim());
}

/**
 * The request one provider is sent, given a piece of a reply.
 *
 * Pure on purpose: it is the part of the studio voice that can be read and
 * checked without a key, a network or a browser, and it is also the part that
 * silently ruins the sound when it is wrong — an instruction sent to a model
 * that ignores it, or a voice name the provider does not have.
 */
export function studioRequestBody(
  provider: StudioProvider,
  text: string,
  voiceId: string,
) {
  const voice = studioVoiceById(provider, voiceId);
  return {
    model: provider.models[0],
    input: text.slice(0, provider.maxChars),
    voice: voice.id,
    response_format: provider.format,
    ...(provider.instructions ? { instructions: STUDIO_INSTRUCTIONS } : {}),
  };
}

/** What the provider sent back, as something that can be played. */
export function studioClip(bytes: Uint8Array, contentType: string | null) {
  const mimeType = (contentType ?? "").trim();
  return {
    audio: base64FromBytes(bytes),
    // A provider that answers with no content type at all gets the benefit of
    // the doubt; a browser can still sniff an mp3 or a wav from its header.
    mimeType: mimeType || "audio/mpeg",
    bytes: bytes.length,
  };
}

/** The bytes a phrase really encodes, for checking the encoder offline. */
export function bytesFromBase64(base64: string): Uint8Array {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = base64.replace(/=+$/, "");
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const character of clean) {
    const index = alphabet.indexOf(character);
    if (index < 0) continue;
    value = (value << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >> bits) & 255);
    }
  }
  return new Uint8Array(out);
}

/** Base64, for an audio file that has to travel through a function call. */
export function base64FromBytes(bytes: Uint8Array): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const triple = (a << 16) | (b << 8) | c;
    out += alphabet[(triple >> 18) & 63];
    out += alphabet[(triple >> 12) & 63];
    out += i + 1 < bytes.length ? alphabet[(triple >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? alphabet[triple & 63] : "=";
  }
  return out;
}

/* -------------------------------------------------------------------- playing */

export type ClipResult = "ended" | "stopped" | "failed";

export type ClipPlayer = {
  play: (
    base64: string,
    mimeType: string,
    /** The two sliders a recording can honestly honour. */
    settings?: { volume?: number; rate?: number },
  ) => Promise<ClipResult>;
  stop: () => void;
};

/**
 * One clip at a time, through an `Audio` element.
 *
 * The element is what the microphone mute is waiting on: `playing` is true from
 * the moment a clip starts until it ends, so the assistant never hears itself
 * — the same contract the device engine honours through `utterance.onend`.
 */
export function createClipPlayer(): ClipPlayer {
  let current: HTMLAudioElement | null = null;

  return {
    play(base64: string, mimeType: string, settings = {}) {
      return new Promise<ClipResult>((resolve) => {
        const element = new Audio(
          `data:${mimeType && mimeType !== "" ? mimeType : "audio/mpeg"};base64,${base64}`,
        );
        // Volume and speed are real on a recording; warmth is not. Pitch-shifting
        // a model's output is exactly the trick that made the device voices sound
        // cheap, so it is not done here — the studio voice has voices to choose
        // from instead, and the next line says as much.
        element.volume = settings.volume ?? 1;
        if (settings.rate) {
          element.preservesPitch = true;
          element.playbackRate = settings.rate;
        }
        current = element;
        let settled = false;
        const settle = (result: ClipResult) => {
          if (settled) return;
          settled = true;
          if (current === element) current = null;
          resolve(result);
        };
        element.onended = () => settle("ended");
        element.onerror = () => settle("failed");
        element.onpause = () => {
          // A pause that is not the end: something took the audio away, and
          // waiting for an `onended` that will never come would hang the queue.
          if (!element.ended) settle("stopped");
        };
        void element.play().catch(() => settle("failed"));
      });
    },

    stop() {
      const element = current;
      current = null;
      if (!element) return;
      element.onended = null;
      element.onerror = null;
      element.onpause = null;
      element.pause();
      element.src = "";
    },
  };
}
