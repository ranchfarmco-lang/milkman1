import { api } from "@/convex/_generated/api";
import { useMutation } from "convex/react";
import { useEffect } from "react";

/**
 * The server treats a member as offline once their heartbeat is older than two
 * minutes (`family.purgeOffline`), so a minute is often enough to keep someone
 * shown as around, and it is a third of the function calls the old 20-second
 * beat made. Coming back into focus always sends one straight away.
 */
const HEARTBEAT_MS = 60_000;

/**
 * Keeps this browser marked as online for as long as the app is open, so the
 * family box can show who is around right now.
 */
export function usePresence() {
  const heartbeat = useMutation(api.family.heartbeat);

  useEffect(() => {
    let stopped = false;

    const beat = () => {
      if (stopped) return;
      void heartbeat({}).catch(() => {
        // A missed heartbeat just means we look offline until the next one.
      });
    };

    beat();
    const timer = window.setInterval(beat, HEARTBEAT_MS);
    const onWake = () => beat();

    window.addEventListener("focus", onWake);
    document.addEventListener("visibilitychange", onWake);

    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", onWake);
      document.removeEventListener("visibilitychange", onWake);
    };
  }, [heartbeat]);
}
