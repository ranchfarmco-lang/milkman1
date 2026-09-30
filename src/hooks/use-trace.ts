import { api } from "@/convex/_generated/api";
import type { ChatRoom } from "@/hooks/use-chat";
import { useQuery } from "convex/react";

/**
 * The turn this box is in the middle of — the thinking and the steps, as they
 * are written, with the reply to follow.
 *
 * A Convex query rather than a poll: the chat is subscribed, so every line the
 * assistant writes while it works arrives on its own. Nothing is kept in
 * component state — the turn lives in the database, which is what lets the same
 * work be watched from a second device, and what lets the feed be lifted off
 * the finished turn and kept under the reply it produced.
 *
 * The family messenger has no AI in it and so has no turn to show.
 */
export function useTrace(room: ChatRoom) {
  return useQuery(api.traces.latest, room === "messenger" ? "skip" : { room });
}
