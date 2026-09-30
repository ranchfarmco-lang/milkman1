import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  BrainClient,
  BrainError,
  CANDIDATE_URLS,
  DEFAULT_BRAIN_URL,
  clearConnection,
  discoverBrain,
  humanBytes,
  isUnreachable,
  loadConnection,
  normalizeUrl,
  saveConnection,
  since,
  type AskResult,
  type BrainHealth,
  type BrainStats,
  type BrainTool,
  type CapabilityMap,
  type Connector,
  type DiagnosticReport,
  type MemoryRow,
  type ModelServer,
  type TierStatus,
  type BrainEvent,
  type PackageReport,
  type TaskList,
} from "@/lib/local-brain";
import { cn } from "@/lib/utils";
import {
  Activity,
  AlertTriangle,
  BrainCircuit,
  Bug,
  CalendarClock,
  Check,
  CircuitBoard,
  Copy,
  Cpu,
  Database,
  Globe,
  HardDriveDownload,
  KeyRound,
  Layers,
  Loader2,
  Package,
  Plug,
  PlugZap,
  RefreshCw,
  Search,
  Send,
  Server,
  ShieldCheck,
  Sparkles,
  Terminal,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { Panel, Stat } from "@/components/BrainPanel";
import { BrowserBrainCard } from "@/components/BrowserBrainCard";
import { PackagesPanel, TasksPanel } from "@/components/BrainTasksPanels";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

/* ------------------------------------------------------------------- context */

type Tab =
  | "overview"
  | "ask"
  | "tools"
  | "tasks"
  | "memory"
  | "connectors"
  | "models"
  | "packages"
  | "diagnostics";

type Bundle = {
  health: BrainHealth;
  capabilities: CapabilityMap;
  stats: BrainStats;
  tools: BrainTool[];
  loaded: { loaded: string[]; broken: Record<string, string> };
  models: ModelServer[];
  modelHint: string;
  connectors: Connector[];
  connectorSummary: { total: number; ready: number; needingKeys: number };
  tiers: TierStatus[];
  diagnostics: DiagnosticReport;
  events: BrainEvent[];
  tasks: TaskList;
  packages: PackageReport;
};

const TABS: { id: Tab; label: string; icon: typeof Cpu }[] = [
  { id: "overview", label: "Overview", icon: Activity },
  { id: "ask", label: "Ask", icon: Sparkles },
  { id: "tools", label: "Tools", icon: Terminal },
  { id: "tasks", label: "Tasks", icon: CalendarClock },
  { id: "memory", label: "Memory", icon: Database },
  { id: "connectors", label: "Connectors", icon: Plug },
  { id: "models", label: "Models", icon: Server },
  { id: "packages", label: "Packages", icon: Package },
  { id: "diagnostics", label: "Diagnostics", icon: ShieldCheck },
];

/* --------------------------------------------------------------- small pieces */

/** One line of code with the button that puts it on the clipboard. */
function Command({ children, label }: { children: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-xl border border-border/70 bg-background/50 px-2.5 py-2">
      <Terminal className="size-3.5 shrink-0 text-muted-foreground" />
      <code className="min-w-0 flex-1 truncate text-[11px]">{children}</code>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={label ?? "Copy"}
        className="shrink-0 cursor-pointer text-muted-foreground hover:text-foreground"
        onClick={() => {
          void navigator.clipboard
            .writeText(children)
            .then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1600);
              toast.success("Copied.");
            })
            .catch(() => toast.error("This browser would not let me copy it — select it instead."));
        }}
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </Button>
    </div>
  );
}

function TierBadge({ tier }: { tier: Connector["tier"] }) {
  const label = { local: "on this machine", free: "no account", key: "needs a key", hosted: "hosted" }[tier];
  return (
    <span
      className={cn(
        "shrink-0 rounded-full border px-2 py-0.5 text-[9px] font-medium",
        tier === "local"
          ? "border-white/40 text-foreground"
          : tier === "free"
            ? "border-border/70 text-muted-foreground"
            : "border-dashed border-border/70 text-muted-foreground",
      )}
    >
      {label}
    </span>
  );
}

function LevelBadge({ level }: { level: "blocking" | "degraded" | "note" }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full border px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide",
        level === "blocking"
          ? "border-white bg-white text-black"
          : level === "degraded"
            ? "border-white/60 text-foreground"
            : "border-border/70 text-muted-foreground",
      )}
    >
      {level}
    </span>
  );
}

