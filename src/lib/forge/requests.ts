/**
 * The handoff between the Assistant and the Builder: a structured build
 * request the Assistant packages, the Builder offers to review and run.
 *
 * The object is validated with Zod on both ends — she cannot send a vague
 * sentence where a goal is required, and the Builder never ingests a shape it
 * did not expect. It travels as an IndexedDB row plus a BroadcastChannel
 * ping, so it works offline and across tabs.
 */
import { z } from "zod";
import { forgeDb, forgeId, type RequestRow } from "./db";
import { postForge } from "./events";

/** What the Assistant must package when she decides a build is needed. */
export const buildRequestSchema = z.object({
  goal: z.string().min(8, "The goal needs a real sentence.").max(2000),
  context: z.string().max(4000).default(""),
  constraints: z.string().max(2000).default(""),
  priority: z.enum(["normal", "high"]).default("normal"),
});

export type BuildRequestInput = z.infer<typeof buildRequestSchema>;

/**
 * The sentence the spec requires her to say when a request goes out. The
 * page appends it after a successful send even if the model forgot, so the
 * behaviour is guaranteed rather than prompted.
 */
export const ASSISTANT_HANDOFF =
  "I have sent a build request to the AI Builder. Please switch to the AI Builder page to review and execute it.";

/** Validate, store, and ping every tab that the Builder is wanted. */
export async function sendBuildRequest(raw: unknown): Promise<RequestRow> {
  const input = buildRequestSchema.parse(raw);
  const now = Date.now();
  const row: RequestRow = {
    id: forgeId(),
    goal: input.goal,
    context: input.context,
    constraints: input.constraints,
    priority: input.priority,
    status: "pending",
    answer: null,
    createdAt: now,
    updatedAt: now,
  };
  await forgeDb.requests.add(row);
  postForge({ type: "requests", id: row.id });
  return row;
}

/** Requests still waiting for the Builder to look at them. */
export async function pendingRequests(): Promise<RequestRow[]> {
  const rows = await forgeDb.requests.where("status").equals("pending").toArray();
  return rows.sort((a, b) => b.createdAt - a.createdAt);
}

/** The Builder accepted or declined a request (or marked it done). */
export async function answerRequest(
  id: string,
  status: RequestRow["status"],
  answer: string | null = null,
): Promise<void> {
  const row = await forgeDb.requests.get(id);
  if (!row) return;
  await forgeDb.requests.put({ ...row, status, answer, updatedAt: Date.now() });
  postForge({ type: "requests", id });
}
