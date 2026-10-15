/**
 * Boxes 9 and 10 — System Health & Diagnostics, and the Quick Actions Bar.
 *
 * Box 9 runs the real battery (stored as the last report), shows the
 * counters and the last recorded error, and holds Reset to Factory — orange,
 * two presses, and honest about what it destroys.
 *
 * Box 10 is the action strip: Start New Build, Continue Session, Open
 * Workspace (each opening the AI Builder in the right state) and Emergency
 * Stop All Agents — which aborts the crew, tears the sandbox down and locks
 * the forge until it is released.
 */
import { ForgeBox, MiniButton } from "@/components/forge/ForgeBox";
import { useForgeAgents, useForgeConfig, useForgeTick } from "@/hooks/use-forge";
import { forgeCounts, resetFactory, runDiagnostics } from "@/lib/forge/diagnostics";
import { emergencyActive, emergencyStop, releaseEmergency } from "@/lib/forge/runtime";
import { forgeDb, lastError, type Tone } from "@/lib/forge/db";
import { OctagonX, Power, Rocket, Stethoscope, Terminal } from "lucide-react";
import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useNavigate } from "react-router";
import { toast } from "sonner";

const CHIP: Record<Tone, string> = {
  good: "border-emerald-400/40 text-emerald-300",
  warn: "border-amber-400/40 text-amber-300",
  bad: "border-rose-400/40 text-rose-300",
  muted: "border-border/60 text-muted-foreground",
};

/* ------------------------------------------------------------------ box 9 */

