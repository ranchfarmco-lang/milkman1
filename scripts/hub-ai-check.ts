/**
 * The hub's own models, walked through every outcome the bridge can produce.
 *
 * The Builder's crew thinks with the hub's own AI by default, and that promise
 * rests on one small piece of glue: `src/lib/forge/hub-ai.ts`, which holds the
 * signed-in client the shell handed it and turns "a system prompt and a
 * message" into `ai.complete` on the deployment. It is the only thing standing
 * between a Build press and the models — and the way it fails is quietly:
 * a client that was never registered, a call that throws, an answer in the
 * wrong shape, and the crew would report a mystery rather than a reason.
 *
 * It talks to nothing but the client it is handed, so a client is easy to
 * stand in for: these checks are the deployment for one line each, and assert
 * where the question went, what it carried, and what came back.
 *
 * Run with: bun scripts/hub-ai-check.ts
 */
import { api } from "../src/convex/_generated/api";
import { DEFAULT_CONFIG } from "../src/lib/forge/config";
import { hubAiReady, hubComplete, setHubAiClient } from "../src/lib/forge/hub-ai";
import { PROVIDERS, chatOnce, providerMeta } from "../src/lib/forge/llm";
import type { ConvexReactClient } from "convex/react";

type Recorded = { fn: unknown; args: Record<string, unknown> };

/**
 * The path a function reference names — `api.ai.complete` reads `ai:complete`.
 *
 * It has to be read, not compared: `anyApi` mints a fresh proxy on every
 * property access, so two reads of the same function are never the same
 * object, and identity would report a correct call as the wrong door.
 */
function refName(fn: unknown): string | null {
  const name = (fn as Record<symbol, unknown> | null)?.[Symbol.for("functionName")];
  return typeof name === "string" ? name : null;
}

/** A client that answers like the deployment, and records what it was asked. */
function fakeClient(
  answer: unknown = { ok: true as const, text: "ok", by: "Freebuff AI" },
): { client: ConvexReactClient; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const client = {
    action: async (fn: unknown, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      return answer;
    },
  } as unknown as ConvexReactClient;
  return { client, calls };
}

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

/* ------------------------------------------------- the hub is the default */

check("the crew starts on This hub", DEFAULT_CONFIG.aiProvider === "hub");
check(
  "…with a model that needs no choosing",
  DEFAULT_CONFIG.aiModel === "auto",
  String(DEFAULT_CONFIG.aiModel),
);
check("This hub is first in the BYOK hub", PROVIDERS[0]?.id === "hub");
check("…and never asks for a key", providerMeta("hub")?.needsKey === false);

/* --------------------------------------------- nobody handed the client in */

setHubAiClient(null);
check("before the shell runs, the hub is not reachable", !hubAiReady());

{
  const answer = await hubComplete({ system: "be brief", prompt: "say ok" });
  check(
    "a page outside the app is told where to go",
    !answer.ok && answer.error.includes("inside the app"),
    answer.ok ? "it answered without a client" : answer.error.slice(0, 80),
  );
}

/* ------------------------------------------------- a question, and an answer */

