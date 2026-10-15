import { Button } from "@/components/ui/button";
import { MessagePanel } from "@/components/MessagePanel";
import { api } from "@/convex/_generated/api";
import type { BuildReport } from "@/convex/sandbox";
import { useChat } from "@/hooks/use-chat";
import { readShippedSource, type SourceMap } from "@/lib/backup";
import { downloadText } from "@/lib/download";
import { getSecret } from "@/lib/forge/crypto";
import { GITHUB_SECRET, pushRepo, saveGithubToken } from "@/lib/forge/github";
import { downloadZip } from "@/lib/forge/zip-io";
import { isBranchName, isRepoName } from "@/lib/github-export";
import {
  changePatch,
  changeSummary,
  changedBundle,
  changesZipName,
  diffLines,
  patchText,
} from "@/lib/self-changes";
import { cn } from "@/lib/utils";
import { useAction, useQuery } from "convex/react";
import {
  ChevronRight,
  CircleAlert,
  ClipboardCopy,
  Download,
  FileCode2,
  GitBranch,
  Hammer,
  Loader2,
  SquarePen,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";

/**
 * This app, as a copy, in the sandbox — and the way a change to it gets in.
 *
 * This is the other half of the AI Builder, and it lives *in* the AI Builder:
 * the same page, the same sandbox, the other of its two jobs. One is a new app
 * — a calculator, a score pad — and the crew writes it and it waits in Saved
 * Projects. This one is the app the person is looking at: the hub itself, its
 * pages, its styling, its behaviour. Two jobs wearing one name was exactly what
 * somebody had to guess at, so the sandbox says which it is holding, and the
 * switch is the first thing on it.
 *
 * Four facts decide how this is built, and each of them is visible here:
 *
 *  * **The hub's own builder does it.** The request goes to the builder agent
 *    on the hub's own models (`room: "builder"` with `focus: "self"`), which is
 *    the AI that can read its own source (`read_own_code`), lay every file of
 *    this project out on its bench (`scaffold_project`), change one in place
 *    (`edit_file`) and run this project's real typecheck and build on the
 *    workshop machine. Nothing here goes through the browser-side crew, which
 *    builds static apps and cannot touch this project at all.
 *  * **It changes a copy, and the copy is the point.** The workshop holds a
 *    replica of this whole app — every file of it, on a machine of its own
 *    (`src/convex/sandbox.ts`) — and that is what the builder edits, installs,
 *    typechecks and builds. A change that breaks the copy takes down a copy and
 *    nothing else, and the hub somebody is using never even notices. **Build the
 *    copy** proves the evolving app still compiles *before* anything is carried
 *    into the real one; **Check it** is the same proof, typecheck only.
 *  * **A change lands on the bench, and never on the running hub.** The builder
 *    has no way to write to the app anyone is using — this is a browser tab, and
 *    a tab cannot save its own source. So what a turn produces is the changed
 *    files themselves, and this box says that in as many words rather than
 *    leaving somebody watching a screen that never changes.
 *  * **Carrying it in is a press, or a few.** A push writes one commit holding
 *    exactly these files, on top of the branch as it stands (the hub's own
 *    GitHub writer uses `base_tree`, so nothing else in the repository moves) —
 *    and for an app deployed from a repository that commit *is* the change. Or
 *    the files are saved as a zip with their real paths, or the whole change is
 *    copied as one patch per file, or a backup is taken.
 *
 * What this must never do is imply that pressing Send changed anything. The
 * builder says what it changed; this box shows it and hands it over; a person
 * decides when it becomes the app.
 */

/** The same note the assistant boxes carry when nothing is configured. */
const NO_MODEL_NOTICE =
  "Nothing for the AI to talk to — the Control Room lists every system this hub can reach and the variable each one asks for, and any of them can be pasted into the Keys tab. The free public systems and a model on this machine need no key at all.";

/**
 * The shipped copy of this app, fetched once and kept.
 *
 * `/self-source.json` is the twin of the snapshot the backend reads, written
 * beside the page by the same `bun run snapshot:self`, and `readShippedSource`
 * is the reader the Backup panel already uses for it. It is a few megabytes, so
 * it is fetched the first time a diff is actually opened — never on page load —
 * and held for the rest of the visit.
 */
function useShippedSource() {
  const [files, setFiles] = useState<SourceMap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);

  const load = useCallback(async (): Promise<SourceMap | null> => {
    if (files) return files;
    setReading(true);
    try {
      const shipped = await readShippedSource();
      setFiles(shipped.files);
      return shipped.files;
    } catch (problem) {
      const message =
        problem instanceof Error
          ? problem.message
          : "The shipped copy could not be read.";
      setError(message);
      return null;
    } finally {
      setReading(false);
    }
  }, [files]);

  return { files, error, reading, load };
}

