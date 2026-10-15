import { api } from "@/convex/_generated/api";
import { useReminders, type Reminder } from "@/hooks/use-reminders";
import { useSettings } from "@/hooks/use-settings";
import { useSpeechSynthesis } from "@/hooks/use-speech";
import { useStudioVoice } from "@/hooks/use-studio-voice";
import { useVoice } from "@/hooks/use-voice";
import { sendNotification } from "@/lib/assistant-actions";
import { pushNote } from "@/lib/companion/notes";
import { useAction } from "convex/react";
import { useCallback, useRef } from "react";

/**
 * The assistant speaks up on its own only for a real alert — a timer that has
 * finished or a reminder that has come due. Silence is never a reason to talk.
 *
 * Wherever the app is open, the alert itself always sounds. It is said out loud
 * in the assistant's own voice when it is allowed to speak up and the house is
 * not quiet; otherwise it rings plainly, so a timer is never swallowed. If the
 * model cannot be reached, the plain alert is used instead.
 */
export function useAssistantNudge() {
  const nudge = useAction(api.ai_turn.nudge);

  const { values } = useSettings();
  const { resolved } = useVoice();
  const quietHeld = values.do_not_disturb ?? false;
  // The Control Room switch for unprompted lines. Off means it only answers.
  const speakUp = values.assistant_speak_up ?? true;

  // The same studio voice the assistant answers in, so a timer going off and a
  // question answered are the same woman speaking.
  const studio = useStudioVoice();

  const { speak } = useSpeechSynthesis({
    enabled: !(values.silence ?? false),
    resolved,
    studio,
  });

  // A line already in flight must not be asked for twice at once.
  const running = useRef(false);

  const onDue = useCallback(
    (reminder: Reminder) => {
      const title = reminder.kind === "timer" ? "Timer finished" : "Reminder";
      const ring = () => {
        speak(`${title}. ${reminder.text}`);
        void sendNotification(title, reminder.text);
      };

      // The little box in the corner is told as well, and told from what the hub
      // already knows rather than from a model — so an alert reaches it even
      // when no key is set and nothing behind the hub answers. The words it
      // says out loud are the model's own, a moment later.
      pushNote({ kind: "alert", text: `${title}: ${reminder.text}` });

      // The alarm always sounds; only the words change.
      if (quietHeld || !speakUp || running.current) {
        ring();
        return;
      }

      running.current = true;
      void nudge({ kind: reminder.kind, text: reminder.text })
        .then((result) => {
          if (!result.ok) {
            ring();
            return;
          }
          speak(result.say);
          void sendNotification("Your assistant", result.say);
        })
        .catch(ring)
        .finally(() => {
          running.current = false;
        });
    },
    [nudge, quietHeld, speak, speakUp],
  );

  // Watching the clock is the job of `useReminders`; this only decides how the
  // alert is voiced. It marks the alert done as soon as it comes due, wherever
  // in the hub you happen to be.
  useReminders({ onDue });
}
