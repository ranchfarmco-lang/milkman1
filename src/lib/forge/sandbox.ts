/**
 * The sandbox: where all building happens, isolated from the live app.
 *
 * Two engines, chosen at boot and shown on a real light:
 *
 * - **WebContainer** — when the browser reports cross-origin isolation, the
 *   real `@webcontainer/api` boots, npm install and npm run build run for
 *   real, and the preview is the dev server's own URL. That isolation needs
 *   response headers (COOP/COEP) on the document, which are the host's to
 *   set, so this page simply asks for it and takes no for an answer.
 *
 * - **LocalBox** — otherwise: this browser's own isolated virtual file system,
 *   kept in IndexedDB, with a genuine static build (entry parsing, reference
 *   checks, syntax checks) and a real preview assembled from the files. It
 *   cannot run `npm`, and says so in the terminal rather than pretending.
 *
 * Either way: files in here are never read or written by the hub itself, and
 * "Apply to Live Project" is the only path out — deliberate, reviewed, and
 * pressed by a person.
 */
import { readConfig, writeConfig } from "./config";
import { forgeDb, recordError, setLight, type BuildStepRow } from "./db";
import { postForge } from "./events";

export type SandboxMode = "webcontainer" | "local";

export type BuildResult = {
  ok: boolean;
  steps: BuildStepRow[];
  errors: string[];
  preview: "doc" | "server" | "none";
};

export type SandboxState = {
  booted: boolean;
  mode: SandboxMode;
  detail: string;
  mounted: string | null;
  files: number;
  building: boolean;
  lastBootAt: number | null;
  /** The WebContainer dev-server URL, when that engine is the one running. */
  serverUrl: string | null;
};

type Container = {
  mount: (tree: Record<string, unknown>) => Promise<void>;
  spawn: (
    command: string,
    args?: string[],
    options?: { output?: boolean | ((line: string) => void) },
  ) => Promise<{ exit: Promise<number> }>;
  on: (event: string, callback: (...args: unknown[]) => void) => void;
  teardown: () => void;
};

const MAX_TERMINAL = 400;

/**
 * The engine itself — one instance per tab, holding the in-memory file system
 * that mirrors into IndexedDB. Pages subscribe for status and terminal lines;
 * the Control Room reads the persisted light instead, so it can be honest even
 * in a second tab where no engine has booted.
 */
class SandboxEngine {
  private vfs = new Map<string, string>();
  private terminal: string[] = [];
  private listeners = new Set<() => void>();
  private container: Container | null = null;
  private hydrated = false;
  private saveTimer: number | null = null;

  private state: SandboxState = {
    booted: false,
    mode: "local",
    detail: "Not booted yet.",
    mounted: null,
    files: 0,
    building: false,
    lastBootAt: null,
    serverUrl: null,
  };

  /* ---------------------------------------------------------------- state */

  status(): SandboxState {
    return { ...this.state, files: this.vfs.size };
  }

