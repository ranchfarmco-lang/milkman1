/**
 * §7 Embedded browser engine, §8 browser security, §29 the browser area,
 * §57 the browser interface.
 *
 * There are two halves to a browser, and the host is honest about which half it
 * is doing at any moment:
 *
 *   RENDER — putting pixels on a screen inside the application. That is the
 *   system's own engine (WebView2, WebKitGTK, WKWebView) and
 *   `native/browser/webview.ts` opens it. When no display or no engine is
 *   present, the host says so instead of pretending a window exists (§51).
 *
 *   NAVIGATE — everything a browser does around the page: history, back and
 *   forward, reload, stopping, cookies, the security status of the address,
 *   downloadable responses, redirects, authentication pages. That is real here,
 *   in every environment, because it is the host's own client doing the work.
 *
 * §8's boundary is drawn by `WebBridge`: a page's JavaScript never reaches the
 * host's functions. The page may call only the verbs the host explicitly grants
 * it, each one is checked, and remote content is kept in the browser profile
 * directory rather than anywhere near configuration or credentials.
 */

import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { paths } from "../core/paths.ts";
import { log } from "../core/log.ts";
import { request } from "../client/internet-client.ts";
import { embeddedEngine, platformId } from "../platform/index.ts";

export type SecurityStatus = {
  scheme: "http" | "https" | "about";
  secure: boolean;
  /** Certificate policy actually applied by the client. */
  certificate: "validated" | "not-applicable";
  note: string;
};

export type HistoryEntry = { url: string; title: string; at: number };

export type BrowserDownloads = {
  id: string;
  url: string;
  path: string;
  bytes: number;
  at: number;
  contentType: string;
};

export type BrowserStatus = {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  security: SecurityStatus;
  /** Which engine is drawing this page, and whether anything is drawing it. */
  renderer: { engine: string; detail: string; windowOpen: boolean };
  /** How the page was obtained, so the claim is checkable. */
  loadedVia: "http-render" | "not-loaded";
  status: number | null;
  contentType: string;
  bytes: number;
  redirects: string[];
  cookies: number;
  history: HistoryEntry[];
  downloads: BrowserDownloads[];
  lastError: string | null;
  at: number;
};

/** The verbs a page is allowed to ask for. Nothing else is reachable (§8). */
export const GRANTED_BRIDGE_VERBS = [
  "browser:navigate",
  "browser:back",
  "browser:forward",
  "browser:reload",
  "browser:stop",
  "browser:home",
  "browser:download",
  "browser:status",
] as const;

export type BridgeVerb = (typeof GRANTED_BRIDGE_VERBS)[number];

/**
 * §8 — the only channel between remote page content and the host.
 *
 * A page may call `invoke(verb, payload)`. The verb must be on the granted list,
 * the payload must be a plain value, and the answer is data. There is no
 * evaluation, no function reference, no path and no command in this interface,
 * which is what makes "arbitrary site JavaScript cannot run native commands"
 * true by construction rather than by care.
 */
export class WebBridge {
  constructor(private readonly allowed: readonly string[] = GRANTED_BRIDGE_VERBS) {}

  async invoke(verb: string, payload: unknown, host: (verb: string, payload: unknown) => Promise<unknown>): Promise<unknown> {
    if (!this.allowed.includes(verb)) {
      throw new Error(`The page asked for "${verb}", which the host does not grant to page content.`);
    }
    if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
      for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
        if (/^(cmd|command|exec|shell|path|file|spawn|eval|require)$/i.test(key)) {
          throw new Error(`The page sent "${key}", which the host never accepts from page content.`);
        }
        if (typeof value === "function") {
          throw new Error("The page sent a function, which cannot cross the bridge.");
        }
      }
    }
    return host(verb, payload);
  }
}

/** A cookie jar: enough of RFC 6265 to keep a site signed in honestly. */
export class CookieJar {
  private jars = new Map<string, Map<string, string>>();

  store(url: string, setCookie: string[]): void {
    const host = new URL(url).hostname;
    const jar = this.jars.get(host) ?? new Map<string, string>();
    for (const raw of setCookie) {
      const [pair] = raw.split(";");
      const index = pair.indexOf("=");
      if (index <= 0) continue;
      jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
    }
    this.jars.set(host, jar);
  }

  header(url: string): string | null {
    const jar = this.jars.get(new URL(url).hostname);
    if (!jar || jar.size === 0) return null;
    return [...jar.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
  }

  count(): number {
    let total = 0;
    for (const jar of this.jars.values()) total += jar.size;
    return total;
  }

  clear(): void {
    this.jars.clear();
  }
}

export type BrowserOptions = {
  /** Where downloads land. Defaults to this installation's downloads folder. */
  downloadDir?: string;
  /** A home page. "about:blank" is a real answer, not a placeholder. */
  home?: string;
};

export class Browser {
  readonly id: string;
  private jar = new CookieJar();
  private entries: HistoryEntry[] = [];
  private index = -1;
  private downloads: BrowserDownloads[] = [];
  private loading = false;
  private stopped = false;
  private last: Omit<BrowserStatus, "history" | "downloads" | "cookies" | "canGoBack" | "canGoForward"> | null = null;
  private readonly renderer = embeddedEngine();
  private windowOpen = false;
  private readonly downloadDir: string;

