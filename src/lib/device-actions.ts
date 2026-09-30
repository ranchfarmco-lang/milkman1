/**
 * The things this page can genuinely do to the device.
 * Everything here is a real browser API — nothing fakes a result.
 */

export type ActionResult = { ok: boolean; message: string };

type ConnectionLike = {
  effectiveType?: string;
  type?: string;
  downlink?: number;
};

type WakeLockSentinelLike = { release: () => Promise<void> };
type WakeLockLike = {
  request: (type: "screen") => Promise<WakeLockSentinelLike>;
};

export function connectionApi() {
  return (navigator as Navigator & { connection?: ConnectionLike }).connection;
}

export function wakeLockApi() {
  return (navigator as Navigator & { wakeLock?: WakeLockLike }).wakeLock;
}

/** Turn a browser error into something a person can act on. */
export function describeError(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "You blocked it. You can allow it again in your browser's site settings.";
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "There is no device available for this.";
    case "NotReadableError":
      return "Something else is already using it.";
    case "NotSupportedError":
      return "This browser does not support it.";
    default:
      return error instanceof Error && error.message
        ? error.message
        : "That did not work.";
  }
}

export async function allowCamera(): Promise<ActionResult> {
  if (!navigator.mediaDevices?.getUserMedia) {
    return { ok: false, message: "This browser has no camera access." };
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    for (const track of stream.getTracks()) track.stop();
    return { ok: true, message: "Camera allowed." };
  } catch (error) {
    return { ok: false, message: describeError(error) };
  }
}

export async function allowMicrophone(): Promise<ActionResult> {
  if (!navigator.mediaDevices?.getUserMedia) {
    return { ok: false, message: "This browser has no microphone access." };
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    return { ok: true, message: "Microphone allowed." };
  } catch (error) {
    return { ok: false, message: describeError(error) };
  }
}

export async function allowNotifications(): Promise<ActionResult> {
  if (typeof window === "undefined" || !("Notification" in window)) {
    return { ok: false, message: "This browser has no notifications." };
  }
  try {
    const result =
      Notification.permission === "granted"
        ? "granted"
        : await Notification.requestPermission();
    return result === "granted"
      ? { ok: true, message: "Notifications allowed." }
      : { ok: false, message: "Notifications stay blocked." };
  } catch (error) {
    return { ok: false, message: describeError(error) };
  }
}

export async function allowClipboard(): Promise<ActionResult> {
  if (!navigator.clipboard?.readText) {
    return { ok: false, message: "This browser has no clipboard access." };
  }
  try {
    await navigator.clipboard.readText();
    return { ok: true, message: "Clipboard allowed." };
  } catch (error) {
    return { ok: false, message: describeError(error) };
  }
}

export async function setFullscreen(on: boolean): Promise<ActionResult> {
  try {
    if (on && !document.fullscreenElement) {
      await document.documentElement.requestFullscreen();
      return { ok: true, message: "Fullscreen on." };
    }
    if (!on && document.fullscreenElement) {
      await document.exitFullscreen();
      return { ok: true, message: "Fullscreen off." };
    }
    return { ok: true, message: on ? "Already fullscreen." : "Already out." };
  } catch (error) {
    return { ok: false, message: describeError(error) };
  }
}

type OrientationLike = {
  lock?: (orientation: string) => Promise<void>;
  unlock?: () => void;
};

function orientationApi(): OrientationLike | undefined {
  if (typeof screen === "undefined") return undefined;
  return (screen as unknown as { orientation?: OrientationLike }).orientation;
}

/**
 * A page can never turn the screen itself — it can only ask to be *held* to one
 * orientation, and the browser only honours that while the app is fullscreen.
 * So "allow" hands the screen back to the device, and switching it off asks for
 * portrait. Every failure says why, rather than pretending it worked.
 */
export async function setScreenRotation(allow: boolean): Promise<ActionResult> {
  const orientation = orientationApi();

  if (!orientation) {
    return {
      ok: false,
      message: "This browser cannot see the screen's orientation.",
    };
  }

  if (allow) {
    try {
      orientation.unlock?.();
    } catch {
      // Nothing was holding it anyway.
    }
    return { ok: true, message: "The screen follows the device." };
  }

  if (!orientation.lock) {
    return {
      ok: false,
      message:
        "This browser cannot hold an orientation — Safari on iPhone does not allow it.",
    };
  }

  try {
    await orientation.lock("portrait");
    return { ok: true, message: "Held upright in portrait." };
  } catch {
    return {
      ok: false,
      message: document.fullscreenElement
        ? "This device will not hold an orientation."
        : "Needs fullscreen — switch Fullscreen on, then try again.",
    };
  }
}

let screenLock: WakeLockSentinelLike | null = null;

export async function setWakeLock(on: boolean): Promise<ActionResult> {
  const wakeLock = wakeLockApi();
  if (!wakeLock) {
    return { ok: false, message: "This browser cannot hold the screen awake." };
  }
  try {
    if (on) {
      // The lock is dropped whenever the tab is hidden, so ask again on return.
      screenLock = await wakeLock.request("screen");
      return { ok: true, message: "The screen will stay awake." };
    }
    await screenLock?.release();
    screenLock = null;
    return { ok: true, message: "The screen can sleep again." };
  } catch (error) {
    return { ok: false, message: describeError(error) };
  }
}

/**
 * Open the system file picker. The page only ever sees the file the person
 * chooses — which is exactly why it cannot browse the library on its own.
 */
export function pickFile(): Promise<ActionResult> {
  return new Promise<ActionResult>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.style.display = "none";

    input.addEventListener("change", () => {
      const file = input.files?.[0];
      input.remove();
      resolve(
        file
          ? { ok: true, message: `Chose ${file.name}.` }
          : { ok: false, message: "No file was chosen." },
      );
    });

    // A cancelled picker fires no event in most browsers; clean up on blur.
    window.addEventListener(
      "focus",
      () => window.setTimeout(() => input.remove(), 500),
      { once: true },
    );

    document.body.appendChild(input);
    input.click();
  });
}