  terminalLines(): string[] {
    return [...this.terminal];
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (err) {
        console.error("[sandbox] listener failed", err);
      }
    }
    postForge({ type: "sandbox" });
  }

  log(line: string) {
    const stamp = new Date().toLocaleTimeString([], { hour12: false });
    this.terminal.push(`${stamp}  ${line}`);
    if (this.terminal.length > MAX_TERMINAL) {
      this.terminal.splice(0, this.terminal.length - MAX_TERMINAL);
    }
    this.notify();
  }

  private async publishLight() {
    if (this.state.booted) {
      await setLight(
        "sandbox",
        "good",
        `${this.state.mode === "webcontainer" ? "WebContainer" : "LocalBox"} running${
          this.state.mounted ? ` — ${this.state.mounted}` : ""
        }.`,
      );
    } else if (this.state.detail) {
      await setLight("sandbox", this.state.mode === "webcontainer" ? "warn" : "muted", this.state.detail);
    }
  }

  private patch(part: Partial<SandboxState>) {
    this.state = { ...this.state, ...part };
    void this.publishLight();
    this.notify();
  }

  /* ------------------------------------------------------------- file system */

  /** Load the persisted sandbox files once, before anything reads them. */
  async hydrate(): Promise<void> {
    if (this.hydrated) return;
    this.hydrated = true;
    try {
      const rows = await forgeDb.sandboxFiles.toArray();
      this.vfs = new Map(rows.map((row) => [row.path, row.content]));
      // The files came back; so does which app they are. Without this a reload
      // turned somebody's project into anonymous files, and the next request
      // had no app to be a change to.
      const config = await readConfig();
      if (config.benchAppId && this.vfs.size) this.state.mounted = config.benchAppId;
      this.patch({});
    } catch (error) {
      await recordError("sandbox hydrate", error);
      this.log("Could not read the stored sandbox files.");
    }
  }

  /** Every path in the sandbox, sorted the way a tree expects. */
  paths(): string[] {
    return [...this.vfs.keys()].sort((a, b) => a.localeCompare(b));
  }

  /** The sandbox as plain rows, for mounts and checks. */
  fileList(): { path: string; content: string }[] {
    return this.paths().map((path) => ({ path, content: this.vfs.get(path) ?? "" }));
  }

  read(path: string): string | null {
    return this.vfs.get(path) ?? null;
  }

  async write(path: string, content: string): Promise<void> {
    await this.hydrate();
    this.vfs.set(path, content);
    const { autoSave } = await readConfig();
    if (autoSave) this.queuePersist(path, content);
    this.notify();
  }

  async remove(path: string): Promise<void> {
    await this.hydrate();
    this.vfs.delete(path);
    void forgeDb.sandboxFiles.delete(path);
    this.notify();
  }

  async clear(): Promise<void> {
    await this.hydrate();
    this.vfs.clear();
    await forgeDb.sandboxFiles.clear();
    // An empty bench holds no app, and saying so is what lets the next build
    // be a new app rather than a change to the one that used to be here.
    await writeConfig({ benchAppId: null });
    this.patch({ mounted: null });
  }

  /** Batch the IndexedDB writes so a burst of edits costs one transaction. */
  private queuePersist(path: string, content: string) {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void forgeDb.sandboxFiles
        .put({ path, content, updatedAt: Date.now() })
        .catch((error) => recordError("sandbox save", error));
    }, 250);
  }

  /* ------------------------------------------------------------------ boot */

  /** Boot the right engine, or say plainly why the sandbox is not up. */
  async boot(): Promise<void> {
    await this.hydrate();
    if (this.state.booted) {
      this.log("Already booted.");
      return;
    }

    const config = await readConfig();
    if (config.emergencyStopped) {
      this.patch({
        detail: "Emergency stop is on — release it in the Control Room before booting.",
      });
      this.log("Refused: emergency stop is engaged.");
      return;
    }

    const isolated =
      typeof crossOriginIsolated !== "undefined" ? crossOriginIsolated : false;

    if (isolated) {
      try {
        await this.bootWebContainer();
        return;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.log(`WebContainer refused to boot: ${reason}`);
        this.log("Falling back to the LocalBox engine.");
      }
    } else {
      this.log(
        "This document is not cross-origin isolated, so WebContainer cannot boot here (the host must serve COOP/COEP headers).",
      );
      this.log("Booting the LocalBox engine instead.");
    }

    this.patch({
      booted: true,
      mode: "local",
      detail: `LocalBox booted — isolated in-browser sandbox, ${this.vfs.size} file${this.vfs.size === 1 ? "" : "s"}.`,
      lastBootAt: Date.now(),
      serverUrl: null,
    });
    this.log("LocalBox ready. Static builds and previews run here; npm needs WebContainer.");
  }

  private async bootWebContainer(): Promise<void> {
    const module = await import("@webcontainer/api");
    const container = (await module.WebContainer.boot()) as unknown as Container;
    this.container = container;

    container.on("server-ready", (...args: unknown[]) => {
      const url = typeof args[1] === "string" ? args[1] : "";
      this.log(`Dev server listening at ${url}`);
      this.patch({ serverUrl: url });
    });

    if (this.vfs.size) {
      await container.mount(toFsTree(this.fileList()));
      this.log(`Mounted ${this.vfs.size} files into WebContainer.`);
    }

    this.patch({
      booted: true,
      mode: "webcontainer",
      detail: "WebContainer booted — real npm, real builds, real dev server.",
      lastBootAt: Date.now(),
    });
    this.log("WebContainer ready.");
  }

  /** Mount a live project's files into the sandbox (Mount Project). */
  async mount(projectId: string, files: { path: string; content: string }[]): Promise<void> {
    await this.hydrate();
    this.vfs.clear();
    await forgeDb.sandboxFiles.clear();
    for (const file of files) {
      this.vfs.set(file.path, file.content);
      await forgeDb.sandboxFiles.put({ path: file.path, content: file.content, updatedAt: Date.now() });
    }
    this.patch({ mounted: projectId });
    await writeConfig({ benchAppId: projectId });
    this.log(`Mounted ${files.length} file${files.length === 1 ? "" : "s"} from “${projectId}”.`);
    if (this.container && this.state.mode === "webcontainer") {
      await this.container.mount(toFsTree(files));
    }
  }

  async teardown(): Promise<void> {
    try {
      this.container?.teardown();
    } catch (error) {
      await recordError("sandbox teardown", error);
    }
    this.container = null;
    this.patch({
      booted: false,
      detail: "Torn down — the sandbox is closed and no build is running.",
      serverUrl: null,
      building: false,
    });
    this.log("Sandbox torn down.");
  }

  async restart(): Promise<void> {
    if (this.state.booted) await this.teardown();
    await this.boot();
  }

  /* ----------------------------------------------------------------- build */

  /**
   * Run the build for whichever engine is up. The result's steps are shown
   * in the terminal and the Control Room; `errors` holds only the blocking
   * ones (a step can fail without blocking — that is a warning, and its
   * `detail` says so).
   */
  async build(): Promise<BuildResult> {
    await this.hydrate();
    if (this.state.building) throw new Error("A build is already running.");

    const config = await readConfig();
    if (config.emergencyStopped) {
      const message = "Emergency stop is on — release it in the Control Room first.";
      this.log(message);
      return { ok: false, steps: [{ label: "Build", ok: false, detail: message }], errors: [message], preview: "none" };
    }

    this.patch({ building: true });
    this.log("Build started.");
    try {
      const result =
        this.state.mode === "webcontainer" && this.container
          ? await this.buildWithContainer()
          : buildLocal(this.vfs, (line) => this.log(line));
      this.patch({ building: false });
      this.log(result.ok ? "Build finished — OK." : `Build finished with ${result.errors.length} problem(s).`);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.patch({ building: false });
      this.log(`Build failed: ${message}`);
      await recordError("sandbox build", error);
      return {
        ok: false,
        steps: [{ label: "Build", ok: false, detail: message }],
        errors: [message],
        preview: "none",
      };
    }
  }

  private async buildWithContainer(): Promise<BuildResult> {
    const container = this.container!;
    const steps: BuildStepRow[] = [];
    const errors: string[] = [];
    const files = [...this.vfs].map(([path, content]) => ({ path, content }));

    await container.mount(toFsTree(files));
    steps.push({ label: "Mount", ok: true, detail: `${files.length} file(s) mounted.` });
    this.log(`Mounted ${files.length} files.`);

    const pkgText = this.vfs.get("package.json");
    if (pkgText) {
      let scripts: Record<string, string> = {};
      try {
        scripts = (JSON.parse(pkgText).scripts ?? {}) as Record<string, string>;
      } catch {
        steps.push({ label: "package.json", ok: false, detail: "Not valid JSON." });
        errors.push("package.json is not valid JSON.");
      }

      const install = await container.spawn("npm", ["install"], {
        output: (line) => this.log(line),
      });
      const installCode = await install.exit;
      steps.push({
        label: "npm install",
        ok: installCode === 0,
        detail: installCode === 0 ? "Dependencies installed." : `npm install exited ${installCode}.`,
      });
      if (installCode !== 0) errors.push("npm install failed — see the terminal.");

      if (scripts.build) {
        const run = await container.spawn("npm", ["run", "build"], {
          output: (line) => this.log(line),
        });
        const runCode = await run.exit;
        steps.push({
          label: "npm run build",
          ok: runCode === 0,
          detail: runCode === 0 ? "Built." : `npm run build exited ${runCode}.`,
        });
        if (runCode !== 0) errors.push("The build command failed — see the terminal.");
      } else {
        steps.push({ label: "Build script", ok: false, detail: "No \"build\" script in package.json (warning)." });
      }
    } else {
      steps.push({ label: "package.json", ok: false, detail: "None — no npm project here (warning)." });
    }

    const hasEntry = this.vfs.has("index.html") || [...this.vfs.keys()].some((path) => path.endsWith(".html"));
    return {
      ok: errors.length === 0,
      steps,
      errors,
      preview: this.state.serverUrl ? "server" : hasEntry ? "doc" : "none",
    };
  }

  /* --------------------------------------------------------------- preview */

  /**
   * The live preview document: the entry HTML with its local stylesheet and
   * script references folded in as real inline content, so the frame renders
   * the sandbox's actual files with no server involved. Null when there is
   * no HTML entry (or the WebContainer's own URL is the preview).
   */
  previewDoc(): string | null {
    const entry =
      (this.vfs.has("index.html") ? "index.html" : null) ??
      [...this.vfs.keys()].find((path) => path.endsWith(".html")) ??
      null;
    if (!entry) return null;
    return assemblePreview(this.vfs, entry);
  }
}

