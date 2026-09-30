import { useConvexConnectionState } from "convex/react";
import { useEffect, useState } from "react";

/**
 * Is the hub's database actually reachable?
 *
 * This exists because of a specific failure that is invisible from the outside:
 * Convex resolves `isLoading` only once it has *talked* to its backend, so on a
 * machine where the backend is not running, `useAuth()` reports loading forever.
 * Every screen behind `RequireAuth` then renders a spinner on a black page with
 * no explanation — which reads as a broken app rather than a missing service,
 * and gives nobody anything to act on.
 *
 * The client already knows the truth and publishes it as connection state, so
 * the app can say what is happening instead of spinning.
 *
 * Two details matter:
 *
 * * **The grace period.** A connection that is merely slow must not flash a
 *   scary screen, so nothing is reported until the client has had a fair chance
 *   to connect.
 * * **`hasEverConnected`, not `isWebSocketConnected`.** A connection that drops
 *   *after* working is a different situation: the data is already in hand and
 *   Convex reconnects on its own. Only a client that has never connected once is
 *   treated as unreachable, so a blip never replaces a working screen.
 */

/** How long to let a slow first connection settle before saying anything. */
const GRACE_MS = 7000;

export type HubReachability = {
  /** Never connected, and the grace period is over. Safe to show a screen for. */
  unreachable: boolean;
  /** How many times the client has tried and failed, for the screen to report. */
  retries: number;
};

export function useHubReachable(): HubReachability {
  const connection = useConvexConnectionState();
  const [graceOver, setGraceOver] = useState(false);

  useEffect(() => {
    if (connection.hasEverConnected) return;
    const timer = window.setTimeout(() => setGraceOver(true), GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [connection.hasEverConnected]);

  return {
    unreachable: !connection.hasEverConnected && graceOver,
    retries: connection.connectionRetries,
  };
}
