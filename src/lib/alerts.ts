/**
 * The alert channels a phone would have — sound, vibration and notifications —
 * gated by the Control Room switches. The switches are written into this gate
 * once, and every alert in the app asks the gate before it fires.
 */

type Gate = {
  /** Mute all sound, including the assistant's voice. */
  silent: boolean;
  /** Hold every alert. */
  dnd: boolean;
  vibrate: boolean;
  tone: boolean;
  notifications: boolean;
  /** Include the message text in a notification. */
  preview: boolean;
};

let gate: Gate = {
  silent: false,
  dnd: false,
  vibrate: true,
  tone: true,
  notifications: true,
  preview: true,
};

export function setAlertGate(next: Partial<Gate>) {
  gate = { ...gate, ...next };
}

/** True while no alert at all should be shown. */
export function alertsMuted() {
  return gate.silent || gate.dnd;
}

export function notificationAllowed() {
  return !alertsMuted() && gate.notifications;
}

function vibrationAllowed() {
  return !alertsMuted() && gate.vibrate;
}

function toneAllowed() {
  return !alertsMuted() && gate.tone;
}

/** Buzz the device, if the settings allow it and the device can. */
export function buzz(milliseconds = 200) {
  if (!vibrationAllowed()) return;
  try {
    navigator.vibrate?.(milliseconds);
  } catch {
    // Vibration is unsupported or blocked; there is nothing to do about it.
  }
}

let audio: AudioContext | null = null;

/** A short, pleasant two-note chime for a new message. */
export function chime() {
  if (!toneAllowed()) return;
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return;

    audio ??= new Ctor();
    if (audio.state === "suspended") void audio.resume();

    const now = audio.currentTime;
    const gain = audio.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.12, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.32);
    gain.connect(audio.destination);

    for (const [index, frequency] of [880, 1318.5].entries()) {
      const osc = audio.createOscillator();
      osc.type = "sine";
      osc.frequency.value = frequency;
      osc.connect(gain);
      const start = now + index * 0.08;
      osc.start(start);
      osc.stop(start + 0.3);
    }
  } catch {
    // Audio stays locked until the person has interacted with the page once.
  }
}

/**
 * Raise a system notification for a new message, respecting Silence, Do Not
 * Disturb and the preview switch.
 */
export async function notifyMessage(title: string, body: string) {
  if (!notificationAllowed()) return;
  if (typeof window === "undefined" || !("Notification" in window)) return;

  try {
    if (Notification.permission === "default") {
      await Notification.requestPermission();
    }
    if (Notification.permission !== "granted") return;
    new Notification(title, {
      body: gate.preview ? body : "New message",
      silent: true,
    });
  } catch {
    // The notification could not be shown; the in-app alert still happened.
  }
}

/**
 * Raise a system notification for an incoming call. The caller's name is always
 * shown — a call is not something to hide behind the preview switch, because
 * you have to decide right now whether to pick it up.
 */
export async function notifyCall(title: string, body: string) {
  if (!notificationAllowed()) return;
  if (typeof window === "undefined" || !("Notification" in window)) return;

  try {
    if (Notification.permission === "default") {
      await Notification.requestPermission();
    }
    if (Notification.permission !== "granted") return;
    new Notification(title, { body, silent: true });
  } catch {
    // The notification could not be shown; the ringing in the app still plays.
  }
}

/**
 * A phone ring for an incoming call. Returns the function that stops it — call
 * it the moment the call is answered, declined or gone. While the switches are
 * set to hold alerts this is silent and returns a no-op.
 */
export function ringtone(): () => void {
  if (!toneAllowed()) return () => undefined;

  let stopped = false;

  const ringOnce = () => {
    if (stopped) return;
    try {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctor) return;

      audio ??= new Ctor();
      if (audio.state === "suspended") void audio.resume();

      const now = audio.currentTime;
      const gain = audio.createGain();
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.16, now + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);
      gain.connect(audio.destination);

      // Two quick notes, over and over, so it reads as a ring and not a chime.
      for (const [index, frequency] of [659.25, 880].entries()) {
        const osc = audio.createOscillator();
        osc.type = "sine";
        osc.frequency.value = frequency;
        osc.connect(gain);
        const start = now + index * 0.24;
        osc.start(start);
        osc.stop(start + 0.42);
      }
    } catch {
      // Audio stays locked until the person has touched the page once.
    }
  };

  ringOnce();
  // A gentle buzz with each ring, where the device can do it.
  buzz(450);
  const timer = window.setInterval(() => {
    ringOnce();
    buzz(450);
  }, 2200);

  return () => {
    stopped = true;
    window.clearInterval(timer);
  };
}
