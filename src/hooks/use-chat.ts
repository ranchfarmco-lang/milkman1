import type { ChatMessage } from "@/components/MessagePanel";
import { api } from "@/convex/_generated/api";
import { useAuth } from "@/hooks/use-auth";
import { useAction, useMutation, useQuery } from "convex/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type ChatRoom = "assistant" | "builder" | "companion" | "messenger";

/**
 * The boxes that are pages of their own.
 *
 * The companion in the corner is a box too — it is a conversation with the same
 * brain — but it is not a place: it has no address, it is on every page at
 * once, and there is nothing to link somebody to. Anything that needs a page,
 * a link or a share target wants one of these three, so the set is named here
 * rather than left as a comment.
 */
export type BoxRoom = Exclude<ChatRoom, "companion">;

export type RespondResult =
  | { ok: true; say: string; actions: unknown[] }
  | { ok: false; error: string };

/**
 * A provider having a bad minute, a rate limit, a connection that dropped — all
 * worth one more go, quietly. A missing key, or nothing to reply to, is not:
 * asking again would only fail the same way twice.
 */
function worthAskingAgain(message: string) {
  return /could not reach|model request failed|did not return an answer|empty answer|timed out|network/i.test(
    message,
  );
}

/**
 * One conversation box: the live thread, sending, and asking the model for a
 * reply. Returns the reply so a caller can read it out loud or act on it.
 *
 * `context` is how the little box that follows the person around describes what
 * is on the screen — the route, the field they are typing in, anything
 * selected. It is asked for afresh at each send, so the answer always describes
 * the screen as it is now rather than the screen as it was when the box
 * mounted, and it is held in a ref rather than in the callback's dependencies
 * so that a page which re-renders on every keystroke does not rebuild the
 * sender underneath itself.
 *
 * `focus` is the one thing a box can say about the *job* rather than the
 * screen: `"self"` means this turn is a change to the app the person is looking
 * at, which only the mirror in the AI Builder's sandbox asks for. It travels
 * with the turn so the
 * builder is told which of its two jobs it is doing, instead of working it out
 * from the words somebody happened to type.
 */
export function useChat(
  room: ChatRoom,
  options: { context?: () => string | null; focus?: "self" } = {},
) {
  const { user } = useAuth();
  const myId = user?._id;

  const rows = useQuery(api.messages.list, { room });
  const aiReady = useQuery(api.ai.configured);

  const send = useMutation(api.messages.send);
  const clear = useMutation(api.messages.clear);
  const respond = useAction(api.ai_turn.respond);

  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const contextOf = useRef(options.context);
  useEffect(() => {
    contextOf.current = options.context;
  }, [options.context]);

  // Read once, not per send: which job the box is asking for is a property of
  // the box, and it is in the sender's dependencies so a box that changes it
  // gets a sender that carries the new one.
  const focus = options.focus;

  const messages = useMemo<ChatMessage[]>(() => {
    if (!rows || !myId) return [];
    return rows.map((row) => ({
      id: row._id,
      text: row.text,
      at: row.createdAt,
      note: row.note ?? null,
      // The working behind an AI reply rides along with it, so it can stay
      // under the answer it produced long after the turn itself is gone.
      feed: row.feed ?? null,
      role: row.role,
      mine: row.role !== "assistant" && row.authorId === myId,
      authorName: row.authorName ?? null,
    }));
  }, [rows, myId]);

  const sendMessage = useCallback(
    async (text: string): Promise<RespondResult | null> => {
      setError(null);

      try {
        await send({ room, text });
      } catch (sendError) {
        const message =
          sendError instanceof Error
            ? sendError.message
            : "Could not send that.";
        setError(message);
        return { ok: false, error: message };
      }

      // The family messenger is just people; only the AI boxes need an answer.
      if (room === "messenger") return null;

      setThinking(true);
      // What is on their screen, read at the moment of asking. Only the
      // companion's prompt reads it; every other box is handed it and ignores
      // it, so the same sender serves all of them.
      const context = contextOf.current?.() ?? undefined;
      try {
        const first = await respond({ room, context, focus });
        if (first.ok) return first;

        // Nothing is stored in the thread on a failed turn, so asking once more
        // cannot answer the same message twice. This is what stops a box from
        // sitting there with an error until the person presses send again.
        if (!worthAskingAgain(first.error)) {
          setError(first.error);
          return first;
        }

        const retry = await respond({ room, context, focus });
        if (!retry.ok) setError(retry.error);
        return retry;
      } catch (respondError) {
        const message =
          respondError instanceof Error
            ? respondError.message
            : "The model call failed. Try again.";
        setError(message);
        return { ok: false, error: message };
      } finally {
        setThinking(false);
      }
    },
    [focus, respond, room, send],
  );

  const clearRoom = useCallback(() => {
    void clear({ room });
  }, [clear, room]);

  return {
    messages,
    thinking,
    error,
    setError,
    sendMessage,
    clearRoom,
    aiReady,
  };
}