/** One line of the diff, in the app's own black and white. */
function DiffRow({
  kind,
  text,
}: {
  kind: "same" | "add" | "del" | "gap";
  text: string;
}) {
  return (
    <div
      className={cn(
        "flex gap-2 whitespace-pre-wrap break-words border-l-2 px-2 py-[1px] font-mono text-[10px] leading-4",
        kind === "add" && "border-white/45 bg-white/[0.06] text-foreground",
        kind === "del" &&
          "border-white/15 bg-transparent text-muted-foreground",
        kind === "same" && "border-transparent text-muted-foreground/70",
        kind === "gap" && "border-transparent text-muted-foreground/60 italic",
      )}
    >
      <span className="shrink-0 select-none opacity-60">
        {kind === "add"
          ? "+"
          : kind === "del"
            ? "−"
            : kind === "gap"
              ? "…"
              : " "}
      </span>
      <span className="min-w-0">{text || " "}</span>
    </div>
  );
}

/**
 * The mirror itself: this app, copied into the sandbox, and the two presses
 * that settle whether the copy still works.
 *
 * Both presses ask the workshop machine, not this build — `api.sandbox.buildNow`
 * seeds the copy from the running app, mirrors the builder's bench over it,
 * installs the app's own dependencies, typechecks, and (for the full build)
 * runs this project's own `bun run build`. What comes back is every step's real
 * output and the exact list of files in the copy that are no longer the app's
 * own — which is also the list a person carries in, so it is worth reading.
 *
 * The reading above the buttons is deliberately thin: whether a machine is
 * configured, and where the replica lives. Whether it is awake and whether it
 * builds are questions only a real request can answer, and this box asks them
 * by pressing a button rather than pretending to a live reading it cannot have.
 */
