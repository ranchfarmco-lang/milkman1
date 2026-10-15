/**
 * The local-model relay, walked through its four outcomes.
 *
 * The relay is the only thing standing between a turn and a model server on the
 * family's own machine, and the only way it fails is by *not* answering — so the
 * paths that matter are all about what happens when nobody or nothing comes
 * back. It talks to nothing but a context, so a context is easy to stand in for:
 * this script is the deployment, a row is the question, and a timer is the page
 * over there carrying it out.
 *
 * Run with: bun scripts/relay-check.ts
 */
import {
  isLoopback,
  makeRelay,
} from "../src/convex/localRelays";

type Row = Record<string, unknown> & { status: string };

/** The deployment, as far as the relay is concerned. */
function harness() {
  const rows = new Map<string, Row>();
  let seq = 0;

  const ctx = {
    runMutation: async (_fn: unknown, args: Record<string, unknown>) => {
      // `open`: identified by carrying a ttl. Everything else takes an id.
      if (args && "ttlMs" in args) {
        const id = `r${++seq}`;
        rows.set(id, { status: "pending" });
        return id;
      }
      if (args && typeof args.id === "string") {
        const row = rows.get(args.id);
        if (row && (row.status === "pending" || row.status === "taken")) {
          row.status = "failed";
        }
        return "";
      }
      throw new Error("unexpected mutation");
    },
    runQuery: async (_fn: unknown, args: Record<string, unknown>) =>
      (typeof args.id === "string" ? (rows.get(args.id) ?? null) : null),
  } as never;

  return { rows, relay: makeRelay(ctx, "u1" as never) };
}

/** The page over there: settles the oldest open row after a moment. */
function answerAfter(
  rows: Map<string, Row>,
  ms: number,
  settle: (row: Row) => void,
) {
  const timer = setInterval(() => {
    for (const row of rows.values()) {
      if (row.status === "pending" || row.status === "taken") {
        settle(row);
        clearInterval(timer);
        return;
      }
    }
  }, ms);
  return () => clearInterval(timer);
}

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

const TARGET = {
  label: "Ollama, on this machine",
  url: "http://127.0.0.1:11434/v1/chat/completions",
  headers: { "Content-Type": "application/json" },
  body: "{}",
  timeoutMs: 5_000,
};

/* --------------------------------------------------------- what is relayed */
check("relay: 127.0.0.1 is on this machine", isLoopback(TARGET.url));
check("relay: localhost is on this machine", isLoopback("http://localhost:1234/v1/models"));
check("relay: [::1] is on this machine", isLoopback("http://[::1]:8080/v1/chat/completions"));
check("relay: a LAN address is not", !isLoopback("http://192.168.1.9:11434/v1"));
check("relay: the public internet is not", !isLoopback("https://text.pollinations.ai/openai"));
check("relay: a bare host is not", !isLoopback("127.0.0.1:11434/v1"));

/* ------------------------------------------------------- an answer arrives */
{
  const { rows, relay } = harness();
  const stop = answerAfter(rows, 80, (row) => {
    row.status = "answered";
    row.answerStatus = 200;
    row.answerBody = '{"choices":[{"message":{"content":"ok"}}]}';
  });
  const result = await relay.send(TARGET);
  stop();
  const parsed = (await result.json()) as { choices: { message: { content: string } }[] };
  check(
    "relay: an answer comes back whole",
    result.ok && result.status === 200 && parsed.choices[0].message.content === "ok",
  );
}

/* ------------------------------------- a non-2xx is an answer, not an error */
{
  const { rows, relay } = harness();
  const stop = answerAfter(rows, 80, (row) => {
    row.status = "answered";
    row.answerStatus = 404;
    row.answerBody = '{"error":"model \'mistral\' not found"}';
  });
  const result = await relay.send(TARGET);
  stop();
  check("relay: the model's own status is preserved", !result.ok && result.status === 404);
}

/* ------------------------------------------- the page says why it could not */
{
  const { rows, relay } = harness();
  const stop = answerAfter(rows, 80, (row) => {
    row.status = "failed";
    row.answerError =
      "Local AI is on this machine, but this page was not allowed to ask 127.0.0.1:11434.";
  });
  let message = "";
  try {
    await relay.send(TARGET);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  stop();
  check("relay: the page's own reason is what surfaces", message.includes("was not allowed to ask"));
}

/* ------------------------------------------------ nobody carries it out */
{
  const { relay } = harness();
  let message = "";
  try {
    await relay.send(TARGET);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  check("relay: no page open says so plainly", message.includes("no page of the hub is open"));
}

/* --------------------------------------------- taken, but nothing came back */
{
  const { rows, relay } = harness();
  const stop = answerAfter(rows, 60, (row) => {
    row.status = "taken";
  });
  let message = "";
  try {
    await relay.send(TARGET);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  stop();
  check("relay: a slow machine is named as slow", /did not answer within \d+ seconds/.test(message));
}

/* -------------------------------------------------- an address that is not ours */
{
  const { relay } = harness();
  let message = "";
  try {
    await relay.send({ ...TARGET, url: "https://text.pollinations.ai/openai" });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  check("relay: refuses anything off this machine", message.includes("not on this machine"));
}

console.log(
  failures === 0
    ? "\nEvery relay check passed."
    : `\n${failures} relay check(s) failed.`,
);
if (failures > 0) process.exit(1);