/** Normalise `./a/../b` against the directory of the file that referenced it. */
export function resolveLocalPath(ref: string, fromPath: string): string | null {
  const clean = ref.split(/[?#]/)[0];
  if (!clean || /^(https?:|data:|blob:|mailto:|javascript:|\/\/)/i.test(clean)) return null;
  const base = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")) : "";
  const parts = (clean.startsWith("/") ? clean.slice(1) : `${base}/${clean}`).split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

/** Local references an HTML file makes: script srcs and stylesheet hrefs. */
export function htmlReferences(html: string): string[] {
  const found: string[] = [];
  const patterns = [
    /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi,
    /<link\b[^>]*\bhref\s*=\s*["']([^"']+\.(?:css))["']/gi,
    /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi,
  ];
  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      if (match[1]) found.push(match[1]);
    }
  }
  return found;
}

/**
 * The LocalBox build: real checks over the real files — entry, references,
 * JSON validity, and a syntax pass over the JavaScript. Returns a result whose
 * steps the terminal prints as they happen.
 */
export function buildLocal(
  vfs: ReadonlyMap<string, string>,
  say: (line: string) => void,
): BuildResult {
  const steps: BuildStepRow[] = [];
  const errors: string[] = [];
  const paths = [...vfs.keys()];

  steps.push({
    label: "Read the sandbox",
    ok: paths.length > 0,
    detail: `${paths.length} file${paths.length === 1 ? "" : "s"} in the sandbox.`,
  });
  say(`read ${paths.length} file(s)`);
  if (!paths.length) {
    errors.push("The sandbox is empty — there is nothing to build.");
    return { ok: false, steps, errors, preview: "none" };
  }

  const entry =
    (vfs.has("index.html") ? "index.html" : null) ?? paths.find((path) => path.endsWith(".html")) ?? null;
  const pkgText = vfs.get("package.json") ?? null;

  steps.push({
    label: "Find the entry",
    ok: Boolean(entry),
    detail: entry
      ? `Entry: ${entry}`
      : pkgText
        ? "No HTML entry — this is a framework project."
        : "No index.html found.",
  });
  say(entry ? `entry ${entry}` : "no HTML entry");
  if (!entry && !pkgText) errors.push("No index.html and no package.json — the build has no entry point.");

  if (pkgText) {
    try {
      const pkg = JSON.parse(pkgText) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        scripts?: Record<string, string>;
      };
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      const frameworks = ["react", "vite", "next", "svelte", "@angular/core", "vue"].filter(
        (name) => name in deps,
      );
      if (frameworks.length) {
        steps.push({
          label: "Framework build",
          ok: false,
          detail: `${frameworks.join(", ")} — running npm needs WebContainer. The LocalBox checks and previews the static files it can (warning).`,
        });
        say(`framework detected: ${frameworks.join(", ")} — npm unavailable in LocalBox`);
      } else if (pkg.scripts?.build) {
        steps.push({
          label: "Build script",
          ok: false,
          detail: `package.json has a "build" script but npm is only available in WebContainer (warning).`,
        });
      } else {
        steps.push({ label: "package.json", ok: true, detail: "Parsed; no npm build needed." });
      }
    } catch (error) {
      const message = `package.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`;
      steps.push({ label: "package.json", ok: false, detail: message });
      errors.push(message);
    }
  }

  if (entry) {
    const html = vfs.get(entry) ?? "";
    const refs = htmlReferences(html);
    const missing: string[] = [];
    const external: string[] = [];
    for (const ref of refs) {
      const resolved = resolveLocalPath(ref, entry);
      if (resolved === null) {
        external.push(ref);
        continue;
      }
      if (!vfs.has(resolved)) missing.push(`${ref} → ${resolved}`);
    }
    steps.push({
      label: "Check references",
      ok: missing.length === 0,
      detail: missing.length
        ? `Missing: ${missing.join(", ")}`
        : `${refs.length} reference(s), ${external.length} left to the network.`,
    });
    say(`references: ${refs.length} (${missing.length} missing)`);
    if (missing.length) errors.push(`${missing.length} referenced file(s) missing from the sandbox.`);

    // Syntax pass over every JavaScript file. Import/export lines are lifted
    // out first (a bare `new Function` cannot parse module syntax), so a
    // module that is otherwise fine is checked rather than rejected.
    let syntaxProblems = 0;
    for (const path of paths.filter((candidate) => /\.m?jsx?$/.test(candidate))) {
      const code = vfs.get(path) ?? "";
      const stripped = code
        .replace(/^\s*(?:import|export)\b[^;\n]*;?\s*$/gm, "")
        .replace(/^\s*import\s+[\s\S]*?from\s+["'][^"']+["'];?\s*$/gm, "");
      const moduleSyntax = /^\s*(?:import|export)\b/m.test(code);
      try {
        new Function(stripped);
      } catch (error) {
        if (moduleSyntax) {
          say(`${path}: module syntax — strict check skipped`);
        } else {
          syntaxProblems += 1;
          const message = `${path}: ${error instanceof Error ? error.message : String(error)}`;
          steps.push({ label: "Syntax", ok: false, detail: message });
          say(`syntax problem in ${path}`);
        }
      }
    }
    if (syntaxProblems) errors.push(`${syntaxProblems} file(s) with a JavaScript syntax error.`);
    if (!syntaxProblems) steps.push({ label: "Syntax", ok: true, detail: "JavaScript parses." });
  }

  const doc = entry ? assemblePreview(vfs, entry) : null;
  steps.push({
    label: "Assemble the preview",
    ok: Boolean(doc),
    detail: doc ? `${doc.length} bytes of preview.` : "No HTML entry to preview.",
  });

  return { ok: errors.length === 0, steps, errors, preview: doc ? "doc" : "none" };
}

