import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Panel, Stat } from "@/components/BrainPanel";
import { cn } from "@/lib/utils";
import { humanBytes, since, type BrainClient, type PackageReport, type TaskList } from "@/lib/local-brain";
import {
  BrainCircuit,
  CalendarClock,
  Check,
  Cpu,
  HardDriveDownload,
  Loader2,
  Package,
  Pause,
  Play,
  RefreshCw,
  ShieldCheck,
  Terminal,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

/**
 * The two panels that are about the machine rather than about asking it things.
 *
 * **Tasks** is the clock: work the brain does on its own, because a system that
 * only answers when spoken to is a tool, not an assistant. **Packages** is the
 * inventory: what is installed, what the package's own installers would add, and
 * — the part that matters most — which outside capability could be replaced by
 * something running on this machine instead.
 *
 * Both are thin views over endpoints the brain already serves, so nothing here
 * is a second implementation of the schedule or the inventory.
 */

/** "in 3 min" — the mirror of `since`, for something still to come. */
function until(when: number | null | undefined): string {
  if (!when) return "not scheduled";
  const seconds = Math.max(0, Math.floor(when - Date.now() / 1000));
  if (seconds < 45) return "any moment now";
  if (seconds < 3600) return `in ${Math.round(seconds / 60)} min`;
  if (seconds < 86_400) return `in ${Math.round(seconds / 3600)} h`;
  return `in ${Math.round(seconds / 86_400)} d`;
}

/** How a task reads in one line: the question it asks, or the tool it runs. */
function taskSubject(task: { kind: string; payload: unknown }): string {
  if (task.kind === "ask") return String(task.payload ?? "");
  const payload = (task.payload ?? {}) as { tool?: string; args?: Record<string, unknown> };
  const args =
    payload.args && Object.keys(payload.args).length ? ` ${JSON.stringify(payload.args)}` : "";
  return `${payload.tool ?? "a tool"}${args}`;
}

export function TasksPanel({
  client,
  bundle,
  onDone,
}: {
  client: BrainClient;
  bundle: { tasks: TaskList };
  onDone: () => Promise<void>;
}) {
  const { tasks, runner, examples } = bundle.tasks;
  const [name, setName] = useState("");
  const [when, setWhen] = useState("every 15 minutes");
  const [kind, setKind] = useState<"ask" | "tool">("ask");
  const [payload, setPayload] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const add = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("Give the task a name first.");
      return;
    }
    let body: unknown = payload.trim();
    if (kind === "tool") {
      try {
        body = JSON.parse(payload || "{}");
      } catch {
        toast.error('A tool task needs JSON, like {"tool":"fs.read","args":{"path":"notes.md"}}.');
        return;
      }
    }
    setBusy("add");
    try {
      const result = await client.addTask({ name: trimmed, when, kind, payload: body });
      toast.success(`${result.task.name}: ${result.task.schedule}`);
      setName("");
      setPayload("");
      await onDone();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "The brain would not take that schedule.",
      );
    } finally {
      setBusy(null);
    }
  };

  const runNow = async (id: number, label: string) => {
    setBusy(`run:${id}`);
    try {
      const result = await client.runTask(id);
      if (result.ok) toast.success(result.result || `${label} finished.`);
      else toast.error(result.error ?? `${label} failed.`);
      await onDone();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "That task could not run.");
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (id: number, enabled: boolean) => {
    setBusy(`toggle:${id}`);
    try {
      await client.setTaskEnabled(id, enabled);
      await onDone();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not change that task.");
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: number, label: string) => {
    setBusy(`remove:${id}`);
    try {
      await client.removeTask(id);
      toast.success(`Removed ${label}.`);
      await onDone();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not remove that task.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <Panel delay={0.02}>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="flex items-center gap-1.5 text-[12px] font-semibold tracking-tight">
            <CalendarClock className="size-3.5" />
            The clock it owns
          </h2>
          <Badge variant="outline" className="rounded-full text-[9px]">
            {runner.running ? `ticking every ${runner.tickSeconds}s` : "paused"}
          </Badge>
          <Badge variant="outline" className="rounded-full text-[9px]">
            {runner.enabled} of {runner.tasks} enabled
          </Badge>
          {runner.lastTick ? (
            <span className="text-[10px] text-muted-foreground">
              last looked {since(runner.lastTick)}
            </span>
          ) : null}
        </div>
        <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
          Work the brain does without being asked. The schedule lives in the same SQLite file as
          the memory, so it survives a restart, and a missed run is not a backlog — the next one
          is counted from the moment the machine came back.
        </p>

        <div className="mt-3 rounded-xl border border-border/70 bg-background/30 p-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="a name, e.g. nightly-tests"
              className="h-9 rounded-lg text-[11px]"
            />
            <Input
              value={when}
              onChange={(event) => setWhen(event.target.value)}
              placeholder="every 15 minutes"
              className="h-9 rounded-lg text-[11px]"
            />
          </div>

          <div className="mt-2 flex flex-wrap gap-1.5">
            {examples.map((example) => (
              <button
                key={example}
                type="button"
                onClick={() => setWhen(example)}
                className="cursor-pointer rounded-full border border-border/70 px-2.5 py-1 text-[9px] text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
              >
                {example}
              </button>
            ))}
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {(["ask", "tool"] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setKind(option)}
                className={cn(
                  "cursor-pointer rounded-full border px-2.5 py-1 text-[9px] transition-colors",
                  kind === option
                    ? "border-white/40 text-foreground"
                    : "border-border/70 text-muted-foreground hover:bg-white/5",
                )}
              >
                {option === "ask" ? "ask a question" : "run a tool"}
              </button>
            ))}
          </div>

          <Textarea
            value={payload}
            onChange={(event) => setPayload(event.target.value)}
            rows={2}
            placeholder={
              kind === "ask"
                ? "what to ask, e.g. summarise the notes in my workspace"
                : '{"tool":"fs.read","args":{"path":"notes/today.md"}}'
            }
            className="mt-2 min-h-16 rounded-lg text-[11px]"
          />

          <Button
            type="button"
            onClick={() => void add()}
            disabled={busy === "add"}
            className="mt-2 h-9 w-full cursor-pointer rounded-lg text-[11px] sm:w-auto"
          >
            {busy === "add" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Play className="size-3.5" />
            )}
            Put it on the clock
          </Button>
        </div>
      </Panel>

      <Panel delay={0.04}>
        <h2 className="text-[12px] font-semibold tracking-tight">
          {tasks.length
            ? `${tasks.length} task${tasks.length === 1 ? "" : "s"}`
            : "Nothing on the clock yet"}
        </h2>
        {tasks.length ? (
          <ul className="mt-1.5 divide-y divide-border/60">
            {tasks.map((task) => (
              <li key={task.id} className="flex flex-col gap-2 py-2.5 sm:flex-row sm:items-start">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] font-medium">{task.name}</span>
                    <Badge variant="outline" className="rounded-full text-[9px]">
                      {task.schedule}
                    </Badge>
                    <span
                      className={cn(
                        "rounded-full border px-1.5 py-px text-[8px]",
                        task.enabled ? "border-white/40" : "border-border/60 text-muted-foreground",
                      )}
                    >
                      {task.enabled ? "on" : "paused"}
                    </span>
                  </div>
                  <p
                    className="mt-1 truncate text-[10px] text-muted-foreground"
                    title={taskSubject(task)}
                  >
                    {taskSubject(task)}
                  </p>
                  <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
                    {task.enabled ? `next ${until(task.next_run)}` : "paused"}
                    {task.runs
                      ? ` · ${task.runs} run${task.runs === 1 ? "" : "s"}, last ${since(task.last_run)}`
                      : " · never run"}
                    {task.lastOk === false ? " · last time failed" : ""}
                  </p>
                  {task.last_error ? (
                    <p
                      className="mt-0.5 truncate text-[10px] text-muted-foreground"
                      title={task.last_error}
                    >
                      {task.last_error}
                    </p>
                  ) : null}
                  {task.lastOk && task.last_result ? (
                    <p className="mt-0.5 line-clamp-2 text-[10px] leading-4 text-muted-foreground">
                      {task.last_result}
                    </p>
                  ) : null}
                </div>

                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    type="button"
                    variant="outline"
                    className="h-8 cursor-pointer rounded-lg text-[10px]"
                    disabled={busy === `run:${task.id}`}
                    onClick={() => void runNow(task.id, task.name)}
                  >
                    {busy === `run:${task.id}` ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <Play className="size-3" />
                    )}
                    Run now
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-8 cursor-pointer rounded-lg text-[10px]"
                    disabled={busy === `toggle:${task.id}`}
                    onClick={() => void toggle(task.id, !task.enabled)}
                  >
                    {task.enabled ? <Pause className="size-3" /> : <Play className="size-3" />}
                    {task.enabled ? "Pause" : "Resume"}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-8 cursor-pointer rounded-lg px-2 text-[10px]"
                    disabled={busy === `remove:${task.id}`}
                    onClick={() => void remove(task.id, task.name)}
                  >
                    {busy === `remove:${task.id}` ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <Trash2 className="size-3" />
                    )}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
            A schedule is a question or a tool call, and nothing else — the two things the rest of
            the brain already knows how to do. `python3 brain/brain.py schedule add ...` puts one
            on the clock without this page too.
          </p>
        )}
      </Panel>
    </div>
  );
}

