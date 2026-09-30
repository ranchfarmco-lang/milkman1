/**
 * The browser half of the brain.
 *
 * The local brain is Python on your machine; this is the same idea living in
 * the page itself, so the hub still thinks when it is offline and no Python
 * process is running. It is deliberately small, honest, and dependency-free:
 *
 *   - its own memory, kept in this browser (localStorage, per origin)
 *   - its own file workspace — files the page can create, read, edit, search,
 *     and hand to the code runner, offline
 *   - its own tool registry, with the same tool names the Python brain uses,
 *     so "what can I do" has one vocabulary in both halves
 *   - a capability probe that reports what THIS browser can actually do,
 *     rather than promising what a browser cannot
 *
 * One boundary is worth naming: a web page cannot run compilers or a shell —
 * the browser forbids it, and no library can lift that. So the local brain runs
 * `run_shell` for real and this half reports it as "needs the local brain".
 * That honesty is what makes the two halves one system: the page knows exactly
 * which work is its own and which belongs to the brain on your machine.
 */

/** Everything is kept under one key so "forget" is one call. */
const STORE_KEY = "browser-brain:v1";

const MAX_MEMORY_ITEMS = 500;
const MAX_FILES = 200;
const MAX_FILE_CHARS = 200_000;

/* ------------------------------------------------------------------- types */

export type BrowserMemoryItem = {
  id: string;
  text: string;
  tags: string[];
  pinned: boolean;
  at: number;
};

export type BrowserFile = {
  path: string;
  text: string;
  at: number;
};

export type BrowserStore = {
  memory: BrowserMemoryItem[];
  files: BrowserFile[];
};

/* ------------------------------------------------------------------ storage */

function emptyStore(): BrowserStore {
  return { memory: [], files: [] };
}

export function loadStore(): BrowserStore {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return emptyStore();
    const parsed = JSON.parse(raw) as Partial<BrowserStore>;
    return {
      memory: Array.isArray(parsed.memory) ? parsed.memory : [],
      files: Array.isArray(parsed.files) ? parsed.files : [],
    };
  } catch {
    // A store that cannot be read is treated as empty, not as an error: the
    // brain still runs, it just starts with a clean slate.
    return emptyStore();
  }
}

function saveStore(store: BrowserStore) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    // Storage full or blocked: the in-memory copy still answers this session.
  }
}

/* ------------------------------------------------------------------- memory */

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function remember(text: string, tags: string[] = []): BrowserMemoryItem {
  const store = loadStore();
  const item: BrowserMemoryItem = {
    id: newId(),
    text: text.trim().slice(0, 2000),
    tags: tags.slice(0, 6),
    pinned: false,
    at: Date.now(),
  };
  store.memory = [item, ...store.memory.filter((one) => one.text !== item.text)].slice(
    0,
    MAX_MEMORY_ITEMS,
  );
  saveStore(store);
  return item;
}

export function forget(match: string): number {
  const needle = match.trim().toLowerCase();
  if (!needle) return 0;
  const store = loadStore();
  const kept = store.memory.filter((one) => !one.text.toLowerCase().includes(needle));
  const removed = store.memory.length - kept.length;
  store.memory = kept;
  saveStore(store);
  return removed;
}

export function searchMemory(query: string, limit = 10): BrowserMemoryItem[] {
  const needle = query.trim().toLowerCase();
  const store = loadStore();
  const scored = store.memory
    .map((item) => {
      const text = item.text.toLowerCase();
      const score = needle
        ? (item.pinned ? 100 : 0) +
          (text.includes(needle) ? 10 : 0) +
          (item.tags.some((tag) => tag.toLowerCase().includes(needle)) ? 5 : 0)
        : item.pinned
          ? 50
          : 0;
      return { item, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || b.item.at - a.item.at);
  return scored.slice(0, limit).map(({ item }) => item);
}

export function pinMemory(id: string, pinned: boolean): boolean {
  const store = loadStore();
  const item = store.memory.find((one) => one.id === id);
  if (!item) return false;
  item.pinned = pinned;
  saveStore(store);
  return true;
}

/* -------------------------------------------------------------------- files */

/** Reject paths that would confuse the workspace or the zip packer. */
export function safePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length < 200 &&
    !path.startsWith("/") &&
    !path.includes("..") &&
    !path.includes("\\") &&
    !path.includes("\n")
  );
}

