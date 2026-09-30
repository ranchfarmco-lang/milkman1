import { api } from "@/convex/_generated/api";
import {
  DEFAULT_VOICE_ID,
  describeVoice,
  profileById,
  resolveVoice,
  VOICE_PROFILES,
  type ResolvedVoice,
  type VoiceProfile,
} from "@/lib/voices";
import { useMutation, useQuery } from "convex/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** What the preview says — short, and enough to tell two voices apart. */
const SAMPLE = "Hi, this is how I will sound when I talk to you.";

/**
 * The voice the AI speaks with.
 *
 * The list of voices comes from the device, and it arrives asynchronously — in
 * some browsers it is empty until `voiceschanged` fires. Until it lands, the
 * profile still resolves, just without a specific voice behind it.
 */
export function useVoice() {
  const stored = useQuery(api.voice.mine);
  const setVoice = useMutation(api.voice.set);

  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);

  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;

    const load = () => {
      const list = window.speechSynthesis.getVoices();
      if (list.length) setVoices(list);
    };

    load();
    window.speechSynthesis.addEventListener("voiceschanged", load);
    return () =>
      window.speechSynthesis.removeEventListener("voiceschanged", load);
  }, []);

  const id = stored ?? DEFAULT_VOICE_ID;
  const profile: VoiceProfile = useMemo(() => profileById(id), [id]);
  const resolved: ResolvedVoice = useMemo(
    () => resolveVoice(profile, voices),
    [profile, voices],
  );

  const choose = useCallback(
    (next: string) => {
      void setVoice({ id: next });
    },
    [setVoice],
  );

  // The voice list arrives late, so read it through a ref when previewing. It
  // is mirrored in an effect rather than written during render: a render can be
  // discarded or replayed, and a ref written on the way past would then be
  // holding the value of a render that never happened.
  const voicesRef = useRef(voices);
  useEffect(() => {
    voicesRef.current = voices;
  }, [voices]);

  /** The real device voice behind a profile, without changing the choice. */
  const deviceVoiceName = useCallback(
    (profileId: string) =>
      describeVoice(resolveVoice(profileById(profileId), voicesRef.current)),
    [],
  );

  /** Say a line in a voice, so it can be judged before it is chosen. */
  const preview = useCallback((profileId: string) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;

    const resolvedSample = resolveVoice(
      profileById(profileId),
      voicesRef.current,
    );

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(SAMPLE);
    if (resolvedSample.voice) utterance.voice = resolvedSample.voice;
    utterance.rate = resolvedSample.rate;
    utterance.pitch = resolvedSample.pitch;
    window.speechSynthesis.speak(utterance);
  }, []);

  return {
    id,
    profile,
    resolved,
    profiles: VOICE_PROFILES,
    choose,
    deviceVoiceName,
    preview,
    /** True wherever the browser has a speech engine; the voice list may lag. */
    engineReady:
      typeof window !== "undefined" && "speechSynthesis" in window,
    voiceCount: voices.length,
  };
}