export function PackagesPanel({
  client,
  bundle,
  onDone,
}: {
  client: BrainClient;
  bundle: { packages: PackageReport };
  onDone: () => Promise<void>;
}) {
  const report = bundle.packages;
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const run = async (installer: string) => {
    setConfirming(null);
    setBusy(installer);
    toast(`Running ${installer} — this can take a while.`);
    try {
      const result = (await client.runInstaller(installer)) as {
        ok?: boolean;
        error?: string;
        ms?: number;
      };
      if (result.ok === false) toast.error(result.error ?? `${installer} failed.`);
      else toast.success(`${installer} finished in ${Math.round((result.ms ?? 0) / 1000)}s.`);
      await onDone();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `${installer} failed.`);
    } finally {
      setBusy(null);
    }
  };

  const recheck = async () => {
    setRefreshing(true);
    try {
      await client.updates(true);
      await onDone();
      toast.success("Re-probed this machine.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not look again.");
    } finally {
      setRefreshing(false);
    }
  };

  const tools = Object.entries(report.inventory.tools);
  const languages = Object.entries(report.inventory.languages);

  return (
    <div className="flex flex-col gap-3">
      <Panel delay={0.02}>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="flex items-center gap-1.5 text-[12px] font-semibold tracking-tight">
            <Package className="size-3.5" />
            What is installed here
          </h2>
          <Badge variant="outline" className="rounded-full text-[9px]">
            {report.independence.independent} independent
          </Badge>
          {report.independence.couldBeReplaced ? (
            <Badge variant="outline" className="rounded-full text-[9px]">
              {report.independence.couldBeReplaced} could be local
            </Badge>
          ) : null}
          <Button
            type="button"
            variant="outline"
            className="ml-auto h-8 cursor-pointer rounded-lg text-[10px]"
            disabled={refreshing}
            onClick={() => void recheck()}
          >
            {refreshing ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <RefreshCw className="size-3" />
            )}
            Look again
          </Button>
        </div>
        <p className="mt-1 text-[10px] leading-4 text-muted-foreground">{report.note}</p>

        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat
            label="Brain"
            value={report.inventory.brain}
            note={report.packagePresent ? "package on disk" : "package missing"}
            icon={BrainCircuit}
          />
          <Stat
            label="Python"
            value={report.inventory.python ?? "missing"}
            note={report.inventory.kernel ?? ""}
            icon={Terminal}
          />
          <Stat label="Tools" value={`${tools.length}`} note="found on PATH" icon={Wrench} />
          <Stat label="Runtimes" value={`${languages.length}`} note="ready to run code" icon={Cpu} />
        </div>

        {report.changes.length ? (
          <div className="mt-3 rounded-xl border border-border/70 bg-background/30 p-3">
            <h3 className="text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Moves since the last look
            </h3>
            <ul className="mt-1 flex flex-col gap-1">
              {report.changes.map((line) => (
                <li key={line} className="text-[10px] leading-4 text-muted-foreground">
                  {line}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {report.suggestions.length ? (
          <div className="mt-3">
            <h3 className="text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Worth installing
            </h3>
            <ul className="mt-1 divide-y divide-border/60">
              {report.suggestions.map((row) => (
                <li
                  key={row.missing}
                  className="flex flex-col gap-0.5 py-2 sm:flex-row sm:items-baseline sm:gap-2"
                >
                  <code className="shrink-0 text-[11px] sm:w-28">{row.missing}</code>
                  <span className="min-w-0 flex-1 text-[10px] leading-4 text-muted-foreground">
                    {row.why}
                  </span>
                  <code className="shrink-0 text-[10px] text-muted-foreground">{row.install}</code>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Panel>

      <Panel delay={0.04}>
        <h2 className="flex items-center gap-1.5 text-[12px] font-semibold tracking-tight">
          <ShieldCheck className="size-3.5" />
          What could be yours instead
        </h2>
        <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
          {report.independence.summary}. Each line names the capability, what is answering it now,
          and the installer or setting that would move it onto this machine.
        </p>

        {report.independence.capabilities.length ? (
          <ul className="mt-2 flex flex-col gap-2">
            {report.independence.capabilities.map((entry) => (
              <li
                key={entry.capability}
                className="rounded-xl border border-border/70 bg-background/30 px-3 py-2.5"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[11px] font-medium">{entry.capability}</span>
                  <Badge
                    variant="outline"
                    className={cn(
                      "rounded-full text-[9px]",
                      entry.independent ? "border-white/40" : "border-dashed",
                    )}
                  >
                    {entry.independent ? "independent" : "could be local"}
                  </Badge>
                  <span className="text-[10px] text-muted-foreground">
                    {entry.inUse.length ? `using ${entry.inUse.join(", ")}` : "nothing connected"}
                  </span>
                </div>
                {entry.use ? (
                  <p className="mt-1 text-[10px] leading-4">
                    Instead of {entry.instead || "a hosted service"}: <strong>{entry.use}</strong>
                  </p>
                ) : null}
                {entry.how ? (
                  <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">{entry.how}</p>
                ) : null}
                {entry.note ? (
                  <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">{entry.note}</p>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-[10px] leading-4 text-muted-foreground">
            Nothing is configured yet, so there is nothing to replace. Connect something in the
            Connectors tab and it will show up here next to its local alternative.
          </p>
        )}
      </Panel>

      <Panel delay={0.06}>
        <h2 className="flex items-center gap-1.5 text-[12px] font-semibold tracking-tight">
          <HardDriveDownload className="size-3.5" />
          The package's own installers
        </h2>
        <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
          These are the scripts sitting next to the brain — the ones already on your drive. An
          update run executes one of them and nothing else: no repository to fetch, no account to
          sign into, so this works with the cable out.
        </p>

        <ul className="mt-2 divide-y divide-border/60">
          {report.installers.map((installer) => (
            <li
              key={installer.name}
              className="flex flex-col gap-2 py-2.5 sm:flex-row sm:items-center"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <code className="text-[11px]">{installer.name}</code>
                  <span className="text-[9px] text-muted-foreground">
                    {humanBytes(installer.bytes)}
                  </span>
                </div>
                <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
                  {installer.purpose}
                </p>
              </div>

              {confirming === installer.name ? (
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    type="button"
                    className="h-8 cursor-pointer rounded-lg text-[10px]"
                    disabled={busy === installer.name}
                    onClick={() => void run(installer.name)}
                  >
                    {busy === installer.name ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <Check className="size-3" />
                    )}
                    Yes, run it
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-8 cursor-pointer rounded-lg px-2 text-[10px]"
                    onClick={() => setConfirming(null)}
                  >
                    <X className="size-3" />
                  </Button>
                </div>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  className="h-8 shrink-0 cursor-pointer rounded-lg text-[10px]"
                  disabled={busy !== null}
                  onClick={() => setConfirming(installer.name)}
                >
                  {busy === installer.name ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Play className="size-3" />
                  )}
                  Run
                </Button>
              )}
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
