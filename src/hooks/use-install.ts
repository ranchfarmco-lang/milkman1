import {
  detectDevice,
  guidesFor,
  isStandalone,
  type DeviceInfo,
  type InstallGuide,
} from "@/lib/pwa";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

/** Chrome's install prompt, which is not in the TypeScript DOM lib yet. */
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export type InstallOutcome = { ok: boolean; message: string };

/**
 * Whether this browser is willing to install the hub, and what to do when it is
 * not. Chrome and Edge announce themselves with `beforeinstallprompt`; Safari
 * never does, which is why the guides exist alongside the button.
 */
/**
 * The display mode is a media query, so it can say when it changes — which is
 * what flips the row to "installed" without needing a reload.
 */
function subscribeDisplayMode(onChange: () => void) {
  const query = window.matchMedia("(display-mode: standalone)");
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

export function useInstall() {
  const [prompt, setPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [busy, setBusy] = useState(false);
  const info: DeviceInfo = useMemo(() => detectDevice(), []);
  // The browser's own "it installed" event, which can arrive before the display
  // mode has finished changing.
  const [announced, setAnnounced] = useState(false);

  // Read from the browser rather than copied into state by an effect: the
  // display mode already is the answer, and a copy would render twice on every
  // mount to say what the browser could have said straight away.
  const standalone = useSyncExternalStore(
    subscribeDisplayMode,
    isStandalone,
    () => false,
  );
  const installed = standalone || announced;

  useEffect(() => {
    const onPrompt = (event: Event) => {
      // Without this Chrome shows its own mini-infobar instead of our button.
      event.preventDefault();
      setPrompt(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setAnnounced(true);
      setPrompt(null);
    };

    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);

    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const install = useCallback(async (): Promise<InstallOutcome> => {
    if (!prompt) {
      return {
        ok: false,
        message: "This browser installs from its own menu — the steps are below.",
      };
    }

    setBusy(true);
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      // A prompt can only be answered once, so it never gets reused.
      setPrompt(null);
      return choice.outcome === "accepted"
        ? { ok: true, message: "Installing — it will appear with your other apps." }
        : { ok: false, message: "Cancelled. You can install it another time." };
    } catch {
      return { ok: false, message: "The browser refused to install it." };
    } finally {
      setBusy(false);
    }
  }, [prompt]);

  const guides: InstallGuide[] = useMemo(() => guidesFor(info), [info]);

  /** The best guide for the device in front of the person. */
  const ownGuide = guides[0];

  return {
    info,
    guides,
    ownGuide,
    /** The browser offered a one-tap install. */
    canInstall: prompt !== null,
    /** The hub is already running as an installed app. */
    installed,
    busy,
    install,
  };
}