/**
 * Fold an HTML file's local stylesheet and script references into itself, so
 * the result renders on its own inside an iframe. Module imports of other
 * local files are rewritten to data URLs — depth one, which is what a static
 * preview needs; anything deeper belongs in WebContainer.
 */
export function assemblePreview(vfs: ReadonlyMap<string, string>, entry: string): string {
  const original = vfs.get(entry) ?? "";

  const withScripts = original.replace(
    /(<script\b[^>]*?)\bsrc\s*=\s*["']([^"']+)["']([^>]*>)(<\/script>)/gi,
    (whole, head: string, src: string, tail: string, close: string) => {
      const resolved = resolveLocalPath(src, entry);
      if (!resolved || !vfs.has(resolved)) return whole;
      const code = inlineModuleImports(vfs, vfs.get(resolved) ?? "", resolved);
      const typeMatch = head.match(/type\s*=\s*["']([^"']+)["']/i);
      const type = typeMatch ? typeMatch[1] : "";
      const attrs = `${head.replace(/\btype\s*=\s*["'][^"']+["']/i, "")}${tail}`;
      const stamped = `${attrs.replace(/\s+/, " ")} type="${type || "text/javascript"}"`.replace(
        /\s+type=""/,
        "",
      );
      return `<script${stamped}>\n${code}\n${close}`;
    },
  );

  const withStyles = withScripts.replace(
    /<link\b[^>]*\bhref\s*=\s*["']([^"']+\.css)["'][^>]*>/gi,
    (whole, href: string) => {
      const resolved = resolveLocalPath(href, entry);
      if (!resolved || !vfs.has(resolved)) return whole;
      return `<style>\n${vfs.get(resolved) ?? ""}\n</style>`;
    },
  );

  return `<!DOCTYPE html>\n${withStyles}`;
}

