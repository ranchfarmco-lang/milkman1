import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { isUnlocked, requireUnlocked } from "./guard";
import {
  action,
  internalMutation,
  mutation,
  query,
} from "./_generated/server";
import type { Id } from "./_generated/dataModel";

/**
 * The hub's own browser (§ the app's front door).
 *
 * A page rendered inside a React app cannot be a real cross-origin browser: the
 * page would be whatever site's `X-Frame-Options` allows, which for most of the
 * web is nothing. So the browser is built here instead, the way a browser proxy
 * is built — the deployment fetches the page, parses it into a document, and
 * hands the app the title, the text and the links. The app renders that, and
 * every link the person taps comes back through here to be fetched.
 *
 * That is also what makes the browser part of the app rather than beside it:
 * the fetch runs with the family's own session and the hub's lock, so a page
 * opened here can be sent straight to the assistant, the messenger or the
 * calendar without leaving what it is reading behind.
 *
 * What it is not: a JavaScript engine. Page scripts are not run, which is both
 * why it is safe and why some pages read as their text rather than as their
 * design. The reader says so on the page instead of pretending otherwise.
 */

const USER_AGENT =
  "Mozilla/5.0 (compatible; FamilyHubBrowser/0.1; +https://localhost/)";
const FETCH_TIMEOUT_MS = 15_000;
const MAX_HTML_BYTES = 3 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
const MAX_TEXT = 200_000;
const MAX_LINKS = 300;

export type BrowserLink = { href: string; text: string };
export type MediaKind = "image" | "audio" | "video" | "pdf";
export type BrowserPage =
  | {
      ok: true;
      url: string;
      finalUrl: string;
      status: number;
      contentType: string;
      title: string;
      text: string;
      links: BrowserLink[];
      bytes: number;
      /**
       * A picture, a sound, a film or a document. It is not parsed — the app is
       * handed the address to play it from, and the bytes never cross the
       * isolate, which is both why it is cheap and why a film can be watched.
       */
      media?: { kind: MediaKind; url: string };
    }
  | { ok: false; error: string };

/** What kind of thing a content type is, if the browser can show it directly. */
function mediaKindOf(contentType: string): MediaKind | null {
  const type = contentType.toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("video/")) return "video";
  if (type.includes("application/pdf")) return "pdf";
  return null;
}

/** The last part of an address, for naming something that has no title. */
function fileNameOf(url: string): string {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
    return name || new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * Refuse anything that would make the deployment reach back into its own
 * network — the loopback, the private ranges, the link-local metadata address
 * and the container DNS names. A browser that can be pointed at 169.254.169.254
 * is an SSRF hole, and this is the only thing standing in it.
 */
/**
 * Exported for the crawler (`crawl.ts`), which fetches pages of its own and has
 * to be held to exactly the same rules: nothing inside this deployment's own
 * network can be reached through the hub, however it was asked for.
 */
export function assertPublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("That is not a web address.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https addresses can be opened.");
  }
  const host = url.hostname.toLowerCase();
  const blocked =
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(?:1[6-9]|2\d|3[01])\./.test(host) ||
    /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host);
  if (blocked) {
    throw new Error(
      "That address is on this machine's own network, so the browser will not fetch it.",
    );
  }
  return url;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_match, code: string) =>
      String.fromCodePoint(Number(code)),
    );
}

/**
 * Turn HTML into the document the app draws: title, text, and its links.
 * Exported as `parseHtml` for the crawler, which walks the same links.
 */
