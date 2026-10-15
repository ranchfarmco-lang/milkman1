import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action, type ActionCtx } from "./_generated/server";
import { assertPublicUrl, fetchWithTimeout, parseHtml } from "./browser";

/**
 * The browser's bots — a crawler, a perch and a site probe.
 *
 * The reader (`browser.ts`) opens one page at a time, because that is what a
 * person does. These are the other half of browsing: the part that walks a
 * site, keeps an eye on a page, and looks at what a server actually answered.
 * All three fetch pages through the same door the reader uses — the same
 * `assertPublicUrl` refusal of anything on this deployment's own network, the
 * same user agent, the same parser — so a bot can never reach somewhere the
 * reader could not, and a page read by one reads exactly as the other.
 *
 * Nothing here runs on its own. A person asks for a crawl and gets it, asks to
 * watch a page and it is checked, asks what a server says and is told. There is
 * no background loop, no schedule and no queue: a browser that quietly fetched
 * things would be a different kind of program.
 *
 * The crawler is deliberately small and honest about itself. It follows one
 * host unless told otherwise, looks at pages only (not pictures or scripts),
 * stops at a page count and a depth, works in a narrow wave rather than
 * hundreds at once, and reports what it left behind rather than pretending it
 * saw everything.
 */

/* --------------------------------------------------------------- the limits */

/** Long enough for a real page, short enough that one slow host cannot stall. */
const CRAWL_TIMEOUT_MS = 9_000;
/** How many pages one crawl may fetch. Sixteen is a walk, not a harvest. */
const MAX_PAGES = 16;
const MAX_DEPTH = 3;
/** Pages fetched at once — a narrow wave, so a crawl stays a polite guest. */
const WAVE = 4;
/** The most bytes of one page the crawler will look at. */
const MAX_BODY = 400_000;
/** A whole crawl gives up here, however much is left in the queue. */
const CRAWL_BUDGET_MS = 45_000;

/** Things that are not pages: following them would fill the crawl with files. */
const NOT_A_PAGE =
  /\.(?:png|jpe?g|gif|webp|svg|ico|bmp|tiff?|css|js|mjs|cjs|json|xml|rss|atom|zip|gz|tgz|bz2|xz|tar|7z|rar|mp3|mp4|m4a|webm|ogg|opus|wav|flac|avi|mov|mkv|woff2?|ttf|otf|eot|pdf|epub|mobi|apk|dmg|exe|msi|iso|deb|rpm|torrent|map)$/i;

/* ----------------------------------------------------------------- helpers */

