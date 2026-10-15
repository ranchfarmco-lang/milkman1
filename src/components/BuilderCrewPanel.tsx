import { ByokBox } from "@/components/forge/ByokBox";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { AppRunner } from "@/hooks/use-app-runner";
import {
  useForgeAgents,
  useForgeApps,
  useForgeConfig,
  useForgeMessages,
  useForgeSessions,
  usePendingRequests,
  useSandbox,
} from "@/hooks/use-forge";
import {
  STATIC_APP_RULE,
  appNamedIn,
  benchContext,
  changeReply,
  pickTarget,
  whereItIs,
} from "@/lib/forge/agent";
import {
  buildAnApp,
  loadAppIntoSandbox,
  onTheHomeScreen,
  reportAppError,
} from "@/lib/forge/apps";
import {
  addForgeMessage,
  clearSessionMessages,
  ensureSession,
} from "@/lib/forge/chat";
import type { AppRow } from "@/lib/forge/db";
import { onForge } from "@/lib/forge/events";
import { PROVIDERS } from "@/lib/forge/llm";
import { answerRequest } from "@/lib/forge/requests";
import { beginRun, endRun } from "@/lib/forge/runtime";
import { cn } from "@/lib/utils";
import {
  AppWindow,
  Ban,
  Bot,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  FileCode2,
  FilePlus2,
  Hammer,
  LayoutTemplate,
  Loader2,
  Paperclip,
  Play,
  Rocket,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Square,
  Trash2,
  User,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

/**
 * The AI app builder — the prompt studio, and the agent inside it.
 *
 * This is the one box where a request goes in, and it is where an app comes
 * out. The six agents — Director, Planner, Files, Research, Implement and
 * Review — were already written, and so was the sandbox build they drive;
 * nothing ever started them, so the page could describe a crew that never ran.
 * Here is the one press that does: it takes a brief, hands it to the whole
 * crew, lets them write the files and build them, and publishes the result.
 *
 * It is an **agent you keep talking to**, not a form that makes one app:
 *
 * * **It continues the app on the bench.** Whatever is in the App Sandbox is
 *   what the request is about. The first request starts an app; every request
 *   after it is a *change* to that same app — the crew's files are put back on
 *   the bench, the brief says which app it is and what its last build did, and
 *   the finished work lands on that app where it stands instead of arriving as
 *   a second app beside it. The row above the box says which app that is, and
 *   it can be pointed at another one, or at a new app, in one press.
 * * **It answers.** Every request is written into this page's own thread, and
 *   so is the reply: what the Director made of it, which files changed, and
 *   whether the build passed — in the same words the run itself used. The
 *   thread is the same `messages` record the Assistant page uses, so a
 *   conversation survives a reload and lands in every tab.
 * * **It touches the build you are looking at.** If the app it just changed is
 *   the one in the Preview & Test Sandbox below, the frame is reloaded so the
 *   change is visible where you were already watching, rather than needing to
 *   be launched again by hand.
 *
 * Everything else on this box does one real thing:
 *
 * * **Templates** — briefs that are known to work, one press to fill the box.
 * * **Attach files** — text files are read here and travel into the brief as
 *   context, so "make this CSV into a chart" arrives with the CSV.
 * * **Model Settings** — the same BYOK hub the Control Room shows, in a dialog.
 *
 * The `runner` is what joins this to the rest of the page: the same state the
 * home screen's icons and the preview box read, so the app this agent is
 * working on and the app in the frame are one fact rather than two.
 *
 * It is the top of the page's chain — ask here, watch the log below, run it in
 * the preview below that, keep it in Saved Projects, publish it to the icons at
 * the bottom — and it is also where the chain comes *back*: a `preset` event
 * from another box (an element picked in the running app, an icon asking for a
 * change) chooses the app and fills this box, so what you see in the preview
 * becomes the next request without being described out loud.
 */

/** A starting brief worth having. Short, concrete, and known to build. */
const TEMPLATES: { label: string; brief: string }[] = [
  {
    label: "Calculator",
    brief:
      "A calculator: a keypad with 0-9 and + − × ÷, a display that shows what you typed, equals, clear, and a backspace. It must work with a mouse and with the keyboard, and it must not use eval().",
  },
  {
    label: "To-do list",
    brief:
      "A to-do list: add a task, tick it off, delete it, and see how many are left. The list is kept in localStorage so it is still there after a reload, and it can be cleared in one press.",
  },
  {
    label: "Timer",
    brief:
      "A countdown timer: pick minutes and seconds or use 5/10/25-minute presets, start, pause and reset. It beeps when it finishes, and the remaining time is shown large enough to read from across the room.",
  },
  {
    label: "Flashcards",
    brief:
      "A flashcard study app: add cards with a question and an answer, study them one at a time, flip a card to see the answer, mark it right or wrong, and show a score at the end. Cards are kept in localStorage.",
  },
  {
    label: "Grocery list",
    brief:
      "A grocery list: add items with a quantity, group them by aisle, tick them off while shopping, and clear what is ticked. It keeps the list in localStorage and can export it as plain text.",
  },
  {
    label: "Budget tracker",
    brief:
      "A simple budget tracker: log an amount, a category and a date, see the month's total and a breakdown by category, and delete an entry. Everything is kept in localStorage and shown in dollars.",
  },
  {
    label: "Chart from data",
    brief:
      "A chart maker: paste in rows of numbers or CSV, choose a line or bar chart, and see it drawn on a canvas with labelled axes and a legend. It must run with no libraries from the internet.",
  },
  {
    label: "Dice & score pad",
    brief:
      "A game score pad: add players, roll one or two dice with big readable results, keep a running total per player, and reset. It keeps the game in localStorage so a refresh does not lose the scores.",
  },
];

/** Attached text, read in the browser and carried into the brief. */
type Attached = { name: string; text: string; bytes: number };

/** Nothing bigger than this rides in a brief, per file and all together. */
const MAX_FILE_CHARS = 60_000;
const MAX_TOTAL_CHARS = 200_000;
/** A brief longer than this is cut, and the person is told so. */
const MAX_BRIEF_CHARS = 24_000;
/** How much of the conversation is shown at once. The whole thread is kept. */
const SHOWN_MESSAGES = 24;

/** Files worth reading as text. Anything else is refused rather than mangled. */
const TEXT_FILE =
  /\.(txt|md|markdown|json|csv|tsv|html?|css|js|jsx|ts|tsx|py|rb|go|rs|java|c|cpp|h|sh|yml|yaml|xml|svg|log|ini|toml)$/i;

function readableChars(chars: number): string {
  if (chars < 1024) return `${chars} B`;
  return `${Math.round(chars / 1024)} KB`;
}

function clock(at: number) {
  return new Date(at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * The brief as the crew will read it: what was asked, then the files attached
 * to it. Naming each file is what makes the difference between the model
 * reading the data and asking for it again.
 */
function withAttachments(brief: string, files: Attached[]): string {
  if (!files.length) return brief;
  const body = files
    .map((file) => `--- ${file.name} ---\n${file.text}`)
    .join("\n\n");
  const composed = `${brief}\n\nAttached files, to read and use as they are — do not ask for them again:\n\n${body}`;
  return composed.length > MAX_BRIEF_CHARS
    ? composed.slice(0, MAX_BRIEF_CHARS)
    : composed;
}

export function BuilderCrewPanel({ runner }: { runner?: AppRunner }) {
  const config = useForgeConfig();
  const agents = useForgeAgents();
  const requests = usePendingRequests();
  const apps = useForgeApps();
  const sandbox = useSandbox();
  const sessions = useForgeSessions("builder");
  const session = sessions?.[0] ?? null;
  const messages = useForgeMessages(session?.id ?? null);

  const [goal, setGoal] = useState("");
  const [name, setName] = useState("");
  const [attached, setAttached] = useState<Attached[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busy, setBusy] = useState<"build" | null>(null);
  const [clearing, setClearing] = useState(false);
  /** `auto` follows the sandbox; `new` is a deliberate blank sheet; else an id. */
  const [target, setTarget] = useState<"auto" | "new" | string>("auto");
  const controller = useRef<AbortController | null>(null);
  // `busy` is React state, which settles after this tick; two presses landing
  // in the same one would otherwise start two runs over the same bench.
  const inFlight = useRef(false);
  const filePicker = useRef<HTMLInputElement>(null);
  /** The request box, so another box can hand a change to it and focus it. */
  const box = useRef<HTMLTextAreaElement>(null);

  // The first open creates this page's conversation — one write, then the live
  // query carries it, and the Build Code Log reads the same session.
  useEffect(() => {
    if (sessions && sessions.length === 0) void ensureSession("builder");
  }, [sessions]);

  /**
   * Another box handing this one something to do.
   *
   * The inspector in the running app can pass the element somebody picked, an
   * icon can point at the app it belongs to, and either way the request lands
   * here — the app chosen, the words filled in, the box focused and the page
   * scrolled to it. That is the chain working in both directions rather than
   * only downwards: what you see in the preview becomes the next request
   * without being described out loud.
   */
  useEffect(
    () =>
      onForge((event) => {
        if (event.type !== "preset") return;
        if (event.id) setTarget(event.id);
        if (event.text) setGoal(event.text);
        document
          .getElementById("builder-studio")
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
        box.current?.focus();
      }),
    [],
  );

  const all = useMemo(() => apps ?? [], [apps]);
  const running = agents.filter((agent) => agent.status === "running");
  const chosen = config.aiProvider && config.aiModel;
  const blocked = config.emergencyStopped;
  const attachedChars = attached.reduce((sum, file) => sum + file.bytes, 0);
  const providerLabel =
    PROVIDERS.find((one) => one.id === config.aiProvider)?.label ??
    "no model chosen";

  /**
   * The app this request is about.
   *
   * The bench is the answer whenever there is one there — that is the app the
   * crew's files are — and otherwise the app in the preview frame, since that
   * is the one somebody is looking at. A person can point it somewhere else,
   * or at a blank sheet, and that choice is respected rather than guessed.
   */
  const benchApp = useMemo(
    () => all.find((app) => app.id === sandbox.mounted) ?? null,
    [all, sandbox.mounted],
  );
  const workingOn = useMemo(
    () =>
      pickTarget({
        choice: target,
        apps: all,
        bench: benchApp,
        running: runner?.live ?? null,
      }),
    [all, benchApp, runner?.live, target],
  );

  /** Read the picked files here, so their text travels with the brief. */
  const attach = async (picked: FileList | null) => {
    if (!picked?.length) return;
    const next: Attached[] = [];
    for (const file of Array.from(picked)) {
      if (!TEXT_FILE.test(file.name) && !file.type.startsWith("text/")) {
        toast.error(
          `${file.name} is not text — attach a .txt, .csv, .json, .html, .js file.`,
        );
        continue;
      }
      if (file.size > MAX_FILE_CHARS * 4) {
        toast.error(
          `${file.name} is too big to read into a brief (${readableChars(file.size)}).`,
        );
        continue;
      }
      try {
        const text = await file.text();
        next.push({
          name: file.name,
          text: text.slice(0, MAX_FILE_CHARS),
          bytes: text.length,
        });
      } catch {
        toast.error(`Could not read ${file.name}.`);
      }
    }
    if (!next.length) return;

    setAttached((current) => {
      const kept: Attached[] = [...current];
      for (const file of next) {
        if (kept.some((one) => one.name === file.name)) continue;
        const total =
          kept.reduce((sum, one) => sum + one.bytes, 0) + file.bytes;
        if (total > MAX_TOTAL_CHARS) {
          toast.error(
            "That is more text than a brief can carry. Detach something first.",
          );
          break;
        }
        kept.push(file);
      }
      return kept;
    });
  };

  /**
   * One request, worked on the app it belongs to, and answered in the thread.
   *
   * The order matters and is the whole feature: the app is put on the bench
   * *first* (so the crew reads its files rather than a blank sheet), the
   * request goes in as a person's turn, the crew writes and builds, and then
   * the reply is written as the agent's turn — what it understood, which files
   * changed, what the build said. A request that makes no files still answers;
   * it just does not pretend something changed.
   */
  const build = async (input: {
    brief: string;
    name?: string;
    /** The pending request this run answers, if it is answering one. */
    requestId?: string;
    /** A packaged request's own context, in place of the app's state. */
    context?: string;
    constraints?: string;
    /** Overrides the target — the app this request is about. */
    about?: AppRow | null;
    /** The person asked for a new app: the bench is emptied first. */
    fresh?: boolean;
  }) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy("build");

    const stop = new AbortController();
    controller.current = stop;
    // The Build Log box stops *this* run and nothing else.
    beginRun(stop);

    /** The app this run is about, decided before a single file moves. */
    const already = input.about === undefined ? workingOn : input.about;
    let thread: string | null = session?.id ?? null;
    let app: AppRow | null = null;

    try {
      const live = await ensureSession("builder");
      thread = live.id;
      await addForgeMessage(live.id, "user", input.brief);

      if (input.fresh) {
        // A new app means a new app: leaving the last one's files on the bench
        // would have the crew plan a change to it and publish the mixture as
        // somebody else's app. The old one is kept — it is a draft in Saved
        // Projects, and Edit Draft puts it back here.
        if (sandbox.engine.fileList().length) {
          await sandbox.engine.clear();
          sandbox.engine.log("A new app starts from an empty bench.");
        }
      } else if (already && sandbox.mounted !== already.id) {
        // Its own files, on the bench, before the brief is read — otherwise the
        // crew would be changing a different app, or starting again.
        await loadAppIntoSandbox(already);
        sandbox.engine.log(
          `“${already.name}” is on the bench — this request changes it.`,
        );
      }

      const result = await buildAnApp({
        goal: input.brief,
        name: input.name,
        sessionId: live.id,
        signal: stop.signal,
        publishAnyway: true,
        appId: already?.id,
        keepGoal: already?.goal,
        context: input.context ?? (already ? benchContext(already) : undefined),
        constraints: input.constraints ?? STATIC_APP_RULE,
      });
      app = result.app;

      const reply = changeReply({
        summary: result.summary,
        written: result.written,
        app,
      });

      if (app) {
        // A new app becomes the one on the bench; an updated one is already it.
        if (!already) await loadAppIntoSandbox(app);
        setTarget(app.id);
        // If this is the app somebody is already watching, the frame is loaded
        // again so the change is seen where they were looking.
        if (runner?.running === app.id) runner.rerun();
      }

      await addForgeMessage(
        thread,
        "assistant",
        reply,
        app
          ? `“${app.name}” — ${
              already ? "changed in place" : "saved in Saved Projects"
            }${onTheHomeScreen(app) ? "" : already ? " · still a draft" : " · a draft"}${
              app.build.ok ? "" : " · build problems left"
            }`
          : "nothing written",
      );

      if (app?.build.ok && !onTheHomeScreen(app) && !already) {
        toast.success(
          `“${app.name}” is in Saved Projects — run it there, and publish it to the home screen when it is finished.`,
        );
      } else if (app?.build.ok) {
        toast.success(`${app.name}: ${result.summary.slice(0, 120)}`);
      } else if (app) {
        toast(`“${app.name}” was changed — the build still reports problems.`);
      } else {
        toast(reply);
      }

      if (input.requestId) {
        await answerRequest(
          input.requestId,
          "done",
          app
            ? `Worked on “${app.name}”: ${result.summary.slice(0, 300)}`
            : reply,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stopped = controller.current?.signal.aborted ?? false;
      const text = stopped ? "Stopped before it finished." : message;
      if (thread) {
        await addForgeMessage(
          thread,
          "assistant",
          text,
          stopped ? "stopped" : "the run failed",
        );
      }
      if (!stopped) {
        toast.error(text);
        void reportAppError("crew build", error);
      }
      if (input.requestId)
        await answerRequest(input.requestId, "accepted", text);
    } finally {
      endRun(stop);
      controller.current = null;
      inFlight.current = false;
      setBusy(null);
    }
  };

  const generate = () => {
    const brief = goal.trim();
    if (brief.length < 8) {
      toast.error(
        workingOn
          ? "Say what to change, in a sentence."
          : "Say what the app should do, in a sentence.",
      );
      return;
    }
    void build({
      brief: withAttachments(brief, attached),
      name,
      fresh: target === "new",
    });
    setGoal("");
  };

  /**
   * Empty this conversation.
   *
   * Only the thread: the app on the bench, its files and the Build Code Log
   * are separate records and are deliberately left alone. The person is asked
   * first, because a deleted conversation cannot be put back.
   */
  const deleteThread = async () => {
    if (!session) return;
    setClearing(true);
    try {
      const removed = await clearSessionMessages(session.id);
      toast.success(
        removed
          ? `Deleted ${removed} ${removed === 1 ? "turn" : "turns"} from this conversation.`
          : "This conversation was already empty.",
      );
    } catch (caught) {
      toast.error(
        caught instanceof Error ? caught.message : "That did not go through.",
      );
    } finally {
      setClearing(false);
    }
  };

  /* ---------------------------------------------------------- the thread */

  const thread = useMemo(() => messages.slice(-SHOWN_MESSAGES), [messages]);
  const scroller = useRef<HTMLDivElement>(null);
  // Follow the newest turn, exactly as the log below follows its own lines.
  useEffect(() => {
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [thread.length, busy]);

  return (
    <section
      id="builder-studio"
      className="shrink-0 scroll-mt-4 rounded-2xl border border-white/25 bg-card/70 p-3 backdrop-blur-sm"
    >
      {/* -------------------------------------------------------- header */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-white/10 text-white">
          <Sparkles className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-[11px] font-semibold tracking-tight">
            <span className="grid size-4 place-items-center rounded-full border border-white/30 text-[8px] font-medium text-foreground/80">
              1
            </span>
            AI app builder — prompt studio
          </p>
          <p className="truncate text-[9px] text-muted-foreground">
            Describe an app, then keep asking for changes — it works on the one
            in the sandbox and answers here.
          </p>
        </div>

        {/* The crew's own lights: a name and what that agent is doing now. */}
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {agents.map((agent) => (
            <span
              key={agent.id}
              className="inline-flex items-center gap-1 text-[9px] text-muted-foreground"
              title={agent.detail}
            >
              <span
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  agent.status === "running"
                    ? "bg-emerald-400/80"
                    : agent.status === "error"
                      ? "bg-destructive/70"
                      : agent.status === "done"
                        ? "bg-white/50"
                        : "bg-white/20",
                )}
              />
              {agent.name}
            </span>
          ))}
        </span>

        <a
          href="#builder-apps"
          className="inline-flex shrink-0 items-center gap-1 text-[10px] text-foreground/85 underline decoration-dotted hover:text-foreground"
        >
          <AppWindow className="size-3" />
          Home screen
          {apps ? ` · ${apps.filter(onTheHomeScreen).length}` : ""}
        </a>
      </div>

      {/* What the crew needs before it can run at all, said plainly. */}
      {blocked ? (
        <p className="mt-2 flex items-center gap-1.5 text-[10px] leading-4 text-muted-foreground">
          <Ban className="size-3 shrink-0" />
          Emergency stop is engaged, so nothing will start. Release it in the
          Control Room&apos;s Quick Actions.
        </p>
      ) : !chosen ? (
        <p className="mt-2 flex items-center gap-1.5 text-[10px] leading-4 text-muted-foreground">
          <CircleAlert className="size-3 shrink-0" />
          No model is chosen, so the crew has nothing to think with. Press Model
          Settings — the default is This hub, the hub&apos;s own models, and a
          key or a model on this machine works just as well.
        </p>
      ) : null}

      {/* --------------------------------------------------- what it works on */}
      <div className="mt-2 flex flex-wrap items-center gap-2 rounded-xl border border-border/60 bg-background/40 px-2.5 py-2">
        {workingOn ? (
          <FileCode2 className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <FilePlus2 className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[10px] leading-4">
            {workingOn ? (
              <>
                Working on{" "}
                <span className="font-medium">“{workingOn.name}”</span> —{" "}
                {workingOn.files.length} file
                {workingOn.files.length === 1 ? "" : "s"} on the bench,
                {workingOn.build.ok
                  ? " and it builds."
                  : " with build problems."}
              </>
            ) : (
              "A new app — the next request starts one from an empty bench."
            )}
          </p>
          <p className="truncate text-[9px] leading-4 text-muted-foreground">
            {workingOn
              ? "A request is a change to this app: its files are put on the bench, and the finished work lands on it where it stands."
              : "A new request starts a new app, which waits in Saved Projects as a draft until you publish it to the home screen."}
          </p>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy !== null}
              title="Which app this agent works on"
              className="h-7 shrink-0 cursor-pointer rounded-lg text-[10px]"
            >
              Change
              <ChevronDown className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-72">
            <DropdownMenuLabel className="text-[11px]">
              Work on which app?
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => setTarget("auto")}
              className="text-[12px]"
            >
              <Bot className="size-3" />
              Follow the sandbox (
              {benchApp?.name ?? runner?.live?.name ?? "nothing on the bench"})
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => setTarget("new")}
              className="text-[12px]"
            >
              <FilePlus2 className="size-3" />A new app — start from an empty
              bench
            </DropdownMenuItem>
            {all.length ? <DropdownMenuSeparator /> : null}
            {all.map((app) => (
              <DropdownMenuItem
                key={app.id}
                onSelect={() => {
                  setTarget(app.id);
                  setGoal("");
                }}
                className="text-[12px]"
              >
                <span className="min-w-0 flex-1 truncate">{app.name}</span>
                <span className="shrink-0 text-[9px] text-muted-foreground">
                  {whereItIs(app, sandbox.mounted, runner?.running ?? null)}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* -------------------------------------------------------- the thread */}
      <div className="mt-2 rounded-xl border border-border/60 bg-background/30">
        <div
          ref={scroller}
          className="max-h-60 min-h-24 overflow-y-auto px-2.5 py-2"
          aria-live="polite"
          aria-label="Conversation with the app builder agent"
        >
          {thread.length === 0 ? (
            <div className="flex h-full min-h-20 flex-col items-center justify-center gap-1 text-center">
              <Bot className="size-4 text-muted-foreground/60" />
              <p className="text-[10px] text-muted-foreground">
                {workingOn
                  ? `Ask for a change to “${workingOn.name}”`
                  : "Describe an app and the crew builds it"}
              </p>
              <p className="max-w-[52ch] text-[9px] leading-4 text-muted-foreground/80">
                Every request is answered here: what the crew made of it, which
                files changed, and what the build said. Nothing is invented —
                the reply is the run&apos;s own words.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {thread.map((row) => (
                <div
                  key={row.id}
                  className={cn(
                    "flex items-start gap-2",
                    row.role === "user" ? "justify-end" : "justify-start",
                  )}
                >
                  {row.role !== "user" ? (
                    <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-lg bg-white/10 text-white">
                      <Bot className="size-3" />
                    </span>
                  ) : null}

                  <div
                    className={cn(
                      "min-w-0 max-w-[52rem] rounded-xl border px-2.5 py-1.5",
                      row.role === "user"
                        ? "border-white/25 bg-white/[0.07]"
                        : "border-border/60 bg-background/50",
                    )}
                  >
                    <p className="whitespace-pre-wrap text-[10px] leading-4">
                      {row.text}
                    </p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[9px] text-muted-foreground">
                      {row.note ? (
                        <span className="rounded-full border border-border/60 px-1.5 py-px">
                          {row.note}
                        </span>
                      ) : null}
                      <span className="tabular-nums">{clock(row.at)}</span>
                    </p>
                  </div>

                  {row.role === "user" ? (
                    <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-lg bg-white/[0.07] text-muted-foreground">
                      <User className="size-3" />
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          )}

          {/* The run in flight, as a turn that has not been answered yet. */}
          {busy === "build" ? (
            <div className="mt-2 flex items-center gap-2 text-[10px] text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              {running.length
                ? running
                    .map((agent) => `${agent.name}: ${agent.detail}`)
                    .join(" · ")
                : "The crew is working…"}
            </div>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 px-2.5 py-1.5 text-[9px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <Hammer className="size-3" />
            {thread.length} turn{thread.length === 1 ? "" : "s"} in this
            conversation
          </span>
          {workingOn && messages.length ? (
            <span className="flex items-center gap-1">
              <CircleCheck className="size-3" />
              Changes land on “{workingOn.name}”, not on a new app
            </span>
          ) : null}

          {session && messages.length ? (
            // Deleting takes the whole thread, so it asks first and says what
            // it is careful *not* to touch — the app itself and the log below.
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={clearing}
                  title="Delete this conversation — the app on the bench and the Build Code Log stay"
                  className="ml-auto h-5 shrink-0 cursor-pointer rounded-lg px-1.5 text-[9px] text-muted-foreground hover:text-foreground"
                >
                  {clearing ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Trash2 className="size-3" />
                  )}
                  Delete conversation
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent className="rounded-2xl border-border/70 bg-card/95 backdrop-blur-sm">
                <AlertDialogHeader>
                  <AlertDialogTitle className="text-[13px] tracking-tight">
                    Delete this conversation?
                  </AlertDialogTitle>
                  <AlertDialogDescription className="text-[11px] leading-4">
                    This clears the {messages.length} turn
                    {messages.length === 1 ? "" : "s"} in this box — the
                    questions and the crew&apos;s replies. The app on the bench,
                    its files and the Build Code Log stay exactly as they are.
                    It cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel className="cursor-pointer">
                    Keep it
                  </AlertDialogCancel>
                  <AlertDialogAction
                    className="cursor-pointer"
                    onClick={() => void deleteThread()}
                  >
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : null}
        </div>
      </div>

      {/* -------------------------------------------------------- the prompt */}
      <div className="mt-2 flex flex-col gap-2">
        <Textarea
          ref={box}
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends; Shift+Enter is a new line. A brief is one press away.
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              generate();
            }
          }}
          placeholder={
            workingOn
              ? `What should “${workingOn.name}” do differently? “Make the keypad bigger and add a percent button.”`
              : "A calculator: a keypad, a display that shows what you typed, and + − × ÷ that work."
          }
          aria-label="What should the app do, or what should change about it"
          disabled={busy !== null}
          className="min-h-16 rounded-xl text-[11px] leading-5"
        />

        {/* What was attached, and the way to take it back off. */}
        {attached.length ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <Paperclip className="size-3 shrink-0 text-muted-foreground" />
            {attached.map((file) => (
              <span
                key={file.name}
                title={`${file.name} — ${readableChars(file.bytes)} of text travels with the brief`}
                className="inline-flex max-w-56 items-center gap-1.5 rounded-full border border-white/25 bg-white/[0.06] px-2 py-0.5 text-[9px]"
              >
                <span className="min-w-0 truncate">{file.name}</span>
                <span className="shrink-0 text-muted-foreground">
                  {readableChars(file.bytes)}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setAttached((current) =>
                      current.filter((one) => one.name !== file.name),
                    )
                  }
                  aria-label={`Detach ${file.name}`}
                  className="shrink-0 cursor-pointer text-muted-foreground hover:text-foreground"
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
            <span className="text-[9px] text-muted-foreground">
              {readableChars(attachedChars)} attached — read in this browser and
              sent with the brief
            </span>
          </div>
        ) : null}

        {/* --------------------------------------------------------- toolbar */}
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            type="button"
            size="sm"
            onClick={generate}
            disabled={busy !== null || blocked || !chosen}
            title={
              workingOn
                ? `Send this as a change to “${workingOn.name}”`
                : "Build a new app from this brief"
            }
            className="h-8 cursor-pointer rounded-lg text-[10px]"
          >
            {busy === "build" ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Rocket className="size-3" />
            )}
            {busy === "build"
              ? "Working…"
              : workingOn
                ? "Send Change"
                : "Generate App"}
          </Button>

          {busy === "build" ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => controller.current?.abort()}
              className="h-8 cursor-pointer rounded-lg text-[10px]"
            >
              <Square className="size-3" />
              Stop
            </Button>
          ) : null}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy !== null}
                className="h-8 cursor-pointer rounded-lg text-[10px]"
              >
                <LayoutTemplate className="size-3" />
                Templates
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
              <DropdownMenuLabel className="text-[11px]">
                A brief that already builds
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {TEMPLATES.map((template) => (
                <DropdownMenuItem
                  key={template.label}
                  onSelect={() => {
                    setGoal(template.brief);
                    toast(
                      `“${template.label}” is in the box — change it, then press the button.`,
                    );
                  }}
                  className="text-[12px]"
                >
                  {template.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <input
            ref={filePicker}
            type="file"
            multiple
            accept=".txt,.md,.markdown,.json,.csv,.tsv,.html,.htm,.css,.js,.jsx,.ts,.tsx,.py,.yml,.yaml,.xml,.svg,.log,.ini,.toml,text/*"
            className="hidden"
            aria-hidden="true"
            tabIndex={-1}
            onChange={(event) => {
              void attach(event.target.files);
              event.target.value = "";
            }}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => filePicker.current?.click()}
            disabled={busy !== null}
            title="Read text files here and send them with the brief as context"
            className="h-8 cursor-pointer rounded-lg text-[10px]"
          >
            <Paperclip className="size-3" />
            Attach Files{attached.length ? ` (${attached.length})` : ""}
          </Button>

          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setSettingsOpen(true)}
            title="Which provider and model the crew thinks with"
            className="h-8 cursor-pointer rounded-lg text-[10px]"
          >
            <SlidersHorizontal className="size-3" />
            Model Settings
          </Button>

          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={
              workingOn ? "Rename it (optional)" : "What to call it (optional)"
            }
            aria-label="App name"
            disabled={busy !== null}
            className="h-8 w-56 rounded-lg text-[11px]"
          />

          <span className="rounded-full border border-border/60 px-2 py-1 text-[9px] text-muted-foreground">
            {providerLabel}
            {config.aiModel ? ` · ${config.aiModel}` : ""}
          </span>
        </div>

        {/* The app the last run finished, and the way to watch it. */}
        {workingOn ? (
          <p className="flex flex-wrap items-center gap-1.5 text-[9px] leading-4 text-muted-foreground">
            <Play className="size-3 shrink-0" />
            {runner?.running === workingOn.id ? (
              <>
                “{workingOn.name}” is in the preview frame below — a change
                reloads it there.
              </>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void runner?.launch(workingOn)}
                className="h-6 cursor-pointer rounded-lg px-2 text-[9px]"
              >
                <Play className="size-3" />
                Run “{workingOn.name}” in the preview
              </Button>
            )}
            <a
              href="#builder-projects"
              className="text-muted-foreground underline decoration-dotted hover:text-foreground"
            >
              {onTheHomeScreen(workingOn)
                ? "or edit its files by hand in Saved Projects"
                : "— a draft in Saved Projects, where Publish to Home Screen puts it among the icons"}
            </a>
          </p>
        ) : (
          <p className="text-[9px] leading-4 text-muted-foreground">
            One press: the six agents write the files, the sandbox builds them,
            and what they make waits in{" "}
            <span className="text-foreground">Saved Projects</span> as a draft —
            never on this hub&apos;s own code — and not among the home
            screen&apos;s icons until somebody presses Publish to Home Screen
            there. From then on it is the app this box works on, and every
            request after it is a change to that app rather than another one.
            The Build Code Log below shows every step as it happens, and the
            Preview &amp; Test Sandbox below that runs what comes out — the one
            box on this page with two things it can hold:{" "}
            <span className="text-foreground">Apps it made</span>, and{" "}
            <span className="text-foreground">This app — its mirror</span>,
            which is where the hub itself is changed. A change to the hub is
            written, typechecked and built in a copy of it in that sandbox,
            never in the app you are using.
          </p>
        )}
      </div>

      {/* Requests the Assistant packaged land here, and go to the same crew. */}
      {requests.length ? (
        <div className="mt-2 border-t border-border/60 pt-2">
          <p className="text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Asked for by the Assistant ({requests.length})
          </p>
          <ul className="mt-1 flex flex-col gap-1.5">
            {requests.map((request) => (
              <li
                key={request.id}
                className="flex flex-wrap items-start gap-2 rounded-xl border border-border/60 bg-background/40 px-2.5 py-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-[10px] leading-4">{request.goal}</p>
                  {request.constraints ? (
                    <p className="mt-0.5 text-[9px] leading-4 text-muted-foreground">
                      Must respect: {request.constraints}
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                  <Button
                    type="button"
                    size="sm"
                    disabled={busy !== null || blocked || !chosen}
                    onClick={() => {
                      // A request that names no app is a request for a new one,
                      // so it starts from an empty bench like any other.
                      const named = appNamedIn(
                        `${request.goal}\n${request.context}`,
                        all,
                      );
                      void build({
                        brief: request.goal,
                        requestId: request.id,
                        context: request.context,
                        constraints: request.constraints,
                        about: named,
                        fresh: named === null,
                      });
                    }}
                    className="h-7 cursor-pointer rounded-lg text-[10px]"
                  >
                    <Rocket className="size-3" />
                    Build this
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() => {
                      void answerRequest(
                        request.id,
                        "declined",
                        "Not this one.",
                      );
                      toast("Declined — the Assistant sees the answer.");
                    }}
                    className="h-7 cursor-pointer rounded-lg text-[10px] text-muted-foreground hover:text-foreground"
                  >
                    Decline
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* --------------------------------------------------- model settings */}
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-[13px]">
              <Settings2 className="size-3.5" />
              Model Settings
            </DialogTitle>
            <DialogDescription className="text-[11px] leading-4">
              The same provider hub the Control Room shows. Keys are sealed in
              this browser&apos;s vault; the pair marked in use is what the crew
              thinks with.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[70vh] overflow-y-auto pr-1">
            <ByokBox />
          </div>
        </DialogContent>
      </Dialog>

      {/* The footer note, kept where the press is. */}
      <p className="mt-2 flex items-center gap-1.5 text-[9px] leading-4 text-muted-foreground">
        <Hammer className="size-3 shrink-0" />
        Nothing here runs on its own: a request starts with the button above,
        and the Build Code Log can stop it.
      </p>
    </section>
  );
}

export default BuilderCrewPanel;