/** A JSON result, folded away until it is wanted. */
function Json({ value, label = "Result" }: { value: unknown; label?: string }) {
  const [open, setOpen] = useState(false);
  const text = useMemo(() => JSON.stringify(value, null, 2) ?? "", [value]);
  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        className="cursor-pointer text-[10px] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      >
        {open ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
      </button>
      {open ? (
        <pre className="mt-1.5 max-h-72 overflow-auto rounded-xl border border-border/70 bg-background/60 p-2.5 text-[10px] leading-4">
          {text}
        </pre>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ the page */

export default function LocalBrain() {
  const [url, setUrl] = useState(DEFAULT_BRAIN_URL);
  const [token, setToken] = useState("");
  const [status, setStatus] = useState<"searching" | "idle" | "connecting" | "connected">("searching");
  const [failure, setFailure] = useState<{
    message: string;
    hint: string;
    unreachable: boolean;
  } | null>(null);
  const [found, setFound] = useState<string | null>(null);
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [refreshing, setRefreshing] = useState(false);

  const client = useMemo(() => (token || url ? new BrainClient({ url, token }) : null), [url, token]);

  /** Everything the page draws, fetched together so the panels agree. */
  const loadEverything = useCallback(async (active: BrainClient) => {
    const [
      health,
      capabilities,
      stats,
      tools,
      models,
      connectors,
      hierarchy,
      diagnostics,
      events,
      tasks,
      packages,
    ] = await Promise.all([
      active.health(),
      active.capabilities(),
      active.stats(),
      active.tools(),
      active.models(),
      active.connectors(),
      active.hierarchy(),
      active.diagnostics(),
      active.events(25),
      active.tasks(),
      active.updates(),
    ]);
    setBundle({
      health,
      capabilities: capabilities.capabilities,
      stats,
      tools: tools.tools,
      loaded: tools.loaded,
      models: models.servers,
      modelHint: models.hint,
      connectors: connectors.connectors,
      connectorSummary: connectors.summary,
      tiers: hierarchy.tiers,
      diagnostics,
      events: events.events,
      tasks,
      packages,
    });
  }, []);

  const connect = useCallback(
    async (target: { url: string; token: string }, remember = true) => {
      setStatus("connecting");
      setFailure(null);
      const active = new BrainClient(target);
      try {
        // `pair` is the token check: a wrong token throws 401 here rather than
        // surfacing later as an empty memory list that looks like data loss.
        await active.pair();
      } catch (error) {
        setStatus("idle");
        setFailure({
          message: error instanceof Error ? error.message : "Could not pair.",
          hint: error instanceof BrainError ? error.hint : "",
          unreachable: isUnreachable(error),
        });
        return;
      }
      setUrl(target.url);
      setToken(target.token);
      if (remember) saveConnection(target);
      try {
        await loadEverything(active);
        setStatus("connected");
        toast.success("Paired with the brain on this machine.");
      } catch (error) {
        setStatus("connected");
        toast.error(error instanceof Error ? error.message : "Paired, but the panels could not load.");
      }
    },
    [loadEverything],
  );

  // On the way in: reuse the last pairing, or look for a brain that is running.
  useEffect(() => {
    let alive = true;
    const saved = loadConnection();
    if (saved) {
      setUrl(saved.url);
      setToken(saved.token);
      void connect(saved, false);
      return () => {
        alive = false;
      };
    }
    void discoverBrain().then((foundBrain) => {
      if (!alive) return;
      if (foundBrain) {
        setUrl(foundBrain.url);
        setFound(foundBrain.url);
        setStatus("idle");
      } else {
        setStatus("idle");
      }
    });
    return () => {
      alive = false;
    };
  }, [connect]);

  const refresh = async () => {
    if (!client) return;
    setRefreshing(true);
    try {
      await loadEverything(client);
      toast.success("Read again from the brain.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not read the brain.");
    } finally {
      setRefreshing(false);
    }
  };

  const disconnect = () => {
    clearConnection();
    setBundle(null);
    setToken("");
    setStatus("idle");
    setFailure(null);
    toast("Forgot the pairing. The brain itself was not touched.");
  };

  /* ------------------------------------------------------------- not connected */

  const row = bundle?.health;

  return (
    <div className="mx-auto flex h-full w-full max-w-5xl flex-col gap-3 overflow-y-auto p-3">
      {/* ------------------------------------------------------------- the head */}
      <Panel className="border-white/25">
        <div className="flex flex-wrap items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-white/10 text-white">
            <CircuitBoard className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="text-[13px] font-bold tracking-tight">Local Brain</h1>
            <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
              The half of this system that runs on your own machine: its own memory, its own
              tools, its own workspace, its own diagnostics — in Python 3 and nothing else. This
              page does not <em>contain</em> a brain; it pairs with the one running on your
              computer and shows you everything in it. Stop the brain and this page says so;
              start it again and your memory is exactly where you left it.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {status === "connected" && row ? (
              <span className="flex items-center gap-1.5 rounded-full border border-white/40 px-2.5 py-1 text-[10px] font-medium">
                <span className="size-1.5 rounded-full bg-white" />
                paired
              </span>
            ) : status === "connecting" || status === "searching" ? (
              <span className="flex items-center gap-1.5 rounded-full border border-border/70 px-2.5 py-1 text-[10px] text-muted-foreground">
                <Loader2 className="size-3 animate-spin" />
                {status === "searching" ? "looking" : "pairing"}
              </span>
            ) : (
              <span className="flex items-center gap-1.5 rounded-full border border-dashed border-border/70 px-2.5 py-1 text-[10px] text-muted-foreground">
                <X className="size-3" />
                not paired
              </span>
            )}
          </div>
        </div>

        {/* the connection bar */}
        <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto]">
          <Input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder={DEFAULT_BRAIN_URL}
            aria-label="Brain address"
            className="h-9 rounded-lg text-[11px]"
          />
          <Input
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="pairing token"
            aria-label="Pairing token"
            type="password"
            className="h-9 rounded-lg font-mono text-[11px]"
          />
          <Button
            type="button"
            className="h-9 cursor-pointer rounded-lg text-[11px]"
            disabled={status === "connecting"}
            onClick={() => void connect({ url: normalizeUrl(url), token })}
          >
            {status === "connecting" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <PlugZap className="size-3.5" />
            )}
            Pair
          </Button>
        </div>

        {found && status !== "connected" ? (
          <p className="mt-2 flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <Check className="size-3" />
            A brain is running at <span className="text-foreground">{found}</span>. Paste its
            pairing token and press Pair.
          </p>
        ) : null}

        {failure ? (
          <div className="mt-2 rounded-xl border border-border/70 bg-background/40 px-3 py-2">
            <p className="text-[11px] font-medium">{failure.message}</p>
            {failure.hint ? (
              <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">{failure.hint}</p>
            ) : null}
          </div>
        ) : null}

        {status === "connected" && bundle ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              className="h-8 cursor-pointer rounded-lg text-[11px]"
              disabled={refreshing}
              onClick={() => void refresh()}
            >
              {refreshing ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              Read it again
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="h-8 cursor-pointer rounded-lg text-[11px] text-muted-foreground hover:text-foreground"
              onClick={disconnect}
            >
              <X className="size-3.5" />
              Forget the pairing
            </Button>
            <span className="ml-auto text-[10px] text-muted-foreground">
              {bundle.health.product} {bundle.health.version} · protocol{" "}
              {bundle.health.protocol} · up {Math.max(1, Math.round(bundle.health.uptimeSeconds / 60))} min
            </span>
          </div>
        ) : null}
      </Panel>

      {/* ---------------------------------------------------------- run it first */}
      {status !== "connected" ? (
        <>
          <BrowserBrainCard />

          <Panel delay={0.03}>
            <h2 className="text-[12px] font-semibold tracking-tight">Run the brain on your machine</h2>
            <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
              It needs Python 3 and nothing else — no packages, no virtual environment, no
              account, no key. Get the package from the{" "}
              <a href="/offline-brain" className="text-foreground underline underline-offset-2">
                Offline Brain
              </a>{" "}
              page (everything is in there, the brain included), then in that folder:
            </p>
            <div className="mt-2 flex flex-col gap-2">
              <Command>python3 brain/brain.py serve</Command>
              <Command>python3 brain/brain.py pair</Command>
            </div>
            <p className="mt-2 text-[10px] leading-4 text-muted-foreground">
              <span className="text-foreground">serve</span> starts the API and prints the pairing
              token; <span className="text-foreground">pair</span> prints the address and the token
              again if you need them later. Paste both above, once — the pairing is remembered on
              this device.
            </p>
          </Panel>

          <Panel delay={0.06}>
            <h2 className="flex items-center gap-1.5 text-[12px] font-semibold tracking-tight">
              <Globe className="size-3.5" />
              If the browser will not let this page reach it
            </h2>
            <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
              A page served over <span className="text-foreground">https</span> is not normally
              allowed to call <span className="text-foreground">http://127.0.0.1</span>. The brain
              answers the browser's private-network preflight to allow it, and if your browser
              still refuses, there are three ways round it, all of them local:
            </p>
            <ul className="mt-2 flex flex-col gap-1.5">
              {[
                "Open the hub at its own address over http:// rather than https, then press Pair again.",
                "Use the brain from a terminal instead — `python3 brain/brain.py ask \"...\"` needs no browser at all.",
                "Run the brain with --host 0.0.0.0 on a machine you control and pair with its LAN address over http://.",
              ].map((line, index) => (
                <li key={line} className="flex items-start gap-2 text-[10px] leading-4 text-muted-foreground">
                  <span className="mt-px grid size-4 shrink-0 place-items-center rounded-full border border-border/60 text-[8px] text-foreground">
                    {index + 1}
                  </span>
                  <span className="min-w-0">{line}</span>
                </li>
              ))}
            </ul>
            {status === "idle" && failure?.unreachable ? (
              <p className="mt-2 text-[10px] leading-4 text-muted-foreground">
                Looked for one at {CANDIDATE_URLS.join(", ")}.
              </p>
            ) : null}
          </Panel>
        </>
      ) : null}

      {/* ------------------------------------------------------------ the panels */}
      {status === "connected" && bundle ? (
        <>
          <div className="flex shrink-0 items-center gap-1 overflow-x-auto rounded-xl border border-border/70 bg-card/50 p-1">
            {TABS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={cn(
                  "inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-medium transition-colors",
                  tab === id
                    ? "bg-white/10 text-foreground"
                    : "text-muted-foreground hover:bg-white/5 hover:text-foreground",
                )}
              >
                <Icon className="size-3.5" />
                {label}
              </button>
            ))}
          </div>

          {tab === "overview" ? <Overview bundle={bundle} /> : null}
          {tab === "ask" ? <Asker client={client!} /> : null}
          {tab === "tools" ? <ToolsPanel client={client!} bundle={bundle} onDone={refresh} /> : null}
          {tab === "tasks" ? <TasksPanel client={client!} bundle={bundle} onDone={refresh} /> : null}
          {tab === "memory" ? <MemoryPanel client={client!} onCount={refresh} /> : null}
          {tab === "connectors" ? (
            <ConnectorsPanel client={client!} bundle={bundle} onDone={refresh} />
          ) : null}
          {tab === "models" ? <ModelsPanel bundle={bundle} /> : null}
          {tab === "packages" ? <PackagesPanel client={client!} bundle={bundle} onDone={refresh} /> : null}
          {tab === "diagnostics" ? <DiagnosticsPanel client={client!} bundle={bundle} onDone={refresh} /> : null}
        </>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------- overview */

function Overview({ bundle }: { bundle: Bundle }) {
  const caps = bundle.capabilities;
  const stats = bundle.stats;
  const gpu = caps.gpus.map((entry) => `${entry.name}${entry.vramMb ? ` (${entry.vramMb} MB)` : ""}`).join(", ");

  return (
    <div className="flex flex-col gap-3">
      <Panel delay={0.02}>
        <h2 className="text-[12px] font-semibold tracking-tight">This machine</h2>
        <p className="mt-0.5 text-[10px] text-muted-foreground">
          Probed by the brain itself, {since(caps.at)}. Nothing here was sent anywhere to be
          found out.
        </p>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          <Stat label="System" value={caps.host.distro || caps.host.os} note={`kernel ${caps.host.kernel}`} icon={HardDriveDownload} />
          <Stat label="CPU" value={`${caps.cpu.cores} cores`} note={caps.cpu.model} icon={Cpu} />
          <Stat
            label="Memory"
            value={`${caps.memory.totalGb} GB`}
            note={`${Math.round(caps.memory.availableMb / 1024)} GB available`}
            icon={Layers}
          />
          <Stat
            label="GPU"
            value={gpu || "none detected"}
            note={gpu ? "local models can use it" : "models run on CPU"}
            icon={Server}
          />
          <Stat
            label="Workspace free"
            value={`${caps.disk.workspace?.freeGb ?? "?"} GB`}
            note={caps.sandbox.workspace}
            icon={HardDriveDownload}
          />
          <Stat
            label="Network"
            value={caps.network.online ? "up" : "offline"}
            note={caps.network.online ? "public sources reachable" : "local only — as designed"}
            icon={Globe}
          />
          <Stat
            label="Tools"
            value={`${bundle.tools.length}`}
            note={bundle.loaded.loaded.length ? `${bundle.loaded.loaded.length} written by the brain` : "all built in"}
            icon={Terminal}
          />
          <Stat label="Python" value={caps.host.python} note="the only thing it needs" icon={CircuitBoard} />
        </div>
      </Panel>

      <div className="grid gap-3 lg:grid-cols-2">
        <Panel delay={0.04}>
          <h2 className="flex items-center gap-1.5 text-[12px] font-semibold tracking-tight">
            <Database className="size-3.5" />
            Memory and workspace
          </h2>
          <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
            One SQLite file, owned by this machine. Conversations, facts, events, tool runs,
            snapshots and keys all live in it, and it reads without this software at all.
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Stat label="Remembered" value={`${stats.memory}`} note="things kept" />
            <Stat label="Tool runs" value={`${stats.toolRuns}`} note="recorded with their outcome" />
            <Stat label="Events" value={`${stats.events}`} note="the log" />
            <Stat
              label="Full-text search"
              value={stats.fts ? "on" : "plain"}
              note={stats.fts ? "ranked with bm25" : "matching only — still works"}
            />
          </div>
          <div className="mt-2 flex flex-col gap-2">
            <Command>{stats.path}</Command>
            <Command>{bundle.health.workspace}</Command>
          </div>
        </Panel>

        <Panel delay={0.06}>
          <h2 className="flex items-center gap-1.5 text-[12px] font-semibold tracking-tight">
            <Layers className="size-3.5" />
            Where it looks for information
          </h2>
          <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
            Asked in this order, stopping at the first tier that has something. The key is what is
            missing before the paid tier, not after it.
          </p>
          <ul className="mt-3 flex flex-col gap-1.5">
            {bundle.tiers.map((tier) => (
              <li key={tier.tier} className="flex items-start gap-2">
                <span
                  className={cn(
                    "mt-1 size-1.5 shrink-0 rounded-full",
                    tier.ready ? "bg-white" : "border border-border bg-transparent",
                  )}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] font-medium">
                    {tier.tier}
                    {tier.ready ? null : (
                      <span className="ml-1.5 text-[9px] text-muted-foreground">not ready</span>
                    )}
                  </p>
                  <p className="text-[10px] leading-4 text-muted-foreground">{tier.detail}</p>
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      <Panel delay={0.08}>
        <h2 className="text-[12px] font-semibold tracking-tight">What it has been doing</h2>
        {bundle.events.length === 0 ? (
          <p className="mt-1 text-[10px] text-muted-foreground">
            Nothing logged yet. Ask it something and the steps land here.
          </p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1">
            {bundle.events.slice(0, 12).map((event) => (
              <li key={event.id} className="flex items-start gap-2 text-[10px] leading-4">
                <span className="mt-px w-14 shrink-0 text-muted-foreground">{since(event.at)}</span>
                <span
                  className={cn(
                    "w-12 shrink-0 uppercase tracking-wide",
                    event.level === "error" ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {event.kind}
                </span>
                <span className="min-w-0 flex-1 truncate" title={event.text}>
                  {event.text}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

/* ------------------------------------------------------------------------ ask */

function Asker({ client }: { client: BrainClient }) {
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [result, setResult] = useState<AskResult | null>(null);

  const ask = async () => {
    const trimmed = question.trim();
    if (!trimmed) return;
    setAsking(true);
    try {
      setResult(await client.ask(trimmed));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "It did not answer.");
    } finally {
      setAsking(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <Panel delay={0.02}>
        <h2 className="text-[12px] font-semibold tracking-tight">Ask the brain on your machine</h2>
        <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
          It plans, calls its own tools, checks what came back, and shows the steps. With a local
          model running it reasons through the model; without one it chooses the tools itself and
          says plainly what it could not do.
        </p>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <Textarea
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void ask();
              }
            }}
            rows={2}
            placeholder="What is on this machine? · remember the spare hose is on shelf three · read notes.txt"
            className="min-h-9 flex-1 resize-none rounded-lg text-[11px]"
          />
          <Button
            type="button"
            className="h-9 shrink-0 cursor-pointer rounded-lg text-[11px]"
            disabled={asking}
            onClick={() => void ask()}
          >
            {asking ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
            Ask
          </Button>
        </div>
      </Panel>

      {result ? (
        <Panel delay={0.04}>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary" className="rounded-full text-[9px]">
              {result.mode === "local-model" ? "reasoned with a local model" : "tools only — no model running"}
            </Badge>
            {result.offline ? (
              <Badge variant="outline" className="rounded-full text-[9px]">
                offline
              </Badge>
            ) : null}
            {result.model ? (
              <span className="text-[10px] text-muted-foreground">
                {result.providerLabel} · {result.model}
              </span>
            ) : null}
            <span className="ml-auto text-[10px] text-muted-foreground">{result.ms} ms</span>
          </div>

          <p className="mt-3 whitespace-pre-wrap text-[12px] leading-5">{result.answer}</p>

          {result.modelHint && !result.model ? (
            <p className="mt-2 rounded-xl border border-dashed border-border/70 px-3 py-2 text-[10px] leading-4 text-muted-foreground">
              <span className="text-foreground">Worth doing:</span> {result.modelHint}
            </p>
          ) : null}

          {result.steps.length ? (
            <>
              <h3 className="mt-3 text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                What it did
              </h3>
              <ul className="mt-2 flex flex-col gap-2">
                {result.steps.map((step, index) => (
                  <li key={`${step.tool}-${index}`} className="rounded-xl border border-border/70 bg-background/30 p-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={cn(
                          "grid size-4 shrink-0 place-items-center rounded-full border text-[8px]",
                          step.ok ? "border-white/60" : "border-dashed border-border/70",
                        )}
                      >
                        {step.ok ? <Check className="size-2.5" /> : <X className="size-2.5" />}
                      </span>
                      <code className="text-[11px] font-medium">{step.tool}</code>
                      <span className="truncate text-[10px] text-muted-foreground">
                        {JSON.stringify(step.args)}
                      </span>
                      <span className="ml-auto text-[9px] text-muted-foreground">
                        {step.verification.checked
                          ? `checked — ${step.verification.detail}`
                          : "not verified"}
                      </span>
                    </div>
                    <Json value={step.result} />
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          {result.errors.length ? (
            <div className="mt-2 rounded-xl border border-border/70 px-3 py-2">
              <p className="text-[10px] leading-4 text-muted-foreground">
                {result.errors.join(" · ")}
              </p>
            </div>
          ) : null}
        </Panel>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------------- tools */

function ToolsPanel({
  client,
  bundle,
  onDone,
}: {
  client: BrainClient;
  bundle: Bundle;
  onDone: () => Promise<void>;
}) {
  const [selected, setSelected] = useState<BrainTool | null>(null);
  const [args, setArgs] = useState("{\n  \n}");
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState<unknown>(null);
  const [problem, setProblem] = useState("");

  const run = async () => {
    if (!selected) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = args.trim() ? (JSON.parse(args) as Record<string, unknown>) : {};
    } catch {
      setProblem("Those arguments are not valid JSON.");
      return;
    }
    setProblem("");
    setRunning(true);
    try {
      setOutput(await client.runTool(selected.name, parsed));
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "The tool refused.");
    } finally {
      setRunning(false);
    }
  };

  const custom = bundle.tools.filter((tool) => tool.source !== "builtin");

  return (
    <div className="flex flex-col gap-3">
      <Panel delay={0.02}>
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-[12px] font-semibold tracking-tight">
              {bundle.tools.length} tools, all of them local
            </h2>
            <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
              Files, shell, code and tests, memory, information lookup, capability discovery,
              diagnostics. A tool that touches the network says so; everything else works with the
              cable out.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            className="h-8 cursor-pointer rounded-lg text-[11px]"
            onClick={() => void onDone()}
          >
            <RefreshCw className="size-3.5" />
            Read again
          </Button>
        </div>

        {custom.length ? (
          <p className="mt-2 rounded-xl border border-dashed border-border/70 px-3 py-2 text-[10px] leading-4 text-muted-foreground">
            <span className="text-foreground">It has written {custom.length} of its own:</span>{" "}
            {custom.map((tool) => tool.name).join(", ")} — plain Python files in{" "}
            {bundle.health.workspace}/tools, loaded on every start. Ask it to build one and it will.
          </p>
        ) : null}

        {Object.keys(bundle.loaded.broken).length ? (
          <p className="mt-2 rounded-xl border border-border/70 px-3 py-2 text-[10px] leading-4">
            <AlertTriangle className="mr-1 inline size-3" />
            {Object.entries(bundle.loaded.broken)
              .map(([name, error]) => `${name}: ${error}`)
              .join(" · ")}
            {" — "}the Diagnostics tab can rewrite it.
          </p>
        ) : null}

        <ul className="mt-3 grid gap-2 sm:grid-cols-2">
          {bundle.tools.map((tool) => {
            const stats = tool.stats ?? {};
            const active = selected?.name === tool.name;
            return (
              <li key={tool.name}>
                <button
                  type="button"
                  onClick={() => {
                    setSelected(tool);
                    setOutput(null);
                    setProblem("");
                    setArgs(
                      Object.keys(tool.args).length
                        ? `{\n  "${Object.keys(tool.args)[0]}": ""\n}`
                        : "{\n  \n}",
                    );
                  }}
                  className={cn(
                    "w-full cursor-pointer rounded-xl border px-3 py-2 text-left transition-colors",
                    active
                      ? "border-white/50 bg-white/10"
                      : "border-border/70 bg-background/30 hover:bg-white/5",
                  )}
                >
                  <p className="flex flex-wrap items-center gap-1.5 text-[11px] font-medium">
                    <code>{tool.name}</code>
                    {tool.broken ? (
                      <span className="rounded-full border border-border/70 px-1.5 text-[8px] uppercase">broken</span>
                    ) : null}
                    {tool.source !== "builtin" ? (
                      <span className="rounded-full border border-white/40 px-1.5 text-[8px] uppercase">its own</span>
                    ) : null}
                    {tool.stats?.calls ? (
                      <span className="ml-auto text-[9px] tabular-nums text-muted-foreground">
                        {tool.stats.calls}× · {tool.stats.avg_ms ?? 0}ms
                      </span>
                    ) : null}
                  </p>
                  <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">{tool.summary}</p>
                  {stats.failures ? (
                    <p className="mt-0.5 text-[9px] text-muted-foreground">
                      {stats.failures} failed of {stats.calls}
                    </p>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      </Panel>

      {selected ? (
        <Panel delay={0.04}>
          <h2 className="text-[12px] font-semibold tracking-tight">
            Run <code>{selected.name}</code>
          </h2>
          {Object.keys(selected.args).length ? (
            <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
              {Object.entries(selected.args).map(([name, description]) => (
                <li key={name} className="text-[10px] text-muted-foreground">
                  <code className="text-foreground">{name}</code> — {description}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-[10px] text-muted-foreground">It takes no arguments.</p>
          )}
          <Textarea
            value={args}
            onChange={(event) => setArgs(event.target.value)}
            rows={4}
            spellCheck={false}
            className="mt-2 font-mono text-[11px]"
          />
          {problem ? <p className="mt-1.5 text-[10px]">{problem}</p> : null}
          <div className="mt-2 flex items-center gap-2">
            <Button
              type="button"
              className="h-8 cursor-pointer rounded-lg text-[11px]"
              disabled={running}
              onClick={() => void run()}
            >
              {running ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
              Run it
            </Button>
            <span className="text-[10px] text-muted-foreground">
              {selected.mutates ? "this one changes things on the machine" : "read-only"}
            </span>
          </div>
          {output ? <Json value={output} /> : null}
        </Panel>
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------------------- memory */

function MemoryPanel({ client, onCount }: { client: BrainClient; onCount: () => Promise<void> }) {
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<MemoryRow[]>([]);
  const [total, setTotal] = useState(0);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (term: string) => {
      try {
        const answer = await client.memory(term);
        setRows(answer.hits);
        setTotal(answer.total);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not read the memory.");
      }
    },
    [client],
  );

  useEffect(() => {
    void load("");
  }, [load]);

  const add = async () => {
    if (!draft.trim()) return;
    setBusy(true);
    try {
      await client.remember(draft.trim());
      setDraft("");
      await load(query);
      await onCount();
      toast.success("Kept. It is in the database on your machine, not in this page.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not remember that.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <Panel delay={0.02}>
        <h2 className="text-[12px] font-semibold tracking-tight">{total} things remembered</h2>
        <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
          Held in the brain's own SQLite file. Nothing here is sent to this hub: reading and
          writing memory goes straight to the machine in front of you.
        </p>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void load(query);
              }}
              placeholder="Search what it knows"
              className="h-9 rounded-lg pl-8 text-[11px]"
            />
          </div>
          <Button
            type="button"
            variant="outline"
            className="h-9 shrink-0 cursor-pointer rounded-lg text-[11px]"
            onClick={() => void load(query)}
          >
            <Search className="size-3.5" />
            Search
          </Button>
        </div>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <Input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void add();
            }}
            placeholder="Tell it something worth keeping"
            className="h-9 flex-1 rounded-lg text-[11px]"
          />
          <Button
            type="button"
            className="h-9 shrink-0 cursor-pointer rounded-lg text-[11px]"
            disabled={busy || !draft.trim()}
            onClick={() => void add()}
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Database className="size-3.5" />}
            Remember
          </Button>
        </div>
      </Panel>

      <Panel delay={0.04}>
        {rows.length === 0 ? (
          <p className="text-[10px] text-muted-foreground">
            Nothing matches. Try another word, or tell it something above — it keeps it.
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {rows.map((row) => (
              <li
                key={row.id}
                className="flex items-start gap-2 rounded-xl border border-border/70 bg-background/30 px-3 py-2"
              >
                <span className="mt-px shrink-0 text-[9px] tabular-nums text-muted-foreground">#{row.id}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] leading-4">{row.text}</p>
                  <p className="mt-0.5 text-[9px] text-muted-foreground">
                    {row.source} · {since(row.updated_at)}
                    {row.tags ? ` · ${row.tags}` : ""}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Forget this"
                  className="shrink-0 cursor-pointer text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    void client
                      .forget(row.id)
                      .then(async () => {
                        await load(query);
                        await onCount();
                        toast.success("Forgotten.");
                      })
                      .catch(() => toast.error("Could not forget that."));
                  }}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

/* ----------------------------------------------------------------- connectors */

function ConnectorsPanel({
  client,
  bundle,
  onDone,
}: {
  client: BrainClient;
  bundle: Bundle;
  onDone: () => Promise<void>;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const groups = useMemo(() => {
    const byCapability = new Map<string, Connector[]>();
    for (const connector of bundle.connectors) {
      const list = byCapability.get(connector.capability) ?? [];
      list.push(connector);
      byCapability.set(connector.capability, list);
    }
    return [...byCapability.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [bundle.connectors]);

  const act = async (key: string, work: () => Promise<unknown>, message: string) => {
    setBusy(key);
    try {
      await work();
      await onDone();
      toast.success(message);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "That did not work.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <Panel delay={0.02}>
        <h2 className="text-[12px] font-semibold tracking-tight">
          {bundle.connectorSummary.ready} of {bundle.connectorSummary.total} ready
        </h2>
        <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
          Every outside capability sits behind one replaceable slot, ranked{" "}
          <span className="text-foreground">on this machine</span> before{" "}
          <span className="text-foreground">no account</span> before{" "}
          <span className="text-foreground">needs a key</span>. {bundle.connectorSummary.needingKeys} would
          work with a key you have not added — and none of them are needed for the local five.
        </p>
        <p className="mt-2 text-[10px] leading-4 text-muted-foreground">
          Keys are stored by the brain on your machine, or read from its environment — never here,
          and never returned to this page. Set them from the machine instead and they never travel:{" "}
          <code className="text-foreground">
            python3 brain/brain.py connectors set-key brave BRAVE_API_KEY=…
          </code>
        </p>
      </Panel>

      {groups.map(([capability, connectors], index) => (
        <Panel key={capability} delay={0.03 + index * 0.01}>
          <h3 className="text-[11px] font-semibold tracking-tight">{capability}</h3>
          <ul className="mt-2 flex flex-col gap-2">
            {connectors.map((connector) => {
              const key = `${connector.id}:${connector.envVars[0] ?? ""}`;
              return (
                <li
                  key={connector.id}
                  className="rounded-xl border border-border/70 bg-background/30 px-3 py-2.5"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[11px] font-medium">{connector.label}</span>
                    <TierBadge tier={connector.tier} />
                    {connector.ready ? (
                      <span className="flex items-center gap-1 text-[9px] text-muted-foreground">
                        <Check className="size-3" /> ready
                      </span>
                    ) : (
                      <span className="text-[9px] text-muted-foreground">
                        {connector.enabled ? "on, waiting for a key" : "off"}
                      </span>
                    )}
                    {connector.lastError ? (
                      <span className="text-[9px] text-muted-foreground">last error: {connector.lastError}</span>
                    ) : null}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="ml-auto h-7 cursor-pointer rounded-lg text-[10px] text-muted-foreground hover:text-foreground"
                      disabled={busy === connector.id}
                      onClick={() =>
                        void act(
                          connector.id,
                          () => client.setConnector(connector.id, !connector.enabled),
                          `${connector.label} ${connector.enabled ? "switched off" : "switched on"}.`,
                        )
                      }
                    >
                      {busy === connector.id ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        <Plug className="size-3" />
                      )}
                      {connector.enabled ? "Switch off" : "Switch on"}
                    </Button>
                  </div>
                  <p className="mt-1 text-[10px] leading-4 text-muted-foreground">{connector.note}</p>

                  {connector.envVars.length ? (
                    <div className="mt-2 flex flex-col gap-1.5 sm:flex-row">
                      <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-border/70 px-2.5 py-1.5">
                        <KeyRound className="size-3 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">
                          {connector.credential.present
                            ? `${connector.envVars[0]} — set (${connector.credential.from})`
                            : `${connector.envVars[0]} — not set`}
                        </span>
                        {connector.credential.present && connector.credential.from === "store" ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label="Remove this key"
                            className="shrink-0 cursor-pointer text-muted-foreground hover:text-foreground"
                            onClick={() =>
                              void act(
                                key,
                                () => client.dropCredential(connector.id, connector.envVars[0]),
                                "Key removed from the brain.",
                              )
                            }
                          >
                            <Trash2 className="size-3" />
                          </Button>
                        ) : null}
                      </div>
                      <Input
                        value={drafts[key] ?? ""}
                        onChange={(event) =>
                          setDrafts((current) => ({ ...current, [key]: event.target.value }))
                        }
                        type="password"
                        placeholder="paste a key"
                        className="h-8 rounded-lg font-mono text-[10px] sm:w-64"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        className="h-8 shrink-0 cursor-pointer rounded-lg text-[10px]"
                        disabled={busy === key || !(drafts[key] ?? "").trim()}
                        onClick={() =>
                          void act(
                            key,
                            async () => {
                              await client.putCredential(connector.id, connector.envVars[0], drafts[key]);
                              setDrafts((current) => ({ ...current, [key]: "" }));
                            },
                            "Key stored on your machine.",
                          )
                        }
                      >
                        {busy === key ? <Loader2 className="size-3 animate-spin" /> : <KeyRound className="size-3" />}
                        Store
                      </Button>
                    </div>
                  ) : null}

                  {connector.install ? (
                    <p className="mt-1.5 text-[9px] text-muted-foreground">
                      self-host it: <code>{connector.install}</code>
                    </p>
                  ) : null}
                  {connector.docs ? (
                    <a
                      href={connector.docs}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1 inline-block text-[9px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
                    >
                      {connector.docs}
                    </a>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </Panel>
      ))}
    </div>
  );
}

/* --------------------------------------------------------------------- models */

function ModelsPanel({ bundle }: { bundle: Bundle }) {
  const up = bundle.models.filter((server) => server.ok);
  return (
    <div className="flex flex-col gap-3">
      <Panel delay={0.02}>
        <h2 className="text-[12px] font-semibold tracking-tight">
          {up.length ? `${up.length} model server(s) answering` : "No local model server is running"}
        </h2>
        <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
          {up.length
            ? "The brain reasons through the leading one. Start a second and it is used as the fallback."
            : "The brain works without one — it uses its tools and its memory and says so. Add one and the same questions get reasoned through properly."}
        </p>
        {!up.length ? (
          <div className="mt-3 flex flex-col gap-2">
            <Command>ollama serve &amp;&amp; ollama pull qwen2.5-coder:7b</Command>
            <Command>llama-server -m models/your-model.gguf --port 8080</Command>
            {bundle.modelHint ? (
              <p className="text-[10px] leading-4 text-muted-foreground">{bundle.modelHint}</p>
            ) : null}
          </div>
        ) : null}
        <ul className="mt-3 flex flex-col gap-2">
          {bundle.models.map((server) => (
            <li
              key={server.id}
              className="rounded-xl border border-border/70 bg-background/30 px-3 py-2.5"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    server.ok ? "bg-white" : "border border-border bg-transparent",
                  )}
                />
                <span className="text-[11px] font-medium">{server.label}</span>
                <span className="text-[10px] text-muted-foreground">{server.base}</span>
                {server.local ? (
                  <span className="rounded-full border border-white/40 px-2 py-0.5 text-[9px]">
                    this machine
                  </span>
                ) : null}
                <span className="ml-auto text-[9px] text-muted-foreground">
                  {server.ok ? `${server.models.length} model(s)` : server.error ?? "not answering"}
                </span>
              </div>
              {server.ok && server.models.length ? (
                <p className="mt-1 flex flex-wrap gap-1.5">
                  {server.models.slice(0, 8).map((model) => (
                    <span
                      key={model}
                      className="rounded-full border border-border/70 px-2 py-0.5 text-[9px] text-muted-foreground"
                    >
                      {model}
                    </span>
                  ))}
                  {server.models.length > 8 ? (
                    <span className="text-[9px] text-muted-foreground">+{server.models.length - 8} more</span>
                  ) : null}
                </p>
              ) : null}
              {!server.ok && server.start ? (
                <p className="mt-1 text-[9px] text-muted-foreground">
                  start it with <code className="text-foreground">{server.start}</code>
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}

/* ---------------------------------------------------------------- diagnostics */

function DiagnosticsPanel({
  client,
  bundle,
  onDone,
}: {
  client: BrainClient;
  bundle: Bundle;
  onDone: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const report = bundle.diagnostics;

  const runRepair = async (name: string) => {
    setBusy(name);
    try {
      const result = (await client.repair(name)) as { ok?: boolean; detail?: string; error?: string };
      if (result.ok === false) toast.error(result.error ?? "That repair failed.");
      else toast.success(result.detail ?? `${name} done.`);
      await onDone();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "That repair failed.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <Panel delay={0.02}>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-[12px] font-semibold tracking-tight">Looking at itself</h2>
          {(["blocking", "degraded", "note"] as const).map((level) => (
            <Badge key={level} variant="outline" className="rounded-full text-[9px]">
              {report.counts[level]} {level}
            </Badge>
          ))}
          <span className="ml-auto text-[10px] text-muted-foreground">{report.ms} ms</span>
        </div>
        <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
          Its own machine, its own tools, its own dependencies — checked, and every problem that
          can be fixed mechanically comes with the name of the repair. Nothing here asked any
          other computer anything.
        </p>

        <ul className="mt-3 flex flex-col gap-2">
          {report.findings.map((finding) => (
            <li
              key={finding.id}
              className="rounded-xl border border-border/70 bg-background/30 px-3 py-2.5"
            >
              <div className="flex flex-wrap items-center gap-2">
                <LevelBadge level={finding.level} />
                <span className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                  {finding.area}
                </span>
                {finding.repair ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="ml-auto h-7 cursor-pointer rounded-lg text-[10px]"
                    disabled={busy === finding.repair}
                    onClick={() => void runRepair(finding.repair)}
                  >
                    {busy === finding.repair ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <Wrench className="size-3" />
                    )}
                    {finding.repair}
                  </Button>
                ) : null}
              </div>
              <p className="mt-1 text-[11px] leading-4">{finding.message}</p>
              {finding.detail ? (
                <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">{finding.detail}</p>
              ) : null}
            </li>
          ))}
        </ul>

        {report.repairs.length ? (
          <div className="mt-3">
            <h3 className="text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Repairs it can run
            </h3>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {report.repairs.map((name) => (
                <button
                  key={name}
                  type="button"
                  disabled={busy === name}
                  onClick={() => void runRepair(name)}
                  className="cursor-pointer rounded-full border border-border/70 px-2.5 py-1 text-[9px] text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
                >
                  {busy === name ? <Loader2 className="mr-1 inline size-2.5 animate-spin" /> : null}
                  {name}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </Panel>

      {report.tools.length ? (
        <Panel delay={0.04}>
          <h2 className="flex items-center gap-1.5 text-[12px] font-semibold tracking-tight">
            <Bug className="size-3.5" />
            Tools that keep failing
          </h2>
          <ul className="mt-2 flex flex-col gap-1">
            {report.tools.map((row) => (
              <li key={row.tool} className="flex items-center gap-2 text-[10px]">
                <code className="text-[11px]">{row.tool}</code>
                <span className="text-muted-foreground">
                  {row.failures} of {row.calls} calls failed · {row.avgMs}ms average
                </span>
                <span className="ml-auto text-muted-foreground">{since(row.lastAt)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[10px] leading-4 text-muted-foreground">
            A tool the brain wrote for itself can be rewritten by asking it to — that is the
            repair that matters most, and it is the last tab.
          </p>
        </Panel>
      ) : null}

      <Panel delay={0.06}>
        <h2 className="flex items-center gap-1.5 text-[12px] font-semibold tracking-tight">
          <BrainCircuit className="size-3.5" />
          Why this is independent
        </h2>
        <ul className="mt-2 flex flex-col gap-1.5 text-[10px] leading-4 text-muted-foreground">
          <li>Memory is one SQLite file — backed up by copying it, read without this software.</li>
          <li>Search is full-text, with a plain-matching fallback when SQLite has no FTS5.</li>
          <li>HTTP is <code>urllib</code>; there is no vendor SDK anywhere in the stack.</li>
          <li>Models are local servers on loopback, and optional.</li>
          <li>Keys come from the environment first, so a key you exported is never written down.</li>
          <li>
            The whole thing is {humanBytes(bundle.stats.bytes)} of database and text you can read,
            move, or delete.
          </li>
        </ul>
      </Panel>
    </div>
  );
}