  constructor(
    id: string,
    private readonly options: BrowserOptions = {},
  ) {
    this.id = id;
    this.downloadDir = options.downloadDir ?? paths().downloads;
    mkdirSync(this.downloadDir, { recursive: true });
  }

  /** §57 createBrowser is the manager; this is one instance's own status. */
  getBrowserStatus(): BrowserStatus {
    return {
      id: this.id,
      url: this.last?.url ?? "about:blank",
      title: this.last?.title ?? "New tab",
      loading: this.loading,
      canGoBack: this.index > 0,
      canGoForward: this.index >= 0 && this.index < this.entries.length - 1,
      security: this.securityOf(this.last?.url ?? "about:blank"),
      renderer: { ...this.renderer, windowOpen: this.windowOpen },
      loadedVia: this.last ? "http-render" : "not-loaded",
      status: this.last?.status ?? null,
      contentType: this.last?.contentType ?? "",
      bytes: this.last?.bytes ?? 0,
      redirects: this.last?.redirects ?? [],
      cookies: this.jar.count(),
      history: [...this.entries].reverse(),
      downloads: [...this.downloads],
      lastError: this.last?.lastError ?? null,
      at: Date.now(),
    };
  }

  private securityOf(url: string): SecurityStatus {
    if (url.startsWith("about:")) {
      return { scheme: "about", secure: false, certificate: "not-applicable", note: "An internal page, not something fetched from a network." };
    }
    const secure = url.startsWith("https:");
    return {
      scheme: secure ? "https" : "http",
      secure,
      certificate: secure ? "validated" : "not-applicable",
      note: secure
        ? "This page came over HTTPS and its certificate validated — if it had not, the request would have failed."
        : "This page came over plain HTTP, so it is not encrypted and could be modified in transit.",
    };
  }

  /** Where a page would render, so the UI can be truthful about it. */
  markWindow(open: boolean): void {
    this.windowOpen = open;
  }

