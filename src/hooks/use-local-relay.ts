import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { loadConnection } from "@/lib/local-brain";
import { useMutation, useQuery } from "convex/react";
import { useEffect, useRef } from "react";

/**
 * This page, carrying out the questions that can only be answered on this
 * machine.
 *
 * A model server on `127.0.0.1` listens for the machine it is running on, and
 * the hub's own server is a different machine in a different building — which
 * is why asking it from there for Ollama always came back with "connection
 * refused". The person, however, is sitting at this machine, with this page
 * open. So when a turn has a local model to ask, it writes the question into a
 * row, this page picks it up, posts it over there, and writes the answer back.
 *
 * The turn itself never leaves the hub: every tool it runs, every message it
 * stores, every calendar entry it makes still happens on the hub's own server,
 * exactly as it does for any other model. All that crosses is one HTTP exchange
 * to an address on this machine, and back.
 *
 * Three properties matter here:
 *
 * * **It is idempotent by construction.** A row is claimed in a mutation that
 *   only lets one page win, so two tabs, a re-render, or React's double-invoked
 *   effects cannot carry the same question out twice.
 * * **It never throws.** Nothing awaits this hook. A failure is written back as
 *   the reason, because a row nobody answers leaves a turn waiting for its full
 *   deadline, and a thrown promise is invisible either way.
 * * **It prefers the plain route and falls back to the brain.** A page may only
 *   ask a local model server that accepts its origin, which Ollama does not do
 *   for an https page by default. The paired brain answers on this machine with
 *   no origin to refuse, so when the direct ask is turned away it is asked for
 *   again through the brain instead.
 */

/** One question a turn has left for this machine. */
type Pending = {
  _id: Id<"localRelays">;
  url: string;
  headers: string;
  body: string;
  createdAt: number;
  expiresAt: number;
};

/**
 * A name for this page. Made once, in an effect, because render has to be
 * reproducible — and two tabs carrying the same question out would be worse
 * than either of them answering slowly.
 */
function makeWorkerId() {
  return `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** What this page is given to claim a question with, and to answer with. */
type Claim = (args: {
  id: Id<"localRelays">;
  workerId: string;
}) => Promise<boolean>;
type Report = (args: {
  id: Id<"localRelays">;
  workerId: string;
  status: number;
  body: string;
  error?: string;
}) => Promise<unknown>;

type Answer = { status: number; body: string };

/** Ask the model server itself. One request, with the turn's own deadline. */
async function askDirectly(
  row: Pending,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<Answer> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(row.url, {
      method: "POST",
      headers,
      body: row.body,
      signal: controller.signal,
    });
    return { status: response.status, body: await response.text() };
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * Ask through the brain on this machine instead.
 *
 * The brain is a server on loopback with CORS written for exactly this — a page
 * of the hub reaching loopback — and it asks the model server from here, where
 * there is no origin to refuse and no mixed-content rule to break. Returns null
 * when there is no brain paired, or when it has nothing new to offer: an older
 * brain answers 404, and an unpaired one 401, neither of which is an answer.
 */
async function askThroughBrain(
  row: Pending,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<Answer | null> {
  const brain = loadConnection();
  if (!brain?.url) return null;

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(
      `${brain.url.replace(/\/+$/, "")}/api/v1/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(brain.token ? { "X-Brain-Token": brain.token } : {}),
        },
        body: JSON.stringify({ url: row.url, headers, payload: row.body }),
        signal: controller.signal,
      },
    );
    if (response.status === 404 || response.status === 401) return null;
    return { status: response.status, body: await response.text() };
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * Why the model on this machine did not get the question, in the words the
 * person reads back.
 *
 * Deliberately free of the words the chat uses to decide a turn is worth
 * asking twice: waiting out this same deadline a second time would be a minute
 * of silence for an answer that is not coming.
 */
function whyNot(url: string, error: unknown): string {
  const host = url.replace(/^https?:\/\//, "").replace(/\/v1.*$/, "");
  const aborted = error instanceof DOMException && error.name === "AbortError";
  return aborted
    ? `Local AI is on this machine, but ${host} did not answer before the turn ran out. Check that it is running and has a model pulled.`
    : `Local AI is on this machine, but this page was not allowed to ask ${host} — either nothing is listening there, or the browser refused a page from talking to a local model server. Ollama allows its own origins only, so either serve the hub over http from this machine, set OLLAMA_ORIGINS, or pair the brain on the Local Brain page and it will ask for the hub.`;
}

/** Carry one question out, from claim to answer, swallowing nothing. */
async function carry(
  row: Pending,
  deps: { claim: Claim; report: Report; workerId: string },
) {
  const { claim, report, workerId } = deps;

  // One page wins, and the loser simply stands down — the winner is already
  // doing the work, so there is nothing to take over.
  let taken = false;
  try {
    taken = await claim({ id: row._id, workerId });
  } catch {
    return;
  }
  if (!taken) return;

  const headers = (() => {
    try {
      const parsed = JSON.parse(row.headers) as unknown;
      return parsed && typeof parsed === "object"
        ? (parsed as Record<string, string>)
        : {};
    } catch {
      return {};
    }
  })();

  // The row's own deadline is the turn's deadline; anything left of it is what
  // this machine has to answer in.
  const budget = Math.max(3_000, row.expiresAt - Date.now());

  let answer: Answer | null = null;
  let refused: unknown = null;

  try {
    answer = await askDirectly(row, headers, budget);
  } catch (error) {
    refused = error;
  }

  // The direct route was turned away — a model server that accepts only its
  // own origins, or a browser that will not let a secure page ask one. The
  // brain is on this machine already, so it asks instead.
  if (!answer) {
    const left = Math.max(2_000, row.expiresAt - Date.now());
    answer = await askThroughBrain(row, headers, left);
  }

  // Reported after the try/catch above on purpose: a page that could not write
  // the answer back must not decide to run the same model call a second time.
  if (answer) {
    await report({
      id: row._id,
      workerId,
      status: answer.status,
      body: answer.body,
    }).catch(() => undefined);
    return;
  }

  await report({
    id: row._id,
    workerId,
    status: 0,
    body: "",
    error: whyNot(
      row.url,
      refused ?? new Error("the model server did not answer"),
    ),
  }).catch(() => undefined);
}

/**
 * Watch for questions this machine has been asked, and carry them out.
 *
 * Mounted once, inside the app shell, so there is a page listening whenever
 * somebody is using the hub — which is exactly when a turn can be waiting on
 * one.
 */
export function useLocalRelay() {
  const pending = useQuery(api.localRelays.next);
  const claim = useMutation(api.localRelays.claim);
  const report = useMutation(api.localRelays.report);

  // One id per page: two tabs are two workers, and the claim decides between
  // them rather than both answering the same question.
  const workerId = useRef("");

  // Rows already picked up by this page. React may render with the same rows
  // again before the claim lands, and the claim alone would not stop that.
  const started = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!workerId.current) workerId.current = makeWorkerId();
    if (!pending?.length) return;
    for (const row of pending as Pending[]) {
      if (started.current.has(row._id)) continue;
      started.current.add(row._id);
      void carry(row, { claim, report, workerId: workerId.current });
    }
  }, [pending, claim, report]);
}
