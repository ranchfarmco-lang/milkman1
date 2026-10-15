import { api } from "@/convex/_generated/api";
import {
  DEFAULT_DELIVERY,
  DEFAULT_VOICE_ID,
  deliveryFrom,
  isDefaultDelivery,
  planUtterances,
  profileById,
  resolveVoice,
  VOICE_PROFILES,
  type ResolvedVoice,
  type Utterance,
  type VoiceDelivery,
  type VoiceProfile,
} from "@/lib/voices";
import { useMutation, useQuery } from "convex/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

/**
 * The voice the AI speaks with, and how she says it.
 *
 * Two things are read from the account — which of the eight she is, and the
 * four delivery numbers — and one thing belongs to the device in front of you:
 * the list of voices it actually has. That list arrives asynchronously, and in
 * some browsers it is empty until `voiceschanged` fires, so until it lands every
 * profile still resolves, just as a stand-in rather than as herself.
 *
 * What a profile *resolves to* is worked out here and nowhere else, so the row
 * in the Control Room and the thing that speaks are the same answer rather than
 * two that resemble each other.
 */
export function useVoice() {
  const stored = useQuery(api.voice.mine);
  const setVoice = useMutation(api.voice.set);
  const saveDelivery = useMutation(api.voice.setDelivery);
  const clearDelivery = useMutation(api.voice.resetDelivery);

  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);

  const supported =
    typeof window !== "undefined" && "speechSynthesis" in window;

  useEffect(() => {
    if (!supported) return;

    const load = () => {
      const list = window.speechSynthesis.getVoices();
      if (list.length) setVoices(list);
    };

    load();
    window.speechSynthesis.addEventListener("voiceschanged", load);
    return () =>
      window.speechSynthesis.removeEventListener("voiceschanged", load);
  }, [supported]);

  const id = stored?.id ?? DEFAULT_VOICE_ID;
  const delivery: VoiceDelivery = useMemo(
    () => deliveryFrom(stored?.delivery),
    [stored?.delivery],
  );

  const profile: VoiceProfile = useMemo(() => profileById(id), [id]);
  const resolved: ResolvedVoice = useMemo(
    () => resolveVoice(profile, voices, delivery),
    [profile, voices, delivery],
  );

  // A write that fails says so rather than leaving the page showing a choice
  // the account never took.
  /** A refused write says so, rather than leaving the page quietly wrong. */
  const wentWrong = useCallback((what: string, error: unknown) => {
    const said = error instanceof Error ? error.message : "";
    toast.error(said || what);
  }, []);

  const choose = useCallback(
    (next: string) => {
      void setVoice({ id: next }).catch((error: unknown) =>
        wentWrong("That voice did not save.", error),
      );
    },
    [setVoice, wentWrong],
  );

  /** Move one of the four sliders, keeping the other three where they are. */
  const setDelivery = useCallback(
    (patch: Partial<VoiceDelivery>) => {
      void saveDelivery({ ...delivery, ...patch }).catch((error: unknown) =>
        wentWrong("The voice settings did not save.", error),
      );
    },
    [delivery, saveDelivery, wentWrong],
  );

  /** Back to her own defaults — the state a fresh account is in. */
  const resetDelivery = useCallback(() => {
    void clearDelivery({}).catch((error: unknown) =>
      wentWrong("The voice settings did not reset.", error),
    );
  }, [clearDelivery, wentWrong]);

  // The voice list arrives late, so read it through refs when resolving
  // outside a render. They are mirrored in effects rather than written during
  // render: a render can be discarded or replayed, and a ref written on the way
  // past would then be holding the value of a render that never happened.
  const voicesRef = useRef(voices);
  const deliveryRef = useRef(delivery);
  useEffect(() => {
    voicesRef.current = voices;
  }, [voices]);
  useEffect(() => {
    deliveryRef.current = delivery;
  }, [delivery]);

  /** The full answer for one profile, without changing the choice. */
  const resolveById = useCallback(
    (profileId: string) =>
      resolveVoice(
        profileById(profileId),
        voicesRef.current,
        deliveryRef.current,
      ),
    [],
  );

  /** The real device voice behind a profile, without changing the choice. */
  const deviceVoiceName = useCallback(
    (profileId: string) => resolveById(profileId).voice?.name ?? null,
    [resolveById],
  );

  /**
   * Say her own line in her own voice, so she can be judged before she is
   * chosen. Every piece goes through the same delivery planner the answers do,
   * so what is heard here is what will be heard later rather than a plain
   * sample the real thing never matches.
   */
  const preview = useCallback(
    (profileId: string) => {
      if (!supported) return;

      const chosen = resolveVoice(
        profileById(profileId),
        voicesRef.current,
        deliveryRef.current,
      );
      const plan: Utterance[] = planUtterances(
        profileById(profileId).sample,
        chosen,
        deliveryRef.current.expressiveness,
      );

      window.speechSynthesis.cancel();
      let index = 0;
      const next = () => {
        if (index >= plan.length) return;
        const piece = plan[index];
        index += 1;
        const utterance = new SpeechSynthesisUtterance(piece.text);
        if (chosen.voice) utterance.voice = chosen.voice;
        utterance.rate = piece.rate;
        utterance.pitch = piece.pitch;
        utterance.volume = piece.volume;
        utterance.onend = next;
        window.speechSynthesis.speak(utterance);
      };
      next();
    },
    [supported],
  );

  return {
    id,
    profile,
    resolved,
    delivery,
    /** True wherever the browser has a speech engine; the voice list may lag. */
    engineReady: supported,
    /** False until the device has actually named its voices. */
    voicesReady: voices.length > 0,
    voiceCount: voices.length,
    profiles: VOICE_PROFILES,
    deliveryIsDefault: isDefaultDelivery(delivery),
    defaults: DEFAULT_DELIVERY,
    choose,
    setDelivery,
    resetDelivery,
    resolveById,
    deviceVoiceName,
    preview,
  };
}