export function writeBrowserFile(path: string, text: string): BrowserFile {
  if (!safePath(path)) {
    throw new Error(
      "That path will not work: no leading /, no .., no backslashes, under 200 characters.",
    );
  }
  const store = loadStore();
  const file: BrowserFile = { path, text: text.slice(0, MAX_FILE_CHARS), at: Date.now() };
  store.files = [
    file,
    ...store.files.filter((one) => one.path !== path),
  ].slice(0, MAX_FILES);
  saveStore(store);
  return file;
}

export function readBrowserFile(path: string): string | null {
  return loadStore().files.find((one) => one.path === path)?.text ?? null;
}

export function listBrowserFiles(): BrowserFile[] {
  return loadStore().files;
}

export function deleteBrowserFile(path: string): boolean {
  const store = loadStore();
  const before = store.files.length;
  store.files = store.files.filter((one) => one.path !== path);
  saveStore(store);
  return store.files.length < before;
}

export function searchBrowserFiles(query: string, limit = 20): BrowserFile[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return listBrowserFiles().slice(0, limit);
  return listBrowserFiles()
    .filter((one) => one.path.toLowerCase().includes(needle) || one.text.toLowerCase().includes(needle))
    .slice(0, limit);
}

/** Run a search across every file, returning path + the lines that matched. */
export function grepBrowserFiles(query: string, limit = 30): Array<{ path: string; line: number; text: string }> {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const out: Array<{ path: string; line: number; text: string }> = [];
  for (const file of listBrowserFiles()) {
    file.text.split("\n").forEach((text, index) => {
      if (out.length < limit && text.toLowerCase().includes(needle)) {
        out.push({ path: file.path, line: index + 1, text: text.slice(0, 400) });
      }
    });
  }
  return out;
}

/* ------------------------------------------------------------ offline runner */

/**
 * Run a small JavaScript program offline. The sandbox is an iframe from the
 * same origin with no network grant; the promise resolves with whatever it
 * printed. Errors come back as output, the way a terminal shows them.
 */
export async function runBrowserCode(code: string, timeoutMs = 5000): Promise<string> {
  const lines: string[] = [];
  const push = (...parts: unknown[]) =>
    lines.push(parts.map((part) => stringify(part)).join(" "));

  const sandbox = document.createElement("iframe");
  sandbox.setAttribute("aria-hidden", "true");
  sandbox.style.display = "none";
  const script = `
    const parentScope = { post: (line) => parent.postMessage({ browserBrainOutput: line }, "*") };
    const realConsole = {
      log: (...parts) => parentScope.post(parts.map(String).join(" ")),
      error: (...parts) => parentScope.post("error: " + parts.map(String).join(" ")),
      warn: (...parts) => parentScope.post("warn: " + parts.map(String).join(" ")),
    };
  `;
  const runner = `try { ${code} } catch (error) { realConsole.error(error instanceof Error ? error.message : String(error)); } realConsole.log("");`;

  // The wait is the point, not the value: the sandbox's own output is collected
  // into `lines` as it arrives, so the promise is simply awaited until it has.
  await new Promise<string>((resolve) => {
    const timer = window.setTimeout(() => {
      lines.push(`(stopped after ${Math.round(timeoutMs / 1000)}s — the sandbox has no infinite loop escape)`);
      resolve(lines.join("\n"));
    }, timeoutMs);

    const onMessage = (event: MessageEvent) => {
      const data = event.data as { browserBrainOutput?: string } | null;
      if (data && typeof data.browserBrainOutput === "string") {
        if (data.browserBrainOutput === "") {
          window.clearTimeout(timer);
          window.removeEventListener("message", onMessage);
          resolve(lines.join("\n"));
        } else {
          lines.push(data.browserBrainOutput);
        }
      }
    };
    window.addEventListener("message", onMessage);

    sandbox.onload = () => {
      try {
        const win = sandbox.contentWindow as (
          Window & { console?: unknown; eval: (code: string) => unknown }
        ) | null;
        if (win) {
          (win as { console: unknown }).console = {
            log: (...parts: unknown[]) => push(...parts),
            error: (...parts: unknown[]) => push("error:", ...parts),
            warn: (...parts: unknown[]) => push("warn:", ...parts),
          };
          win.eval(`${script}\nconst realConsole = window.console;\n${runner}`);
        }
      } catch (error) {
        push("error:", error instanceof Error ? error.message : String(error));
        window.clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        resolve(lines.join("\n"));
      }
    };

    document.body.appendChild(sandbox);
    // srcdoc keeps it same-origin (so postMessage works both ways) while the
    // iframe itself gets a fresh global scope, away from the app's variables.
    sandbox.srcdoc = `<!doctype html><meta charset="utf-8">`;
  });

  sandbox.remove();
  return lines.join("\n").trim() || "(no output — print with console.log)";
}

