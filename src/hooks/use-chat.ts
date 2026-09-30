import type { ChatMessage } from "@/components/MessagePanel";
import { api } from "@/convex/_generated/api";
import { useAuth } from "@/hooks/use-auth";
import { useAction, useMutation, useQuery } from "convex/react";
import { useCallback, useMemo, useState } from "react";

export type ChatRoom = "assistant" | "builder" | "messenger";

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
 */
export function useChat(room: ChatRoom) {
  const { user } = useAuth();
  const myId = user?._id;

  const rows = useQuery(api.messages.list, { room });
  const aiReady = useQuery(api.ai.configured);

  const send = useMutation(api.messages.send);
  const clear = useMutation(api.messages.clear);
  const respond = useAction(api.ai_turn.respond);

  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const messages = useMemo<ChatMessage[]>(() => {
    if (!rows || !myId) return [];
    return rows.map((row) => ({
      id: row._id,
      text: row.text,
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
      try {
        const first = await respond({ room });
        if (first.ok) return first;

        // Nothing is stored in the thread on a failed turn, so asking once more
        // cannot answer the same message twice. This is what stops a box from
        // sitting there with an error until the person presses send again.
        if (!worthAskingAgain(first.error)) {
          setError(first.error);
          return first;
        }

        const retry = await respond({ room });
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
    [respond, room, send],
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
