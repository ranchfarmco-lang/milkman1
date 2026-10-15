import { Button } from "@/components/ui/button";
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
import { LivePreview, type InspectorPick } from "@/components/LivePreview";
import { BuilderMirror } from "@/components/BuilderMirror";
import type { AppRunner } from "@/hooks/use-app-runner";
import {
  appDocument,
  appFileName,
  deleteApp,
  downloadAppZip,
  duplicateApp,
  loadAppIntoSandbox,
  onTheHomeScreen,
  rebuildApp,
  renameApp,
  reportAppError,
  runnable,
  sendAppBack,
  setAppOnHome,
} from "@/lib/forge/apps";
import type { AppRow } from "@/lib/forge/db";
import { postForge } from "@/lib/forge/events";
import { beginRun, endRun } from "@/lib/forge/runtime";
import { downloadBlob } from "@/lib/download";
import { cn } from "@/lib/utils";
import {
  Activity,
  AppWindow,
  Calculator,
  CalendarDays,
  ChefHat,
  CircleAlert,
  CircleCheck,
  CloudSun,
  Coins,
  Copy,
  CopyPlus,
  ArrowUp,
  Crosshair,
  Download,
  ExternalLink,
  FileText,
  FolderInput,
  FolderOpen,
  Gamepad2,
  GraduationCap,
  Hammer,
  Image as ImageIcon,
  KeyRound,
  LayoutGrid,
  ListChecks,
  Loader2,
  Map,
  Maximize2,
  MessageSquare,
  Monitor,
  MonitorPlay,
  Music,
  Package,
  Palette,
  Pencil,
  Play,
  RotateCw,
  Send,
  Smartphone,
  Square,
  Timer,
  Trash2,
  WandSparkles,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

/**
 * The builder page's two boxes about *apps*: the home screen at the top, and
 * the sandbox preview the launched app runs in.
 *
 * The AI Builder page is where an app is asked for, built, launched and saved.
 * The two components here are the launching and the saving half of that:
 *
 *   * **`BuilderAppsPanel`** — the home screen, at the bottom of the page
 *     because that is where the chain ends: an app gets here only by being
 *     published from Saved Projects. Every app that has been put here is one
 *     launcher icon: the classic rounded square with a small logo and its name
 *     underneath, the way a phone shows what it holds. Pressing one opens it
 *     in the preview box above, which is what a home screen is
 *     for. The icon is picked, and the tools for *that* app — run it, put it
 *     back on the bench, send it back for work, rebuild, rename, duplicate,
 *     save it out as a file, take it off the home screen, delete it — sit in
 *     one strip underneath, so the screen stays a screen instead of a wall of
 *     buttons. Apps that are still being worked on are not here at all: every
 *     build waits as a draft in Saved Projects, the fifth box (see
 *     BuilderWorkbench), and only Publish to Home Screen puts one here.
 *   * **`BuilderSandboxPreview`** — the preview box, which is the sandbox
 *     rather than a picture of code. Whatever icon was pressed runs here, in
 *     a frame with `allow-scripts` and without `allow-same-origin`, so the app
 *     behaves exactly as it would in a browser while the hub's session, its
 *     storage and its database stay out of its reach.
 *
 * Both boxes are two halves of one runner (`useAppRunner`), so pressing an icon
 * and the frame in the preview box are the same fact rather than two that can
 * disagree — the state lives once, above both of them.
 *
 * Two habits, kept from the App Sandbox page this came from:
 *
 * * **Nothing here runs on its own.** A launch, a rebuild, a rename and a
 *   send-back are all a press by a person. The page never spends a model call
 *   or a build to keep itself cheerful.
 * * **A failure is said out loud.** Every press goes through one guard that
 *   writes the message into the box and toasts it, rather than swallowing it.
 */

/** What a page can be doing when a button has been pressed and not returned. */
type Busy = string | null;

/** One toolbar button: its icon, its words, and what it really does. */
function ToolButton({
  icon: Icon,
  label,
  onClick,
  disabled,
  title,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="h-7 cursor-pointer rounded-lg text-[10px]"
    >
      <Icon className="size-3" />
      {label}
    </Button>
  );
}

/** One app's build, in the fewest words that still tell the truth. */
function buildBadge(app: AppRow) {
  return app.build.ok
    ? "builds"
    : `${app.build.errors.length || 1} problem${app.build.errors.length === 1 ? "" : "s"}`;
}

/**
 * The small logo on a launcher icon.
 *
 * A home screen reads by shape, and every icon here being the same generic
 * window would make a shelf of twenty apps unreadable. The mark is picked from
 * the app's own name and brief — a calculator gets a calculator, a grocery list
 * gets a purse — and anything the list does not recognise gets the plain app
 * window, which is honest rather than a guess at what it is.
 */
const GLYPHS: { match: RegExp; icon: LucideIcon }[] = [
  { match: /calc|arithmetic|math|number|convert/i, icon: Calculator },
  { match: /game|arcade|chess|puzzle|score|play/i, icon: Gamepad2 },
  { match: /timer|clock|alarm|stopwatch|pomodoro|countdown/i, icon: Timer },
  { match: /todo|to-do|task|checklist|chore|habit|packing/i, icon: ListChecks },
  { match: /paint|draw|sketch|palette|colour|color|canvas/i, icon: Palette },
  { match: /music|sound|audio|beat|piano|drum|tune/i, icon: Music },
  { match: /weather|forecast|rain|temperature|sky/i, icon: CloudSun },
  { match: /chat|message|letter|mail|note to/i, icon: MessageSquare },
  { match: /money|budget|expense|cost|price|shop|grocery|spend/i, icon: Coins },
  { match: /map|route|trip|travel|nearby|directions/i, icon: Map },
  { match: /photo|image|camera|picture|gallery/i, icon: ImageIcon },
  { match: /quiz|test|learn|study|flashcard|spell/i, icon: GraduationCap },
  { match: /fitness|workout|exercise|steps|health|water/i, icon: Activity },
  { match: /recipe|cook|meal|kitchen|food|menu/i, icon: ChefHat },
  {
    match: /calendar|schedule|planner|appointment|birthday/i,
    icon: CalendarDays,
  },
  { match: /password|secret|vault|lock|key|login/i, icon: KeyRound },
  { match: /file|document|text|markdown|write|letter/i, icon: FileText },
];

/** The logo an app's icon carries. */
function glyphFor(app: AppRow): LucideIcon {
  const hay = `${app.name} ${app.goal}`;
  return GLYPHS.find((one) => one.match.test(hay))?.icon ?? AppWindow;
}

/** Take the page to the preview box, where a pressed icon's app runs. */
function scrollToPreview() {
  window.setTimeout(() => {
    document
      .getElementById("builder-preview")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, 60);
}

/* ------------------------------------------------------------- the home screen */

/**
 * One launcher icon: the rounded square, the small logo, the name underneath.
 *
 * Everything a phone's home screen has, and nothing else: pressing it opens the
 * app. What is inside the square is only the app's own state — a ring while it
 * is the one running, and a dot when its build has something to say.
 */
function AppIcon({
  app,
  glyph: Glyph,
  running,
  picked,
  onOpen,
}: {
  app: AppRow;
  /** Its logo, chosen by the home screen — passed in rather than looked up
   *  here, so this is one component with a prop rather than a component
   *  standing for whatever the last render decided. */
  glyph: LucideIcon;
  running: boolean;
  picked: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      title={app.goal || app.name}
      aria-label={`Open ${app.name}`}
      className="group flex w-[4.75rem] cursor-pointer flex-col items-center gap-1.5 rounded-2xl p-1 text-center outline-none focus-visible:ring-2 focus-visible:ring-white/40"
    >
      <span
        className={cn(
          "relative grid size-16 place-items-center rounded-[1.15rem] border bg-gradient-to-b from-white/[0.14] to-white/[0.04] text-white shadow-sm transition-all duration-200 group-hover:-translate-y-0.5 group-hover:border-white/45 group-hover:from-white/25",
          running
            ? "border-white/60 from-white/25 ring-2 ring-white/35"
            : picked
              ? "border-white/45"
              : "border-white/20",
        )}
      >
        <Glyph className="size-7" strokeWidth={1.6} />

        {/* Its build has something to say. */}
        {app.build.ok ? null : (
          <span
            className="absolute top-1.5 right-1.5 grid size-3.5 place-items-center rounded-full bg-black/60 text-white"
            title={buildBadge(app)}
          >
            <CircleAlert className="size-2.5" />
          </span>
        )}

        {/* It is the one in the sandbox right now. */}
        {running ? (
          <span className="absolute -bottom-0.5 rounded-full bg-white px-1.5 py-px text-[7px] font-semibold tracking-wide text-black uppercase">
            live
          </span>
        ) : null}
      </span>

      <span
        className={cn(
          "line-clamp-2 w-full text-[9.5px] leading-3.5 break-words",
          picked || running
            ? "font-medium text-foreground"
            : "text-muted-foreground",
        )}
      >
        {app.name}
      </span>
    </button>
  );
}

/**
 * The home screen: the apps that are ready, as icons, and the tools for the one
 * that is picked.
 *
 * This is the last box on the AI Builder page, because it is where the chain
 * ends: an app is asked for at the top, built, watched, run and kept — and this
 * is the shelf of finished ones, the answer to "what have I got?". Pressing an
 * icon opens it in the preview box above; picking it fills the strip underneath
 * with everything that can be done to it, so the screen itself stays clean.
 */
export function BuilderAppsPanel({ runner }: { runner: AppRunner }) {
  /** The icon being looked at. The newest is shown until one is. */
  const [picked, setPicked] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  /** The icon whose "send it back" note is open. */
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [note, setNote] = useState("");
  /** Which icon's delete has been pressed once and is waiting for the second. */
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const all = runner.all;
  const home = useMemo(() => all.filter(onTheHomeScreen), [all]);
  const active = useMemo(
    () => home.find((one) => one.id === picked) ?? home[0] ?? null,
    [home, picked],
  );

  const launched = home.filter((one) => one.runs > 0).length;
  const working = home.filter((one) => one.build.ok).length;
  const drafts = all.length - home.length;

  // A delete left armed should not fire an hour later: the asking fades on its
  // own, the same as the rest of the hub's twice-pressed buttons.
  useEffect(() => {
    if (confirmDelete === null) return;
    const timer = window.setTimeout(() => setConfirmDelete(null), 6000);
    return () => window.clearTimeout(timer);
  }, [confirmDelete]);

  /**
   * Every button goes through here: one press, one busy mark, and a failure
   * that is said out loud and written down rather than swallowed.
   */
  const guard = async (label: string, work: () => Promise<void>) => {
    setBusy(label);
    setProblem(null);
    try {
      await work();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setProblem(message);
      toast.error(message);
      void reportAppError(label, error);
    } finally {
      setBusy(null);
    }
  };

  const pick = (id: string) => {
    setPicked(id);
    setNoteFor(null);
    setNote("");
    setRenaming(null);
    setRenameDraft("");
    setConfirmDelete(null);
  };

  /** Pressing an icon does what pressing an icon does: the app opens. */
  const open = (app: AppRow) => {
    pick(app.id);
    void runner.launch(app);
    scrollToPreview();
  };

  /**
   * Hand this app to the prompt box, with it already chosen as the target.
   *
   * The last link in the chain, and the one that closes the loop: an icon on
   * the home screen is not the end of an app, it is the app somebody may want
   * changed — and pressing this says *which* app in the box that will do it,
   * rather than making anybody scroll up and find it in a menu.
   */
  const askForChange = (app: AppRow) => {
    postForge({ type: "preset", id: app.id });
    toast(
      `“${app.name}” is chosen in the prompt studio above — say what to change.`,
    );
  };

  const openOnBench = async (app: AppRow) => {
    await guard(`open on the bench:${app.id}`, async () => {
      const files = await loadAppIntoSandbox(app);
      toast.success(
        `${files} file(s) of “${app.name}” are on the bench, in Projects.`,
      );
    });
  };

  /**
   * Build this app again — a crew run, like the one the prompt studio starts.
   *
   * It is registered as *the* run in front before it starts and taken back off
   * the wire in a `finally`, because the Build Code Log below shows a Stop
   * button for as long as any agent is running. Without this the button would
   * answer "Nothing is running to stop" over a rebuild that plainly is, which
   * is the one kind of control worse than none.
   */
  const rebuild = async (app: AppRow) => {
    const stop = new AbortController();
    beginRun(stop);
    try {
      await guard(`rebuild:${app.id}`, async () => {
        const result = await rebuildApp(app, { signal: stop.signal });
        setPicked(result.app.id);
        // A rebuilt app is a different document, so the frame is reloaded rather
        // than left holding the old one.
        await runner.launch(result.app);
        if (result.stopped) {
          // Stopped part-way is its own answer, not a build that failed.
          toast(
            `“${result.app.name}” was stopped mid-rebuild — press Rebuild to run it again.`,
          );
          return;
        }
        toast.success(
          result.build.ok
            ? `“${result.app.name}” was rebuilt and it passes.`
            : `“${result.app.name}” was rebuilt — ${result.build.errors.length} problem(s) came back.`,
        );
      });
    } finally {
      endRun(stop);
    }
  };

  const duplicate = async (app: AppRow) => {
    await guard(`duplicate:${app.id}`, async () => {
      const copy = await duplicateApp(app.id);
      if (!copy) {
        toast.error("That app is no longer here.");
        return;
      }
      setPicked(copy.id);
      toast.success(`Copied as “${copy.name}”.`);
    });
  };

  const rename = async (app: AppRow) => {
    await guard(`rename:${app.id}`, async () => {
      const done = await renameApp(app.id, renameDraft);
      if (!done) {
        toast.error("A name is needed — an empty one would blank the icon.");
        return;
      }
      setRenaming(null);
      toast.success("Renamed.");
    });
  };

  const sendBack = async (app: AppRow) => {
    await guard(`send back:${app.id}`, async () => {
      await sendAppBack(app, note);
      setNote("");
      setNoteFor(null);
      toast.success(
        "Sent back. The request is waiting in the AI app builder box — press Build it and the work starts.",
      );
    });
  };

  /** Off the home screen and into Saved Projects, while it is not ready yet. */
  const takeOffHome = async (app: AppRow) => {
    await guard(`take off the home screen:${app.id}`, async () => {
      const done = await setAppOnHome(app.id, false);
      if (!done) {
        toast.error("That app is no longer here.");
        return;
      }
      if (runner.running === app.id) runner.stop();
      setPicked(null);
      toast.success(`“${app.name}” is a draft in Saved Projects now.`);
    });
  };

  const remove = async (app: AppRow) => {
    await guard(`delete:${app.id}`, async () => {
      await deleteApp(app.id);
      if (runner.running === app.id) runner.stop();
      if (picked === app.id) setPicked(null);
      setConfirmDelete(null);
      toast.success(`“${app.name}” is gone.`);
    });
  };

  return (
    <section
      id="builder-apps"
      className="rounded-2xl border border-white/25 bg-card/70 p-3 backdrop-blur-sm"
    >
      {/* -------------------------------------------------------- header */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-white/10 text-white">
          <LayoutGrid className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-[11px] font-semibold tracking-tight">
            <span className="grid size-4 shrink-0 place-items-center rounded-full border border-white/30 text-[8px] font-medium text-foreground/80">
              5
            </span>
            App icons — the home screen
          </p>
          <p className="truncate text-[9px] text-muted-foreground">
            Finished apps only — press an icon and it opens in the Preview &amp;
            Test Sandbox above. Whatever the crew has just made waits in Saved
            Projects.
          </p>
        </div>

        <span className="flex flex-wrap items-center gap-1.5">
          <span className="rounded-full border border-border/60 px-2 py-1 text-[9px] tabular-nums text-muted-foreground">
            {runner.apps === null
              ? "reading…"
              : `${home.length} app${home.length === 1 ? "" : "s"}`}
          </span>
          <span className="rounded-full border border-border/60 px-2 py-1 text-[9px] tabular-nums text-muted-foreground">
            {launched} launched
          </span>
          <span className="rounded-full border border-border/60 px-2 py-1 text-[9px] tabular-nums text-muted-foreground">
            {working} building clean
          </span>
          {drafts > 0 ? (
            <a
              href="#builder-projects"
              title="Work that is not on the home screen yet — running, or ready to publish"
              className="rounded-full border border-dashed border-border/70 px-2 py-1 text-[9px] tabular-nums text-muted-foreground hover:border-border hover:text-foreground"
            >
              {drafts} in Saved Projects
            </a>
          ) : null}
        </span>
      </div>

      {problem ? (
        <p className="mt-2 flex items-start gap-1.5 rounded-xl border border-dashed border-border/70 bg-background/40 px-2.5 py-2 text-[10px] leading-4 text-muted-foreground">
          <CircleAlert className="mt-px size-3 shrink-0" />
          {problem}
        </p>
      ) : null}

      {/* ------------------------------------------------------------ icons */}
      {runner.apps === null ? (
        <p className="mt-2 flex items-center gap-1.5 rounded-xl border border-border/60 bg-background/30 px-3 py-4 text-[10px] text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          Reading the home screen…
        </p>
      ) : home.length === 0 ? (
        <p className="mt-2 flex items-start gap-2 rounded-xl border border-dashed border-border/70 bg-background/30 px-3 py-4 text-[10px] leading-4 text-muted-foreground">
          <AppWindow className="mt-px size-3.5 shrink-0" />
          <span>
            No apps on the home screen yet — and nothing arrives here until you
            say so. Write what you want in the prompt studio above and press
            Generate App: what it makes is a{" "}
            <span className="text-foreground">draft in Saved Projects</span>,
            where you can run it, change it or edit its files. Press{" "}
            <span className="text-foreground">Publish to Home Screen</span>{" "}
            there when it is finished and it appears here as an icon.
          </span>
        </p>
      ) : (
        <div className="mt-2 flex flex-wrap gap-1">
          {home.map((app) => (
            <AppIcon
              key={app.id}
              app={app}
              glyph={glyphFor(app)}
              running={runner.running === app.id}
              picked={picked === app.id}
              onOpen={() => open(app)}
            />
          ))}
        </div>
      )}

      {/* ------------------------------------------- the picked app's tools */}
      {active ? (
        <div className="mt-3 rounded-xl border border-border/60 bg-background/30 p-2.5">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <p className="min-w-0 flex-1 truncate text-[11px] font-medium">
              {active.name}
            </p>
            <span
              className={cn(
                "shrink-0 rounded-full border px-1.5 py-px text-[8px]",
                active.build.ok
                  ? "border-white/40 text-foreground"
                  : "border-dashed border-border/70 text-muted-foreground",
              )}
            >
              {buildBadge(active)}
            </span>
            <span className="shrink-0 text-[9px] tabular-nums text-muted-foreground">
              {active.files.length} file{active.files.length === 1 ? "" : "s"} ·{" "}
              {active.runs > 0
                ? `run ${active.runs} time${active.runs === 1 ? "" : "s"}`
                : "never run"}{" "}
              · {new Date(active.updatedAt).toLocaleString()}
            </span>
          </div>

          <p className="mt-1 line-clamp-2 text-[9px] leading-4 text-muted-foreground">
            {active.goal || "No brief was kept for this app."}
          </p>

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Button
              type="button"
              size="sm"
              onClick={() => open(active)}
              disabled={busy !== null}
              title="Open this app in the Preview & Test Sandbox above"
              className="h-7 cursor-pointer rounded-lg bg-white text-[10px] text-black hover:bg-white/85"
            >
              <Play className="size-3" />
              {runner.running === active.id ? "Launch again" : "Launch"}
            </Button>
            <ToolButton
              icon={WandSparkles}
              label="Ask for a change"
              onClick={() => askForChange(active)}
              disabled={busy !== null}
              title="Choose this app in the prompt studio above and say what to change about it"
            />
            <ToolButton
              icon={FolderOpen}
              label="Open on the bench"
              onClick={() => void openOnBench(active)}
              disabled={busy !== null}
              title="Put this app's files on the bench in Projects, so they can be edited"
            />
            <ToolButton
              icon={Send}
              label={noteFor === active.id ? "Close the note" : "Send back"}
              onClick={() => {
                setNoteFor(noteFor === active.id ? null : active.id);
                setNote("");
              }}
              disabled={busy !== null}
              title="Say what is wrong, and the builder gets the app's own brief and files with it"
            />
            <ToolButton
              icon={Hammer}
              label={
                busy === `rebuild:${active.id}` ? "Rebuilding…" : "Rebuild"
              }
              onClick={() => void rebuild(active)}
              disabled={busy !== null}
              title="Ask the builder to build this app again from its own brief"
            />
            <ToolButton
              icon={Pencil}
              label="Rename"
              onClick={() => {
                setRenaming(active.id);
                setRenameDraft(active.name);
              }}
              disabled={busy !== null}
            />
            <ToolButton
              icon={CopyPlus}
              label="Duplicate"
              onClick={() => void duplicate(active)}
              disabled={busy !== null}
              title="A copy, so a change can be tried without risking this one"
            />
            {/* Export is one press with two answers, rather than two buttons
                that both mean "save this app somewhere". */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy !== null}
                  title="Save this app onto this device"
                  className="h-7 cursor-pointer rounded-lg text-[10px]"
                >
                  <Download className="size-3" />
                  Export
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56">
                <DropdownMenuLabel className="text-[11px]">
                  Save “{active.name}”
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => {
                    const doc = appDocument(active);
                    if (doc) saveDocHtml(doc, active);
                  }}
                  disabled={!runnable(active)}
                  className="text-[12px]"
                >
                  <Download className="size-3.5" />
                  One .html file
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => {
                    const count = downloadAppZip(active);
                    toast.success(`Saved ${count} file(s) as a zip.`);
                  }}
                  className="text-[12px]"
                >
                  <Package className="size-3.5" />
                  Every file, as .zip
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <ToolButton
              icon={FolderInput}
              label="Move to drafts"
              onClick={() => void takeOffHome(active)}
              disabled={busy !== null}
              title="Keep it, but move it to Saved Projects until it is ready"
            />
            {confirmDelete === active.id ? (
              <ToolButton
                icon={Trash2}
                label={
                  busy === `delete:${active.id}`
                    ? "Deleting…"
                    : "Delete for good"
                }
                onClick={() => void remove(active)}
                disabled={busy !== null}
                title="This cannot be undone"
              />
            ) : (
              <ToolButton
                icon={Trash2}
                label="Delete"
                onClick={() => setConfirmDelete(active.id)}
                disabled={busy !== null}
                title="Press once to be asked again, twice to remove it"
              />
            )}
          </div>

          {renaming === active.id ? (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <Input
                value={renameDraft}
                onChange={(event) => setRenameDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void rename(active);
                  if (event.key === "Escape") setRenaming(null);
                }}
                aria-label="New name"
                className="h-7 min-w-32 flex-1 rounded-lg text-[10px]"
              />
              <Button
                type="button"
                size="sm"
                onClick={() => void rename(active)}
                disabled={busy !== null}
                className="h-7 cursor-pointer rounded-lg text-[10px]"
              >
                Save the name
              </Button>
            </div>
          ) : null}

          {noteFor === active.id ? (
            <div className="mt-2 flex flex-col gap-1.5 border-t border-border/50 pt-2">
              <Textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="The buttons do nothing and the equals sign is in the wrong place."
                aria-label="What needs fixing"
                className="min-h-12 rounded-xl text-[10px]"
              />
              <Button
                type="button"
                size="sm"
                onClick={() => void sendBack(active)}
                disabled={busy !== null}
                className="h-7 cursor-pointer rounded-lg text-[10px]"
              >
                <Send className="size-3" />
                {busy === `send back:${active.id}`
                  ? "Sending…"
                  : "Send it back for work"}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/* --------------------------------------------------------- the preview */

/**
 * The preview box: the app itself, running, in the sandbox.
 *
 * This is not a rendering of the code — it is the app. An icon is pressed on
 * the home screen below, the document is assembled from that app's own files
 * and handed to a frame, and what comes back is the real thing: its scripts
 * run, its stylesheet paints, and a bug in it is visible here rather than after
 * it has been copied to a phone.
 *
 * The sandbox is the one part of this that must not be softened. The frame
 * carries `allow-scripts` — a page with no scripting is not a preview of
 * anything — and deliberately does not carry `allow-same-origin`, so the
 * document lands in an opaque origin and cannot reach this page, its storage,
 * or the signed-in session behind it.
 *
 * Two things can be in this sandbox, and they are the two jobs of the whole
 * page: the app the builder just made, and **this app itself** — a copy of the
 * hub, on the workshop machine, where a change is written, typechecked and
 * built before anybody carries it into the real one. They are here, in one box
 * with a switch, rather than on two pages, because "change this app" and "make
 * an app" are one job with two targets, and the sandbox is where both of them
 * happen.
 */
export function BuilderSandboxPreview({ runner }: { runner: AppRunner }) {
  const { live, liveDoc, liveMissing, liveReady, runKey, running } = runner;
  /** Which of the page's two jobs this sandbox is holding right now. */
  const [target, setTarget] = useState<"app" | "self">("app");
  // The newest app of any kind, home screen or draft alike: a project that is
  // still being worked on is exactly the one somebody wants to run next.
  const newest = runner.all.find(onTheHomeScreen) ?? runner.all[0] ?? null;

  /** Phone width or the whole box. */
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  /** The inspector, which runs inside the frame (see LivePreview). */
  const [inspector, setInspector] = useState(false);
  const [pick, setPick] = useState<InspectorPick | null>(null);
  /** What goes full screen: this box, not the whole page. */
  const frame = useRef<HTMLDivElement>(null);
  const [full, setFull] = useState(false);

  useEffect(() => {
    const onFullScreen = () => setFull(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFullScreen);
    return () => document.removeEventListener("fullscreenchange", onFullScreen);
  }, []);

  const toggleFullScreen = async () => {
    const node = frame.current;
    if (!node) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await node.requestFullscreen();
    } catch {
      toast.error(
        "This browser would not open the frame full screen. Open it in a new tab instead.",
      );
    }
  };

  return (
    <section
      id="builder-preview"
      className="flex min-h-0 flex-1 scroll-mt-4 flex-col overflow-hidden rounded-2xl border border-white/25 bg-card/70 backdrop-blur-sm"
    >
      {/* -------------------------------------------------------- header */}
      <header className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2">
        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-white/10 text-white">
          <MonitorPlay className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 truncate text-[11px] font-semibold tracking-tight">
            <span className="grid size-4 shrink-0 place-items-center rounded-full border border-white/30 text-[8px] font-medium text-foreground/80">
              3
            </span>
            Preview &amp; Test Sandbox
          </p>
          <p className="truncate text-[9px] text-muted-foreground">
            {target === "self"
              ? "This app, as a copy — changed, checked and carried in from here"
              : live
                ? `${live.name} — running where it cannot reach this page or the hub's database`
                : "Press an app icon below and it opens here, running for real"}
          </p>
        </div>
        {target === "app" && live ? (
          <a
            href="#builder-log"
            title={
              live.build.ok
                ? "The build passed — press for the log that ran it"
                : `The build reported ${live.build.errors.length} problem(s) — press for the log that found them`
            }
            className={cn(
              "flex shrink-0 items-center gap-1 rounded-full border px-2 py-1 text-[9px] transition-colors hover:border-white/40",
              live.build.ok
                ? "border-white/40 text-foreground"
                : "border-dashed border-border/70 text-muted-foreground",
            )}
          >
            {live.build.ok ? (
              <CircleCheck className="size-3" />
            ) : (
              <CircleAlert className="size-3" />
            )}
            {buildBadge(live)}
            <ArrowUp className="size-3" />
            log
          </a>
        ) : null}
      </header>

      {/* Which of the two jobs is in the sandbox. The switch is here, at the
          top, rather than hidden behind a link: a person asking for a change to
          the hub and a person asking for a new app are asking two different
          things, and which one they are doing has to be readable at a glance. */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border/60 px-3 py-2">
        <span className="text-[9px] uppercase tracking-[0.14em] text-muted-foreground">
          In the sandbox
        </span>
        <span className="inline-flex items-center gap-0.5 rounded-xl border border-border/60 bg-background/40 p-0.5">
          <Button
            type="button"
            size="sm"
            variant={target === "app" ? "secondary" : "ghost"}
            onClick={() => setTarget("app")}
            aria-pressed={target === "app"}
            title="The app the crew made, running"
            className={cn(
              "h-6 cursor-pointer rounded-lg px-2 text-[10px]",
              target === "app" ? "text-foreground" : "text-muted-foreground",
            )}
          >
            <AppWindow className="size-3" />
            Apps it made
          </Button>
          <Button
            type="button"
            size="sm"
            variant={target === "self" ? "secondary" : "ghost"}
            onClick={() => setTarget("self")}
            aria-pressed={target === "self"}
            title="This hub itself, as a copy on the workshop machine — changed, checked, then carried in"
            className={cn(
              "h-6 cursor-pointer rounded-lg px-2 text-[10px]",
              target === "self" ? "text-foreground" : "text-muted-foreground",
            )}
          >
            <Hammer className="size-3" />
            This app — its mirror
          </Button>
        </span>
        {target === "self" ? (
          <span className="text-[9px] text-muted-foreground">
            changed in a copy of the hub, never in the hub itself
          </span>
        ) : null}
      </div>

      {target === "self" ? (
        <BuilderMirror />
      ) : (
        <>
          {/* -------------------------------------------------------- tools */}
          <div className="flex flex-wrap items-center gap-1.5 border-b border-border/60 px-3 py-2">
            <ToolButton
              icon={Play}
              label="Run it"
              onClick={() => {
                const app = live ?? newest;
                if (app) void runner.launch(app);
              }}
              disabled={!newest}
              title="Open the newest app — or this one again — in the frame"
            />
            <ToolButton
              icon={RotateCw}
              label="Refresh"
              onClick={runner.rerun}
              disabled={live === null}
              title="Load the app from the top, exactly as a fresh page"
            />
            <ToolButton
              icon={Square}
              label="Stop"
              onClick={() => {
                runner.stop();
                toast("Stopped. Nothing of it is left running.");
              }}
              disabled={running === null}
              title="Take the app out of the frame"
            />

            {/* Device view: the layout at phone width, or across the box. */}
            <span className="inline-flex items-center gap-0.5 rounded-xl border border-border/60 bg-background/40 p-0.5">
              <Button
                type="button"
                size="sm"
                variant={device === "mobile" ? "secondary" : "ghost"}
                onClick={() => setDevice("mobile")}
                aria-pressed={device === "mobile"}
                title="Show the app at phone width, 390 pixels"
                className={cn(
                  "h-6 cursor-pointer rounded-lg px-2 text-[10px]",
                  device === "mobile"
                    ? "text-foreground"
                    : "text-muted-foreground",
                )}
              >
                <Smartphone className="size-3" />
                Mobile
              </Button>
              <Button
                type="button"
                size="sm"
                variant={device === "desktop" ? "secondary" : "ghost"}
                onClick={() => setDevice("desktop")}
                aria-pressed={device === "desktop"}
                title="Show the app across the whole box"
                className={cn(
                  "h-6 cursor-pointer rounded-lg px-2 text-[10px]",
                  device === "desktop"
                    ? "text-foreground"
                    : "text-muted-foreground",
                )}
              >
                <Monitor className="size-3" />
                Desktop
              </Button>
            </span>

            <ToolButton
              icon={Crosshair}
              label={inspector ? "Inspecting" : "Inspect"}
              onClick={() => {
                setInspector((on) => !on);
                if (inspector) setPick(null);
              }}
              disabled={live === null}
              title="Press an element in the app to see what it is — this is a real inspector inside the frame"
            />

            <ToolButton
              icon={Maximize2}
              label={full ? "Exit full screen" : "Full screen"}
              onClick={() => void toggleFullScreen()}
              disabled={live === null}
              title="Fill the screen with the running app"
            />
            <ToolButton
              icon={ExternalLink}
              label="Open in a new tab"
              onClick={() => {
                if (liveDoc) openDocInNewTab(liveDoc);
              }}
              disabled={!liveReady || liveDoc === null}
              title="Open the app in its own browser tab, where it fills the window"
            />
            <ToolButton
              icon={Download}
              label="Save .html"
              onClick={() => {
                if (live && liveDoc) saveDocHtml(liveDoc, live);
              }}
              disabled={liveDoc === null}
              title="Save the app as one file that runs wherever it is opened"
            />
            <ToolButton
              icon={Package}
              label="Save .zip"
              onClick={() => {
                if (!live) return;
                const count = downloadAppZip(live);
                toast.success(`Saved ${count} file(s) as a zip.`);
              }}
              disabled={live === null}
              title="Save every file of the app, folder structure and all"
            />
            <ToolButton
              icon={Copy}
              label="Copy the code"
              onClick={() => {
                if (liveDoc) void copyDocCode(liveDoc);
              }}
              disabled={liveDoc === null}
              title="Copy the app's assembled page to the clipboard"
            />
          </div>

          {/* --------------------------------------------------------- frame */}
          {/* It fills the box rather than sitting at a fixed height: the sandbox is
          the one surface here that has to be big enough to actually use an app
          in, and the page gives it the room (see the Builder page's own note). */}
          {/* What the inspector found, named and ready to copy. */}
          {inspector && pick ? (
            <div className="flex flex-wrap items-center gap-2 border-b border-border/60 bg-background/50 px-3 py-1.5">
              <Crosshair className="size-3 shrink-0 text-sky-300/80" />
              <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-foreground/85">
                {pick.selector}
              </span>
              <span className="hidden max-w-72 min-w-0 flex-1 truncate font-mono text-[9px] text-muted-foreground sm:block">
                {pick.html}
              </span>
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  // The chain, working upwards: what was picked in the running app
                  // becomes the next request, with the app it belongs to already
                  // chosen — so "change this" needs no describing.
                  postForge({
                    type: "preset",
                    id: live?.id,
                    text: `Change this part of ${live ? `“${live.name}”` : "the app"}:\n\n${pick.selector}\n${pick.html}\n\n`,
                  });
                  toast.success(
                    "In the prompt studio above — say what should change about it.",
                  );
                }}
                className="h-6 shrink-0 cursor-pointer rounded-lg text-[10px]"
              >
                <WandSparkles className="size-3" />
                Ask for a change
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(`${pick.selector}\n\n${pick.html}`)
                    .then(() =>
                      toast.success(
                        "Copied — say this in the prompt box to change it.",
                      ),
                    )
                    .catch(() =>
                      toast.error("This browser would not let the hub copy."),
                    );
                }}
                className="h-6 shrink-0 cursor-pointer rounded-lg text-[10px] text-muted-foreground hover:text-foreground"
              >
                <Copy className="size-3" />
                Copy
              </Button>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                onClick={() => setPick(null)}
                aria-label="Clear the inspected element"
                className="size-6 shrink-0 cursor-pointer text-muted-foreground hover:text-foreground"
              >
                <X className="size-3" />
              </Button>
            </div>
          ) : null}

          {live && liveDoc ? (
            <div
              ref={frame}
              className="flex min-h-0 flex-1 flex-col bg-background p-2"
            >
              <LivePreview
                key={`${live.id}-${runKey}`}
                html={liveDoc}
                label={live.name}
                device={device}
                inspector={inspector}
                onPick={setPick}
              />
            </div>
          ) : (
            <div className="flex min-h-48 flex-1 flex-col items-center justify-center px-4 py-8 text-center">
              <span className="grid size-11 place-items-center rounded-2xl border border-dashed border-border/80 bg-white/10 text-white">
                <Play className="size-5" />
              </span>
              <p className="mt-3 text-[12px] font-medium">Nothing is running</p>
              <p className="mt-1 max-w-[42ch] text-[10px] leading-4 text-muted-foreground">
                Press an app icon on the home screen, press Run beside a draft
                in Saved Projects, or Run it here, and the app opens in this
                frame. It is the real app — its scripts run — in a frame that
                cannot reach the hub.
              </p>
              {live && !runnable(live) ? (
                <p className="mt-2 max-w-[42ch] text-[10px] leading-4 text-muted-foreground">
                  This app has no page to open: there is no index.html (or any
                  other .html file) among its files. Send it back for work from
                  its icon.
                </p>
              ) : live && liveMissing.length ? (
                <p className="mt-2 max-w-[42ch] text-[10px] leading-4 text-muted-foreground">
                  This app asks for file(s) it does not carry:{" "}
                  {liveMissing.join(", ")}. Send it back for work and it can be
                  repaired.
                </p>
              ) : null}
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** Open an assembled document in its own tab, where it fills the window. */
function openDocInNewTab(doc: string) {
  const url = URL.createObjectURL(
    new Blob([doc], { type: "text/html;charset=utf-8" }),
  );
  const opened = window.open(url, "_blank");
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  if (!opened) {
    toast.error(
      "This browser blocked the new tab. Allow pop-ups for the hub and press it again.",
    );
  }
}

/** Save an assembled document as the one file it will run from. */
function saveDocHtml(doc: string, app: AppRow) {
  const saved = downloadBlob(
    appFileName(app),
    new Blob([doc], { type: "text/html;charset=utf-8" }),
  );
  if (saved) toast.success(`Saved ${appFileName(app)}.`);
  else toast.error("There was nothing to save.");
}

/** Put the assembled page on the clipboard, or say why it could not go. */
async function copyDocCode(doc: string) {
  try {
    await navigator.clipboard.writeText(doc);
    toast.success("The app's code is on the clipboard.");
  } catch {
    toast.error(
      "This browser would not let the hub copy. Open it in a new tab and save it from there.",
    );
  }
}
