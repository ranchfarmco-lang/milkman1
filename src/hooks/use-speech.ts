import type { ResolvedVoice } from "@/lib/voices";
import { useCallback, useEffect, useRef, useState } from "react";

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
 * `resolved` is the chosen one of the eight voices, and the device voice it
 * landed on.
 */
export function useSpeechSynthesis({
  enabled = true,
  resolved,
}: {
  enabled?: boolean;
  resolved?: ResolvedVoice;
} = {}) {
  const [speaking, setSpeaking] = useState(false);
  const supported =
    typeof window !== "undefined" && "speechSynthesis" in window;
  const enabledRef = useRef(enabled);
  const voiceRef = useRef(resolved);

  useEffect(() => {
    voiceRef.current = resolved;
  }, [resolved]);

  useEffect(() => {
    enabledRef.current = enabled;
    if (!enabled && supported) {
      window.speechSynthesis.cancel();
      setSpeaking(false);
    }
  }, [enabled, supported]);

  const stop = useCallback(() => {
    if (!supported) return;
    window.speechSynthesis.cancel();
    setSpeaking(false);
  }, [supported]);

  const speak = useCallback(
    (text: string) => {
      const clean = text.trim();
      if (!supported || !enabledRef.current || !clean) return;

      window.speechSynthesis.cancel();
      // Mark speaking true right away rather than waiting for `onstart`, which
      // only fires a moment later. In that gap the microphone would otherwise
      // still be open and could pick up the first word of the reply, hear it as
      // the person, and answer it — a loop where the assistant talks to itself.
      setSpeaking(true);
      const utterance = new SpeechSynthesisUtterance(clean);
      const chosen = voiceRef.current;
      if (chosen?.voice) utterance.voice = chosen.voice;
      utterance.rate = chosen?.rate ?? 1.03;
      utterance.pitch = chosen?.pitch ?? 1;
      utterance.onstart = () => setSpeaking(true);
      utterance.onend = () => setSpeaking(false);
      utterance.onerror = () => setSpeaking(false);
      window.speechSynthesis.speak(utterance);
    },
    [supported],
  );

  useEffect(
    () => () => {
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