export function parseHtml(html: string, base: string): {
  title: string;
  text: string;
  links: BrowserLink[];
} {
  const withoutScripts = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");

  const rawTitle = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const title = rawTitle
    ? decodeEntities(rawTitle.replace(/\s+/g, " ").trim()).slice(0, 300)
    : "";

  const links: BrowserLink[] = [];
  const seen = new Set<string>();
  for (const match of withoutScripts.matchAll(
    /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
  )) {
    if (links.length >= MAX_LINKS) break;
    const label = decodeEntities(match[2].replace(/<[^>]+>/g, " "))
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160);
    let href = match[1].trim();
    if (!href || href.startsWith("#") || /^(javascript|mailto|tel):/i.test(href)) {
      continue;
    }
    try {
      href = new URL(href, base).href;
    } catch {
      continue;
    }
    if (!/^https?:/i.test(href)) continue;
    const key = `${href}|${label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ href, text: label || href });
  }

  const text = decodeEntities(
    withoutScripts
      .replace(/<\/(?:p|div|li|tr|h[1-6]|section|article|header|footer|blockquote)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim()
    .slice(0, MAX_TEXT);

  return { title, text, links };
}

/** A fetch with the browser's own headers, on a leash. Exported for the crawler. */
export async function fetchWithTimeout(
  url: URL,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
        "accept-language": "en-US,en;q=0.9",
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch a page and hand the app a document it can draw. */
export const fetchPage = action({
  args: { url: v.string() },
  handler: async (ctx, { url }): Promise<BrowserPage> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return { ok: false, error: "Sign in to browse." };
    if (!(await ctx.runQuery(internal.access.unlocked, {}))) {
      return {
        ok: false,
        error: "This hub is locked. Enter the family password to continue.",
      };
    }

    let target: URL;
    try {
      target = assertPublicUrl(url);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "That address cannot be opened.",
      };
    }

    try {
      const response = await fetchWithTimeout(target, FETCH_TIMEOUT_MS);
      const contentType = response.headers.get("content-type") ?? "";
      const finalUrl = response.url || target.href;
      const mediaKind = mediaKindOf(contentType);

      // A picture, a sound, a film or a PDF is handed to the app to play rather
      // than parsed. The bytes stay where they are, so a long film costs this
      // function nothing and the media element streams it directly.
      if (mediaKind) {
        return {
          ok: true,
          url: target.href,
          finalUrl,
          status: response.status,
          contentType,
          title: fileNameOf(finalUrl),
          text: "",
          links: [],
          bytes: Number(response.headers.get("content-length") ?? 0) || 0,
          media: { kind: mediaKind, url: finalUrl },
        };
      }

      const body = await response.text();
      if (body.length > MAX_HTML_BYTES) {
        return {
          ok: false,
          error: `That page is larger than ${Math.round(MAX_HTML_BYTES / 1024 / 1024)} MB, which the browser will not load.`,
        };
      }

      const looksHtml = /html|xml/i.test(contentType);
      const parsed = looksHtml
        ? parseHtml(body, finalUrl)
        : { title: target.hostname, text: body.slice(0, MAX_TEXT), links: [] };

      return {
        ok: true,
        url: target.href,
        finalUrl,
        status: response.status,
        contentType,
        title: parsed.title || target.hostname,
        text: parsed.text,
        links: parsed.links,
        bytes: body.length,
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

/** Fetch a file and keep it, so it is yours on every device. */
export const startDownload = action({
  args: { url: v.string(), name: v.optional(v.string()) },
  handler: async (
    ctx,
    { url, name },
  ): Promise<{ ok: true; name: string; bytes: number } | { ok: false; error: string }> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return { ok: false, error: "Sign in to download." };
    if (!(await ctx.runQuery(internal.access.unlocked, {}))) {
      return { ok: false, error: "This hub is locked. Enter the family password to continue." };
    }

    let target: URL;
    try {
      target = assertPublicUrl(url);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "That address cannot be opened.",
      };
    }

    try {
      const response = await fetchWithTimeout(target, FETCH_TIMEOUT_MS);
      if (!response.ok) {
        return { ok: false, error: `The server answered HTTP ${response.status}.` };
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > MAX_DOWNLOAD_BYTES) {
        return {
          ok: false,
          error: `That file is larger than ${Math.round(MAX_DOWNLOAD_BYTES / 1024 / 1024)} MB.`,
        };
      }
      const contentType =
        response.headers.get("content-type") ?? "application/octet-stream";
      const storageId = await ctx.storage.store(
        new Blob([bytes], { type: contentType }),
      );
      const fileName = (
        name?.trim() ||
        decodeURIComponent(target.pathname.split("/").pop() ?? "") ||
        "download"
      ).slice(0, 120);

      await ctx.runMutation(internal.browser.recordDownload, {
        userId,
        url: target.href,
        name: fileName,
        contentType,
        bytes: bytes.byteLength,
        storageId,
      });

      return { ok: true, name: fileName, bytes: bytes.byteLength };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "The file could not be fetched.";
      return { ok: false, error: `The download failed: ${message}` };
    }
  },
});

/** The row that indexes a stored download. Only this file's actions call it. */
export const recordDownload = internalMutation({
  args: {
    userId: v.id("users"),
    url: v.string(),
    name: v.string(),
    contentType: v.string(),
    bytes: v.number(),
    storageId: v.id("_storage"),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("browserDownloads", { ...args, at: Date.now() });
    return null;
  },
});

/** Everything this account has downloaded, newest first, each with its link. */
export const downloads = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null || !(await isUnlocked(ctx))) return [];
    const rows = await ctx.db
      .query("browserDownloads")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(100);
    return Promise.all(
      rows.map(async (row) => ({
        _id: row._id,
        pageUrl: row.url,
        name: row.name,
        contentType: row.contentType,
        bytes: row.bytes,
        at: row.at,
        href: await ctx.storage.getUrl(row.storageId),
      })),
    );
  },
});

/** Forget a download, and let go of the bytes behind it. */
export const removeDownload = mutation({
  args: { id: v.id("browserDownloads") },
  handler: async (ctx, { id }) => {
    await requireUnlocked(ctx);
    const userId = await getAuthUserId(ctx);
    const row = await ctx.db.get(id);
    if (!row || !userId || row.userId !== userId) return false;
    await ctx.storage.delete(row.storageId);
    await ctx.db.delete(id);
    return true;
  },
});

/** Saved pages, newest first. */
export const bookmarks = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null || !(await isUnlocked(ctx))) return [];
    return await ctx.db
      .query("browserBookmarks")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(200);
  },
});

/** Save the page that is open. Saving the same address twice changes nothing. */
export const addBookmark = mutation({
  args: { url: v.string(), title: v.string() },
  handler: async (ctx, { url, title }) => {
    await requireUnlocked(ctx);
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Sign in to save a page.");

    const existing = await ctx.db
      .query("browserBookmarks")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .filter((q) => q.eq(q.field("url"), url))
      .first();
    if (existing) {
      if (existing.title !== title) {
        await ctx.db.patch(existing._id, { title });
      }
      return existing._id as Id<"browserBookmarks">;
    }

    return (await ctx.db.insert("browserBookmarks", {
      userId,
      url,
      title: title.slice(0, 300) || url,
      at: Date.now(),
    })) as Id<"browserBookmarks">;
  },
});

export const removeBookmark = mutation({
  args: { id: v.id("browserBookmarks") },
  handler: async (ctx, { id }) => {
    await requireUnlocked(ctx);
    const userId = await getAuthUserId(ctx);
    const row = await ctx.db.get(id);
    if (!row || !userId || row.userId !== userId) return false;
    await ctx.db.delete(id);
    return true;
  },
});
