import { api } from "@/convex/_generated/api";
import { useSettings } from "@/hooks/use-settings";
import { useVoice } from "@/hooks/use-voice";
import {
  createClipPlayer,
  DEFAULT_STUDIO_VOICE,
  pickStudioProvider,
  splitStudioVoice,
  STUDIO_PROVIDERS,
  studioChunks,
  studioVoiceById,
} from "@/lib/voice-studio";
import { useAction, useMutation, useQuery } from "convex/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** The switch itself lives with the other app switches, in device settings. */
export const STUDIO_SETTING = "voice_studio";

/**
 * What the Test button says.
 *
 * Written for the voice rather than for the test: a question, a claim and a
 * dry aside, so what is heard is a person rather than a calibration tone.
 */
export const STUDIO_SAMPLE =
  "There you are. This is the studio voice — low, warm, and rather better than the one that came with your laptop. Ask me anything.";

export type StudioClip = {
  ok: boolean;
  audio?: string;
  mimeType?: string;
  provider?: string;
  /** Why it could not be spoken, in words a person can act on. */
  error?: string;
  /** The variable that would fix it, when one would. */
  missing?: string;
  docs?: string;
};

/**
 * The studio voice, as the app sees it.
 *
 * Three questions, answered once and shared: is a speech model connected, is
 * the person's switch on, and can this reply be cut into pieces that provider
 * will accept. `say` is the fourth — it turns one piece into one clip of audio,
 * and when it cannot, it says why in a sentence worth reading rather than
 * failing silently into a voice nobody wanted.
 *
 * Nothing here is trusted blindly: the switch can be on with no key connected
 * (then `ready` is false and the device's own voice speaks), and a key can exist
 * on a deployment whose functions cannot run at all. Both end the same way —
 * the reply is read by the engine this device already has — which is why the
 * studio voice is an upgrade rather than a dependency.
 */
export function useStudioVoice() {
  const stored = useQuery(api.speech.status);
  const say = useAction(api.speech.say);
  const save = useMutation(api.speech.choose);
  const settings = useSettings();
  // The two sliders a recording can honour, for anything this hook plays itself
  // — which is the Test button, and nothing else.
  const { delivery } = useVoice();

  /** Its own player, so a test is not queued behind a reply being read. */
  const player = useRef<ReturnType<typeof createClipPlayer> | null>(null);
  if (player.current === null) player.current = createClipPlayer();
  useEffect(() => () => player.current?.stop(), []);

  const switchedOn = settings.values[STUDIO_SETTING] !== false;
  const [trouble, setTrouble] = useState<string | null>(null);
  const [speaking, setSpeaking] = useState(false);
  /** The last provider that actually spoke, so the page can be specific. */
  const [heard, setHeard] = useState<string | null>(null);
  const lastTrouble = useRef<string | null>(null);

  const choice = stored?.choice ?? DEFAULT_STUDIO_VOICE;
  const wanted = useMemo(() => splitStudioVoice(choice), [choice]);

  const keyed = useMemo(() => stored?.keyed ?? [], [stored?.keyed]);
  const provider = useMemo(
    () => pickStudioProvider(wanted.providerId, keyed),
    [wanted.providerId, keyed],
  );
  const voice = useMemo(
    () => (provider ? studioVoiceById(provider, wanted.voiceId) : null),
    [provider, wanted.voiceId],
  );

  /** True only when every part is in place: a key, a switch, and a real voice. */
  const ready = Boolean(provider && voice && switchedOn && stored?.signedIn !== false);

  const report = useCallback((reason: string) => {
    // Said once per distinct reason: a reply of six sentences failing the same
    // way should not put six identical lines on the page.
    if (lastTrouble.current === reason) return;
    lastTrouble.current = reason;
    setTrouble(reason);
  }, []);

  const speakClip = useCallback(
    async (text: string): Promise<StudioClip> => {
      if (!provider || !voice) {
        return { ok: false, error: "No speech model is connected." };
      }
      try {
        const result = await say({ text, voice: choice, providerId: provider.id });
        if (result.ok) {
          lastTrouble.current = null;
          setHeard(`${result.provider} · ${result.model}`);
          return {
            ok: true,
            audio: result.audio,
            mimeType: result.mimeType,
            provider: result.provider,
          };
        }
        report(result.error);
        return {
          ok: false,
          error: result.error,
          missing: "missing" in result ? result.missing : undefined,
          docs: "docs" in result ? result.docs : undefined,
        };
      } catch (error) {
        // The whole backend being unreachable is the common case offline, and it
        // reads as one sentence rather than as a stack trace.
        const reason =
          error instanceof Error
            ? "The hub could not be reached, so this device's own voice is speaking."
            : "The studio voice could not be reached.";
        report(reason);
        return { ok: false, error: reason };
      }
    },
    [provider, voice, say, choice, report],
  );

  const chooseVoice = useCallback(
    (value: string) => {
      void save({ value }).catch(() => undefined);
    },
    [save],
  );

  /**
   * Say the sample out loud, here and now.
   *
   * This is the acceptance test for the whole feature, so it does exactly what
   * a reply does — the same call, the same audio element, the same sliders —
   * and stops there. If it is silent, the reason is on the page rather than
   * being something to guess at.
   */
  const test = useCallback(async () => {
    if (!provider || !voice) {
      report("No speech model is connected yet.");
      return;
    }
    player.current?.stop();
    setSpeaking(true);
    try {
      const clip = await speakClip(STUDIO_SAMPLE);
      if (!clip.ok || !clip.audio) return;
      await player.current?.play(clip.audio, clip.mimeType ?? "audio/mpeg", {
        volume: delivery.volume,
        rate: delivery.speed,
      });
    } finally {
      setSpeaking(false);
    }
  }, [provider, voice, speakClip, report, delivery.volume, delivery.speed]);

  const chunks = useCallback(
    (text: string) => studioChunks(text, provider?.maxChars ?? 190),
    [provider?.maxChars],
  );

  return {
    /** The query may not have answered yet; the device voice is used meanwhile. */
    known: stored !== undefined,
    available: Boolean(stored?.available),
    ready,
    switchedOn,
    provider,
    voice,
    choice,
    keyed,
    providers: STUDIO_PROVIDERS,
    trouble,
    heard,
    speaking,
    setSpeaking,
    chunks,
    speakClip,
    test,
    chooseVoice,
    setSwitchedOn: (on: boolean) => settings.update(STUDIO_SETTING, on),
  };
}
