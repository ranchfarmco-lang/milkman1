/**
 * Boxes 4 and 5 — Local Storage & Project Engine, and File System & Context.
 *
 * Box 4 is the project engine: IndexedDB and OPFS health lights from real
 * probes, Export/Import ZIP, New/Clear Project, and the auto-save switch.
 * Box 5 is the file system: Re-index, Rebuild knowledge.md and Validate
 * Integrity, each doing exactly what it says over the live project's rows.
 */
import { ForgeBox, MiniButton } from "@/components/forge/ForgeBox";
import { Switch } from "@/components/ui/switch";
import { useForgeConfig, useForgeTick } from "@/hooks/use-forge";
import { writeConfig } from "@/lib/forge/config";
import {
  clearProjectFiles,
  currentProject,
  importFilesAsProject,
  projectFiles,
  rebuildKnowledge,
  reindexProject,
  validateIntegrity,
} from "@/lib/forge/files";
import { downloadZip, readZip } from "@/lib/forge/zip-io";
import { forgeDb, setLight, type Tone } from "@/lib/forge/db";
import { useLiveQuery } from "dexie-react-hooks";
import {
  Database,
  FileSearch,
  FileText,
  FolderPlus,
  Import,
  ListChecks,
  Package,
  Trash2,
} from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

/* ------------------------------------------------------------------ box 4 */

