import { Button } from "@/components/ui/button";
import {
  useAgentLogs,
  useForgeAgents,
  useForgeApps,
  useForgeSessions,
  useSandbox,
} from "@/hooks/use-forge";
import { downloadText } from "@/lib/download";
import { stopRun } from "@/lib/forge/runtime";
import { cn } from "@/lib/utils";
import {
  ArrowDown,
  ArrowDownToLine,
  Ban,
  CircleAlert,
  Eraser,
  FileCode2,
  Pause,
  Play,
  Save,
  Square,
  Terminal,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

/**
 * The Build Code Log: what the crew is doing, as it does it.
 *
 * A build is a long thing — an agent reads the brief, another shapes the files,
 * another writes them, the sandbox builds what was written — and until now the
 * only sign of it was a spinner and a finished sentence. This box is the live
 * terminal of that work, and every line in it is written while the work runs:
 *
 *  * **the crew's own words** — every line the pipeline writes with `logAgent`,
 *    tagged with the agent that said it, which is the step-by-step reasoning as
 *    the code is being generated;
 *  * **the sandbox's output** — what the build engine prints while it reads the
 *    files, resolves references, checks syntax and reports what it found.
 *
 * Nothing here is invented and nothing is replayed: the rows are appended as the
 * two sources grow, in the order they arrived. It says which app the lines are
 * about, too — the one on the bench, named in the header — because a log of a
 * build is only a *build* log if it says what is being built, and that name is
 * a link straight to the app in the Preview & Test Sandbox.
 *
 * Four controls, and each one does what it says:
 *
 *  * **Auto-scroll** — follow the newest line, or stop following and read.
 *  * **Clear** — empty the view. It hides what is shown rather than deleting it;
 *    the record stays where it was written, and the next line arrives as usual.
 *  * **Export** — save the whole log as a .txt file, so a build that went wrong
 *    can be read somewhere else.
 *  * **Stop / Pause** — Pause freezes the view (the run keeps going); Stop ends
 *    the run itself, through the same controller the prompt box started it with.
 */

type FeedRow = {
  key: string;
  at: number;
  /** Who said it: an agent's name, or `sandbox` for the engine's own output. */
  who: string;
  text: string;
  kind: "agent" | "sandbox" | "error";
};

/** The most lines the box holds. Older ones fall off the top. */
const MAX_FEED = 400;

function clock(at: number) {
  return new Date(at).toLocaleTimeString([], { hour12: false });
}

export function BuilderBuildLog() {
  const agents = useForgeAgents();
  const apps = useForgeApps();
  const sessions = useForgeSessions("builder");
  const sessionId = sessions?.[0]?.id ?? null;
  const logRows = useAgentLogs(sessionId);
  // The live query answers `undefined` until its first read; an empty array is
  // the same answer and keeps the feed effect from re-running for a new one.
  const logs = useMemo(() => logRows ?? [], [logRows]);
  const sandbox = useSandbox();

  const [feed, setFeed] = useState<FeedRow[]>([]);
  const [paused, setPaused] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);

  /** How much of each source has been taken into the feed already. */
  const takenLogs = useRef(0);
  const takenLines = useRef(0);
  /**
   * Whether the box has caught up with the world once already.
   *
   * A builder session keeps every line it has ever written, and the sandbox
   * keeps the tail of what it last printed. A *live* log should not open by
   * replaying yesterday's build, so the first pass takes the current lengths as
   * the starting line and shows nothing — and from then on, everything is news.
   */
  const caughtUp = useRef(false);

  const names = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent.name] as const)),
    [agents],
  );

  const running = agents.some((agent) => agent.status === "running");
  // Which app these lines are about. The bench is what the crew is editing,
  // so naming it here is the one thing that makes the log a *build* log
  // rather than a stream of sentences — and it is a link to the app itself.
  const benchApp = useMemo(
    () => (apps ?? []).find((app) => app.id === sandbox.mounted) ?? null,
    [apps, sandbox.mounted],
  );

  // Two sources grow independently; both are taken in the order they arrived.
  // Paused, the counters are left where they are, so Resuming catches up rather
  // than losing what happened while somebody was reading.
  useEffect(() => {
    if (paused) return;

    // The first answer from the log table is history, not news: start from it.
    if (!caughtUp.current && logRows !== undefined) {
      caughtUp.current = true;
      takenLogs.current = logs.length;
      takenLines.current = sandbox.lines.length;
      return;
    }

    // A different session (or a cleared table) means starting over rather than
    // reading past the end of a shorter list.
    if (logs.length < takenLogs.current) takenLogs.current = 0;

    const fresh: FeedRow[] = [];

    for (const row of logs.slice(takenLogs.current)) {
      fresh.push({
        key: `agent-${row.id ?? `${row.sessionId}-${row.at}-${row.text.slice(0, 12)}`}`,
        at: row.at,
        who: names.get(row.agent) ?? row.agent,
        text: row.text,
        kind: /error|failed|cannot|could not/i.test(row.text) ? "error" : "agent",
      });
    }
    takenLogs.current = logs.length;

    const lines = sandbox.lines;
    if (lines.length < takenLines.current) takenLines.current = 0;
    const now = Date.now();
    lines.slice(takenLines.current).forEach((line, index) => {
      fresh.push({
        key: `sandbox-${takenLines.current + index}-${line.slice(0, 16)}`,
        at: now,
        who: "sandbox",
        text: line,
        kind: /error|failed|cannot|could not|problem/i.test(line)
          ? "error"
          : "sandbox",
      });
    });
    takenLines.current = lines.length;

    if (fresh.length) {
      setFeed((current) => [...current, ...fresh].slice(-MAX_FEED));
    }
  }, [logs, logRows, sandbox.lines, paused, names]);

  const scroller = useRef<HTMLDivElement>(null);

  // Follow the newest line, but only while somebody asked to follow it.
  useEffect(() => {
    if (!autoScroll || paused) return;
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [feed, autoScroll, paused]);

  const clear = () => {
    setFeed([]);
    takenLogs.current = logs.length;
    takenLines.current = sandbox.lines.length;
    toast("The log is cleared. The next line the crew writes appears as usual.");
  };

  const exportLog = () => {
    const text = feed
      .map((row) => `${clock(row.at)}  [${row.who}] ${row.text}`)
      .join("\n");
    if (downloadText("build-log", text)) {
      toast.success(`Saved ${feed.length} line(s) as build-log.txt.`);
    } else {
      toast.error("There is nothing in the log to save yet.");
    }
  };

  const stop = () => {
    if (stopRun()) toast("Stopping — the crew ends at its next check.");
    else toast("Nothing is running to stop.");
  };

  return (
    <section
      id="builder-log"
      className="flex h-full min-h-0 scroll-mt-4 flex-col overflow-hidden rounded-2xl border border-white/20 bg-black/70 backdrop-blur-sm"
    >
      {/* -------------------------------------------------------- header */}
      <header className="flex flex-wrap items-center gap-2 border-b border-white/10 px-3 py-2">
        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-white/10 text-white">
          <Terminal className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 truncate text-[11px] font-semibold tracking-tight text-white">
            <span className="grid size-4 shrink-0 place-items-center rounded-full border border-white/30 text-[8px] font-medium text-white/80">
              2
            </span>
            Build Code Log
          </p>
          <p className="truncate text-[9px] text-white/50">
            {running
              ? "The crew is working — every step is printed here as it happens"
              : "Every step the crew takes, and what the sandbox said about it"}
          </p>
        </div>

        <span
          className={cn(
            "flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-1 text-[9px]",
            running
              ? "border-emerald-400/40 text-emerald-200/90"
              : "border-white/15 text-white/50",
          )}
        >
          <span
            className={cn(
              "size-1.5 rounded-full",
              running ? "animate-pulse bg-emerald-400/80" : "bg-white/30",
            )}
          />
          {running ? "running" : feed.length ? `${feed.length} lines` : "idle"}
        </span>

        {/* Which app these lines are about, and the way to the app itself —
            the chain said out loud: this log is the build of that app. */}
        {benchApp ? (
          <a
            href="#builder-preview"
            title={`The crew is working on “${benchApp.name}” — press to see it in the preview`}
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-1 text-[9px] transition-colors hover:border-white/40 hover:text-white",
              benchApp.build.ok
                ? "border-white/20 text-white/70"
                : "border-dashed border-white/25 text-white/60",
            )}
          >
            <FileCode2 className="size-3" />
            <span className="max-w-40 truncate">{benchApp.name}</span>
            <span className="text-white/40">
              {benchApp.build.ok ? "builds" : `${benchApp.build.errors.length} problem(s)`}
            </span>
            <ArrowDown className="size-3" />
          </a>
        ) : null}

        {/* ------------------------------------------------------ controls */}
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setAutoScroll((on) => !on)}
            aria-pressed={autoScroll}
            title={
              autoScroll
                ? "Following the newest line — press to stop following"
                : "Not following — press to follow the newest line again"
            }
            className="h-7 cursor-pointer rounded-lg border-white/20 bg-white/5 text-[10px] text-white hover:bg-white/10"
          >
            <ArrowDownToLine className="size-3" />
            Auto-Scroll
            <span className="text-white/50">{autoScroll ? "on" : "off"}</span>
          </Button>

          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={clear}
            disabled={feed.length === 0}
            title="Empty the view — the record itself is untouched"
            className="h-7 cursor-pointer rounded-lg border-white/20 bg-white/5 text-[10px] text-white hover:bg-white/10"
          >
            <Eraser className="size-3" />
            Clear Logs
          </Button>

          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={exportLog}
            disabled={feed.length === 0}
            title="Save the whole log as a .txt file"
            className="h-7 cursor-pointer rounded-lg border-white/20 bg-white/5 text-[10px] text-white hover:bg-white/10"
          >
            <Save className="size-3" />
            Export Logs
          </Button>

          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setPaused((on) => !on)}
            aria-pressed={paused}
            title={
              paused
                ? "The view is frozen — press to follow it again"
                : "Freeze the view while the run carries on"
            }
            className="h-7 cursor-pointer rounded-lg border-white/20 bg-white/5 text-[10px] text-white hover:bg-white/10"
          >
            {paused ? <Play className="size-3" /> : <Pause className="size-3" />}
            {paused ? "Resume" : "Pause"}
          </Button>

          {running ? (
            <Button
              type="button"
              size="sm"
              onClick={stop}
              title="End the run the prompt box started"
              className="h-7 cursor-pointer rounded-lg bg-white text-[10px] text-black hover:bg-white/85"
            >
              <Square className="size-3" />
              Stop
            </Button>
          ) : null}
        </div>
      </header>

      {/* ---------------------------------------------------------- feed */}
      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-2 font-mono text-[10px] leading-4.5"
        role="log"
        aria-live="polite"
        aria-label="Build code log"
      >
        {feed.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 py-6 text-center">
            <Terminal className="size-4 text-white/30" />
            <p className="text-[10px] text-white/60">Nothing in the log yet</p>
            <p className="max-w-[46ch] text-[9px] leading-4 text-white/40">
              Press Generate App in the prompt studio above and every step the
              crew takes prints here — what each agent is doing, and what the
              sandbox said when it built what they wrote.
            </p>
          </div>
        ) : (
          feed.map((row) => (
            <div key={row.key} className="flex items-start gap-2 py-0.5">
              <span className="shrink-0 tabular-nums text-white/30">
                {clock(row.at)}
              </span>
              <span
                className={cn(
                  "shrink-0 font-semibold",
                  row.kind === "error"
                    ? "text-destructive/80"
                    : row.who === "sandbox"
                      ? "text-white/40"
                      : "text-white/75",
                )}
              >
                {row.who}
              </span>
              <span
                className={cn(
                  "min-w-0 flex-1 break-words whitespace-pre-wrap",
                  row.kind === "error" ? "text-destructive/80" : "text-white/70",
                )}
              >
                {row.text}
              </span>
            </div>
          ))
        )}
      </div>

      {/* The truth about what the buttons do, said once. */}
      <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-white/10 px-3 py-1.5 text-[9px] text-white/40">
        <span className="flex items-center gap-1">
          {paused ? (
            <>
              <Ban className="size-3" />
              The view is frozen; the run is still going.
            </>
          ) : (
            <>
              <CircleAlert className="size-3" />
              Clear hides what is shown; the log is written by the run itself.
            </>
          )}
        </span>
        <span className="ml-auto tabular-nums">
          {feed.length ? `${feed.length} line(s)` : "no lines"}
        </span>
      </footer>
    </section>
  );
}