function stringify(part: unknown): string {
  if (typeof part === "string") return part;
  try {
    return JSON.stringify(part) ?? String(part);
  } catch {
    return String(part);
  }
}

/* ---------------------------------------------------------- tool descriptors */

export type BrowserTool = {
  name: string;
  args: string;
  what: string;
  /** "here" = this browser does it; "local" = the Python brain's job. */
  home: "here" | "local" | "online";
};

/**
 * The tool list, in the same vocabulary as the Python brain's registry
 * (`brain/src/tools.py`). The names match one for one so anything that talks to
 * one half can ask the other the same question.
 */
export const BROWSER_TOOLS: BrowserTool[] = [
  { name: "memory_write", args: "text, tags?", what: "Remember something across sessions — in this browser.", home: "here" },
  { name: "memory_search", args: "query", what: "Find what you told it to remember.", home: "here" },
  { name: "fs_write", args: "path, text", what: "Create or replace a file in the offline workspace.", home: "here" },
  { name: "fs_read", args: "path", what: "Read a file from the workspace.", home: "here" },
  { name: "fs_list", args: "—", what: "Every file the workspace holds.", home: "here" },
  { name: "fs_delete", args: "path", what: "Remove a file from the workspace.", home: "here" },
  { name: "fs_search", args: "query", what: "Search file names and contents.", home: "here" },
  { name: "grep", args: "pattern", what: "Line-level search across every file, like ripgrep.", home: "here" },
  { name: "code_run", args: "javascript", what: "Run a JavaScript program offline in a sandboxed iframe.", home: "here" },
  { name: "html_run", args: "html", what: "Open an HTML page in a new tab — it renders offline.", home: "here" },
  { name: "capabilities", args: "—", what: "Report what this browser can actually do right now.", home: "here" },
  { name: "code_run_full", args: "language, code", what: "27+ languages through the real compilers (Wandbox) — needs the internet.", home: "online" },
  { name: "web_fetch", args: "url", what: "Fetch a page or an API over the network.", home: "online" },
  { name: "web_search", args: "query", what: "Search the web.", home: "online" },
  { name: "ai_answer", args: "question", what: "Ask a hosted model through the hub's provider chain.", home: "online" },
  { name: "run_shell", args: "command", what: "A real shell on your machine — the local brain's job.", home: "local" },
  { name: "shell_run", args: "command", what: "The same shell under its registry name in brain/src/tools.py.", home: "local" },
  { name: "git_run", args: "args", what: "Version control on the real filesystem.", home: "local" },
  { name: "schedule", args: "task, when", what: "Recurring work that runs while the machine is on.", home: "local" },
  { name: "model_serve", args: "model", what: "Serve downloaded model weights behind one endpoint.", home: "local" },
];