function MirrorPanel() {
  const workshop = useQuery(api.sandbox.state);
  const buildCopy = useAction(api.sandbox.buildNow);
  const [busy, setBusy] = useState<"check" | "build" | null>(null);
  const [report, setReport] = useState<BuildReport | null>(null);

  const run = async (quick: boolean) => {
    setBusy(quick ? "check" : "build");
    try {
      const result = await buildCopy({ quick });
      setReport(result);
      if (result.ok) {
        toast.success(
          quick
            ? "The copy typechecks. This app was not touched."
            : "The copy builds. This app was not touched.",
        );
      } else {
        toast.error(
          result.error ?? "The copy did not build — the output is below.",
        );
      }
    } catch {
      toast.error("Could not reach the workshop to build the copy.");
    } finally {
      setBusy(null);
    }
  };

  const connected = workshop?.connected === true;

  return (
    <section className="flex flex-col rounded-2xl border border-white/20 bg-background/30">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <Hammer className="size-3.5 shrink-0 text-muted-foreground" />
        <h3 className="flex-1 text-[11px] font-medium tracking-tight">
          The mirror — this whole app, on a machine of its own
        </h3>

        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy !== null || !connected}
          onClick={() => void run(true)}
          title="Typecheck the copy and nothing else — the fast one, for while you are still changing things"
          className="h-7 cursor-pointer rounded-lg text-[10px]"
        >
          {busy === "check" ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <Zap className="size-3" />
          )}
          {busy === "check" ? "Checking…" : "Check it"}
        </Button>

        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy !== null || !connected}
          onClick={() => void run(false)}
          title="Seed the copy, install what it needs, typecheck it and run this project's real build"
          className="h-7 cursor-pointer rounded-lg text-[10px]"
        >
          {busy === "build" ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <Hammer className="size-3" />
          )}
          {busy === "build" ? "Building…" : "Build the copy"}
        </Button>
      </div>

      <p className="px-3 pb-2 text-[9px] leading-4 text-muted-foreground">
        {workshop === undefined ? (
          "Looking for the sandbox…"
        ) : connected ? (
          <>
            Every file of this app is copied to{" "}
            <code className="text-foreground">{workshop.replica}</code> —
            another machine, another tree — and that copy is what the builder
            edits, installs and builds. Nothing it does here can reach the hub
            you are using: a copy that stops compiling is the worst it can
            manage.
          </>
        ) : (
          <>
            No sandbox machine is configured, so there is nowhere of its own for
            the copy to stand and the builder says so plainly. One key —{" "}
            <code className="text-foreground">DAYTONA_API_KEY</code> — gives it
            one. Nothing else about this hub needs a machine of its own, and
            every other box works without one.
          </>
        )}
      </p>

      {report ? (
        <div className="border-t border-border/60 px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                "rounded-full border px-1.5 py-px text-[8px]",
                report.ok
                  ? "border-white/40 text-foreground"
                  : "border-dashed border-border/70 text-muted-foreground",
              )}
            >
              {report.ok
                ? busy === "check"
                  ? "The copy typechecks"
                  : "The copy builds"
                : "The copy does not build"}
            </span>

            {report.seededFiles > 0 ? (
              <span className="text-[9px] text-muted-foreground">
                {report.seededFiles} files copied from the running app
              </span>
            ) : null}
          </div>

          {report.error ? (
            <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
              {report.error}
            </p>
          ) : null}

          <ul className="mt-2 flex flex-col gap-1.5">
            {report.steps.map((step) => (
              <li
                key={step.name}
                className="rounded-xl border border-border/70 bg-background/30 px-2.5 py-2"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[10px] font-medium">{step.name}</span>
                  <span className="text-[9px] text-muted-foreground">
                    {step.ok ? "passed" : "failed"} in {step.seconds}s
                  </span>
                </div>

                {!step.ok ? (
                  <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-[9px] leading-4 text-muted-foreground">
                    {step.detail}
                  </pre>
                ) : null}
              </li>
            ))}
          </ul>

          <p className="mt-2 text-[10px] leading-4 text-muted-foreground">
            {report.changed === null
              ? "Could not compare the copy against this app's own files, so there is no list of what it changed."
              : report.changed.length === 0
                ? "Nothing in the copy differs from this app's own files."
                : `Different from this app (${report.changed.length}): ${report.changed.join(", ")}`}
          </p>
        </div>
      ) : null}
    </section>
  );
}

/**
 * One file the AI has changed about this app: its path, how much moved, and —
 * when somebody opens it — the diff itself against how it ships today.
 *
 * The bench copy is read live (`api.workspace.readOwn`), so a row left open
 * while the AI works again shows the newer change rather than a stale one.
 */