{
  const { client, calls } = fakeClient();
  setHubAiClient(client);

  const answer = await hubComplete({
    system: "You are the Director.",
    prompt: "The brief.",
    maxTokens: 2048,
    temperature: 0.4,
  });

  check("with the shell open, the hub is reachable", hubAiReady());
  check(
    "the answer comes back whole",
    answer.ok && answer.text === "ok" && answer.by === "Freebuff AI",
  );
  check("exactly one question was asked", calls.length === 1, `${calls.length}`);

  const call = calls[0];
  check(
    "it knocked on `ai.complete` and no other door",
    refName(call?.fn) === refName(api.ai.complete),
    `${refName(call?.fn)} vs ${refName(api.ai.complete)}`,
  );
  check(
    "the system prompt and the message both travelled",
    call?.args.system === "You are the Director." && call?.args.prompt === "The brief.",
  );
  check(
    "the budget and the temperature travelled too",
    call?.args.maxTokens === 2048 && call?.args.temperature === 0.4,
  );

  /* ------------------------------------------- the crew's own call shape */

  const turn = await chatOnce({
    provider: "hub",
    model: "auto",
    system: "You are the Planner.",
    messages: [
      { role: "user", content: "Plan a calculator." },
      { role: "assistant", content: '{"files":[]}' },
      { role: "user", content: "Reply with only the JSON object." },
    ],
  });

  const second = calls[1];
  const prompt = String(second?.args.prompt ?? "");
  check(
    "a crew turn reaches the same door",
    refName(second?.fn) === refName(api.ai.complete),
  );
  check(
    "its own earlier answer is marked as one, not as the person's",
    prompt.includes("(your earlier answer)\n{\"files\":[]}"),
    prompt.slice(0, 120),
  );
  check(
    "the whole exchange travels, in order",
    prompt.indexOf("Plan a calculator.") < prompt.indexOf("(your earlier answer)") &&
      prompt.indexOf("(your earlier answer)") <
        prompt.indexOf("Reply with only the JSON object."),
  );
  check(
    "the system prompt is the agent's, not the crew's",
    second?.args.system === "You are the Planner.",
  );
  check(
    "the hub path hands back text and no invented tool calls",
    turn.text === "ok" && turn.toolCalls.length === 0,
  );

  check(
    "the crew's turn was the second thing asked and nothing else was",
    calls.length === 2,
    `${calls.length} calls`,
  );
}

/* -------------------------------------------------- the hub says no itself */

{
  // A hub with every system switched off answers `ai.complete` with a refusal,
  // and it has to reach the crew as one: a refusal read as an answer would have
  // the planner parse the sentence as JSON.
  const { client, calls } = fakeClient({
    ok: false,
    error: "Every AI system is switched off.",
  });
  setHubAiClient(client);

  const refused = await hubComplete({ system: "", prompt: "" });
  check(
    "the hub's own refusal is passed through, not papered over",
    !refused.ok && refused.error.includes("Every AI system is switched off."),
    refused.ok ? "it claimed success" : refused.error,
  );
  check(
    "…and it was one question, not a retry",
    calls.length === 1,
    `${calls.length} calls`,
  );
}

/* ------------------------------------------------- the call itself blowing up */

{
  const client = {
    action: async () => {
      throw new Error("Every AI system is switched off.");
    },
  } as unknown as ConvexReactClient;
  setHubAiClient(client);

  const answer = await hubComplete({ system: "x", prompt: "y" });
  check(
    "a failure comes back as a sentence, never as a thrown promise",
    !answer.ok && answer.error.includes("Every AI system is switched off."),
    answer.ok ? "it claimed success" : answer.error.slice(0, 80),
  );
}

{
  const client = {
    action: async () => {
      throw "not an Error at all";
    },
  } as unknown as ConvexReactClient;
  setHubAiClient(client);

  const answer = await hubComplete({ system: "x", prompt: "y" });
  check(
    "even a non-Error has something to say",
    !answer.ok && answer.error.length > 0,
    answer.ok ? "it claimed success" : answer.error,
  );
}

/* ------------------------------------------ the shell goes, the door closes */

{
  setHubAiClient(null);
  let message = "";
  try {
    await chatOnce({
      provider: "hub",
      model: "auto",
      messages: [{ role: "user", content: "build me a calculator" }],
    });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  check(
    "a crew turn after the shell unmounts says where the hub is",
    message.includes("inside the app"),
    message.slice(0, 80),
  );
}

console.log(
  failures === 0 ? "\nEvery hub-AI check passed." : `\n${failures} hub-AI check(s) failed.`,
);

// Ending on an explicit status rather than on the event loop draining: the
// forge opens a BroadcastChannel at import (the wire between its pages), which
// holds the process open by itself — so a script that only exited on failure
// would hang here for ever with every check green.
process.exit(failures === 0 ? 0 : 1);