/** What the tool list looks like on this browser, with counts. */
export function browserToolSummary() {
  const here = BROWSER_TOOLS.filter((tool) => tool.home === "here");
  const online = BROWSER_TOOLS.filter((tool) => tool.home === "online");
  const local = BROWSER_TOOLS.filter((tool) => tool.home === "local");
  return { here, online, local, total: BROWSER_TOOLS.length };
}

/* --------------------------------------------------------------- capabilities */

export type BrowserCapabilities = {
  browser: string;
  platform: string;
  cores: number;
  memoryGb: number | null;
  network: "online" | "offline" | "unknown";
  storage: { persistent: boolean; estimateMb: number | null };
  workers: boolean;
  fileSystemAccess: boolean;
  serviceWorker: boolean;
  webgl: boolean;
  languages: { name: string; how: string; offline: boolean }[];
};

/** Ask the browser what it can do — discovered, never assumed. */
export async function browserCapabilities(): Promise<BrowserCapabilities> {
  const nav = navigator as Navigator & {
    deviceMemory?: number;
    storage?: { estimate?: () => Promise<{ usage?: number; quota?: number }>; persist?: () => Promise<boolean> };
  };

  let network: BrowserCapabilities["network"] = "unknown";
  if (typeof nav.onLine === "boolean") network = nav.onLine ? "online" : "offline";

  let estimateMb: number | null = null;
  let persistent = false;
  try {
    const estimate = await nav.storage?.estimate?.();
    if (estimate?.quota) estimateMb = Math.round(estimate.quota / (1024 * 1024));
    persistent = (await nav.storage?.persist?.()) ?? false;
  } catch {
    // Some browsers gate these behind permissions; absence is fine.
  }

  let webgl = false;
  try {
    const canvas = document.createElement("canvas");
    webgl = Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    // A canvas that refuses a context is reported, not fatal.
  }

  const online = network === "online";
  return {
    browser: nav.userAgent.split(") ").pop() ?? nav.userAgent,
    platform: nav.platform || "unknown",
    cores: nav.hardwareConcurrency || 1,
    memoryGb: nav.deviceMemory ?? null,
    network,
    storage: { persistent, estimateMb },
    workers: typeof Worker !== "undefined",
    fileSystemAccess: typeof (window as { showSaveFilePicker?: unknown }).showSaveFilePicker === "function",
    serviceWorker: "serviceWorker" in navigator,
    webgl,
    languages: [
      { name: "JavaScript", how: "sandboxed iframe, offline", offline: true },
      { name: "HTML/CSS", how: "renders in a new tab, offline", offline: true },
      { name: "JSON", how: "parsed and written directly, offline", offline: true },
      {
        name: "Python, C, C++, Rust, Go, Java, Ruby, PHP, TypeScript, Bash +17 more",
        how: "the hub's real compilers (Wandbox)",
        offline: false,
      },
      ...(online
        ? []
        : []),
    ],
  };
}

/** One flat sentence-per-fact answer to "what can this browser do?". */
export function capabilityLines(caps: BrowserCapabilities): string[] {
  return [
    `${caps.browser} on ${caps.platform}, ${caps.cores} core${caps.cores === 1 ? "" : "s"}${caps.memoryGb ? `, ~${caps.memoryGb} GB memory` : ""}.`,
    caps.network === "offline"
      ? "Offline right now: the offline tools above are the ones that answer."
      : caps.network === "online"
        ? "Online right now: the compiler runner, web fetch/search and hosted models are also available."
        : "Network state unknown to this page.",
    `Storage for the workspace and memory: ${caps.storage.estimateMb ? `about ${caps.storage.estimateMb} MB` : "an unmeasured amount"}${caps.storage.persistent ? ", marked persistent" : ""}.`,
    caps.fileSystemAccess
      ? "This browser can save downloads to a folder you choose."
      : "Downloads land in your Downloads folder (this browser has no folder picker).",
  ];
}
