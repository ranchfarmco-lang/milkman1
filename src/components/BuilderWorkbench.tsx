import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AppRunner } from "@/hooks/use-app-runner";
import { useForgeApps, useSandbox } from "@/hooks/use-forge";
import type { AppRow } from "@/lib/forge/db";
import {
  deleteApp,
  duplicateApp,
  loadAppIntoSandbox,
  onTheHomeScreen,
  publishApp,
  reportAppError,
  runnable,
  setAppOnHome,
} from "@/lib/forge/apps";
import { cn } from "@/lib/utils";
import {
  AppWindow,
  CircleAlert,
  CopyPlus,
  FilePlus2,
  Files,
  Folder,
  FolderOpen,
  Home,
  Loader2,
  Package,
  Pencil,
  Play,
  Save,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

/**
 * Saved Projects — the drafts, and the workshop they are worked on in.
 *
 * This is the fourth box on the AI Builder page, beside the preview, and its job
 * is the one thing the home screen deliberately does not do: hold work that is
 * not ready. A project saved from the bench is a **draft** — kept whole, with
 * its build, exactly as an app is, but not on the home screen until somebody
 * publishes it there. An app can be moved off the home screen and land back
 * here, too.
 *
 * Every app the crew builds lands here first, too: a build is published as a
 * draft (`publishFromSandbox`), and its own **Publish to Home Screen** is the
 * only thing that puts it among the icons. That ordering is the point — nothing
 * reaches the home screen without somebody deciding it is finished.
 *
 * Every draft carries the things a draft needs, and nothing else:
 *
 *  * **Run** — it, in the Preview & Test Sandbox beside it, without publishing it.
 *  * **Edit Draft** — its files onto the bench below, where the tree and the
 *    editor work on them; Save Draft runs a build and puts the result in the
 *    preview box.
 *  * **Duplicate** — a copy to try something risky in, without risking this one.
 *  * **Move** — the open file to another path. A path is not a label here: the
 *    entry page and what the build can run are both decided by names, so this
 *    is the one edit the editor cannot make by hand.
 *  * **Publish to Home Screen** — it is finished enough to launch, so it becomes
 *    an icon in the box at the bottom of the page.
 *  * **Delete** — two presses, and it is gone for good.
 *
 * The other half of the box is the bench itself, and it is the *sandbox's* bench
 * rather than a second copy of one. That is the fix for what this box used to
 * do: it listed one bench's files (the hub's own workspace) while its buttons
 * read and wrote a different one (the sandbox), so "open this project" said the
 * files were on the bench and nothing appeared. Whatever the crew builds, and
 * whatever a draft is mounted into, is the one tree that shows here — so Edit
 * Draft genuinely puts the files in the editor.
 */

/** One node of the tree: a folder, or a file with the path it is known by. */
type TreeNode = {
  name: string;
  /** Set on a file; absent on a folder. */
  path?: string;
  children: TreeNode[];
};

/** Fold a flat list of paths into a tree, folders first, files alphabetised. */
function buildTree(paths: string[]): TreeNode {
  const root: TreeNode = { name: "", children: [] };

  for (const path of [...paths].sort((a, b) => a.localeCompare(b))) {
    const parts = path.split("/");
    let node = root;

    parts.forEach((part, index) => {
      const leaf = index === parts.length - 1;
      let next = node.children.find(
        (child) => child.name === part && Boolean(child.path) === leaf,
      );

      if (!next) {
        next = leaf
          ? { name: part, path, children: [] }
          : { name: part, children: [] };
        node.children.push(next);
      }
      node = next;
    });
  }

  const order = (nodes: TreeNode[]): TreeNode[] =>
    nodes
      .sort(
        (a, b) =>
          Number(Boolean(a.path)) - Number(Boolean(b.path)) ||
          a.name.localeCompare(b.name),
      )
      .map((node) => ({ ...node, children: order(node.children) }));

  return { name: "", children: order(root.children) };
}

/** One draft's build, in the fewest words that still tell the truth. */
function buildBadge(app: AppRow) {
  return app.build.ok
    ? "builds"
    : `${app.build.errors.length || 1} problem${app.build.errors.length === 1 ? "" : "s"}`;
}

/**
 * What to call a draft saved from the bench, when it is not a project already
 * known by a name: its own folder, if the bench holds one, and otherwise the
 * date — so two saves in a row are two drafts rather than one name twice.
 */
function benchProjectName(files: { path: string }[]): string {
  const folders = new Map<string, number>();
  for (const file of files) {
    const folder = file.path.includes("/") ? file.path.split("/")[0] : "";
    if (!folder) continue;
    folders.set(folder, (folders.get(folder) ?? 0) + 1);
  }
  const best = [...folders.entries()].sort((a, b) => b[1] - a[1])[0];
  if (best && best[1] > 1) return best[0].slice(0, 60);
  return `Bench project — ${new Date().toLocaleString()}`.slice(0, 60);
}

/** One row of the tree, with its folder's children folded out below it. */
function TreeRow({
  node,
  depth,
  selected,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  if (node.path) {
    const active = selected === node.path;
    return (
      <button
        type="button"
        onClick={() => onSelect(node.path!)}
        title={node.path}
        className={cn(
          "flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-left font-mono text-[10px] leading-4",
          active
            ? "bg-white/15 text-foreground"
            : "text-muted-foreground hover:bg-white/5 hover:text-foreground",
        )}
        style={{ paddingLeft: `${0.5 + depth * 0.75}rem` }}
      >
        <span className="truncate">{node.name}</span>
      </button>
    );
  }

  return (
    <div>
      <div
        className="flex items-center gap-1.5 px-2 py-1 text-[10px] font-medium tracking-wide text-muted-foreground/80 uppercase"
        style={{ paddingLeft: `${0.5 + depth * 0.75}rem` }}
      >
        <Folder className="size-3 shrink-0" />
        <span className="truncate">{node.name}</span>
      </div>
      <div>
        {node.children.map((child) => (
          <TreeRow
            key={child.path ?? `dir-${child.name}`}
            node={child}
            depth={depth + 1}
            selected={selected}
            onSelect={onSelect}
          />
        ))}
      </div>
    </div>
  );
}

export function BuilderWorkbench({ runner }: { runner?: AppRunner }) {
  // The bench is the sandbox's own file system — the one the crew builds, the
  // one a draft is mounted into, and the one the preview box beside it runs.
  const sandbox = useSandbox();
  const engine = sandbox.engine;

  // Everything kept — from which the drafts are the ones not on the home screen.
  const apps = useForgeApps();
  const drafts = useMemo(
    () => (apps ?? []).filter((app) => !onTheHomeScreen(app)),
    [apps],
  );

  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [newPath, setNewPath] = useState("");
  /** The open file's new path, while it is being renamed. */
  const [renaming, setRenaming] = useState(false);
  const [renamePath, setRenamePath] = useState("");
  const [busy, setBusy] = useState(false);
  const [savingProject, setSavingProject] = useState(false);
  /** The draft a button is working on, so its own row can say so. */
  const [acting, setActing] = useState<string | null>(null);
  /** Which draft's delete has been pressed once and is waiting for the second. */
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const files = engine.fileList();
  const openProject = apps?.find((app) => app.id === sandbox.mounted) ?? null;

  // What is actually open: what was picked while it still exists, otherwise —
  // nothing picked yet, or the pick deleted under us — the entry page, then
  // the first file. Derived rather than remembered, so a deleted file can
  // never leave this panel holding a path that no longer answers.
  const fallbackPath = useMemo(() => {
    const paths = files.map((file) => file.path);
    return (
      paths.find((path) => /(^|\/)index\.html?$/i.test(path)) ??
      paths[0] ??
      null
    );
  }, [files]);
  const activePath =
    selected !== null && files.some((file) => file.path === selected)
      ? selected
      : fallbackPath;

  // A stale pick is corrected here too, so the tree and the editor cannot
  // drift apart: this settles in one pass and never repeats.
  if (selected !== activePath) setSelected(activePath);

  const serverContent = activePath === null ? null : engine.read(activePath);

  // Follow the bench whenever the editor is not being typed in: a build that
  // rewrites the open file rewrites what is shown, which is exactly what
  // "live" should mean. A person mid-edit is never interrupted — the unsaved
  // mark says a newer version is one Discard away — and picking another file
  // always loads that file. This is the documented "adjust state when what you
  // are looking at changes" pattern: guarded, so it settles at once.
  const seenKey =
    activePath === null || serverContent === null
      ? null
      : JSON.stringify([activePath, serverContent]);
  const [seen, setSeen] = useState<string | null>(null);

  if (seenKey === null) {
    if (seen !== null) setSeen(null);
  } else if (seenKey !== seen) {
    setSeen(seenKey);
    const previous =
      seen === null ? null : (JSON.parse(seen) as [string, string]);
    const sameFile = previous !== null && previous[0] === activePath;
    const clean = !sameFile || previous[1] === draft;
    if (clean && serverContent !== null && draft !== serverContent) {
      setDraft(serverContent);
    }
  }

  const dirty = serverContent !== null && draft !== serverContent;
  const tree = useMemo(
    () => buildTree(files.map((file) => file.path)),
    [files],
  );
  const lineCount = draft ? draft.split("\n").length : 0;

  // A delete left armed should not fire an hour later: the asking fades on its
  // own, the same as the rest of the hub's twice-pressed buttons.
  useEffect(() => {
    if (confirmDelete === null) return;
    const timer = window.setTimeout(() => setConfirmDelete(null), 6000);
    return () => window.clearTimeout(timer);
  }, [confirmDelete]);

  const saveDraft = async () => {
    if (!activePath || !dirty) return;
    setBusy(true);
    try {
      await engine.write(activePath, draft);
      toast.success(`${activePath} saved.`);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not save that file.",
      );
    } finally {
      setBusy(false);
    }
  };

  const addFile = async () => {
    const path = newPath.trim();
    if (!path) return;
    setBusy(true);
    try {
      await engine.write(path, "");
      setNewPath("");
      setSelected(path);
      toast.success(`${path} created.`);
    } catch {
      toast.error("Could not create that file.");
    } finally {
      setBusy(false);
    }
  };

  /**
   * Move the open file to a new path, with its content.
   *
   * A path is not a label here: `index.html` at the root is the page an app
   * opens on, and the sandbox build decides what it can run by the extension.
   * A file written as `app.ts` instead of `app.js` therefore cannot be fixed by
   * editing it — only by moving it — so this is the one edit the editor could
   * not make by hand.
   */
  const renameFile = async () => {
    const from = activePath;
    const to = renamePath.trim().replace(/^\/+/, "");
    if (!from) return;
    if (!to || to === from) {
      setRenaming(false);
      return;
    }
    if (files.some((file) => file.path === to)) {
      toast.error(`${to} is already on the bench — use another path.`);
      return;
    }
    setBusy(true);
    try {
      await engine.write(to, dirty ? draft : (serverContent ?? ""));
      await engine.remove(from);
      setSelected(to);
      setRenaming(false);
      toast.success(`Moved ${from} to ${to}.`);
    } catch {
      toast.error("Could not move that file.");
    } finally {
      setBusy(false);
    }
  };

  const deleteFile = async () => {
    if (!activePath) return;
    const path = activePath;
    setBusy(true);
    try {
      await engine.remove(path);
      setSelected(null);
      toast.success(`${path} removed.`);
    } catch {
      toast.error("Could not remove that file.");
    } finally {
      setBusy(false);
    }
  };

  /**
   * Keep the bench as a draft.
   *
   * A new one is a draft — that is what this box is for — while saving a
   * project that is already open updates it where it stands, keeping its name,
   * its place, and whether it is on the home screen.
   */
  const saveProject = async () => {
    if (!files.length) {
      toast.error("The bench is empty — there is nothing to save yet.");
      return;
    }
    setSavingProject(true);
    setProblem(null);
    try {
      const build = await engine.build();
      const app = await publishApp({
        id: openProject?.id,
        name: openProject?.name ?? benchProjectName(files),
        goal:
          openProject?.goal ??
          "Saved from the bench — a draft that is not on the home screen yet.",
        files,
        build,
        sessionId: openProject?.sessionId ?? null,
        onHome: openProject ? onTheHomeScreen(openProject) : false,
      });
      toast.success(
        app.build.ok
          ? `“${app.name}” is saved: ${app.files.length} file(s), and it builds.`
          : `“${app.name}” is saved, with the build problems it has.`,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Could not save that project.";
      setProblem(message);
      toast.error(message);
      void reportAppError("save draft", error);
    } finally {
      setSavingProject(false);
    }
  };

  /** Edit Draft: its files onto the bench, ready to be worked on. */
  const openDraft = async (app: AppRow) => {
    setActing(app.id);
    setProblem(null);
    try {
      const count = await loadAppIntoSandbox(app);
      setSelected(null);
      toast.success(
        `${count} file(s) of “${app.name}” are on the bench — edit them below.`,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Could not open that draft.";
      setProblem(message);
      toast.error(message);
    } finally {
      setActing(null);
    }
  };

  /**
   * Run a draft in the Preview box beside it, without publishing it.
   *
   * A draft is an app: it has its own files and its own entry page, and the
   * frame runs exactly that. Publishing is what puts it among the home screen's
   * icons, and it is a separate decision — so seeing what you have does not
   * have to look like finishing it.
   */
  const run = async (app: AppRow) => {
    if (!runner) return;
    if (!runnable(app)) {
      toast.error(
        `“${app.name}” has no page to open — send it back for work from its icon.`,
      );
      return;
    }
    await runner.launch(app);
    toast(`“${app.name}” is running in the Preview & Test Sandbox.`);
  };

  /** A copy to try something risky in. Copies stay drafts while it is one. */
  const duplicate = async (app: AppRow) => {
    setActing(app.id);
    try {
      const copy = await duplicateApp(app.id);
      if (!copy) {
        toast.error("That draft is no longer here.");
        return;
      }
      toast.success(`Copied as “${copy.name}”.`);
    } finally {
      setActing(null);
    }
  };

  /** It is finished enough to launch, so it becomes an icon on the home screen. */
  const publish = async (app: AppRow) => {
    setActing(app.id);
    try {
      const done = await setAppOnHome(app.id, true);
      if (!done) {
        toast.error("That draft is no longer here.");
        return;
      }
      toast.success(`“${app.name}” is on the home screen.`);
    } finally {
      setActing(null);
    }
  };

  const removeDraft = async (app: AppRow) => {
    setActing(app.id);
    try {
      await deleteApp(app.id);
      setConfirmDelete(null);
      toast.success(`“${app.name}” is gone.`);
    } finally {
      setActing(null);
    }
  };

  return (
    <section
      id="builder-projects"
      className="flex h-full min-h-0 scroll-mt-4 flex-col overflow-hidden rounded-2xl border border-border/70 bg-card/70 backdrop-blur-sm"
    >
      {/* ---------------------------------------------------------- header */}
      <header className="flex flex-wrap items-center gap-3 border-b border-border/60 px-4 py-2.5">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-white/10 text-white">
          <FolderOpen className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-1.5 truncate text-[12px] font-semibold tracking-tight">
            <span className="grid size-4 shrink-0 place-items-center rounded-full border border-white/30 text-[8px] font-medium text-foreground/80">
              4
            </span>
            Saved Projects — drafts &amp; workshop
          </h2>
          <p className="truncate text-[10px] text-muted-foreground">
            {openProject
              ? `“${openProject.name}” is on the bench`
              : "Every build waits here first — run it, change it, or publish it when it is finished"}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void saveProject()}
          disabled={savingProject || files.length === 0}
          title="Keep the bench's files as a draft here — publish it to the home screen when it is ready"
          className="h-7 shrink-0 cursor-pointer rounded-lg text-[10px]"
        >
          {savingProject ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <Package className="size-3" />
          )}
          Save Draft
        </Button>
        <span className="shrink-0 rounded-full border border-border/60 bg-background/40 px-2 py-0.5 text-[9px] font-medium text-muted-foreground">
          {`${drafts.length} draft${drafts.length === 1 ? "" : "s"} · ${files.length} file${
            files.length === 1 ? "" : "s"
          }`}
        </span>
      </header>

      {problem ? (
        <p className="mx-4 mt-2 flex items-start gap-1.5 rounded-xl border border-dashed border-border/70 bg-background/40 px-2.5 py-2 text-[10px] leading-4 text-muted-foreground">
          <CircleAlert className="mt-px size-3 shrink-0" />
          {problem}
        </p>
      ) : null}

      {/* ------------------------------------------------------ the drafts */}
      <div className="flex max-h-[18rem] min-h-0 shrink-0 flex-col overflow-y-auto border-b border-border/60 px-3 py-2">
        {apps === null ? (
          <p className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            Reading the drafts…
          </p>
        ) : drafts.length === 0 ? (
          <p className="flex items-start gap-2 rounded-xl border border-dashed border-border/70 bg-background/30 px-3 py-3 text-[10px] leading-4 text-muted-foreground">
            <AppWindow className="mt-px size-3.5 shrink-0" />
            <span>
              No drafts yet. Every app the crew builds waits here first, and
              Save Draft keeps whatever is on the bench here too — nothing on
              this page reaches the home screen until Publish to Home Screen.
            </span>
          </p>
        ) : (
          <div className="grid gap-2 @3xl:grid-cols-2">
            {drafts.map((app) => (
              <div
                key={app.id}
                className="flex flex-col gap-1.5 rounded-xl border border-border/60 bg-background/30 px-2.5 py-2"
              >
                <div className="flex items-center gap-1.5">
                  <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-[11px] font-medium">
                    {app.name}
                  </span>
                  <span
                    className={cn(
                      "shrink-0 rounded-full border px-1.5 py-px text-[8px]",
                      app.build.ok
                        ? "border-white/40 text-foreground"
                        : "border-dashed border-border/70 text-muted-foreground",
                    )}
                  >
                    {buildBadge(app)}
                  </span>
                </div>

                <p className="truncate text-[9px] tabular-nums text-muted-foreground">
                  {app.files.length} file{app.files.length === 1 ? "" : "s"} ·{" "}
                  {new Date(app.updatedAt).toLocaleString()}
                </p>
                <p className="line-clamp-2 text-[9px] leading-4 text-muted-foreground">
                  {app.goal || "No brief was kept for this draft."}
                </p>

                <div className="mt-0.5 flex flex-wrap items-center gap-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void openDraft(app)}
                    disabled={acting !== null}
                    title="Put its files on the bench below, where the editor works"
                    className="h-6 cursor-pointer rounded-lg px-2 text-[9px]"
                  >
                    {acting === app.id ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <FolderOpen className="size-3" />
                    )}
                    Edit Draft
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void duplicate(app)}
                    disabled={acting !== null}
                    title="A copy, so a change can be tried without risking this one"
                    className="h-6 cursor-pointer rounded-lg px-2 text-[9px]"
                  >
                    <CopyPlus className="size-3" />
                    Duplicate
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void run(app)}
                    disabled={acting !== null || !runner}
                    title="Run this draft in the Preview &amp; Test Sandbox, without publishing it"
                    className="h-6 cursor-pointer rounded-lg px-2 text-[9px]"
                  >
                    <Play className="size-3" />
                    {runner?.running === app.id ? "Running" : "Run"}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => void publish(app)}
                    disabled={acting !== null}
                    title="It is finished enough to launch — make it an icon on the home screen"
                    className="h-6 cursor-pointer rounded-lg bg-white px-2 text-[9px] text-black hover:bg-white/85"
                  >
                    <Home className="size-3" />
                    Publish to Home Screen
                  </Button>
                  {confirmDelete === app.id ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => void removeDraft(app)}
                      disabled={acting !== null}
                      title="This cannot be undone"
                      className="h-6 cursor-pointer rounded-lg px-2 text-[9px] text-destructive/90 hover:text-destructive"
                    >
                      <Trash2 className="size-3" />
                      Delete for good
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setConfirmDelete(app.id)}
                      disabled={acting !== null}
                      title="Press once to be asked again, twice to remove it"
                      className="h-6 cursor-pointer rounded-lg px-2 text-[9px] text-muted-foreground hover:text-foreground"
                    >
                      <Trash2 className="size-3" />
                      Delete
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ----------------------------------------------------- tree + editor */}
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {/* The tree: a narrow column of paths, its own scroll. */}
        <div className="flex min-h-0 shrink-0 flex-col border-b border-border/60 md:w-52 md:border-r md:border-b-0">
          <div className="min-h-0 flex-1 overflow-y-auto py-1.5">
            {files.length === 0 ? (
              <p className="px-3 py-2 text-[10px] leading-4 text-muted-foreground">
                Nothing on the bench. Press Edit Draft above, press Generate App
                in the prompt studio, or write a new file.
              </p>
            ) : (
              tree.children.map((node) => (
                <TreeRow
                  key={node.path ?? `dir-${node.name}`}
                  node={node}
                  depth={0}
                  selected={activePath}
                  onSelect={setSelected}
                />
              ))
            )}
          </div>

          {/* New file: one field, path and all. */}
          <div className="flex items-center gap-1.5 border-t border-border/60 px-2 py-2">
            <Input
              value={newPath}
              onChange={(event) => setNewPath(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void addFile();
              }}
              placeholder="new/file.ts"
              aria-label="New file path"
              className="h-7 rounded-lg font-mono text-[10px]"
            />
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              onClick={() => void addFile()}
              disabled={!newPath.trim() || busy}
              aria-label="Create the file"
              className="size-7 shrink-0 cursor-pointer text-muted-foreground hover:text-foreground"
            >
              <FilePlus2 className="size-3.5" />
            </Button>
          </div>
        </div>

        {/* The editor: the real content, with the save under it. */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {activePath === null ? (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-4 text-center">
              <span className="grid size-11 place-items-center rounded-2xl border border-dashed border-border/80 bg-white/10 text-white">
                <Files className="size-5" />
              </span>
              <p className="mt-3 text-[12px] font-medium">No file open</p>
              <p className="mt-1 max-w-[26ch] text-[10px] leading-4 text-muted-foreground">
                Edit a draft, pick one from the tree, or make a new file here.
              </p>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-1.5">
                <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-foreground/85">
                  {activePath}
                </span>
                {dirty ? (
                  <span className="shrink-0 rounded-full border border-dashed border-border/70 px-1.5 py-px text-[8px] text-muted-foreground">
                    unsaved
                  </span>
                ) : null}
                <span className="shrink-0 text-[9px] text-muted-foreground">
                  {lineCount} lines · {draft.length.toLocaleString()} chars
                </span>
              </div>

              {renaming ? (
                <div className="flex flex-wrap items-center gap-1.5 border-b border-border/60 bg-background/40 px-3 py-2">
                  <span className="shrink-0 text-[9px] text-muted-foreground">
                    Move it to
                  </span>
                  <Input
                    value={renamePath}
                    onChange={(event) => setRenamePath(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void renameFile();
                      if (event.key === "Escape") setRenaming(false);
                    }}
                    aria-label="New path for this file"
                    autoFocus
                    className="h-7 min-w-40 flex-1 rounded-lg font-mono text-[10px]"
                  />
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => void renameFile()}
                    disabled={busy || !renamePath.trim()}
                    className="h-7 shrink-0 cursor-pointer rounded-lg text-[10px]"
                  >
                    Move it
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setRenaming(false)}
                    className="h-7 shrink-0 cursor-pointer rounded-lg text-[10px] text-muted-foreground hover:text-foreground"
                  >
                    Cancel
                  </Button>
                </div>
              ) : null}

              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "s") {
                    event.preventDefault();
                    void saveDraft();
                  }
                }}
                data-spell="off"
                spellCheck={false}
                wrap="off"
                aria-label={`Editing ${activePath}`}
                className="min-h-0 flex-1 resize-none bg-background/40 p-3 font-mono text-[11px] leading-5 text-foreground outline-none"
              />

              <div className="flex items-center gap-2 border-t border-border/60 px-3 py-2">
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void saveDraft()}
                  disabled={!dirty || busy}
                  className="h-7 cursor-pointer rounded-lg text-[10px]"
                >
                  {busy ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Save className="size-3" />
                  )}
                  Save
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setRenamePath(activePath);
                    setRenaming((open) => !open);
                  }}
                  disabled={busy}
                  title="Move this file to another path — the sandbox decides what it can run by the name"
                  className="h-7 cursor-pointer rounded-lg text-[10px] text-muted-foreground hover:text-foreground"
                >
                  <Pencil className="size-3" />
                  Move
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => void deleteFile()}
                  disabled={busy}
                  className="h-7 cursor-pointer rounded-lg text-[10px] text-muted-foreground hover:text-foreground"
                >
                  <Trash2 className="size-3" />
                  Delete
                </Button>
                {dirty ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setDraft(serverContent ?? "")}
                    className="h-7 cursor-pointer rounded-lg text-[10px] text-muted-foreground hover:text-foreground"
                  >
                    Discard
                  </Button>
                ) : null}
                <span className="ml-auto truncate text-[9px] text-muted-foreground">
                  saved to the bench — Save Draft runs a build and puts it in
                  the preview
                </span>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
