/**
 * NOVA OS browser (§13).
 *
 * The OS browses the web with its own user agent. What is implemented here is
 * the part a browser is built on and that can genuinely be written from scratch:
 *
 *   · the transport — fetching a URL over HTTP or HTTPS with the OS's own
 *     user-agent string, following redirects, and enforcing a timeout;
 *   · the parser — turning the returned HTML into a document: title, headings,
 *     links, forms and readable text;
 *   · navigation — history with back, forward and reload, and a current page;
 *   · downloads — writing a fetched body to the OS's download directory;
 *   · a safety rule — a page that is not itself local may not make the browser
 *     fetch a private or loopback address.
 *
 * What is not implemented, and is not faked (§3.D): a visual rendering engine.
 * Laying out HTML and CSS into pixels is a multi-million-line component (WebKit,
 * Gecko, Blink) and cannot be built or booted in this environment. The browser
 * therefore renders the parsed document — its text, structure and links — which
 * is a real, usable reader, and it names the rendering engine as the package
 * that upgrades it (os/build/packages/webengine.json is the integration point).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bus, ensureOsPaths, log, type ComponentStatus, type OsComponent } from "../core/runtime.ts";

export type ParsedDocument = {
  title: string | null;
  text: string;
  headings: { level: number; text: string }[];
  links: { href: string; text: string }[];
  forms: number;
  bytes: number;
};

export type BrowserPage = {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string | null;
  bytes: number;
  fetchedAt: number;
  document: ParsedDocument | null;
  error: string | null;
};

export type BrowserDownload = {
  url: string;
  path: string;
  bytes: number;
  at: number;
};

/** User agent the OS presents. No earlier application's name appears here. */
export const NOVA_USER_AGENT = "NOVA-OS/0.1 (browser; +https://localhost/)";

const PRIVATE_HOST = /^(?:localhost|127\.|10\.|192\.168\.|169\.254\.|::1$|\[::1\]|0\.0\.0\.0)/i;
const PRIVATE_172 = /^172\.(?:1[6-9]|2\d|3[01])\./;
const PRIVATE_10064 = /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;

/** Whether a host is one the public Internet should not be able to reach. */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return PRIVATE_HOST.test(host) || PRIVATE_172.test(host) || PRIVATE_10064.test(host) || host.endsWith(".local") || host.endsWith(".internal");
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)));
}

/**
 * Parse HTML into a document. This is a real parser for the parts a browser
 * needs before rendering: it reads the title, the heading structure, every link
 * with its text, the number of forms, and the readable text with the script and
 * style contents removed.
 */
