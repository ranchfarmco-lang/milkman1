/**
 * Box 2 — Active Agents Status.
 *
 * The six crew members as the pipeline last reported them — a reading, not a
 * decoration: rows come straight from the agents table the run writes into.
 * Parallel agents toggle, Force Restart (back to idle), View Logs (the real
 * thought stream of the most recent session) and Clear Memory (forget the
 * logs — a reset, so it wears orange and asks twice).
 */
import { ForgeBox, ForgeLight, MiniButton } from "@/components/forge/ForgeBox";
import { useForgeAgents, useForgeConfig, useForgeTick } from "@/hooks/use-forge";
import { writeConfig } from "@/lib/forge/config";
import { forgeDb, type Tone } from "@/lib/forge/db";
import { logAgent, resetAgents } from "@/lib/forge/pipeline";
import { Switch } from "@/components/ui/switch";
import { useLiveQuery } from "dexie-react-hooks";
import { Boxes, Eraser, RotateCcw, ScrollText } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

const STATUS_TONE: Record<string, Tone> = {
  running: "good",
  done: "good",
  error: "bad",
  stopped: "warn",
  idle: "muted",
};

const STATUS_LABEL: Record<string, string> = {
  running: "RUNNING",
  done: "DONE",
  error: "ERROR",
  stopped: "STOPPED",
  idle: "IDLE",
};

export function AgentsBox() {
  const agents = useForgeAgents();
  const config = useForgeConfig();
  const tick = useForgeTick();
  const [showLogs, setShowLogs] = useState(false);
  const [clearArmed, setClearArmed] = useState(false);
  const [restartArmed, setRestartArmed] = useState(false);
  const [readAt, setReadAt] = useState<number | null>(null);

  const logs = useLiveQuery(
    () => forgeDb.agentLogs.orderBy("at").reverse().limit(40).toArray(),
    ["agentLogs", tick],
  );

  const running = agents.filter((agent) => agent.status === "running");
  const failed = agents.filter((agent) => agent.status === "error");

  const tone: Tone = failed.length ? "bad" : running.length ? "good" : "muted";
  const value = running.length
    ? `${running.length} RUNNING`
    : failed.length
      ? `${failed.length} FAILED`
      : "ALL IDLE";
  const note = running.length
    ? running.map((agent) => agent.name).join(", ")
    : "No run in progress.";

  const newestSession = useMemo(
    () => [...(logs ?? [])].sort((a, b) => b.at - a.at)[0]?.sessionId ?? null,
    [logs],
  );

  const restart = async () => {
    if (!restartArmed) {
      setRestartArmed(true);
      toast("Press Force Restart again to put every agent back to idle.");
      window.setTimeout(() => setRestartArmed(false), 4000);
      return;
    }
    setRestartArmed(false);
    await resetAgents("Restarted — waiting for work.");
    if (newestSession) await logAgent(newestSession, "director", "Force restart: crew reset to idle.");
    toast.success("The crew is back to idle.");
  };

  const clearMemory = async () => {
    if (!clearArmed) {
      setClearArmed(true);
      toast("Press Clear Memory again to forget every agent log.");
      window.setTimeout(() => setClearArmed(false), 4000);
      return;
    }
    setClearArmed(false);
    await forgeDb.agentLogs.clear();
    await resetAgents("Waiting for work.");
    toast.success("Agent memory cleared.");
  };

  return (
    <ForgeBox
      id="forge-agents"
      icon={Boxes}
      title="Active Agents Status"
      light={{ tone, value, note: `${note}${readAt ? ` Read ${new Date(readAt).toLocaleTimeString([], { hour12: false })}.` : ""}` }}
      onRefresh={() => setReadAt(Date.now())}
      test={{ label: showLogs ? "Hide Logs" : "View Logs", onTest: () => setShowLogs((value_) => !value_) }}
      hint="Live rows from the pipeline: each agent writes its own status and words while it works, so these readings are what actually ran."
    >
      <div className="flex items-center gap-2 pb-2">
        <Switch
          checked={config.parallelAgents}
          onCheckedChange={(checked) => void writeConfig({ parallelAgents: checked })}
        />
        <span className="text-[10px] text-foreground/90">Parallel agents</span>
        <span className="text-[9px] text-muted-foreground">
          {config.parallelAgents
            ? "on — research runs beside planning, files write side by side."
            : "off — one agent at a time, in order."}
        </span>
      </div>

      <ul className="divide-y divide-border/50">
        {agents.map((agent) => (
          <li key={agent.id} className="flex items-start gap-2 py-2">
            <span
              className={`mt-0.5 size-2 shrink-0 rounded-full ${
                agent.status === "running"
                  ? "animate-pulse bg-emerald-400"
                  : agent.status === "error"
                    ? "bg-rose-500"
                    : agent.status === "done"
                      ? "bg-emerald-400/70"
                      : agent.status === "stopped"
                        ? "bg-amber-400"
                        : "bg-white/25"
              }`}
            />
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-1.5 text-[11px] font-medium">
                {agent.name}
                <span className="rounded-full border border-border/60 px-1.5 py-px text-[8px] tracking-wider text-muted-foreground">
                  {STATUS_LABEL[agent.status]}
                </span>
              </p>
              <p className="truncate text-[10px] leading-4 text-muted-foreground">
                {agent.role}
                {agent.status !== "idle" ? ` — ${agent.detail}` : ""}
              </p>
            </div>
            <ForgeLight
              tone={STATUS_TONE[agent.status]}
              value={agent.endedAt ? new Date(agent.endedAt).toLocaleTimeString([], { hour12: false }) : ""}
              note={agent.detail}
            />
          </li>
        ))}
      </ul>

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/50 pt-3">
        <MiniButton onClick={restart} title="Put every agent back to idle (two presses)">
          <RotateCcw className="size-3 text-amber-300" />
          {restartArmed ? "press again to restart" : "Force Restart"}
        </MiniButton>
        <MiniButton onClick={() => setShowLogs((value_) => !value_)}>
          <ScrollText className="size-3" />
          {showLogs ? "Hide Logs" : "View Logs"}
        </MiniButton>
        <MiniButton onClick={clearMemory} title="Forget every agent log (two presses)">
          <Eraser className="size-3 text-amber-300" />
          {clearArmed ? "press again to clear" : "Clear Memory"}
        </MiniButton>
      </div>

      {showLogs ? (
        <div className="mt-2 max-h-52 overflow-y-auto rounded-xl border border-border/60 bg-background/50 p-2">
          {logs?.length ? (
            <ul className="flex flex-col gap-1">
              {[...logs].reverse().map((row) => (
                <li key={row.id} className="flex gap-2 text-[9px] leading-4">
                  <span className="shrink-0 text-muted-foreground">
                    {new Date(row.at).toLocaleTimeString([], { hour12: false })}
                  </span>
                  <span className="shrink-0 font-semibold text-foreground/80">@{row.agent}</span>
                  <span className="min-w-0 text-muted-foreground">{row.text}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[10px] text-muted-foreground">
              No logs yet — they appear the first time the Builder runs a build.
            </p>
          )}
        </div>
      ) : null}
    </ForgeBox>
  );
}
