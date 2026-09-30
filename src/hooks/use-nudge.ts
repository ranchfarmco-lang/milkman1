import { api } from "@/convex/_generated/api";
import { useSettings } from "@/hooks/use-settings";
import { useSpeechSynthesis } from "@/hooks/use-speech";
import { useVoice } from "@/hooks/use-voice";
import { sendNotification } from "@/lib/assistant-actions";
import { useAction, useQuery } from "convex/react";
import { useEffect, useRef } from "react";

/**
 * How long the silence must last before each unprompted line, in order. One per
 * silence, and the gaps stretch out, so a living assistant never turns into a
 * nag. Do Not Disturb switches the whole thing off.
 */
const GAPS_MS = [4 * 60_000, 15 * 60_000, 40 * 60_000];

/** How often the silence is measured. */
const CHECK_MS = 20_000;

/**
 * Lets the assistant speak first — a little put out, a little fond — after the
 * person has gone quiet for a while. It runs wherever the app is open, and the
 * line is said out loud and shown as a notification unless sound is off.
 */
export function useAssistantNudge() {
  const rows = useQuery(api.messages.list, { room: "assistant" });
  const nudge = useAction(api.ai_turn.nudge);

  const { values } = useSettings();
  const { resolved } = useVoice();
  const quietHeld = values.do_not_disturb ?? false;
  // The Control Room switch for unprompted lines. Off means it only answers.
  const speakUp = values.assistant_speak_up ?? true;

  const { speak } = useSpeechSynthesis({
    enabled: !(values.silence ?? false),
    resolved,
  });

  // A nudge already in flight must not be asked for twice.
  const running = useRef(false);

  useEffect(() => {
    if (quietHeld || !speakUp) return;

    const timer = window.setInterval(() => {
      if (running.current || !rows || rows.length === 0) return;

      const lastUser = [...rows]
        .reverse()
        .find((row) => row.role === "user");
      if (!lastUser) return;

      // Replies beyond the first one to this message were spoken unprompted.
      const since = rows.filter(
        (row) => row.role === "assistant" && row.createdAt >= lastUser.createdAt,
      ).length;
      const alreadySpoken = Math.max(0, since - 1);
      if (alreadySpoken >= GAPS_MS.length) return;

      if (Date.now() - lastUser.createdAt < GAPS_MS[alreadySpoken]) return;

      running.current = true;
      void nudge({})
        .then((result) => {
          if (!result.ok) return;
          speak(result.say);
          void sendNotification("Your assistant", result.say);
        })
        .catch(() => {
          // A line that does not arrive is not worth telling anyone about.
        })
        .finally(() => {
          running.current = false;
        });
    }, CHECK_MS);

    return () => window.clearInterval(timer);
  }, [nudge, quietHeld, rows, speak, speakUp]);
}