function countWords(text: string) {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/**
 * A page's address as the crawler holds it: no fragment (it is the same page),
 * no trailing slash (so `/a` and `/a/` are not crawled twice), nothing else
 * touched — a query string is part of what a page is.
 */
export function crawlUrl(href: string): string | null {
  try {
    const url = new URL(href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
      url.pathname = url.pathname.replace(/\/+$/, "");
    }
    return url.href;
  } catch {
    return null;
  }
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * A short, stable shape of a page: the title and its words, run through a
 * 32-bit hash. Two runs that read the same give the same value, so a perch can
 * tell "the page changed" from "the page answered again".
 *
 * Exported with `crawlUrl` for `scripts/browser-check.ts`, which checks both
 * promises: one page is one address, and the same page fingerprints the same.
 */
export function fingerprint(text: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${hash.toString(16).padStart(8, "0")}-${text.length}`;
}

/**
 * The two refusals every one of these actions makes, said once: the reader's
 * own — a session, and an unlocked hub. A bot is not a way around either.
 */
async function refusal(ctx: ActionCtx): Promise<string | null> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) return "Sign in to use the browser's bots.";
  if (!(await ctx.runQuery(internal.access.unlocked, {}))) {
    return "This hub is locked. Enter the family password to continue.";
  }
  return null;
}

/* -------------------------------------------------------------- the crawler */

export type CrawlPage = {
  url: string;
  title: string;
  status: number;
  bytes: number;
  words: number;
  links: number;
  depth: number;
  ms: number;
  /** The page this one was found on, null for the start. */
  from: string | null;
  error?: string;
};

export type CrawlReport =
  | { ok: false; error: string }
  | {
      ok: true;
      start: string;
      scope: "host" | "any";
      pages: CrawlPage[];
      edges: { from: string; to: string }[];
      stats: {
        crawled: number;
        failed: number;
        bytes: number;
        words: number;
        ms: number;
        depth: number;
        hosts: { host: string; pages: number }[];
        skipped: number;
        queued: number;
      };
      note: string;
    };

/** One page fetched, and the pages it points at that are worth following. */
async function walkOne(entry: {
  url: string;
  depth: number;
  from: string | null;
  scope: "host" | "any";
  allowedHost: string;
}): Promise<{ page: CrawlPage; next: string[] }> {
  const started = Date.now();
  try {
    const target = assertPublicUrl(entry.url);
    const response = await fetchWithTimeout(target, CRAWL_TIMEOUT_MS);
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    const readable = /html|xml|text/.test(contentType);
    const body = readable
      ? (await response.text()).slice(0, MAX_BODY)
      : "";
    const parsed = /html|xml/.test(contentType)
      ? parseHtml(body, response.url || target.href)
      : { title: target.hostname, text: body, links: [] as { href: string; text: string }[] };

    const next: string[] = [];
    for (const link of parsed.links) {
      if (next.length >= 60) break;
      const href = crawlUrl(link.href);
      if (!href || NOT_A_PAGE.test(new URL(href).pathname)) continue;
      if (entry.scope === "host" && hostOf(href) !== entry.allowedHost) continue;
      next.push(href);
    }

    return {
      page: {
        url: entry.url,
        title: parsed.title || target.hostname,
        status: response.status,
        bytes: body.length,
        words: countWords(parsed.text),
        links: parsed.links.length,
        depth: entry.depth,
        ms: Date.now() - started,
        from: entry.from,
      },
      next,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "The page could not be fetched.";
    return {
      page: {
        url: entry.url,
        title: entry.url,
        status: 0,
        bytes: 0,
        words: 0,
        links: 0,
        depth: entry.depth,
        ms: Date.now() - started,
        from: entry.from,
        error: /abort/i.test(message) ? "That page took too long to answer." : message,
      },
      next: [],
    };
  }
}

/**
 * Walk out from a page: the start, then what it links to, then what those link
 * to, as far as the depth and the page count allow. The whole walk is handed
 * back — every page's status, size, words and time, and the edge it was found
 * on — because a crawler that only returned the text would be a fetch with
 * extra steps.
 */
export const crawl = action({
  args: {
    start: v.string(),
    depth: v.optional(v.number()),
    max: v.optional(v.number()),
    scope: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<CrawlReport> => {
    const blocked = await refusal(ctx);
    if (blocked) return { ok: false, error: blocked };

    let start: URL;
    try {
      start = assertPublicUrl(args.start);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "That address cannot be crawled.",
      };
    }

    const depth = Math.min(
      Math.max(Math.round(args.depth ?? 1), 0),
      MAX_DEPTH,
    );
    const max = Math.min(Math.max(Math.round(args.max ?? 8), 1), MAX_PAGES);
    const scope: "host" | "any" = args.scope === "any" ? "any" : "host";
    const allowedHost = start.hostname.toLowerCase();
    const startedAt = Date.now();

    const pages: CrawlPage[] = [];
    const edges: { from: string; to: string }[] = [];
    const seen = new Set<string>([crawlUrl(start.href) ?? start.href]);
    const frontier: { url: string; depth: number; from: string | null }[] = [
      { url: start.href, depth: 0, from: null },
    ];
    let skipped = 0;

    while (
      frontier.length &&
      pages.length < max &&
      Date.now() - startedAt < CRAWL_BUDGET_MS
    ) {
      const wave = frontier.splice(0, Math.min(WAVE, max - pages.length));
      const walked = await Promise.all(
        wave.map((entry) =>
          walkOne({ ...entry, scope, allowedHost }),
        ),
      );

      for (let index = 0; index < walked.length; index += 1) {
        const { page, next } = walked[index];
        const parent = wave[index];
        pages.push(page);

        // Only pages one step further in may be followed, and only while there
        // is room for them — everything else is counted as left behind.
        const roomForMore = parent.depth < depth && pages.length < max;
        for (const href of next) {
          if (seen.has(href)) continue;
          if (!roomForMore) {
            skipped += 1;
            continue;
          }
          if (seen.size - 1 >= MAX_PAGES * 4) {
            skipped += 1;
            continue;
          }
          seen.add(href);
          edges.push({ from: page.url, to: href });
          frontier.push({ url: href, depth: parent.depth + 1, from: page.url });
        }
      }
    }

    if (!pages.length) {
      return {
        ok: false,
        error: "Nothing could be fetched from that address, so there is no crawl to show.",
      };
    }

    const hosts = new Map<string, number>();
    for (const page of pages) {
      const host = hostOf(page.url);
      hosts.set(host, (hosts.get(host) ?? 0) + 1);
    }

    const crawled = pages.filter((page) => !page.error).length;
    const failed = pages.length - crawled;
    const walked = pages.reduce((deepest, page) => Math.max(deepest, page.depth), 0);
    const note = [
      `Walked ${pages.length} page${pages.length === 1 ? "" : "s"} from ${hostOf(start.href)}`,
      scope === "host"
        ? "without leaving the host"
        : "following links anywhere they lead",
      walked === 0
        ? "and followed nothing from the start page"
        : `to ${walked} step${walked === 1 ? "" : "s"} deep`,
      skipped
        ? `leaving ${skipped} link${skipped === 1 ? "" : "s"} unfollowed`
        : "and followed every page link it found",
      max >= MAX_PAGES ? `(the crawler stops at ${MAX_PAGES} pages)` : "",
    ]
      .filter(Boolean)
      .join(", ");

    return {
      ok: true,
      start: start.href,
      scope,
      pages,
      edges,
      stats: {
        crawled,
        failed,
        bytes: pages.reduce((sum, page) => sum + page.bytes, 0),
        words: pages.reduce((sum, page) => sum + page.words, 0),
        ms: Date.now() - startedAt,
        depth: pages.reduce((deepest, page) => Math.max(deepest, page.depth), 0),
        hosts: [...hosts.entries()]
          .map(([host, count]) => ({ host, pages: count }))
          .sort((a, b) => b.pages - a.pages),
        skipped,
        queued: frontier.length,
      },
      note: `${note}.`,
    };
  },
});

/* -------------------------------------------------------------- the perches */

export type PerchReport =
  | { ok: false; error: string }
  | {
      ok: true;
      url: string;
      finalUrl: string;
      status: number;
      contentType: string;
      title: string;
      bytes: number;
      words: number;
      links: number;
      ms: number;
      /** The same value for the same page, so a change can be seen. */
      fingerprint: string;
      excerpt: string;
      at: number;
    };

/**
 * Look at one page and hand back its shape — title, words, size, and a
 * fingerprint of what it says. The perch itself lives in the browser (the list
 * of pages being watched is on the device); this is the look, and comparing the
 * fingerprint with the last one is what turns a look into "it changed".
 */
export const perch = action({
  args: { url: v.string() },
  handler: async (ctx, { url }): Promise<PerchReport> => {
    const blocked = await refusal(ctx);
    if (blocked) return { ok: false, error: blocked };

    let target: URL;
    try {
      target = assertPublicUrl(url);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "That address cannot be watched.",
      };
    }

    const started = Date.now();
    try {
      const response = await fetchWithTimeout(target, CRAWL_TIMEOUT_MS);
      const contentType = response.headers.get("content-type") ?? "";
      const body = (await response.text()).slice(0, MAX_BODY);
      const finalUrl = response.url || target.href;
      const parsed = /html|xml/i.test(contentType)
        ? parseHtml(body, finalUrl)
        : { title: target.hostname, text: body, links: [] };
      const text = parsed.text;

      return {
        ok: true,
        url: target.href,
        finalUrl,
        status: response.status,
        contentType,
        title: parsed.title || target.hostname,
        bytes: body.length,
        words: countWords(text),
        links: parsed.links.length,
        ms: Date.now() - started,
        fingerprint: fingerprint(`${parsed.title}\n${text}`),
        excerpt: text.slice(0, 500),
        at: Date.now(),
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "The page could not be fetched.";
      return {
        ok: false,
        error: /abort/i.test(message)
          ? "That page took too long to answer."
          : `The page could not be fetched: ${message}`,
      };
    }
  },
});

/* ---------------------------------------------------------------- the probe */

export type SiteReport =
  | { ok: false; error: string }
  | {
      ok: true;
      url: string;
      finalUrl: string;
      status: number;
      contentType: string;
      bytes: number;
      ms: number;
      redirected: boolean;
      headers: { name: string; value: string }[];
      document: {
        title: string;
        description: string;
        canonical: string;
        language: string;
        headings: number;
        images: number;
        links: number;
        forms: number;
        scripts: number;
        openGraph: string[];
      };
      robots: {
        ok: boolean;
        status: number;
        bytes: number;
        rules: string[];
      } | null;
      sitemap: {
        ok: boolean;
        status: number;
        urls: number;
        sample: string[];
      } | null;
      note: string;
    };

/** The headers a site tells you about itself, in the order they arrived. */
const WATCHED_HEADERS = [
  "content-type",
  "content-length",
  "server",
  "cache-control",
  "etag",
  "last-modified",
  "strict-transport-security",
  "content-security-policy",
  "x-frame-options",
  "x-content-type-options",
  "referrer-policy",
  "vary",
];

function pickHeaders(response: Response) {
  const seen: { name: string; value: string }[] = [];
  for (const name of WATCHED_HEADERS) {
    const value = response.headers.get(name);
    if (value) seen.push({ name, value: value.slice(0, 240) });
  }
  return seen;
}

/** One short fetch of a file the site keeps for bots, if the site keeps it. */
async function fetchSideFile(
  base: string,
  path: string,
): Promise<{ status: number; ok: boolean; body: string } | null> {
  try {
    const url = new URL(path, base);
    const response = await fetchWithTimeout(url, 6_000);
    const body = (await response.text()).slice(0, 60_000);
    return { status: response.status, ok: response.ok, body };
  } catch {
    return null;
  }
}

/**
 * What a server actually says about a page, before anybody reads it: the status,
 * the headers it sent, how long it took, what the document declares about
 * itself, and whether it keeps a `robots.txt` and a `sitemap.xml` for the bots
 * that come by. This is the one view of the web a reader never sees, and the
 * one that tells you whether a page is worth reading at all.
 */
export const probe = action({
  args: { url: v.string() },
  handler: async (ctx, { url }): Promise<SiteReport> => {
    const blocked = await refusal(ctx);
    if (blocked) return { ok: false, error: blocked };

    let target: URL;
    try {
      target = assertPublicUrl(url);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "That address cannot be probed.",
      };
    }

    const started = Date.now();
    try {
      const response = await fetchWithTimeout(target, CRAWL_TIMEOUT_MS);
      const finalUrl = response.url || target.href;
      const contentType = response.headers.get("content-type") ?? "";
      const body = (await response.text()).slice(0, MAX_BODY);
      const ms = Date.now() - started;

      const mark = (pattern: RegExp) => (body.match(pattern) ?? []).length;
      const meta = (name: string) => {
        const found = new RegExp(
          `<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([^"']*)["']`,
          "i",
        ).exec(body);
        return found ? found[1].slice(0, 240) : "";
      };
      const links = mark(/<a\b[^>]*href=/gi);
      const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1]?.trim() ?? "";

      const [robots, sitemap] = await Promise.all([
        fetchSideFile(finalUrl, "/robots.txt"),
        fetchSideFile(finalUrl, "/sitemap.xml"),
      ]);

      const robotsRules = (robots?.body ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
        .slice(0, 14);

      const sitemapUrls = [...(sitemap?.body ?? "").matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(
        (match) => match[1],
      );

      return {
        ok: true,
        url: target.href,
        finalUrl,
        status: response.status,
        contentType,
        bytes: body.length,
        ms,
        redirected: finalUrl !== target.href,
        headers: pickHeaders(response),
        document: {
          title: title.slice(0, 300),
          description: meta("description"),
          canonical: /<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i
            .exec(body)?.[1]
            ?.slice(0, 300) ?? "",
          language: /<html[^>]+lang=["']([^"']+)["']/i.exec(body)?.[1] ?? "",
          headings: mark(/<h[1-6]\b/gi),
          images: mark(/<img\b/gi),
          links,
          forms: mark(/<form\b/gi),
          scripts: mark(/<script\b/gi),
          openGraph: ["og:title", "og:description", "og:image", "og:type"]
            .map((name) => meta(name))
            .filter(Boolean),
        },
        robots: robots
          ? {
              ok: robots.ok,
              status: robots.status,
              bytes: robots.body.length,
              rules: robotsRules,
            }
          : null,
        sitemap: sitemap
          ? {
              ok: sitemap.ok,
              status: sitemap.status,
              urls: sitemapUrls.length,
              sample: sitemapUrls.slice(0, 8),
            }
          : null,
        note: [
          `The server answered HTTP ${response.status} in ${ms} ms`,
          `with ${Math.round(body.length / 1024)} KB of ${contentType.split(";")[0] || "unknown content"}`,
          robots ? (robots.ok ? "and it keeps a robots.txt for bots" : `and its robots.txt answered ${robots.status}`) : "and it keeps no robots.txt reachable here",
          sitemap?.ok && sitemapUrls.length
            ? `It lists ${sitemapUrls.length} address${sitemapUrls.length === 1 ? "" : "es"} in its sitemap.`
            : "",
        ]
          .filter(Boolean)
          .join(", ")
          .replace(", and", " and"),
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "The site could not be probed.";
      return {
        ok: false,
        error: /abort/i.test(message)
          ? "That server took too long to answer."
          : `The site could not be probed: ${message}`,
      };
    }
  },
});
