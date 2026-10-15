/**
 * Conversation persistence for the two AI pages — one helper both use, so a
 * message is written, the session is touched, and every tab hears about it
 * in exactly one place.
 */
import { forgeDb, forgeId, type MessageRow, type SessionRow } from "./db";
import { postForge } from "./events";

/** The page's current session, creating the first one on demand. */
export async function ensureSession(page: "assistant" | "builder"): Promise<SessionRow> {
  const rows = await forgeDb.sessions.where("page").equals(page).toArray();
  rows.sort((a, b) => b.updatedAt - a.updatedAt);
  if (rows.length) return rows[0];

  const now = Date.now();
  const session: SessionRow = {
    id: forgeId(),
    page,
    title: `${page === "assistant" ? "Assistant" : "Builder"} — ${new Date().toLocaleString()}`,
    createdAt: now,
    updatedAt: now,
    lastBuildId: null,
    appliedAt: null,
  };
  await forgeDb.sessions.put(session);
  postForge({ type: "sessions", id: session.id });
  return session;
}

/** Start a fresh session, leaving the old one in history. */
export async function newSession(page: "assistant" | "builder"): Promise<SessionRow> {
  const now = Date.now();
  const session: SessionRow = {
    id: forgeId(),
    page,
    title: `${page === "assistant" ? "Assistant" : "Builder"} — ${new Date().toLocaleString()}`,
    createdAt: now,
    updatedAt: now,
    lastBuildId: null,
    appliedAt: null,
  };
  await forgeDb.sessions.put(session);
  postForge({ type: "sessions", id: session.id });
  return session;
}

/** Append one line to a conversation. */
export async function addForgeMessage(
  sessionId: string,
  role: MessageRow["role"],
  text: string,
  note: string | null = null,
): Promise<void> {
  await forgeDb.messages.add({
    id: forgeId(),
    sessionId,
    role,
    text,
    note,
    at: Date.now(),
  });
  const session = await forgeDb.sessions.get(sessionId);
  if (session) await forgeDb.sessions.put({ ...session, updatedAt: Date.now() });
  postForge({ type: "messages", id: sessionId });
}

/** Forget one conversation (the Clear button). */
export async function clearSessionMessages(sessionId: string): Promise<number> {
  const rows = await forgeDb.messages.where("sessionId").equals(sessionId).toArray();
  await forgeDb.messages.bulkDelete(rows.map((row) => row.id));
  postForge({ type: "messages", id: sessionId });
  return rows.length;
}