function ChangeRow({
  path,
  shipped,
  reading,
  load,
}: {
  path: string;
  shipped: SourceMap | null;
  reading: boolean;
  load: () => Promise<SourceMap | null>;
}) {
  const [open, setOpen] = useState(false);
  const bench = useQuery(api.workspace.readOwn, open ? { path } : "skip");

  const before = shipped?.[path] ?? null;
  const after = bench && "content" in bench ? bench.content : null;

  const diff = useMemo(() => {
    if (!open || before === null || after === null) return null;
    return diffLines(before, after);
  }, [open, before, after]);

  const patch = useMemo(
    () =>
      before === null || after === null ? null : patchText(path, before, after),
    [path, before, after],
  );

  const open_ = async () => {
    setOpen((was) => !was);
    if (!shipped) await load();
  };

  const copyPatch = async () => {
    if (!patch) return;
    await navigator.clipboard.writeText(patch);
    toast.success(`The patch for ${path} is on the clipboard.`);
  };

  return (
    <div className="border-t border-border/60 first:border-t-0">
      <button
        type="button"
        onClick={() => void open_()}
        className="flex w-full cursor-pointer items-center gap-2 px-2.5 py-2 text-left transition-colors hover:bg-white/[0.03]"
      >
        <ChevronRight
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
        <span className="min-w-0 flex-1 truncate font-mono text-[10px]">
          {path}
        </span>
        {diff && !diff.same ? (
          <span className="shrink-0 font-mono text-[9px] text-muted-foreground">
            +{diff.added} −{diff.removed}
          </span>
        ) : (
          <span className="shrink-0 text-[9px] text-muted-foreground">
            changed
          </span>
        )}
      </button>

      {open ? (
        <div className="pb-2.5 pl-2.5 pr-2">
          {reading || bench === undefined ? (
            <p className="flex items-center gap-1.5 px-2 py-2 text-[10px] text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              Reading the change…
            </p>
          ) : bench === null ? (
            <p className="px-2 py-2 text-[10px] text-muted-foreground">
              This file is no longer on the bench, so there is nothing to carry
              in for it.
            </p>
          ) : before === null ? (
            <p className="px-2 py-2 text-[10px] leading-4 text-muted-foreground">
              The copy of the app shipped beside this page does not have{" "}
              <span className="font-mono">{path}</span>, so there is nothing to
              compare it against. The backend still counts it as changed; the
              files themselves are what to carry in.
            </p>
          ) : (
            <>
              {diff ? (
                <div className="max-h-72 overflow-y-auto rounded-lg border border-border/60 bg-background/50 py-1">
                  {diff.lines.map((line, index) => (
                    <DiffRow
                      key={`${line.kind}-${index}`}
                      kind={line.kind}
                      text={line.text}
                    />
                  ))}
                </div>
              ) : null}

              {diff?.clipped ? (
                <p className="mt-1 text-[9px] leading-4 text-muted-foreground">
                  The middle of a large change is left out here; the file itself
                  is whole, and that is what gets carried in.
                </p>
              ) : null}

              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void copyPatch()}
                  disabled={!patch}
                  title={
                    patch
                      ? "One unified diff, the shape a patch tool expects"
                      : "This change is too large to hand over as a patch — save the files instead"
                  }
                  className="h-6 cursor-pointer rounded-lg text-[10px]"
                >
                  <FileCode2 className="size-3" />
                  Copy the patch
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    downloadText(`${path.replace(/\//g, "-")}.txt`, after ?? "")
                  }
                  className="h-6 cursor-pointer rounded-lg text-[10px] text-muted-foreground hover:text-foreground"
                >
                  <Download className="size-3" />
                  Save this file as it now stands
                </Button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Carrying the change into a repository.
 *
 * One press, one commit, and only these files: the hub's GitHub writer builds
 * the new tree on top of whatever the branch already holds (`base_tree`), so a
 * push of two changed files moves those two paths and leaves everything else in
 * the repository exactly where it was. The token is the same one the Control
 * Room's GitHub box uses, sealed in this browser's vault — pasted once, kept
 * encrypted, never sent anywhere but `api.github.com`.
 */
function PushRow({ paths }: { paths: string[] }) {
  const exportBench = useAction(api.workspace.exportNow);
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [saved, setSaved] = useState(false);
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("main");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void getSecret(GITHUB_SECRET).then((value) => setSaved(Boolean(value)));
  }, []);

  const push = async () => {
    const key = (token.trim() || (await getSecret(GITHUB_SECRET)) || "").trim();
    if (!key) {
      toast(
        "A token is needed first — paste a personal access token with repo scope.",
      );
      return;
    }
    if (!isRepoName(repo)) {
      toast("The repository goes as owner/repo, like sugar/private-hub.");
      return;
    }
    if (!isBranchName(branch.trim() || "main")) {
      toast("That branch name will not do.");
      return;
    }

    setBusy(true);
    try {
      if (token.trim()) {
        await saveGithubToken(token.trim());
        setSaved(true);
      }
      const bench = await exportBench({});
      if (!bench) {
        toast.error(
          "The bench did not answer — sign in and unlock the hub, then try again.",
        );
        return;
      }
      const files = changedBundle(bench.files, paths);
      if (!files.length) {
        toast(
          "The changed files are no longer on the bench, so there is nothing to push.",
        );
        return;
      }
      const result = await pushRepo({
        token: key,
        repo: repo.trim(),
        branch: branch.trim() || "main",
        files,
        message: `This app — ${files.length} file(s) changed by the AI Builder`,
      });
      if (result.ok) toast.success(result.detail);
      else toast.error(result.detail);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-t border-border/60 pt-2.5">
      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        className="flex w-full cursor-pointer items-center gap-2 text-left"
      >
        <GitBranch className="size-3 shrink-0 text-muted-foreground" />
        <span className="flex-1 text-[10px]">
          Push these {paths.length === 1 ? "changes" : `${paths.length} files`}{" "}
          to a repository
        </span>
        <ChevronRight
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
      </button>

      {open ? (
        <div className="mt-2 flex flex-col gap-2">
          <p className="text-[9px] leading-4 text-muted-foreground">
            One commit, holding exactly{" "}
            {paths.length === 1 ? "this file" : "these files"}, built on top of
            the branch as it stands — nothing else in the repository moves. For
            an app deployed from a repository, that commit is the change.
          </p>

          <div className="flex flex-wrap items-center gap-1.5">
            {!saved ? (
              <input
                type="password"
                autoComplete="off"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder="personal access token (repo scope)"
                aria-label="GitHub personal access token"
                className="h-7 min-w-0 flex-1 rounded-lg border border-border/60 bg-background/60 px-2 text-[10px] outline-none focus:border-white/40"
              />
            ) : (
              <span className="text-[9px] text-muted-foreground">
                A token is sealed in this browser
                {token.trim() ? " (being replaced)" : ""}.
              </span>
            )}
            <input
              value={repo}
              onChange={(event) => setRepo(event.target.value)}
              placeholder="owner/repo"
              aria-label="Repository"
              data-spell="off"
              spellCheck={false}
              className="h-7 w-40 rounded-lg border border-border/60 bg-background/60 px-2 text-[10px] outline-none focus:border-white/40"
            />
            <input
              value={branch}
              onChange={(event) => setBranch(event.target.value)}
              placeholder="main"
              aria-label="Branch"
              data-spell="off"
              spellCheck={false}
              className="h-7 w-20 rounded-lg border border-border/60 bg-background/60 px-2 text-[10px] outline-none focus:border-white/40"
            />
            <Button
              type="button"
              size="sm"
              onClick={() => void push()}
              disabled={busy}
              className="h-7 cursor-pointer rounded-lg text-[10px]"
            >
              {busy ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <GitBranch className="size-3" />
              )}
              {busy ? "Pushing…" : "Push"}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * What the AI has changed about this app, and the ways it gets in.
 *
 * The list is live: `api.backup.changed` is a query over the bench and the
 * snapshot, so a file the builder writes appears here the moment it is written —
 * while the turn is still running, rather than after somebody remembers to look.
 */
function ChangedPanel() {
  const changed = useQuery(api.backup.changed, {});
  const exportBench = useAction(api.workspace.exportNow);
  const shipped = useShippedSource();
  const [busy, setBusy] = useState<string | null>(null);

  // One list, stable between renders: the sender below it and the rows above it
  // are keyed on it, and a fresh array on every render would rebuild both.
  const paths = useMemo(() => changed?.paths ?? [], [changed]);

  const benchFiles = useCallback(async () => {
    const bench = await exportBench({});
    if (!bench) {
      toast.error(
        "The bench did not answer — sign in and unlock the hub, then try again.",
      );
      return null;
    }
    const files = changedBundle(bench.files, paths);
    if (!files.length) {
      toast(
        "The changed files are no longer on the bench, so there is nothing to carry in.",
      );
      return null;
    }
    return { at: bench.at, files };
  }, [exportBench, paths]);

  const save = async () => {
    setBusy("save");
    try {
      const bundle = await benchFiles();
      if (!bundle) return;
      downloadZip(changesZipName(bundle.at), bundle.files);
      toast.success(
        `${bundle.files.length} file(s) saved with their real paths — put them back in the project as they are.`,
      );
    } finally {
      setBusy(null);
    }
  };

  const copyAll = async () => {
    setBusy("patch");
    try {
      const map = await shipped.load();
      if (!map) {
        toast.error(shipped.error ?? "The shipped copy could not be read.");
        return;
      }
      const bundle = await benchFiles();
      if (!bundle) return;
      const patch = changePatch(
        bundle.files.map((file) => ({
          path: file.path,
          before: map[file.path] ?? "",
          after: file.content,
        })),
      );
      if (!patch) {
        toast(
          "One of these changes is too large to hand over as a patch — save the files instead.",
        );
        return;
      }
      await navigator.clipboard.writeText(patch);
      toast.success("Every change, as a patch, is on the clipboard.");
    } finally {
      setBusy(null);
    }
  };

  const totals = useMemo(() => {
    // The header's own line only needs the count of files; the line counts are
    // per row, where a person is actually reading them.
    return changeSummary({ files: paths.length, added: 0, removed: 0 }).split(
      " — ",
    )[0];
  }, [paths.length]);

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-white/20 bg-card/60 backdrop-blur-sm">
      <div className="flex items-center gap-2 px-3 py-2">
        <SquarePen className="size-3.5 shrink-0 text-muted-foreground" />
        <h3 className="flex-1 text-[11px] font-medium tracking-tight">
          What the AI has changed about this app
        </h3>
        <span className="rounded-full border border-border/60 px-2 py-0.5 text-[9px] text-muted-foreground">
          {totals}
        </span>
      </div>

      <p className="px-3 pb-2 text-[9px] leading-4 text-muted-foreground">
        A change the AI makes to this app lands on its bench — the working copy
        it keeps — and never on the hub you are using. These are the files that
        no longer match how the app shipped
        {changed
          ? ` (${changed.total} files, taken ${new Date(changed.at).toLocaleDateString()})`
          : ""}
        . They are what a backup merges over the shipped app, and what a push or
        a save carries in.
      </p>

      <div className="min-h-0 flex-1 overflow-y-auto border-t border-border/60">
        {changed === undefined ? (
          <p className="flex items-center gap-1.5 px-3 py-3 text-[10px] text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            Reading the bench…
          </p>
        ) : changed === null ? (
          <p className="px-3 py-3 text-[10px] leading-4 text-muted-foreground">
            The bench is not answering. Sign in and unlock the hub, then open
            this page again.
          </p>
        ) : paths.length === 0 ? (
          <p className="px-3 py-3 text-[10px] leading-4 text-muted-foreground">
            Nothing yet. Ask on the left — “make the nav sit on the left”, “give
            the calendar a week view”, “make the buttons bigger” — and every
            file it touches appears here, with the diff, as it is written.
          </p>
        ) : (
          paths.map((path) => (
            <ChangeRow
              key={path}
              path={path}
              shipped={shipped.files}
              reading={shipped.reading}
              load={shipped.load}
            />
          ))
        )}
      </div>

      <div className="flex flex-col gap-2 border-t border-border/60 px-3 py-2.5">
        {shipped.error ? (
          <p className="flex items-start gap-1.5 text-[9px] leading-4 text-muted-foreground">
            <CircleAlert className="mt-0.5 size-3 shrink-0" />
            {shipped.error}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void save()}
            disabled={!paths.length || busy !== null}
            title="A zip holding exactly these files, at the paths they belong at"
            className="h-7 cursor-pointer rounded-lg text-[10px]"
          >
            {busy === "save" ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Download className="size-3" />
            )}
            Save the changed files
          </Button>

          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void copyAll()}
            disabled={!paths.length || busy !== null}
            title="One unified diff per changed file, in one hunk each"
            className="h-7 cursor-pointer rounded-lg text-[10px]"
          >
            {busy === "patch" ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <ClipboardCopy className="size-3" />
            )}
            Copy the whole patch
          </Button>
        </div>

        {paths.length ? <PushRow paths={paths} /> : null}

        <p className="text-[9px] leading-4 text-muted-foreground">
          A backup carries this in too: taken from the{" "}
          <Link
            to="/offline-brain"
            className="text-foreground underline decoration-dotted hover:decoration-solid"
          >
            Offline Brain
          </Link>
          , it merges these files — the ones written since the app&apos;s own
          copy — over that copy, so the copy you save is the app with the change
          already in it. Nothing written before that copy can replace newer code
          in it.
        </p>
      </div>
    </section>
  );
}

/**
 * The whole second job of the AI Builder page, in one box: the mirror of this
 * app in the sandbox, the request that changes it, and the changed files with
 * the ways to carry them into the real app.
 *
 * Asked on the left, shown on the right, which is the shape of changing this
 * app: the AI writes the files, and the person decides what happens to them.
 * The request is the same box the assistant page uses, on the builder's own
 * thread — one conversation per person, and the job written into the turn
 * (`focus: "self"`) rather than into the words somebody had to remember to type.
 */
export function BuilderMirror() {
  const chat = useChat("builder", { focus: "self" });

  const aiOffline = chat.aiReady === false;
  const busy = chat.thinking;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
      <MirrorPanel />

      <div className="flex min-h-0 flex-col gap-3 @4xl:flex-row @4xl:items-stretch">
        {/* The request. */}
        <div className="flex h-[30rem] min-h-0 min-w-0 flex-col @4xl:h-[38rem] @4xl:flex-1">
          <MessagePanel
            title="Change this app"
            subtitle="It edits this app's own files in the mirror — you decide when they go in"
            icon={SquarePen}
            accent={{
              iconWrap: "bg-white/10 text-white",
              send: "bg-white text-black hover:bg-white/85",
              bubble: "bg-white/15 text-white",
              dot: "bg-white",
            }}
            placeholder="Make the header stick to the top…"
            emptyTitle="Nothing asked yet"
            emptyHint="Say what should change about this app and the AI changes the real files inside the mirror, then checks them there. The diff lands in the box beside this one, ready to push, save or back up."
            status={aiOffline ? "Not connected" : busy ? "Working" : "Ready"}
            room="builder"
            messages={chat.messages}
            onSend={(text) => void chat.sendMessage(text)}
            onClear={chat.clearRoom}
            thinking={busy}
            notice={chat.error ?? (aiOffline ? NO_MODEL_NOTICE : null)}
            footer={
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-border/60 px-4 py-2 text-[9px] leading-4 text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      "size-1.5 rounded-full",
                      busy ? "bg-white" : "bg-white/30",
                    )}
                  />
                  {busy
                    ? "Changing this app — the diff appears on the right as files are written"
                    : "It changes this app only. A new app is what the crew above makes."}
                </span>
              </div>
            }
          />
        </div>

        {/* What changed about it, and the ways to carry it in. Wants the height:
            a diff is a tall thing. */}
        <div className="flex h-[30rem] min-h-0 min-w-0 flex-col @4xl:h-[38rem] @4xl:w-[30rem] @4xl:shrink-0">
          <ChangedPanel />
        </div>
      </div>
    </div>
  );
}