/**
 * Rewrite relative `./sibling.js` imports inside a module to data URLs built
 * from the sandbox's own copy of that file.
 */
function inlineModuleImports(
  vfs: ReadonlyMap<string, string>,
  code: string,
  fromPath: string,
): string {
  return code.replace(
    /(from\s*|import\s*\(\s*)(["'])(\.\.?\/[^"']+|[\w./-]+\.js)\2/g,
    (whole, prefix: string, quote: string, spec: string) => {
      const resolved = resolveLocalPath(spec, fromPath);
      if (!resolved || !vfs.has(resolved)) return whole;
      const source = vfs.get(resolved) ?? "";
      const bytes = new TextEncoder().encode(source);
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      }
      const encoded = btoa(binary);
      return `${prefix}${quote}data:text/javascript;base64,${encoded}${quote}`;
    },
  );
}

/** Nested tree the WebContainer mount call wants. */
function toFsTree(files: { path: string; content: string }[]): Record<string, unknown> {
  const tree: Record<string, unknown> = {};
  for (const file of files) {
    const parts = file.path.split("/").filter(Boolean);
    let node = tree;
    for (const part of parts.slice(0, -1)) {
      const next = (node[part] ??= {}) as Record<string, unknown>;
      node = next;
    }
    node[parts[parts.length - 1]] = { file: { contents: file.content } };
  }
  return tree;
}

export const sandbox = new SandboxEngine();

// __SANDBOX_BUILD__