export function parseHtml(html: string): ParsedDocument {
  const withoutScripts = html.replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ");

  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const headings: { level: number; text: string }[] = [];
  for (const match of withoutScripts.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    const text = decodeEntities(match[2].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    if (text) headings.push({ level: Number(match[1]), text });
  }

  const links: { href: string; text: string }[] = [];
  for (const match of withoutScripts.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const text = decodeEntities(match[2].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    links.push({ href: match[1], text });
  }

  const forms = (withoutScripts.match(/<form\b/gi) ?? []).length;

  const text = decodeEntities(
    withoutScripts
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<\/(?:p|div|li|tr|h[1-6]|section|article|header|footer|br)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();

  return {
    title: title ? decodeEntities(title.replace(/\s+/g, " ").trim()) : null,
    text,
    headings,
    links,
    forms,
    bytes: Buffer.byteLength(html),
  };
}

export class NovaBrowser implements OsComponent {
  readonly name = "browser";
  readonly about = "The OS browser: real document transport and HTML parsing, navigation history, downloads and a private-address guard.";
  readonly requires: string[] = ["net"];

  private current: ComponentStatus = "stopped";
  private entries: BrowserPage[] = [];
  private index = -1;
  private downloads: BrowserDownload[] = [];

  status(): ComponentStatus {
    return this.current;
  }

  async start(): Promise<void> {
    this.current = "running";
    log.info("browser", "Browser ready.");
  }

  async stop(): Promise<void> {
    this.current = "stopped";
  }

  currentPage(): BrowserPage | null {
    return this.entries[this.index] ?? null;
  }

  history(): BrowserPage[] {
    return [...this.entries];
  }

  downloadHistory(): BrowserDownload[] {
    return [...this.downloads];
  }

  /**
   * Fetch and parse a URL. A failure is returned as a page with an error rather
   * than thrown, because a browser shows the failure to the user.
   */
  async navigate(rawUrl: string, options: { allowPrivate?: boolean; timeoutMs?: number } = {}): Promise<BrowserPage> {
    const url = normaliseUrl(rawUrl);
    const failed = (error: string): BrowserPage => ({
      url: rawUrl,
      finalUrl: rawUrl,
      status: 0,
      contentType: null,
      bytes: 0,
      fetchedAt: Date.now(),
      document: null,
      error,
    });

    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return failed(`"${rawUrl}" is not a URL this browser can open.`);
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      return failed(`The browser fetches http and https; "${target.protocol}" is not supported.`);
    }
    // §13 safety: a public page must not be able to make the browser reach into
    // the machine's own network. Loopback navigation is allowed only when the
    // caller explicitly asks for it (the OS's own pages do).
    if (!options.allowPrivate && isPrivateHost(target.hostname)) {
      return failed(`${target.hostname} is a private address, and this navigation did not ask for private addresses. The browser refuses to fetch the machine's own network on a public page's behalf.`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
    const started = Date.now();
    try {
      const response = await fetch(target, {
        redirect: "follow",
        signal: controller.signal,
        headers: { "user-agent": NOVA_USER_AGENT, accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5" },
      });
      const body = await response.text();
      const document = /html|xml/i.test(response.headers.get("content-type") ?? "") ? parseHtml(body) : null;
      const page: BrowserPage = {
        url: rawUrl,
        finalUrl: response.url || url,
        status: response.status,
        contentType: response.headers.get("content-type"),
        bytes: Buffer.byteLength(body),
        fetchedAt: Date.now(),
        document,
        error: response.ok ? null : `The server answered HTTP ${response.status} in ${Date.now() - started} ms.`,
      };
      this.record(page);
      bus.publish("browser.navigated", "browser", { url: page.finalUrl, status: page.status, bytes: page.bytes });
      return page;
    } catch (error) {
      const page = failed(`The fetch failed: ${error instanceof Error ? error.message : String(error)}`);
      this.record(page);
      return page;
    } finally {
      clearTimeout(timer);
    }
  }

  private record(page: BrowserPage): void {
    this.entries = this.entries.slice(0, this.index + 1);
    this.entries.push(page);
    if (this.entries.length > 200) this.entries.shift();
    this.index = this.entries.length - 1;
  }

  back(): BrowserPage | null {
    if (this.index <= 0) return this.currentPage();
    this.index -= 1;
    return this.currentPage();
  }

  forward(): BrowserPage | null {
    if (this.index >= this.entries.length - 1) return this.currentPage();
    this.index += 1;
    return this.currentPage();
  }

  async reload(options: { allowPrivate?: boolean } = {}): Promise<BrowserPage | null> {
    const page = this.currentPage();
    if (!page) return null;
    return this.navigate(page.finalUrl || page.url, options);
  }

  /** Save a fetched body to the OS download directory. */
  async download(url: string, options: { allowPrivate?: boolean; name?: string } = {}): Promise<BrowserDownload> {
    const page = await this.navigate(url, { ...options });
    if (page.error) throw new Error(page.error);
    const dir = join(ensureOsPaths().data, "downloads");
    mkdirSync(dir, { recursive: true });
    const fallbackName = url.split("/").filter(Boolean).pop()?.split("?")[0] || "download.bin";
    const path = join(dir, (options.name ?? fallbackName).replace(/[^\w.-]/g, "_"));
    const response = await fetch(url, { headers: { "user-agent": NOVA_USER_AGENT } });
    const bytes = Buffer.from(await response.arrayBuffer());
    writeFileSync(path, bytes);
    const record: BrowserDownload = { url, path, bytes: bytes.byteLength, at: Date.now() };
    this.downloads.push(record);
    log.info("browser", `Downloaded ${bytes.byteLength} bytes from ${url}.`);
    return record;
  }

  capability() {
    return {
      available: [
        "Real HTTP and HTTPS fetching with the OS's own user-agent string.",
        "A real HTML parser: title, headings, links, forms and readable text.",
        "Navigation history with back, forward and reload.",
        "Downloads written to the OS download directory.",
        "A guard that a public page cannot make the browser fetch a private address.",
      ],
      blocked: [
        {
          what: "Rendering a page's pixels (layout and painting)",
          why: "A visual rendering engine is a multi-million-line component (WebKit, Gecko, Blink); it cannot be written from scratch here, and none can be built or booted in this environment.",
          fallback: "Letters and documents are parsed and shown as a structured reader. os/build/packages/webengine.json records the integration point for adding a real engine as a package on the image.",
        },
        {
          what: "Executing page scripts and a JavaScript runtime",
          why: "That needs a full engine with a DOM and a sandbox; the parsed-document reader deliberately does not run page code, which also removes the largest class of browser attack from this component.",
          fallback: "The engine package would supply a script runtime with its own sandbox when it is installed.",
        },
      ],
    };
  }
}

function normaliseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}
