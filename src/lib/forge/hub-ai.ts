/**
 * The hub's own AI, for the builder's crew.
 *
 * The forge keeps its keys in the browser: you paste one in the Control Room's
 * BYOK hub and the crew talks to that provider directly. That is the right
 * shape for somebody who has a key to paste — and the wrong one for a hub that
 * already has models of its own. This deployment ships with a gateway key
 * (`VLY_INTEGRATION_KEY`), the family can add any other in the Keys tab, and a
 * model on the family's own machine needs no key at all. All of that is on the
 * server, behind the same walk a chat turn makes, and none of it is reachable
 * from here without a door.
 *
 * `ai.complete` in `src/convex/ai.ts` is that door. This module is the one
 * thing the router in `llm.ts` needs to knock on it: a reference to the signed
 * in client the hub is already using, set once by the shell that has it, plus
 * one function that turns "a system prompt and a message" into text.
 *
 * Why a registry rather than an import: the client carries this browser's
 * session — it is the one the auth provider built — and it only exists inside
 * React. A module-level slot set by `AppShell` is the smallest bridge that
 * does not make every forge module a React component, and the answers are the
 * same either way: signed in and unlocked, or refused with a sentence.
 */
import { api } from "@/convex/_generated/api";
import type { ConvexReactClient } from "convex/react";

let client: ConvexReactClient | null = null;

/** The hub's client, handed in by the shell while it is on screen. */
export function setHubAiClient(next: ConvexReactClient | null): void {
  client = next;
}

/** Whether the hub is there to answer — false on a page opened without it. */
export function hubAiReady(): boolean {
  return client !== null;
}

export type HubAnswer =
  | { ok: true; text: string; by: string }
  | { ok: false; error: string };

/**
 * Ask the hub's models one question.
 *
 * Never throws: every failure comes back as `{ ok: false, error }` carrying the
 * hub's own sentence, because the crew reports it to the person watching rather
 * than dying inside a pipeline. The one failure this module invents is being
 * asked from somewhere the hub is not — a page opened outside the app — and it
 * says exactly that.
 */
export async function hubComplete(input: {
  system: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
}): Promise<HubAnswer> {
  const convex = client;
  if (!convex) {
    return {
      ok: false,
      error:
        "The hub's own AI is reached through the hub. Open the AI Builder inside the app, signed in, and press Build again.",
    };
  }

  try {
    return await convex.action(api.ai.complete, {
      system: input.system,
      prompt: input.prompt,
      maxTokens: input.maxTokens,
      temperature: input.temperature,
    });
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "The hub's own AI did not answer.",
    };
  }
}