export function StorageBox() {
  const config = useForgeConfig();
  const tick = useForgeTick();
  const fileInput = useRef<HTMLInputElement>(null);
  const [probe, setProbe] = useState<{ indexeddb: Tone; opfs: Tone; detail: string } | null>(null);
  const [clearArmed, setClearArmed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const projectCount = useLiveQuery(() => forgeDb.projects.count(), ["projects", tick]);
  const fileCount = useLiveQuery(() => forgeDb.files.count(), ["files", tick]);

  const runProbe = async () => {
    let indexeddbTone: Tone = "bad";
    let opfsTone: Tone = "warn";
    const notes: string[] = [];
    try {
      const rows = await forgeDb.projects.count();
      indexeddbTone = "good";
      notes.push(`IndexedDB open — ${rows} project row(s).`);
    } catch (error) {
      notes.push(`IndexedDB refused: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      if (navigator.storage?.getDirectory) {
        await navigator.storage.getDirectory();
        opfsTone = "good";
        notes.push("OPFS available.");
      } else {
        notes.push("OPFS not offered by this browser.");
      }
    } catch (error) {
      opfsTone = "bad";
      notes.push(`OPFS refused: ${error instanceof Error ? error.message : String(error)}`);
    }
    const detail = notes.join(" ");
    setProbe({ indexeddb: indexeddbTone, opfs: opfsTone, detail });
    await setLight("storage", indexeddbTone, detail);
    toast(detail);
  };

  const exportZip = async () => {
    setBusy("export");
    try {
      const project = await currentProject();
      const files = await projectFiles(project.id);
      if (!files.length) {
        toast("The project has no files to export yet.");
        return;
      }
      downloadZip(project.name, files);
      toast.success(`Exported ${files.length} file(s) as ${project.name}.zip.`);
    } finally {
      setBusy(null);
    }
  };

  const importZip = async (file: File) => {
    setBusy("import");
    try {
      const rows = await readZip(file);
      const project = await importFilesAsProject(
        file.name.replace(/\.zip$/i, "") || "Imported project",
        rows,
      );
      toast.success(`Imported ${rows.length} file(s) into “${project.name}”.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not read that ZIP.");
    } finally {
      setBusy(null);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const newProject = async () => {
    const name = window.prompt("Name the new project:", "New project");
    if (name === null) return;
    const project = await importFilesAsProject(
      name.trim() || "New project",
      [
        {
          path: "index.html",
          content:
            '<!DOCTYPE html>\\n<html lang="en">\\n<head>\\n  <meta charset="utf-8" />\\n  <meta name="viewport" content="width=device-width, initial-scale=1" />\\n  <title>New project</title>\\n</head>\\n<body>\\n  <h1>Hello</h1>\\n</body>\\n</html>\\n',
        },
      ],
    );
    toast.success(`“${project.name}” created with a starter index.html.`);
  };

  const clearProject = async () => {
    if (!clearArmed) {
      setClearArmed(true);
      toast("Press Clear Project again to delete every file in it.");
      window.setTimeout(() => setClearArmed(false), 4000);
      return;
    }
    setClearArmed(false);
    const project = await currentProject();
    const removed = await clearProjectFiles(project.id);
    toast.success(`Cleared ${removed} file(s) from “${project.name}”.`);
  };

  const tone: Tone = probe?.indexeddb === "bad" ? "bad" : fileCount ? "good" : "warn";

  return (
    <ForgeBox
      id="forge-storage"
      icon={Database}
      title="Local Storage & Project Engine"
      light={{
        tone,
        value: probe ? (probe.indexeddb === "good" ? "STORE OK" : "STORE FAIL") : `${fileCount ?? 0} FILES`,
        note: probe?.detail ?? `${projectCount ?? 0} project(s) in IndexedDB.`,
      }}
      onRefresh={runProbe}
      test={{ label: "Storage Test", onTest: runProbe }}
      hint="Everything the forge knows lives in this browser's IndexedDB — one database, “controlforge”. The ZIP is the way to take it anywhere."
    >
      <div className="flex flex-wrap items-center gap-2">
        <MiniButton onClick={() => void exportZip()} disabled={busy === "export"} title="Download the current project as a .zip">
          <Package className="size-3" />
          {busy === "export" ? "Exporting…" : "Export ZIP"}
        </MiniButton>
        <MiniButton onClick={() => fileInput.current?.click()} disabled={busy === "import"} title="Import files from a .zip as a new project">
          <Import className="size-3" />
          {busy === "import" ? "Importing…" : "Import ZIP"}
        </MiniButton>
        <input
          ref={fileInput}
          type="file"
          accept=".zip,application/zip"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void importZip(file);
          }}
        />
        <MiniButton onClick={() => void newProject()} title="Start an empty project">
          <FolderPlus className="size-3" />
          New Project
        </MiniButton>
        <MiniButton onClick={() => void clearProject()} title="Delete every file in the current project (two presses)">
          <Trash2 className="size-3 text-amber-300" />
          {clearArmed ? "press again to clear" : "Clear Project"}
        </MiniButton>

        <label className="ml-auto flex items-center gap-2 text-[10px] text-foreground/90">
          <Switch
            checked={config.autoSave}
            onCheckedChange={(checked) => void writeConfig({ autoSave: checked })}
          />
          Auto-save
        </label>
      </div>

      <p className="mt-2 text-[9px] leading-4 text-muted-foreground">
        Auto-save {config.autoSave ? "is on — sandbox edits are written to IndexedDB as you type them." : "is off — sandbox edits stay in memory until a build runs."}
      </p>
    </ForgeBox>
  );
}

/* ------------------------------------------------------------------ box 5 */

export function FilesBox() {
  const tick = useForgeTick();
  const [report, setReport] = useState<string | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const [reading, setReading] = useState(false);

  const fileCount = useLiveQuery(() => forgeDb.files.count(), ["files", tick]);

  const withProject = async <T,>(work: (projectId: string) => Promise<T>): Promise<T> => {
    const project = await currentProject();
    return work(project.id);
  };

  const reindex = async () => {
    setReading(true);
    try {
      const result = await withProject((id) => reindexProject(id));
      setReport(result.detail);
      setIssues([]);
      toast.success(result.detail);
    } finally {
      setReading(false);
    }
  };

  const knowledgeRebuild = async () => {
    setReading(true);
    try {
      const result = await withProject((id) => rebuildKnowledge(id));
      setReport(`knowledge.md rebuilt — ${result.bytes} bytes describing the project.`);
      setIssues([]);
      toast.success("knowledge.md rebuilt from the project's real files.");
    } finally {
      setReading(false);
    }
  };

  const integrity = async () => {
    setReading(true);
    try {
      const result = await withProject((id) => validateIntegrity(id));
      setIssues(result.issues);
      setReport(
        result.ok
          ? "Every file checked — no issues."
          : `${result.issues.length} issue(s) found.`,
      );
      if (result.ok) toast.success("Integrity check passed.");
      else toast(`${result.issues.length} issue(s) — see the list.`);
    } finally {
      setReading(false);
    }
  };

  return (
    <ForgeBox
      id="forge-files"
      icon={FileSearch}
      title="File System & Context"
      light={{
        tone: issues.length ? "warn" : fileCount ? "good" : "muted",
        value: report ? (issues.length ? `${issues.length} ISSUES` : "CHECKED") : `${fileCount ?? 0} INDEXED`,
        note: report ?? "Re-index, rebuild knowledge.md, or validate integrity.",
      }}
      onRefresh={reindex}
      test={{ label: "Validate Integrity", onTest: integrity }}
      testing={reading}
      hint="knowledge.md is the document the File & Context agent reads before anything is written — it is regenerated from the project itself, never hand-edited."
    >
      <div className="flex flex-wrap items-center gap-2">
        <MiniButton onClick={reindex} disabled={reading}>
          <ListChecks className="size-3" />
          Re-index
        </MiniButton>
        <MiniButton onClick={knowledgeRebuild} disabled={reading}>
          <FileText className="size-3" />
          Rebuild knowledge.md
        </MiniButton>
        <MiniButton onClick={integrity} disabled={reading}>
          <FileSearch className="size-3" />
          Validate Integrity
        </MiniButton>
      </div>

      {report ? <p className="mt-2 text-[10px] text-foreground/90">{report}</p> : null}

      {issues.length ? (
        <ul className="mt-2 flex max-h-40 flex-col gap-1 overflow-y-auto rounded-xl border border-amber-400/30 bg-amber-400/5 p-2">
          {issues.map((issue, index) => (
            <li key={index} className="text-[10px] leading-4 text-amber-200/90">
              {issue}
            </li>
          ))}
        </ul>
      ) : null}
    </ForgeBox>
  );
}
