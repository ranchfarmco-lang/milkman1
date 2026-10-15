/**
 * Emergency stop: one press, everywhere.
 *
 * The Control Room's button and the Builder's banner both call in here. The
 * stop aborts every registered controller (so a pipeline standing in the
 * middle of an agent call stops at the next check), marks the running agents
 * as stopped, tears the sandbox down, and writes the flag into the config so
 * a second tab — or a reload — still refuses to start anything until the
 * owner releases it.
 */
import { readConfig, writeConfig } from "./config";
import { forgeDb, type AgentRow } from "./db";
import { postForge } from "./events";
import { sandbox } from "./sandbox";

const aborters = new Set<AbortController>();

/** Register a controller the stop button may abort. Returns the unregistrer. */
export function registerAbort(controller: AbortController): () => void {
  aborters.add(controller);
  return () => aborters.delete(controller);
}

/* ------------------------------------------------------- the run in front */

/**
 * The crew run happening now, if one is.
 *
 * Separate from `aborters` above, which is the emergency stop's list of every
 * controller that must die at once. This is the *one* run a person is watching:
 * the box that starts a build registers its controller here, so the Build Log's
 * own Stop can end that build and nothing else. Two boxes have to agree about
 * this — the prompt box starts it, the log box stops it — so the state lives
 * between them rather than in either.
 */
let current: AbortController | null = null;

/** The prompt box says a build has started. */
export function beginRun(controller: AbortController): void {
  current = controller;
}

/** The prompt box says it has finished, one way or another. */
export function endRun(controller: AbortController): void {
  if (current === controller) current = null;
}

/** Stop the build that is running; false when there is nothing to stop. */
export function stopRun(): boolean {
  if (!current) return false;
  current.abort();
  return true;
}

/** Is the stop currently engaged? Reads the persisted flag, not a memory. */
export async function emergencyActive(): Promise<boolean> {
  return (await readConfig()).emergencyStopped;
}

/** Kill every agent, tear down the sandbox, and lock the flag in place. */
export async function emergencyStop(): Promise<void> {
  for (const controller of aborters) controller.abort();

  // Whatever was running is now stopped — say so where the lights read it.
  const running = await forgeDb.agents.where("status").equals("running").toArray();
  const now = Date.now();
  for (const row of running) {
    await forgeDb.agents.put({
      ...row,
      status: "stopped",
      detail: "Stopped by Emergency Stop.",
      endedAt: now,
      at: now,
    } satisfies AgentRow);
  }

  await sandbox.teardown();
  await writeConfig({ emergencyStopped: true });
  postForge({ type: "emergency" });
  postForge({ type: "agents" });
  postForge({ type: "sandbox" });
}

/** Let the forge work again. The sandbox stays down until someone boots it. */
export async function releaseEmergency(): Promise<void> {
  await writeConfig({ emergencyStopped: false });
  postForge({ type: "emergency" });
}
