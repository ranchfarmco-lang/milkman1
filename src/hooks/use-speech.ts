import { planUtterances, type ResolvedVoice } from "@/lib/voices";
import { createClipPlayer } from "@/lib/voice-studio";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The studio voice, as this hook needs it.
 *
 * Structural rather than imported from the hook that provides it, so the
 * speaker has no opinion about where the clips come from: anything that can cut
 * a reply up and turn one piece into audio can be handed over.
 */
export type StudioSpeaker = {
  ready: boolean;
  chunks: (text: string) => string[];
  speakClip: (text: string) => Promise<{
    ok: boolean;
    audio?: string;
    mimeType?: string;
  }>;
  setSpeaking?: (on: boolean) => void;
};

function recognitionCtor() {
  if (typeof window === "undefined") return null;
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

/**
 * How long the room must be quiet before a spoken sentence is treated as
 * finished and sent. The browser marks a result "final" at the first little
 * pause, so trusting that alone means the assistant answers a half-thought.
 *
 * Long questions come with pauses for thought in the middle, so this is
 * deliberately a couple of seconds: the assistant keeps listening through a
 * breath and only answers once the room has been quiet for two seconds.
 */
const SILENCE_MS = 2_000;

/** A beat of quiet before the microphone is reopened, so the tail of the
 *  assistant's own voice has time to die away first. */
const RESTART_MS = 350;

/**
 * Talking: reads the assistant's replies out loud. `enabled` is the Control
 * Room's Silence switch — while it is off, nothing is spoken at all.
 * `resolved` is the chosen one of the eight voices, already resolved against
 * this device: which voice, how fast, how low, how loud, and how much she moves
 * inside a reply. `expressiveness` overrides that last number where a caller
 * wants a flat read — the sample lines do not, so what is heard there is what
 * will be heard later.
 *
 * A reply is not read as one long utterance. It is handed to the same planner
 * the Control Room's sliders describe (`planUtterances`), which breaks it into
 * the pieces she says in one breath and gives each one its own small movement —
 * the lift on a question, the quicker step on a joke, the drop before something
 * serious. The pieces are spoken in order, and `speaking` stays true across the
 * whole run rather than flickering between sentences, because the microphone's
 * mute depends on it and a flicker there is how the assistant hears itself.
 *
 * `studio` is the other engine, and it is tried first when it is ready: the
 * words go to a speech model and what comes back is a clip, played through an
 * `Audio` element. It is an upgrade, never a dependency — if a clip fails, the
 * rest of the reply is handed to the device engine in the same run, so a reply
 * is always read by something, and never twice.
 */
export function useSpeechSynthesis({
  enabled = true,
  resolved,
  studio,
}: {
  enabled?: boolean;
  resolved?: ResolvedVoice;
  studio?: StudioSpeaker;
} = {}) {
  const [speaking, setSpeaking] = useState(false);
  /** One clip player per hook, because two would fight over the audio. */
  const player = useRef<ReturnType<typeof createClipPlayer> | null>(null);
  if (player.current === null) player.current = createClipPlayer();
  // Read through a ref, like the voice itself: the studio object is rebuilt
  // whenever the queries behind it move.
  const studioRef = useRef(studio);
  useEffect(() => {
    studioRef.current = studio;
  }, [studio]);
  const supported =
    typeof window !== "undefined" && "speechSynthesis" in window;
  const enabledRef = useRef(enabled);
  const voiceRef = useRef(resolved);
  /** Bumped by `stop` and by a new reply, so an old run cannot keep talking. */
  const runRef = useRef(0);

  useEffect(() => {
    voiceRef.current = resolved;
  }, [resolved]);

  useEffect(() => {
    enabledRef.current = enabled;
    if (!enabled && supported) {
      runRef.current += 1;
      window.speechSynthesis.cancel();
      setSpeaking(false);
    }
  }, [enabled, supported]);

  const stop = useCallback(() => {
    runRef.current += 1;
    player.current?.stop();
    studioRef.current?.setSpeaking?.(false);
    if (supported) window.speechSynthesis.cancel();
    setSpeaking(false);
  }, [supported]);

  const speakDevice = useCallback(
    (text: string) => {
      const clean = text.trim();
      if (!supported || !enabledRef.current || !clean) return;

      const chosen = voiceRef.current;
      const base = {
        rate: chosen?.rate ?? 0.97,
        pitch: chosen?.pitch ?? 0.95,
        volume: chosen?.volume ?? 1,
      };
      const plan = planUtterances(
        clean,
        base,
        chosen?.delivery?.expressiveness ?? 0.45,
      );
      if (!plan.length) return;

      const run = runRef.current + 1;
      runRef.current = run;

      window.speechSynthesis.cancel();
      // Mark speaking true right away rather than waiting for `onstart`, which
      // only fires a moment later. In that gap the microphone would otherwise
      // still be open and could pick up the first word of the reply, hear it as
      // the person, and answer it — a loop where the assistant talks to itself.
      setSpeaking(true);

      // Chromium stops reading after about fifteen seconds unless it is nudged,
      // and the nudge is the platform's own: while she is talking, tell the
      // engine to carry on from a pause it never took. A no-op elsewhere.
      let ticker: number | null = window.setInterval(() => {
        if (window.speechSynthesis.speaking) window.speechSynthesis.resume();
      }, 8_000);

      const finish = () => {
        if (ticker !== null) {
          window.clearInterval(ticker);
          ticker = null;
        }
        setSpeaking(false);
      };

      let index = 0;
      const next = () => {
        // A stop, a new reply, or the switch going off ends the run here rather
        // than leaving the rest of a discarded answer queued up to speak.
        if (runRef.current !== run || !enabledRef.current) {
          finish();
          return;
        }
        if (index >= plan.length) {
          finish();
          return;
        }

        const piece = plan[index];
        index += 1;
        const utterance = new SpeechSynthesisUtterance(piece.text);
        if (chosen?.voice) utterance.voice = chosen.voice;
        utterance.rate = piece.rate;
        utterance.pitch = piece.pitch;
        utterance.volume = piece.volume;
        utterance.onend = next;
        // An error on one piece ends the run rather than skipping to the next:
        // a run that keeps going through errors ends up reading a reply in the
        // wrong voice, which is worse than stopping.
        utterance.onerror = finish;
        window.speechSynthesis.speak(utterance);
      };

      // A beat between cancelling and speaking. Several engines drop the first
      // utterance sent immediately after a cancel, which reads as the first
      // sentence going missing — and it is the sentence with her name in it.
      window.setTimeout(next, 90);
    },
    [supported],
  );

  /**
   * The studio voice: a model speaks, this device plays what comes back.
   *
   * One clip at a time, in order, and the microphone stays shut for the whole
   * run. The moment a clip fails — no key, no connection, a rate limit, the
   * deployment itself down — the pieces that are left are read by the device's
   * own engine instead, in the same run and without repeating what was already
   * said. A reply is never dropped for want of an upgrade.
   */
  const speakStudio = useCallback(
    async (text: string, speaker: StudioSpeaker) => {
      const run = runRef.current + 1;
      runRef.current = run;

      window.speechSynthesis.cancel();
      setSpeaking(true);
      speaker.setSpeaking?.(true);

      const pieces = speaker.chunks(text);
      let spoke = 0;

      try {
        for (const piece of pieces) {
          if (runRef.current !== run || !enabledRef.current) return;

          const clip = await speaker.speakClip(piece);
          if (runRef.current !== run || !enabledRef.current) return;

          if (!clip.ok || !clip.audio) {
            const left = pieces.slice(spoke).join(" ");
            if (left.trim()) speakDeviceRef.current(left);
            return;
          }

          // The sliders that a recording can honour are passed on here, so
          // changing the volume or the pace in the Control Room changes what is
          // heard whichever engine is speaking.
          const clipPlayer = player.current;
          const ended = clipPlayer
            ? await clipPlayer.play(clip.audio, clip.mimeType ?? "audio/mpeg", {
                volume: voiceRef.current?.volume ?? 1,
                rate: voiceRef.current?.rate ?? 1,
              })
            : "failed";
          spoke += 1;
          if (ended !== "ended") return;
        }
      } finally {
        // Whichever way it ended — finished, stopped, or handed over to the
        // device engine — the microphone is given back exactly once.
        if (runRef.current === run) {
          speaker.setSpeaking?.(false);
          setSpeaking(false);
        }
      }
    },
    [speakDevice],
  );

  // The device engine is reached through a ref by the studio run, so the two
  // callbacks do not have to be declared in the order they call each other.
  const speakDeviceRef = useRef(speakDevice);
  useEffect(() => {
    speakDeviceRef.current = speakDevice;
  }, [speakDevice]);

  /**
   * Say it: the studio voice when it is ready, this device's own voice when it
   * is not. The choice is made once per reply rather than per sentence, so a
   * single answer never changes voice halfway through.
   */
  const speak = useCallback(
    (text: string) => {
      const clean = text.trim();
      if (!enabledRef.current || !clean) return;

      const speaker = studioRef.current;
      if (speaker?.ready) {
        void speakStudio(clean, speaker);
        return;
      }
      speakDevice(clean);
    },
    [speakDevice, speakStudio],
  );

  useEffect(
    () => () => {
      runRef.current += 1;
      player.current?.stop();
      if (supported) window.speechSynthesis.cancel();
    },
    [supported],
  );

  return { speak, stop, speaking, supported };
}

/**
 * Listening: keeps the microphone open while `active` is true and hands back
 * each finished sentence. `muted` pauses it — used while the assistant is
 * talking or working, so it never transcribes its own voice.
 *
 * A sentence is considered finished only after `SILENCE_MS` of quiet, not at
 * the browser's first "final" marker, so pausing to think never costs you the
 * rest of your sentence.
 */
export function useDictation({
  active,
  muted,
  onFinal,
}: {
  active: boolean;
  muted: boolean;
  onFinal: (text: string) => void;
}) {
  const [supported] = useState(() => recognitionCtor() !== null);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const activeRef = useRef(active);
  const mutedRef = useRef(muted);
  const onFinalRef = useRef(onFinal);

  // Words already finalised by the browser in this utterance, waiting for the
  // silence window to close before they are sent.
  const pendingRef = useRef("");
  const interimRef = useRef("");
  const timerRef = useRef<number | null>(null);
  const startingRef = useRef(false);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    onFinalRef.current = onFinal;
  }, [onFinal]);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const clearPending = useCallback(() => {
    pendingRef.current = "";
    interimRef.current = "";
    setInterim("");
  }, []);

  /** Send whatever has been heard, once, and start the next utterance fresh. */
  const commit = useCallback(() => {
    const text = `${pendingRef.current} ${interimRef.current}`
      .replace(/\s+/g, " ")
      .trim();
    clearPending();
    if (text.length > 1) onFinalRef.current(text);
  }, [clearPending]);

  /** Restart the silence countdown on every scrap of speech. */
  const armSilence = useCallback(() => {
    clearTimer();
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      commit();
    }, SILENCE_MS);
  }, [clearTimer, commit]);

  /** Open the microphone if it is not already on its way up. */
  const ensureRunning = useCallback(() => {
    const recognition = recognitionRef.current;
    if (!recognition || startingRef.current) return;
    try {
      startingRef.current = true;
      recognition.start();
    } catch {
      // Already running — the next result will come through.
      startingRef.current = false;
    }
  }, []);

  // Build one recogniser and keep it alive for the life of the page.
  useEffect(() => {
    const Ctor = recognitionCtor();
    if (!Ctor) return;

    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || "en-US";
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      startingRef.current = false;
      setListening(true);
    };

    recognition.onresult = (event) => {
      // While the assistant is talking or thinking the microphone is meant to
      // be shut; a buffered result arriving late must not become a new message.
      if (mutedRef.current) return;

      let finalText = "";
      let interimText = "";

      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const transcript = result[0]?.transcript ?? "";
        if (result.isFinal) finalText += transcript;
        else interimText += transcript;
      }

      if (finalText.trim()) {
        pendingRef.current = `${pendingRef.current} ${finalText}`
          .replace(/\s+/g, " ")
          .trim();
      }
      interimRef.current = interimText.trim();
      setInterim(interimRef.current);

      // Any speech at all — final or still settling — restarts the quiet clock.
      armSilence();
    };

    recognition.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        setError("Microphone access is blocked in this browser.");
      } else if (event.error === "audio-capture") {
        setError("No microphone was found.");
      }
    };

    recognition.onend = () => {
      setListening(false);
      startingRef.current = false;
      // Speech recognition stops after each pause; keep it going while the
      // person still has hands-free switched on, after a short breath.
      if (activeRef.current && !mutedRef.current) {
        window.setTimeout(() => {
          if (activeRef.current && !mutedRef.current) ensureRunning();
        }, RESTART_MS);
      }
    };

    recognitionRef.current = recognition;

    return () => {
      activeRef.current = false;
      recognitionRef.current = null;
      try {
        recognition.abort();
      } catch {
        // Nothing to clean up.
      }
    };
  }, [armSilence, ensureRunning]);

  useEffect(() => {
    mutedRef.current = muted;
    const recognition = recognitionRef.current;
    if (!recognition) return;

    if (active && !muted) {
      setError(null);
      ensureRunning();
    } else {
      // Drop anything half-heard and shut the microphone hard. `abort` throws
      // away buffered audio; `stop` would finish delivering it, and that is how
      // the assistant's own voice gets mistaken for the person's.
      clearTimer();
      clearPending();
      try {
        recognition.abort();
      } catch {
        // Already stopped.
      }
      startingRef.current = false;
      setListening(false);
    }
  }, [active, muted, clearPending, clearTimer, ensureRunning]);

  return { supported, listening, interim, error, clearError: () => setError(null) };
}
