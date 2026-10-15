/**
 * The wire between the three forge pages.
 *
 * Dexie's live queries keep one tab reactive on their own; a second tab (the
 * Control Room open beside the Builder, say) learns about a change through
 * this BroadcastChannel. Every message both reaches the other tabs and bumps
 * a local epoch, so hooks that read plain rows can re-read on either kind of
 * news.
 *
 * Emergency Stop travels the same wire: one press anywhere stops the pipeline
 * everywhere.
 */

export type ForgeEventType =
  | "config"
  | "agents"
  | "logs"
  | "sandbox"
  | "messages"
  | "sessions"
  | "requests"
  | "builds"
  /** The App Sandbox: an app was published, renamed, run or taken away. */
  | "apps"
  | "files"
  | "projects"
  | "lights"
  | "secrets"
  | "diagnostics"
  | "emergency"
  /**
   * One box handing something to another: usually the running app handing the
   * part of itself somebody picked to the prompt box, so "change this" needs a
   * copy and a paste rather than a description.
   */
  | "preset";

export type ForgeEvent = { type: ForgeEventType; id?: string; text?: string };

type Listener = (event: ForgeEvent) => void;

const listeners = new Set<Listener>();
const tickers = new Set<() => void>();

let epoch = 0;

const channel: BroadcastChannel | null =
  typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("controlforge") : null;

function fire(event: ForgeEvent, remote: boolean) {
  epoch += 1;
  for (const tick of tickers) tick();
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (err) {
      console.error("[forge] event listener failed", err);
      void Promise.resolve(err);
    }
  }
  if (!remote) {
    try {
      channel?.postMessage(event);
    } catch {
      // A closed channel is not worth a crash — the local tabs still heard it.
    }
  }
}

if (channel) {
  channel.onmessage = (message) => {
    const event = message.data as ForgeEvent | undefined;
    if (event?.type) fire(event, true);
  };
}

/** Tell every tab (and this one) that forge state changed. */
export function postForge(event: ForgeEvent): void {
  fire(event, false);
}

/** Subscribe to forge events. Returns the unsubscriber. */
export function onForge(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Subscribe to the epoch counter — bumped by any event, local or remote. */
export function onForgeTick(tick: () => void): () => void {
  tickers.add(tick);
  return () => tickers.delete(tick);
}

/** The current epoch. Hooks hold it in state and re-read when it moves. */
export function forgeEpoch(): number {
  return epoch;
}