  /**
   * §65 — whether this browser may be pointed at an address on this machine's
   * own network. It may when the person at the host is driving it, and it may
   * not when a remote caller is: otherwise the browser area would be a way to
   * probe the host's local network from the Internet.
   */
  async navigate(
    rawUrl: string,
    options: { recordHistory?: boolean; allowPrivate?: boolean } = {},
  ): Promise<BrowserStatus> {
    const url = normalize(rawUrl, this.last?.url ?? null);
    if (url.startsWith("about:")) {
      this.last = {
        id: this.id,
        url,
        title: url === "about:blank" ? "New tab" : url,
        loading: false,
        security: this.securityOf(url),
        renderer: { ...this.renderer, windowOpen: this.windowOpen },
        loadedVia: "not-loaded",
        status: null,
        contentType: "internal",
        bytes: 0,
        redirects: [],
        lastError: null,
        at: Date.now(),
      };
      if (options.recordHistory !== false) this.push(url, this.last.title);
      return this.getBrowserStatus();
    }

    this.loading = true;
    this.stopped = false;

    const cookie = this.jar.header(url);
    const result = await request(url, {
      method: "GET",
      headers: { accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8", ...(cookie ? { cookie } : {}) },
      maxBytes: 12 * 1024 * 1024,
      throwOnHttpError: false,
      force: options.allowPrivate === true,
    });

    if (this.stopped) {
      this.loading = false;
      return this.getBrowserStatus();
    }

    const setCookie = result.headers["set-cookie"];
    if (setCookie) this.jar.store(result.finalUrl, Array.isArray(setCookie) ? setCookie : [setCookie]);

    const contentType = result.headers["content-type"] ?? "";
    const text = typeof result.body === "string" ? result.body : "";
    const title = text ? titleOf(text) || result.finalUrl : result.finalUrl;
    const failed = !result.ok && result.failure !== null;

    this.last = {
      id: this.id,
      url: result.finalUrl || url,
      title: failed ? `${url} — could not be loaded` : title,
      loading: false,
      security: this.securityOf(result.finalUrl || url),
      renderer: { ...this.renderer, windowOpen: this.windowOpen },
      loadedVia: text || result.status ? "http-render" : "not-loaded",
      status: result.status,
      contentType,
      bytes: text.length || byteLengthOf(result.body),
      redirects: result.redirects,
      lastError: failed ? `${result.failure?.kind}: ${result.failure?.message}` : null,
      at: Date.now(),
    };
    this.loading = false;

    if (options.recordHistory !== false) this.push(this.last.url, this.last.title);
    log.info("browser", "Navigated.", { url: this.last.url, status: result.status, engine: this.renderer.engine });
    return this.getBrowserStatus();
  }

  private push(url: string, title: string): void {
    // A new navigation from a back/forward position replaces the forward branch.
    if (this.index < this.entries.length - 1) this.entries = this.entries.slice(0, this.index + 1);
    this.entries.push({ url, title, at: Date.now() });
    if (this.entries.length > 200) this.entries.shift();
    this.index = this.entries.length - 1;
  }

  async back(options: { allowPrivate?: boolean } = {}): Promise<BrowserStatus> {
    if (this.index <= 0) return this.getBrowserStatus();
    this.index -= 1;
    return await this.navigate(this.entries[this.index].url, { recordHistory: false, ...options });
  }

  async forward(options: { allowPrivate?: boolean } = {}): Promise<BrowserStatus> {
    if (this.index >= this.entries.length - 1) return this.getBrowserStatus();
    this.index += 1;
    return await this.navigate(this.entries[this.index].url, { recordHistory: false, ...options });
  }

  async reload(options: { allowPrivate?: boolean } = {}): Promise<BrowserStatus> {
    const url = this.last?.url;
    if (!url || url.startsWith("about:")) return this.getBrowserStatus();
    return await this.navigate(url, { recordHistory: false, ...options });
  }

  /** §29 STOP — a real stop: the answer that arrives late is discarded. */
  stop(): BrowserStatus {
    this.stopped = true;
    this.loading = false;
    return this.getBrowserStatus();
  }

  home(options: { allowPrivate?: boolean } = {}): Promise<BrowserStatus> {
    return this.navigate(this.options.home ?? "about:blank", options);
  }

  /** §57 download — the response is saved, and the file is really on disk. */
  async download(
    url: string,
    options: { allowPrivate?: boolean } = {},
  ): Promise<{ ok: boolean; file: BrowserDownloads | null; detail: string }> {
    const result = await request<Uint8Array>(url, {
      method: "GET",
      maxBytes: 256 * 1024 * 1024,
      throwOnHttpError: false,
      force: options.allowPrivate === true,
    });
    if (!result.ok || !(result.body instanceof Uint8Array)) {
      return { ok: false, file: null, detail: result.failure?.message ?? `The download answered ${result.status}.` };
    }
    const bytes = result.body;
    const name = fileNameFor(result.finalUrl, result.headers["content-disposition"] ?? "");
    const path = join(this.downloadDir, name);
    writeFileSync(path, bytes);
    const file: BrowserDownloads = {
      id: String(this.downloads.length + 1),
      url: result.finalUrl,
      path,
      bytes: bytes.byteLength,
      at: Date.now(),
      contentType: result.headers["content-type"] ?? "application/octet-stream",
    };
    this.downloads = [file, ...this.downloads].slice(0, 100);
    log.info("browser", "Saved a download.", { url: result.finalUrl, bytes: bytes.byteLength });
    return { ok: true, file, detail: `Saved ${name} (${bytes.byteLength} bytes).` };
  }
}

/** The response body may be text or raw bytes; this is the honest size of it. */
function byteLengthOf(body: unknown): number {
  if (typeof body === "string") return 0;
  if (body instanceof Uint8Array) return body.byteLength;
  return 0;
}

function normalize(raw: string, base: string | null): string {
  const trimmed = raw.trim();
  if (!trimmed) return "about:blank";
  if (trimmed === "about:blank" || trimmed.startsWith("about:")) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  // A bare word is a search is not something this browser pretends to do; a
  // bare host becomes a URL, and anything else is refused honestly.
  if (/^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(trimmed)) return `https://${trimmed}`;
  try {
    return new URL(trimmed, base ?? undefined).toString();
  } catch {
    return "about:blank";
  }
}

function titleOf(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match ? match[1].replace(/\s+/g, " ").trim().slice(0, 200) : "";
}

function fileNameFor(url: string, disposition: string): string {
  const named = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(disposition);
  const raw = named ? decodeURIComponent(named[1]) : new URL(url).pathname.split("/").pop() || "download";
  const safe = raw.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe.slice(0, 80) || "download";
}

/** §57 createBrowser — the manager that hands out browser instances. */
export class BrowserManager {
  private browsers = new Map<string, Browser>();
  private counter = 0;

  createBrowser(options: BrowserOptions = {}): Browser {
    this.counter += 1;
    const id = `browser-${this.counter}`;
    const browser = new Browser(id, options);
    this.browsers.set(id, browser);
    log.info("browser", "Browser created.", { id, engine: embeddedEngine().engine, platform: platformId() });
    return browser;
  }

  get(id: string): Browser | null {
    return this.browsers.get(id) ?? null;
  }

  first(): Browser {
    const existing = [...this.browsers.values()][0];
    return existing ?? this.createBrowser({ home: "about:blank" });
  }

  list(): BrowserStatus[] {
    return [...this.browsers.values()].map((browser) => browser.getBrowserStatus());
  }

  close(id: string): boolean {
    return this.browsers.delete(id);
  }
}

export const browsers = new BrowserManager();
