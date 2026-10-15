import { useForgeApps } from "@/hooks/use-forge";
import {
  appDocument,
  appMissingReferences,
  recordRun,
  reportAppError,
  runnable,
} from "@/lib/forge/apps";
import type { AppRow } from "@/lib/forge/db";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";

/**
 * Which app is in the sandbox frame — the one fact the builder page's boxes
 * need to agree on.
 *
 * The shelf at the top of the page launches, and the preview box at the bottom
 * holds the frame, so the state cannot live in either of them: a Run on a card
 * has to put that app in the frame, and Stop in the frame has to take the
 * "running" mark off the card. One hook, read by both, is the only way those
 * two cannot drift apart.
 *
 * Nothing here runs by itself. A launch is always a press, and a failure to
 * start is said out loud rather than swallowed.
 */
export type AppRunner = {
  /** Every app on the shelf, newest first — `null` while the first read runs. */
  apps: AppRow[] | null;
  /** The same list, never null, so a box can count it without a null check. */
  all: AppRow[];
  /** The app in the frame, and the number that says which run of it this is. */
  running: string | null;
  runKey: number;
  live: AppRow | null;
  /** The running app's whole document, assembled once per change. */
  liveDoc: string | null;
  /** Files the running app asks for and does not carry. */
  liveMissing: string[];
  /** It has an entry page and everything it asks for, so it can be opened. */
  liveReady: boolean;
  launch: (app: AppRow) => Promise<void>;
  /** Load the app from the top — the honest way to run a page again. */
  rerun: () => void;
  /** Take the app out of the frame. */
  stop: () => void;
};

export function useAppRunner(): AppRunner {
  const apps = useForgeApps();
  const [running, setRunning] = useState<string | null>(null);
  // Bumping this remounts the frame, which is how "run it again" is honest.
  const [runKey, setRunKey] = useState(0);

  const all = useMemo(() => apps ?? [], [apps]);
  const live = useMemo(
    () => all.find((one) => one.id === running) ?? null,
    [all, running],
  );
  // Assembled once per app rather than once per render: the whole document is
  // folded together here, and a person typing in a note re-renders the box on
  // every keystroke.
  const liveDoc = useMemo(() => (live ? appDocument(live) : null), [live]);
  const liveMissing = useMemo(
    () => (live ? appMissingReferences(live) : []),
    [live],
  );
  const liveReady = live !== null && runnable(live) && liveMissing.length === 0;

  const launch = useCallback(async (app: AppRow) => {
    try {
      await recordRun(app.id);
      setRunning(app.id);
      setRunKey((count) => count + 1);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not start that app.",
      );
      void reportAppError("launch", error);
    }
  }, []);

  const rerun = useCallback(() => setRunKey((count) => count + 1), []);
  const stop = useCallback(() => setRunning(null), []);

  return {
    apps,
    all,
    running,
    runKey,
    live,
    liveDoc,
    liveMissing,
    liveReady,
    launch,
    rerun,
    stop,
  };
}