export function HealthBox() {
  const tick = useForgeTick();
  const [running, setRunning] = useState(false);
  const [resetArmed, setResetArmed] = useState(false);

  // The stored report, the counters and the last error are all live rows —
  // they update the moment Full Diagnostics (or a reset) writes them.
  const report = useLiveQuery(() => forgeDb.diagnostics.get("last"), ["diagnostics", tick]);
  const counts = useLiveQuery(() => forgeCounts(), ["counts", tick]);
  const errorRow = useLiveQuery(async () => {
    const row = await lastError();
    return row
      ? {
          at: row.at,
          where: row.where,
          message: row.message,
          fresh: Date.now() - row.at < 24 * 60 * 60 * 1000,
        }
      : null;
  }, ["errors", tick]);

  const full = async () => {
    setRunning(true);
    try {
      const row = await runDiagnostics();
      const bad = row.results.filter((result) => result.tone === "bad").length;
      const warn = row.results.filter((result) => result.tone === "warn").length;
      toast(bad ? `Diagnostics finished — ${bad} problem(s), ${warn} warning(s).` : warn ? `Diagnostics finished — ${warn} warning(s), no failures.` : "Diagnostics finished — everything checked out.");
    } finally {
      setRunning(false);
    }
  };

  const factoryReset = async () => {
    if (!resetArmed) {
      setResetArmed(true);
      toast("Reset to Factory erases every project, key, log and switch. Press again to do it.");
      window.setTimeout(() => setResetArmed(false), 5000);
      return;
    }
    setResetArmed(false);
    setRunning(true);
    try {
      await resetFactory();
      toast.success("The forge is back to factory state.");
    } finally {
      setRunning(false);
    }
  };

  const tone: Tone = !report
    ? "muted"
    : report.results.some((result) => result.tone === "bad")
      ? "bad"
      : report.results.some((result) => result.tone === "warn")
        ? "warn"
        : "good";

  const freshError = errorRow?.fresh ?? false;

  return (
    <ForgeBox
      id="forge-health"
      icon={Stethoscope}
      title="System Health & Diagnostics"
      light={{
        tone,
        value: !report ? "NOT RUN" : tone === "bad" ? "PROBLEMS FOUND" : tone === "warn" ? "WARNINGS" : "ALL CLEAR",
        note: report ? `Report from ${new Date(report.at).toLocaleString()}.` : "Press Full Diagnostics to run every check.",
      }}
      onRefresh={() => {
        if (report) {
          toast(`Report from ${new Date(report.at).toLocaleString()} — ${report.results.length} checks, ${Object.values(report.counts).reduce((total, value) => total + value, 0)} rows stored.`);
        } else {
          toast("No report yet — press Full Diagnostics to run every check.");
        }
      }}
      test={{ label: running ? "Running…" : "Full Diagnostics", onTest: full }}
      testing={running}
      hint="Each line is a check that really ran in this browser — the origin, the network, the store, the vault, the lights, the agents."
    >
      {report ? (
        <ul className="flex flex-col gap-1">
          {report.results.map((result) => (
            <li key={result.id} className="flex items-start gap-2 text-[10px] leading-4">
              <span className={`mt-px shrink-0 rounded-full border px-1.5 py-px text-[8px] font-semibold tracking-wide ${CHIP[result.tone]}`}>
                {result.tone.toUpperCase()}
              </span>
              <span className="w-44 shrink-0 font-medium text-foreground/90">{result.label}</span>
              <span className="min-w-0 flex-1 text-muted-foreground">{result.detail}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[10px] text-muted-foreground">
          No report yet. Full Diagnostics runs the whole battery and stores the result here.
        </p>
      )}

      {counts ? (
        <div className="mt-3 flex flex-wrap gap-1.5 border-t border-border/50 pt-3">
          {Object.entries(counts).map(([name, value]) => (
            <span
              key={name}
              className="rounded-full border border-border/60 bg-background/40 px-2 py-0.5 text-[9px] text-muted-foreground"
            >
              {name}: <span className="text-foreground">{value}</span>
            </span>
          ))}
        </div>
      ) : null}

      <div className="mt-3 rounded-xl border border-border/60 bg-background/50 p-2">
        <p className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
          Last error
        </p>
        <p className={`mt-1 break-words text-[10px] leading-4 ${freshError ? "text-amber-300" : "text-muted-foreground"}`}>
          {errorRow
            ? `${new Date(errorRow.at).toLocaleString()} — ${errorRow.where}: ${errorRow.message}`
            : "Nothing has been recorded."}
        </p>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/50 pt-3">
        <MiniButton onClick={factoryReset} disabled={running} title="Erase every forge table, key and switch (two presses)">
          <Power className="size-3 text-amber-300" />
          {resetArmed ? "press again to erase everything" : "Reset to Factory"}
        </MiniButton>
        <span className="text-[9px] text-muted-foreground">
          Projects, keys, logs, chats and switches — all of it, back to a fresh install.
        </span>
      </div>
    </ForgeBox>
  );
}

/* ---------------------------------------------------------------- box 10 */

export function QuickActionsBox() {
  const navigate = useNavigate();
  const config = useForgeConfig();
  const agents = useForgeAgents();
  const [stopped, setStopped] = useState(false);
  const [stopArmed, setStopArmed] = useState(false);

  useEffect(() => {
    void emergencyActive().then((value) => setStopped(value));
  }, [config.emergencyStopped]);

  const running = agents.filter((agent) => agent.status === "running").length;

  const engage = async () => {
    if (!stopArmed) {
      setStopArmed(true);
      toast("Emergency Stop kills every agent and tears down the sandbox. Press again to engage.");
      window.setTimeout(() => setStopArmed(false), 5000);
      return;
    }
    setStopArmed(false);
    await emergencyStop();
    setStopped(true);
    toast.success("Emergency Stop engaged — all agents stopped, sandbox torn down.");
  };

  const release = async () => {
    await releaseEmergency();
    setStopped(false);
    toast.success("Emergency Stop released. The sandbox can boot again.");
  };

  const tone: Tone = stopped ? "bad" : running ? "good" : "muted";
  const value = stopped ? "STOPPED" : running ? `${running} RUNNING` : "READY";

  return (
    <ForgeBox
      id="forge-quick"
      icon={Rocket}
      title="Quick Actions"
      light={{ tone, value, note: stopped ? "The forge is locked until the stop is released." : "Nothing running — the forge is idle." }}
      onRefresh={() => void emergencyActive().then((value_) => setStopped(value_))}
      test={{ label: stopped ? "Release Stop" : "Stop All Agents", onTest: stopped ? release : engage }}
      hint="One press of Start New Build opens the AI Builder with a fresh session; Continue picks the last one up where it stopped."
    >
      <div className="flex flex-wrap items-center gap-2">
        <MiniButton onClick={() => navigate("/ai-builder", { state: { action: "new" } })} title="Open the AI Builder with a fresh session">
          <Rocket className="size-3" />
          Start New Build
        </MiniButton>
        <MiniButton onClick={() => navigate("/ai-builder", { state: { action: "continue" } })} title="Open the AI Builder on the most recent session">
          <Terminal className="size-3" />
          Continue Session
        </MiniButton>
        <MiniButton onClick={() => navigate("/ai-builder", { state: { action: "workspace" } })} title="Open the AI Builder with the file workspace in front">
          <Stethoscope className="size-3" />
          Open Workspace
        </MiniButton>

        <span className="ml-auto">
          <MiniButton onClick={engage} title="Stop every agent and tear down the sandbox (two presses)">
            <OctagonX className="size-3 text-amber-300" />
            {stopArmed ? "press again to stop everything" : "Emergency Stop All Agents"}
          </MiniButton>
        </span>
      </div>

      {stopped ? (
        <div className="mt-2 rounded-xl border border-amber-400/40 bg-amber-400/10 p-2 text-[10px] leading-4 text-amber-200">
          Emergency Stop is engaged. The pipeline refuses to start and the sandbox stays down until
          it is released (the button above turns into Release Stop).
        </div>
      ) : null}
    </ForgeBox>
  );
}
