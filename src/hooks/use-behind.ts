import { api } from "@/convex/_generated/api";
import { useQuery } from "convex/react";

/** One line of work the hub did without being asked. */
export type BehindRow = {
  id: string;
  at: number;
  /** alert nudge, board or calendar — which job this was. */
  source: string;
  label: string;
  detail: string | null;
  status: "running" | "done" | "failed";
  endedAt: number | null;
};

/**
 * The work nobody asked for, live.
 *
 * A subscription rather than a poll, so a job appears the moment it starts and
 * resolves the moment it ends — which is the whole point of showing it: the
 * hub should not be able to do something on its own without it being visible.
 *
 * An empty list is the honest answer when nothing has run: it means the hub has
 * been quiet, not that the feed is broken. It is also what a locked account
 * gets, since the work behind it is not theirs to read.
 */
export function useBehindTheScenes() {
  const rows = useQuery(api.ai_behind.recent);

  return {
    rows: (rows ?? []) as BehindRow[],
    /** Still finding out. Distinct from knowing there is nothing. */
    loading: rows === undefined,
    running: (rows ?? []).some((row) => row.status === "running"),
  };
}
