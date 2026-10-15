/**
 * The Local Storage & Project Engine, and the File System & Context work:
 * live projects and their files, knowledge.md, indexing, integrity.
 *
 * The *live* project is what Apply writes into and Export takes away — it
 * lives only in IndexedDB. The sandbox has its own separate copy; nothing
 * here reaches into the sandbox, and nothing reaches into the running hub.
 */
import { forgeDb, forgeId, recordError, setLight, type ProjectRow } from "./db";
import { postForge } from "./events";

const rowId = (project: string, path: string) => `${project}::${path}`;

/** Every local project, newest first. */
export async function listProjects(): Promise<ProjectRow[]> {
  const rows = await forgeDb.projects.toArray();
  return rows.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Create an empty project. */
export async function createProject(name: string): Promise<ProjectRow> {
  const now = Date.now();
  const row: ProjectRow = {
    id: forgeId(),
    name: name.trim() || "Untitled project",
    note: "",
    createdAt: now,
    updatedAt: now,
  };
  await forgeDb.projects.put(row);
  postForge({ type: "projects", id: row.id });
  return row;
}

/**
 * The project everything acts on: the most recently touched one, or a fresh
 * one the first time the forge is opened. The engine always has somewhere to
 * put files, so no button starts by failing.
 */
export async function currentProject(): Promise<ProjectRow> {
  const rows = await listProjects();
  if (rows.length) return rows[0];
  return createProject("My first project");
}

/** The project's files as plain rows. */
export async function projectFiles(projectId: string): Promise<{ path: string; content: string }[]> {
  const rows = await forgeDb.files.where("project").equals(projectId).toArray();
  return rows
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((row) => ({ path: row.path, content: row.content }));
}

/** Write one file into the live project. */
export async function writeLiveFile(
  projectId: string,
  path: string,
  content: string,
): Promise<void> {
  await forgeDb.files.put({
    id: rowId(projectId, path),
    project: projectId,
    path,
    content,
    updatedAt: Date.now(),
  });
  await touchProject(projectId);
  postForge({ type: "files" });
}

/**
 * Apply to Live Project — the one deliberate path out of the sandbox. All the
 * sandbox's files land in the live project in a single transaction.
 */
export async function applyFiles(
  projectId: string,
  files: { path: string; content: string }[],
): Promise<number> {
  const now = Date.now();
  await forgeDb.files.bulkPut(
    files.map((file) => ({
      id: rowId(projectId, file.path),
      project: projectId,
      path: file.path,
      content: file.content,
      updatedAt: now,
    })),
  );
  await touchProject(projectId);
  await setLight(
    "applied",
    "good",
    `${files.length} file(s) applied to the live project.`,
  );
  postForge({ type: "files" });
  postForge({ type: "projects", id: projectId });
  return files.length;
}

async function touchProject(projectId: string): Promise<void> {
  const row = await forgeDb.projects.get(projectId);
  if (row) await forgeDb.projects.put({ ...row, updatedAt: Date.now() });
}

/** Empty a project without deleting it. */
export async function clearProjectFiles(projectId: string): Promise<number> {
  const rows = await forgeDb.files.where("project").equals(projectId).toArray();
  await forgeDb.files.bulkDelete(rows.map((row) => row.id));
  await touchProject(projectId);
  postForge({ type: "files" });
  return rows.length;
}

/** Remove a project and everything under it. */
export async function deleteProject(projectId: string): Promise<void> {
  await clearProjectFiles(projectId);
  await forgeDb.projects.delete(projectId);
  postForge({ type: "projects" });
  // Never leave the engine with zero projects — nothing would accept a file.
  if (!(await forgeDb.projects.count())) await currentProject();
}

/** Import zip rows as a new project; returns what was created. */
export async function importFilesAsProject(
  name: string,
  files: { path: string; content: string }[],
): Promise<ProjectRow> {
  const project = await createProject(name);
  await applyFiles(project.id, files);
  return project;
}

/* --------------------------------------------------------- file system box */

export type IndexResult = { files: number; bytes: number; detail: string };

/** Re-index: walk the project, count what is really there, publish a light. */
export async function reindexProject(projectId: string): Promise<IndexResult> {
  const files = await projectFiles(projectId);
  const bytes = files.reduce(
    (total, file) => total + new TextEncoder().encode(file.content).length,
    0,
  );
  const detail = `${files.length} file(s), ${formatBytes(bytes)} — indexed ${new Date().toLocaleTimeString()}.`;
  await setLight("files", files.length ? "good" : "warn", detail);
  postForge({ type: "files" });
  return { files: files.length, bytes, detail };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Rebuild knowledge.md: a real digest of the project — the tree with sizes,
 * the dependencies it declares, the titles its pages carry. This is the
 * document the File & Context agent reads, so it is regenerated from truth
 * rather than kept by hand.
 */
export async function rebuildKnowledge(projectId: string): Promise<{ bytes: number; preview: string }> {
  const project = await forgeDb.projects.get(projectId);
  const files = await projectFiles(projectId);

  const lines: string[] = [
    `# knowledge.md — ${project?.name ?? "project"}`,
    "",
    `Rebuilt ${new Date().toISOString()} · ${files.length} file(s).`,
    "",
    "## Tree",
  ];

  for (const file of files.filter((entry) => entry.path !== "knowledge.md")) {
    const bytes = new TextEncoder().encode(file.content).length;
    const linesInFile = file.content.split("\n").length;
    lines.push(`- ${file.path} — ${formatBytes(bytes)}, ${linesInFile} line(s)`);
  }

  const pkg = files.find((file) => file.path === "package.json");
  if (pkg) {
    try {
      const parsed = JSON.parse(pkg.content) as {
        name?: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const deps = Object.keys({ ...parsed.dependencies, ...parsed.devDependencies });
      lines.push("", "## Dependencies", ...(deps.length ? deps.map((dep) => `- ${dep}`) : ["- (none)"]));
    } catch {
      lines.push("", "## Dependencies", "- package.json could not be parsed.");
    }
  }

  const html = files.find((file) => file.path.endsWith("index.html") || file.path.endsWith(".html"));
  if (html) {
    const title = html.content.match(/<title>([^<]*)<\/title>/i)?.[1];
    lines.push("", "## Entry", `- ${html.path}${title ? ` — “${title}”` : ""}`);
  }

  const preview = lines.join("\n");
  await writeLiveFile(projectId, "knowledge.md", `${preview}\n`);
  await setLight("knowledge", "good", `knowledge.md rebuilt — ${files.length} file(s) described.`);
  return { bytes: preview.length, preview };
}

export type IntegrityResult = { ok: boolean; issues: string[] };

/** Validate integrity: parse what can be parsed, balance what can be counted. */
export async function validateIntegrity(projectId: string): Promise<IntegrityResult> {
  const files = await projectFiles(projectId);
  const issues: string[] = [];

  for (const file of files) {
    const { path, content } = file;

    if (!content.trim()) {
      issues.push(`${path} is empty.`);
      continue;
    }
    if (new TextEncoder().encode(content).length > 500 * 1024) {
      issues.push(`${path} is larger than 500 KB.`);
    }

    if (path.endsWith(".json")) {
      try {
        JSON.parse(content);
      } catch (error) {
        issues.push(`${path} is not valid JSON (${error instanceof Error ? error.message : String(error)}).`);
      }
    }

    if (/\.m?jsx?$/.test(path)) {
      const stripped = content
        .replace(/^\s*(?:import|export)\b[^;\n]*;?\s*$/gm, "")
        .replace(/^\s*import\s+[\s\S]*?from\s+["'][^"']+["'];?\s*$/gm, "");
      try {
        new Function(stripped);
      } catch (error) {
        if (!/^\s*(?:import|export)\b/m.test(content)) {
          issues.push(`${path} has a JavaScript syntax error (${error instanceof Error ? error.message : String(error)}).`);
        }
      }
    }

    if (path.endsWith(".css")) {
      const open = (content.match(/\{/g) ?? []).length;
      const close = (content.match(/\}/g) ?? []).length;
      if (open !== close) issues.push(`${path} has unbalanced braces (${open} open, ${close} close).`);
    }

    if (path.endsWith(".html") && !/<html[\s>]/i.test(content)) {
      issues.push(`${path} has no <html> element.`);
    }
  }

  if (!files.length) issues.push("The project has no files.");

  const ok = issues.length === 0;
  await setLight(
    "integrity",
    ok ? "good" : "warn",
    ok ? `${files.length} file(s) checked — all clean.` : `${issues.length} issue(s) found.`,
  );
  postForge({ type: "files" });
  return { ok, issues };
}

/** Record a failure for the diagnostics box. Re-exported for page code. */
export { recordError };
