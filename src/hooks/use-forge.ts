/**
 * Reading the forge from React: every hook below is a live view over the
 * local database, re-reading when its own rows change *or* when any forge
 * event arrives — from this tab or the one beside it.
 *
 * The one exception is the sandbox engine: it is in-memory state owned by
 * this tab, so it is subscribed to directly.
 */
import { CREW } from "@/convex/ai_crew";
import { DEFAULT_CONFIG } from "@/lib/forge/config";
import {
  forgeDb,
  type AgentLogRow,
  type AppRow,
  type AgentRow,
  type AgentStatus,
  type ConfigRow,
  type LightRow,
  type MessageRow,
  type RequestRow,
  type SessionRow,
} from "@/lib/forge/db";
import { forgeEpoch, onForge } from "@/lib/forge/events";
import { sandbox, type SandboxState } from "@/lib/forge/sandbox";
import { useLiveQuery } from "dexie-react-hooks";
import { useCallback, useEffect, useMemo, useState } from "react";

/** Re-read whenever any forge event lands (local write or other tab). */
export function useForgeTick(): number {
  const [tick, setTick] = useState(forgeEpoch());
  useEffect(
    () => onForge(() => setTick(forgeEpoch())),
    [],
  );
  return tick;
}

/** Every forge switch, defaults filled in. */
export function useForgeConfig(): ConfigRow {
  const tick = useForgeTick();
  const row = useLiveQuery(() => forgeDb.config.get("config"), ["config", tick]);
  return useMemo(
    () => ({ ...DEFAULT_CONFIG, ...(row ?? {}), id: "config" as const }),
    [row],
  );
}

/** One crew member's status — the whole roster, idle where nothing has run. */
export type AgentView = {
  id: string;
  name: string;
  role: string;
  status: AgentStatus;
  detail: string;
  sessionId: string | null;
  endedAt: number | null;
};

/** The six agents as the Control Room and the Builder both show them. */
export function useForgeAgents(): AgentView[] {
  const tick = useForgeTick();
  const rows = useLiveQuery(() => forgeDb.agents.toArray(), ["agents", tick]);
  const byId = useMemo(() => {
    const map = new Map<string, AgentRow>();
    for (const row of rows ?? []) map.set(row.id, row);
    return map;
  }, [rows]);

  return useMemo(
    () =>
      CREW.map((member) => {
        const row = byId.get(member.id);
        return {
          id: member.id,
          name: member.name,
          role: member.role,
          status: row?.status ?? "idle",
          detail: row?.detail ?? "Waiting for work.",
          sessionId: row?.sessionId ?? null,
          endedAt: row?.endedAt ?? null,
        };
      }),
    [byId],
  );
}

/** Every status light the forge has published. */
export function useForgeLights(): LightRow[] {
  const tick = useForgeTick();
  const rows = useLiveQuery(() => forgeDb.lights.toArray(), ["lights", tick]);
  return useMemo(() => rows ?? [], [rows]);
}

/** A light by id (`provider:openai`, `sandbox`, `github`, …). */
export function useForgeLight(id: string): LightRow | undefined {
  const lights = useForgeLights();
  return useMemo(() => lights.find((light) => light.id === id), [lights, id]);
}

/**
 * The App Sandbox: every app the builder has made, newest first.
 *
 * `null` while the first read is still in flight, so a page can say it is
 * reading rather than say there is nothing there.
 */
export function useForgeApps(): AppRow[] | null {
  const tick = useForgeTick();
  const rows = useLiveQuery(() => forgeDb.apps.toArray(), ["apps", tick]);
  return useMemo(() => {
    if (!rows) return null;
    return [...rows].sort((a, b) => b.updatedAt - a.updatedAt);
  }, [rows]);
}

/** Build requests waiting for the Builder. */
export function usePendingRequests(): RequestRow[] {
  const tick = useForgeTick();
  const rows = useLiveQuery(
    () => forgeDb.requests.where("status").equals("pending").toArray(),
    ["requests", tick],
  );
  return useMemo(
    () => (rows ?? []).sort((a, b) => b.createdAt - a.createdAt),
    [rows],
  );
}

/** One page's conversation, oldest first. */
export function useForgeMessages(sessionId: string | null): MessageRow[] {
  const tick = useForgeTick();
  const rows = useLiveQuery(
    () =>
      sessionId
        ? forgeDb.messages.where("sessionId").equals(sessionId).sortBy("at")
        : Promise.resolve([] as MessageRow[]),
    ["messages", sessionId ?? "none", tick],
  );
  return useMemo(() => rows ?? [], [rows]);
}

/** A page's sessions, most recently touched first — null until the first read. */
export function useForgeSessions(page: "assistant" | "builder"): SessionRow[] | null {
  const tick = useForgeTick();
  const rows = useLiveQuery(
    () => forgeDb.sessions.where("page").equals(page).toArray(),
    ["sessions", page, tick],
  );
  return useMemo(() => {
    if (!rows) return null;
    return [...rows].sort((a, b) => b.updatedAt - a.updatedAt);
  }, [rows]);
}

/** The agent thought stream for one session, oldest first. */
export function useAgentLogs(sessionId: string | null) {
  const tick = useForgeTick();
  return useLiveQuery(
    () =>
      sessionId
        ? forgeDb.agentLogs.where("sessionId").equals(sessionId).limit(300).toArray()
        : Promise.resolve([] as AgentLogRow[]),
    ["agentLogs", sessionId ?? "none", tick],
  );
}

/**
 * The sandbox as this tab sees it: status, terminal lines, and a re-render
 * whenever the engine logs or changes. Hydration from IndexedDB happens on
 * first mount, so the file tree is real even before a boot.
 */
export function useSandbox(): SandboxState & { lines: string[]; engine: typeof sandbox } {
  const [status, setStatus] = useState<SandboxState>(() => sandbox.status());
  const [lines, setLines] = useState<string[]>(() => sandbox.terminalLines());

  useEffect(() => {
    void sandbox.hydrate();
    return sandbox.subscribe(() => {
      setStatus(sandbox.status());
      setLines(sandbox.terminalLines());
    });
  }, []);

  return useMemo(() => ({ ...status, lines, engine: sandbox }), [status, lines]);
}

/** Force a re-render from imperative forge code (buttons that write directly). */
export function useForgeRefresh(): () => void {
  const [, setTick] = useState(0);
  return useCallback(() => setTick((value) => value + 1), []);
}
