import { useSettings } from "@/hooks/use-settings";
import { setAlertGate } from "@/lib/alerts";
import {
  setFullscreen,
  setScreenRotation,
  setWakeLock,
} from "@/lib/device-actions";
import { useEffect } from "react";

/**
 * Applies the Control Room switches everywhere, not just on the Control Room
 * page. Runs once inside the signed-in shell so a reload is enough to bring
 * the device back to how the person left it.
 */
export function useDeviceEffects() {
  const { values, isReady } = useSettings();

  const silent = values.silence ?? false;
  const dnd = values.do_not_disturb ?? false;
  const vibrate = values.vibrate_messages ?? true;
  const tone = values.alert_tone ?? true;
  const notifications = values.notify_messages ?? true;
  const preview = values.notification_preview ?? true;
  const keepAwake = values.keep_screen_awake ?? false;
  const fullscreen = values.fullscreen ?? false;
  const allowRotation = values.screen_rotation ?? true;

  // Every alert in the app reads this gate before it fires.
  useEffect(() => {
    if (!isReady) return;
    setAlertGate({
      silent,
      dnd,
      vibrate,
      tone,
      notifications,
      preview,
    });
  }, [dnd, isReady, notifications, preview, silent, tone, vibrate]);

  // Silence stops anything already being read out.
  useEffect(() => {
    if (isReady && silent && typeof window !== "undefined") {
      window.speechSynthesis?.cancel();
    }
  }, [isReady, silent]);

  // Hold the screen awake exactly while the switch is on.
  useEffect(() => {
    if (!isReady) return;
    void setWakeLock(keepAwake);
  }, [isReady, keepAwake]);

  // Fullscreen can only be entered from a tap, so this only ever leaves it.
  useEffect(() => {
    if (!isReady) return;
    if (!fullscreen) void setFullscreen(false);
  }, [isReady, fullscreen]);

  // Rotation never belongs to the page, so this only ever hands the screen back
  // or asks to be held upright. It re-runs when fullscreen changes because
  // holding an orientation is only allowed while the app is filling the screen.
  useEffect(() => {
    if (!isReady) return;
    void setScreenRotation(allowRotation);
  }, [allowRotation, fullscreen, isReady]);
}
