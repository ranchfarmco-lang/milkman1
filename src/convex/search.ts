import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action } from "./_generated/server";
import { BROWSER_UA, decodeEntities, fetchWithTimeout, stripHtml } from "./ai";

/**
 * The hub's own search — the one the browser uses.
 *
 * The browser opens a page by fetching it here (`browser.ts`), so a search that
 * merely handed the reader off to somebody else's search page would not be this
 * browser at all: it would be a redirect wearing the app's address bar. Instead
 * a query is answered here, by the hub, from the same sources the assistant
 * already trusts — a real web index when the family has a key for one, and
 * without a key the open ones: Wikipedia, Hacker News, Stack Overflow, a live
 * news feed, Wikimedia Commons, the Internet Archive, OpenStreetMap, Open
 * Library and the npm registry.
 *
 * A plain HTML search engine is deliberately not scraped. Every one of them
 * answers a server with a bot wall, and a browser that pretended otherwise
 * would be lying about what it just did (§51).
 *
 * A query can be narrowed the way a search page lets you narrow one: a category
 * (all, images, shopping, short videos, videos, news, maps, more, tools) and a
 * refinement — the order the rows come back in (relevance, newest, largest,
 * cheapest) and how far back a source is allowed to reach. Every vertical is
 * asked of a source that really holds that material, and where the hub holds
 * nothing (prices, without a key) it says so rather than inventing a number.
 *
 * It returns rows rather than prose, because these are drawn as links the person
 * can open in the browser itself.
 */

export type SearchRow = {
  title: string;
  url: string;
  snippet: string;
  source: string;
  /** When the source dated it, so the reader can be handed the newest first. */
  date?: string;
  /** Bytes, when the source says — images, films, archives. */
  size?: number;
  /** Seconds, for a film or a clip. */
  duration?: number;
  /** A price as the shop wrote it, when a shop answered. */
  price?: string;
};

export type SearchCategory =
  | "all"
  | "images"
  | "shopping"
  | "short-videos"
  | "videos"
  | "news"
  | "maps"
  | "more"
  | "tools";

export type SearchSort = "relevance" | "time" | "size" | "price";
export type SearchRange = "any" | "day" | "week" | "month" | "year";

/**
 * One shelf of the hub's open sources, when a query is pointed at just one of
 * them rather than at a whole category. This is the "narrow it down" the
 * browser's More and Tools boxes are made of: the same words, asked of the
 * books, or the archive's sound, or the package registry, and nothing else.
 */
export type SearchShelf =
  | "all"
  | "wiki"
  | "books"
  | "texts"
  | "audio"
  | "datasets"
  | "software"
  | "code"
  | "discuss"
  | "packages";

/**
 * The narrowing every search page has and this one now has too: a site, an
 * exact phrase, words to drop, and a file kind. Empty is not a filter.
 */
export type SearchFilters = {
  site?: string;
  exact?: string;
  exclude?: string;
  filetype?: string;
};

export type SearchAnswer =
  | { ok: false; error: string }
  | {
      ok: true;
      query: string;
      /** The category and refinements that were actually used, as coerced. */
      category: SearchCategory;
      sort: SearchSort;
      range: SearchRange;
      /** The shelf the query was pointed at, `all` when it was the whole category. */
      shelf: SearchShelf;
      /** The narrowing that was applied, as it was understood. */
      filters: SearchFilters;
      /** The keyed index that answered, or null when there is no key. */
      via: string | null;
      results: SearchRow[];
      note: string;
    };

const CATEGORIES: readonly SearchCategory[] = [
  "all",
  "images",
  "shopping",
  "short-videos",
  "videos",
  "news",
  "maps",
  "more",
  "tools",
];
const SORTS: readonly SearchSort[] = ["relevance", "time", "size", "price"];
const RANGES: readonly SearchRange[] = ["any", "day", "week", "month", "year"];
const SHELVES: readonly SearchShelf[] = [
  "all",
  "wiki",
  "books",
  "texts",
  "audio",
  "datasets",
  "software",
  "code",
  "discuss",
  "packages",
];

const RANGE_MS: Record<SearchRange, number> = {
  any: 0,
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
  year: 365 * 24 * 60 * 60 * 1000,
};

/** What a time window is called in a sentence, and in a news feed's own words. */
const RANGE_WORDS: Record<SearchRange, string> = {
  any: "any time",
  day: "24 hours",
  week: "week",
  month: "month",
  year: "year",
};
const RANGE_WHEN: Record<SearchRange, string> = {
  any: "",
  day: "when:1d",
  week: "when:7d",
  month: "when:30d",
  year: "when:1y",
};

/** How many rows the browser is handed, and how long one snippet may be. */
const MAX_ROWS = 24;
const MAX_SNIPPET = 240;

/* ---------------------------------------------------------------- helpers */

function pick<T extends string>(
  allowed: readonly T[],
  value: string | undefined,
  fallback: T,
): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function tidy(text: string, max = MAX_SNIPPET) {
  return stripHtml(text).replace(/\s+/g, " ").trim().slice(0, max);
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** A date, whichever of the three shapes a source uses. */
function isoDate(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  }
  if (typeof value !== "string" || !value.trim()) return undefined;
  const stamp = Date.parse(value.trim());
  return Number.isFinite(stamp) ? new Date(stamp).toISOString() : undefined;
}

/** A year on its own is still a date, just a coarse one. */
function yearDate(value: unknown): string | undefined {
  const year = asNumber(value) ?? Number.parseInt(asString(value), 10);
  if (!Number.isFinite(year) || year < 1000 || year > 3000) return undefined;
  return `${year}-01-01T00:00:00.000Z`;
}

/** One row per address, in the order the sources were asked. */
function dedupe(rows: SearchRow[]) {
  const seen = new Set<string>();
  const out: SearchRow[] = [];
  for (const row of rows) {
    const url = row.url.trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ ...row, url });
  }
  return out;
}

/** A price, however the shop wrote it. */
function priceOf(raw: unknown): string | undefined {
  if (typeof raw === "string") return raw.trim() || undefined;
  if (!raw || typeof raw !== "object") return undefined;
  const price = raw as { raw?: unknown; value?: unknown; currency?: unknown };
  const written = asString(price.raw);
  if (written) return written;
  const value = asNumber(price.value) ?? asString(price.value);
  if (value === undefined || value === "") return undefined;
  return `${asString(price.currency)}${value}`;
}

/** The number inside a price, so prices can be listed cheapest first. */
function priceNumber(row: SearchRow): number | undefined {
  if (!row.price) return undefined;
  const digits = row.price.replace(/[^\d.]/g, "").replace(/^\./, "");
  const value = Number.parseFloat(digits);
  return Number.isFinite(value) ? value : undefined;
}

/** Only the rows a source dated inside the window; undated rows are kept. */
function withinRange(rows: SearchRow[], range: SearchRange) {
  if (range === "any") return rows;
  const window = RANGE_MS[range];
  const now = Date.now();
  return rows.filter((row) => {
    if (!row.date) return true;
    const stamp = Date.parse(row.date);
    return !Number.isFinite(stamp) || now - stamp <= window;
  });
}

/** List the rows the way the reader asked, in a stable order. */
function order(rows: SearchRow[], sort: SearchSort): SearchRow[] {
  if (sort === "relevance") return rows;

  const key = (row: SearchRow): number => {
    if (sort === "time") {
      const stamp = row.date ? Date.parse(row.date) : Number.NaN;
      return Number.isFinite(stamp) ? -stamp : Number.POSITIVE_INFINITY;
    }
    if (sort === "size") {
      return row.size != null ? -row.size : Number.POSITIVE_INFINITY;
    }
    const price = priceNumber(row);
    return price ?? Number.POSITIVE_INFINITY;
  };

  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const left = key(a.row);
      const right = key(b.row);
      if (left !== right) return left < right ? -1 : 1;
      return a.index - b.index;
    })
    .map((entry) => entry.row);
}

/* ------------------------------------------------------------ narrowing */

/** A hostname, however the person wrote the site — with or without its scheme. */
function siteHost(raw: string | undefined): string {
  const text = asString(raw)
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/\/.*$/, "")
    .replace(/^www\./i, "")
    .toLowerCase();
  return /^[\w.-]+\.[a-z]{2,}$/i.test(text) ? text : "";
}

/** The words to leave out: commas, spaces or both may separate them. */
function excludedWords(raw: string | undefined): string[] {
  return asString(raw)
    .split(/[,\s]+/)
    .map((word) => word.trim().toLowerCase())
    .filter((word) => word.length > 1)
    .slice(0, 8);
}

function fileKind(raw: string | undefined): string {
  return asString(raw).replace(/^\./, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return "";
  }
}

function haystack(row: SearchRow): string {
  return `${row.title} ${row.snippet} ${row.url}`.toLowerCase();
}

/**
 * What the keyed index is handed: the words plus the operators a search index
 * understands. A keyless open source (Wikipedia, Hacker News) is asked the
 * plain words instead — it would take `site:` as a word to look for, which is
 * how a narrowing ends up finding nothing on a source that never had it.
 */
export function operatorQuery(query: string, filters: SearchFilters): string {
  const parts = [query];
  const site = siteHost(filters.site);
  if (site) parts.push(`site:${site}`);
  const exact = asString(filters.exact).replace(/"/g, "").slice(0, 80);
  if (exact) parts.push(`"${exact}"`);
  for (const word of excludedWords(filters.exclude)) parts.push(`-${word}`);
  const kind = fileKind(filters.filetype);
  if (kind) parts.push(`filetype:${kind}`);
  return parts.join(" ");
}

/**
 * Narrowing, applied to what came back rather than promised to the sources.
 * (Exported with `operatorQuery` for `scripts/browser-check.ts`, which walks
 * every filter and every refusal to empty the list.)
 *
 * Every filter here is a filter over rows the hub already holds, because the
 * open sources have no operator language: Wikipedia cannot be told "only this
 * host". What each does when it would empty the list is the honest part — a
 * filter that matches nothing is reported and dropped, never kept as a reason
 * to show a blank results page.
 */
export function narrowRows(
  rows: SearchRow[],
  filters: SearchFilters,
): { rows: SearchRow[]; notes: string[] } {
  const notes: string[] = [];
  let out = rows;

  const site = siteHost(filters.site);
  if (site) {
    const kept = out.filter((row) => {
      const host = hostOf(row.url);
      return host === site || host.endsWith(`.${site}`);
    });
    if (kept.length) {
      out = kept;
      notes.push(`restricted to ${site}`);
    } else {
      notes.push(`nothing from ${site} came back, so no row was dropped for it`);
    }
  }

  const excluded = excludedWords(filters.exclude);
  if (excluded.length) {
    const kept = out.filter(
      (row) => !excluded.some((word) => haystack(row).includes(word)),
    );
    if (kept.length) {
      out = kept;
      notes.push(`without ${excluded.join(", ")}`);
    } else {
      notes.push(`every row mentioned ${excluded.join(", ")}, so none were dropped`);
    }
  }

  const kind = fileKind(filters.filetype);
  if (kind) {
    const kept = out.filter((row) => pathOf(row.url).endsWith(`.${kind}`));
    if (kept.length) {
      out = kept;
      notes.push(`only .${kind} files`);
    } else {
      notes.push(`no .${kind} file came back, so the list was left whole`);
    }
  }

  const exact = asString(filters.exact).toLowerCase();
  if (exact) {
    const carrying = out.filter((row) => haystack(row).includes(exact));
    if (carrying.length && carrying.length < out.length) {
      out = [...carrying, ...out.filter((row) => !carrying.includes(row))];
      notes.push(`rows carrying “${asString(filters.exact)}” first`);
    } else if (!carrying.length) {
      notes.push(`no row carries “${asString(filters.exact)}” word for word`);
    }
  }

  return { rows: out, notes };
}

/** Shortest first — what somebody asking for a short video actually wants. */
function byDuration(rows: SearchRow[]): SearchRow[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const left = a.row.duration ?? Number.POSITIVE_INFINITY;
      const right = b.row.duration ?? Number.POSITIVE_INFINITY;
      if (left !== right) return left < right ? -1 : 1;
      return a.index - b.index;
    })
    .map((entry) => entry.row);
}

/* ------------------------------------------------------------ web indexes */

const braveKey = () => process.env.BRAVE_API_KEY?.trim() ?? "";
const tavilyKey = () => process.env.TAVILY_API_KEY?.trim() ?? "";

function braveRows(payload: unknown, label = "Brave"): SearchRow[] {
  const results = (payload as { web?: { results?: unknown[] } } | null)?.web?.results;
  if (!Array.isArray(results)) return [];
  return results
    .map((entry) => {
      const hit = entry as { title?: unknown; url?: unknown; description?: unknown };
      const url = asString(hit.url);
      return {
        title: tidy(asString(hit.title), 140) || url,
        url,
        snippet: tidy(asString(hit.description)),
        source: label,
      } satisfies SearchRow;
    })
    .filter((row) => Boolean(row.url));
}

/** Brave's web index, when the family has a key for one. */
async function brave(query: string): Promise<SearchRow[]> {
  const key = braveKey();
  if (!key) return [];

  try {
    const response = await fetchWithTimeout(
      `https://api.search.brave.com/res/v1/web/search?count=8&q=${encodeURIComponent(query)}`,
      {
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": key,
        },
      },
    );
    if (!response.ok) return [];
    return braveRows(await response.json());
  } catch {
    return [];
  }
}

/** Brave's image index — pictures, not pages about pictures. */
async function braveImages(query: string): Promise<SearchRow[]> {
  const key = braveKey();
  if (!key) return [];

  try {
    const response = await fetchWithTimeout(
      `https://api.search.brave.com/res/v1/images/search?count=12&q=${encodeURIComponent(query)}`,
      {
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": key,
        },
      },
    );
    if (!response.ok) return [];

    const payload = (await response.json()) as { results?: unknown[] };
    return (payload.results ?? [])
      .map((entry) => {
        const hit = entry as {
          title?: unknown;
          url?: unknown;
          thumbnail?: { src?: unknown };
          properties?: { url?: unknown; placeholder?: unknown };
        };
        const image =
          asString(hit.properties?.url) ||
          asString(hit.thumbnail?.src) ||
          asString(hit.url);
        return {
          title: tidy(asString(hit.title), 140) || asString(hit.url),
          url: image,
          snippet: tidy(asString(hit.url), 180),
          source: "Brave Images",
        } satisfies SearchRow;
      })
      .filter((row) => Boolean(row.url));
  } catch {
    return [];
  }
}

/** Brave's shopping index, when there is a key — the only real prices here. */
async function braveShopping(query: string): Promise<SearchRow[]> {
  const key = braveKey();
  if (!key) return [];

  try {
    const response = await fetchWithTimeout(
      `https://api.search.brave.com/res/v1/shopping/search?count=12&q=${encodeURIComponent(query)}`,
      {
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": key,
        },
      },
    );
    if (!response.ok) return [];

    const payload = (await response.json()) as { results?: unknown[] };
    return (payload.results ?? [])
      .map((entry) => {
        const hit = entry as {
          title?: unknown;
          url?: unknown;
          description?: unknown;
          price?: unknown;
        };
        const url = asString(hit.url);
        const price = priceOf(hit.price);
        return {
          title: tidy(asString(hit.title), 140) || url,
          url,
          snippet: [price, tidy(asString(hit.description), 180)]
            .filter(Boolean)
            .join(" · "),
          source: "Brave Shopping",
          price,
        } satisfies SearchRow;
      })
      .filter((row) => Boolean(row.url));
  } catch {
    return [];
  }
}

/** Tavily, if that is the key they gave instead. */
async function tavily(query: string): Promise<SearchRow[]> {
  const key = tavilyKey();
  if (!key) return [];

  try {
    const response = await fetchWithTimeout("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: key,
        query,
        search_depth: "basic",
        max_results: 8,
      }),
    });
    if (!response.ok) return [];

    const data = (await response.json()) as {
      results?: { title?: string; url?: string; content?: string }[];
    };

    return (data.results ?? [])
      .map((result) => ({
        title: tidy(result.title ?? "", 140) || (result.url ?? ""),
        url: result.url ?? "",
        snippet: tidy(result.content ?? ""),
        source: "Tavily",
      }))
      .filter((row) => Boolean(row.url));
  } catch {
    return [];
  }
}

const exaKey = () => process.env.EXA_API_KEY?.trim() ?? "";

/**
 * Exa's index, when that is the key the family gave instead of Brave or Tavily.
 * It is a semantic index — the words are matched by meaning rather than by
 * keyword — and it hands back the passages themselves, which is what makes it
 * worth asking for a reading list as well as a list of addresses.
 */
async function exa(query: string): Promise<SearchRow[]> {
  const key = exaKey();
  if (!key) return [];

  try {
    const response = await fetchWithTimeout("https://api.exa.ai/search", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "x-api-key": key,
      },
      body: JSON.stringify({
        query,
        numResults: 8,
        type: "auto",
        contents: { highlights: true },
      }),
    });
    if (!response.ok) return [];

    const data = (await response.json()) as {
      results?: {
        title?: unknown;
        url?: unknown;
        publishedDate?: unknown;
        highlights?: unknown;
      }[];
    };

    return (data.results ?? [])
      .map((hit): SearchRow | null => {
        const url = asString(hit.url);
        if (!url) return null;
        const highlights = Array.isArray(hit.highlights)
          ? hit.highlights.map((line) => asString(line)).filter(Boolean)
          : [];
        return {
          title: tidy(asString(hit.title), 140) || url,
          url,
          snippet: tidy(highlights.join(" … ")),
          source: "Exa",
          date: isoDate(hit.publishedDate),
        } satisfies SearchRow;
      })
      .filter((row): row is SearchRow => row !== null);
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------- open sources */

/** Wikipedia's public API. No key. */
async function wikipedia(query: string): Promise<SearchRow[]> {
  try {
    const response = await fetchWithTimeout(
      `https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=5&srsearch=${encodeURIComponent(query)}`,
      { headers: { "User-Agent": BROWSER_UA, Accept: "application/json" } },
    );
    if (!response.ok) return [];

    const data = (await response.json()) as {
      query?: { search?: { title?: string; snippet?: string }[] };
    };

    // No date on these rows on purpose: the only stamp the search API gives is
    // the last edit, which is not when the thing was written, and a time window
    // read that way would be a lie.
    return (data.query?.search ?? []).map((hit) => {
      const title = decodeEntities(hit.title ?? "");
      return {
        title,
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`,
        snippet: tidy(hit.snippet ?? ""),
        source: "Wikipedia",
      };
    });
  } catch {
    return [];
  }
}

/** What people are actually building, keyless. */
async function hackerNews(query: string): Promise<SearchRow[]> {
  try {
    const response = await fetchWithTimeout(
      `https://hn.algolia.com/api/v1/search?tags=story&hitsPerPage=6&query=${encodeURIComponent(query)}`,
      { headers: { "User-Agent": BROWSER_UA, Accept: "application/json" } },
    );
    if (!response.ok) return [];

    const data = (await response.json()) as {
      hits?: {
        title?: string;
        url?: string;
        objectID?: string;
        points?: number;
        num_comments?: number;
        created_at?: string;
      }[];
    };

    return (data.hits ?? [])
      .filter((hit) => hit.title)
      .map((hit) => ({
        title: decodeEntities(hit.title ?? ""),
        url:
          hit.url ??
          `https://news.ycombinator.com/item?id=${hit.objectID ?? ""}`,
        snippet: [
          hit.points != null ? `${hit.points} points` : "",
          hit.num_comments != null ? `${hit.num_comments} comments` : "",
        ]
          .filter(Boolean)
          .join(" · "),
        source: "Hacker News",
        date: isoDate(hit.created_at),
      }))
      .filter((row) => Boolean(row.url));
  } catch {
    return [];
  }
}

/** Code answers, keyless. */
async function stackOverflow(query: string): Promise<SearchRow[]> {
  try {
    const response = await fetchWithTimeout(
      `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&site=stackoverflow&pagesize=6&q=${encodeURIComponent(query)}`,
      { headers: { "User-Agent": BROWSER_UA, Accept: "application/json" } },
    );
    if (!response.ok) return [];

    const data = (await response.json()) as {
      items?: {
        title?: string;
        link?: string;
        tags?: string[];
        score?: number;
        is_answered?: boolean;
        creation_date?: number;
      }[];
    };

    return (data.items ?? [])
      .map((item) => ({
        title: decodeEntities(item.title ?? ""),
        url: item.link ?? "",
        snippet: [
          item.is_answered ? "answered" : "unanswered",
          item.score != null ? `score ${item.score}` : "",
          (item.tags ?? []).slice(0, 4).join(", "),
        ]
          .filter(Boolean)
          .join(" · "),
        source: "Stack Overflow",
        date: isoDate(item.creation_date),
      }))
      .filter((row) => Boolean(row.url));
  } catch {
    return [];
  }
}

/** One tag out of an RSS item, CDATA and entities and all. */
function rssTag(item: string, tag: string) {
  const match = item.match(
    new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"),
  );
  return decodeEntities(
    (match?.[1] ?? "")
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/<[^>]+>/g, " ")
      .trim(),
  );
}

/** Bing hands out redirect links wearing the real address as a parameter. */
function unwrapNewsLink(raw: string) {
  if (!raw) return "";
  try {
    const target = new URL(raw).searchParams.get("url");
    if (target) return target;
  } catch {
    // Not something we can take apart; hand it back as it came.
  }
  return raw;
}

/** Read one news feed, if it answers. */
async function newsFeed(url: string, label: string): Promise<SearchRow[]> {
  try {
    const response = await fetchWithTimeout(url, {
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "application/rss+xml,application/xml,text/xml,*/*",
      },
    });
    if (!response.ok) return [];

    const xml = await response.text();
    const items = xml.split(/<item[\s>]/i).slice(1, 9);

    return items
      .map((item): SearchRow | null => {
        const title = rssTag(item, "title");
        if (!title) return null;
        const link = unwrapNewsLink(rssTag(item, "link"));
        const date = isoDate(rssTag(item, "pubDate"));
        const summary = tidy(rssTag(item, "description"), 180);
        return {
          title,
          url: link,
          snippet: summary,
          source: label,
          date,
        } satisfies SearchRow;
      })
      .filter((row): row is SearchRow => row !== null && Boolean(row.url));
  } catch {
    return [];
  }
}

/** Anything current: a real news feed, no key and no bot wall. */
async function news(query: string, range: SearchRange): Promise<SearchRow[]> {
  const asked = [query, RANGE_WHEN[range]].filter(Boolean).join(" + ");

  const bing = await newsFeed(
    `https://www.bing.com/news/search?format=RSS&q=${encodeURIComponent(query)}`,
    "Bing News",
  );

  const google = await newsFeed(
    `https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=${encodeURIComponent(asked)}`,
    "Google News",
  );

  return [...bing, ...google];
}

/**
 * Wikimedia Commons — files the world already agreed may be shown, each with
 * its real byte size. This is what makes the images and video categories
 * something other than web pages about pictures.
 */
async function commons(query: string, want: "image" | "video"): Promise<SearchRow[]> {
  try {
    const response = await fetchWithTimeout(
      `https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6&gsrlimit=20&gsrsearch=${encodeURIComponent(query)}&prop=imageinfo&iiprop=url%7Csize%7Cmime%7Ctimestamp`,
      { headers: { "User-Agent": BROWSER_UA, Accept: "application/json" } },
    );
    if (!response.ok) return [];

    const data = (await response.json()) as {
      query?: {
        pages?: Record<
          string,
          {
            title?: string;
            index?: number;
            imageinfo?: {
              url?: string;
              size?: number;
              mime?: string;
              timestamp?: string;
              duration?: number;
              width?: number;
              height?: number;
            }[];
          }
        >;
      };
    };

    return Object.values(data.query?.pages ?? {})
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((page): SearchRow | null => {
        const info = page.imageinfo?.[0];
        const url = asString(info?.url);
        const mime = asString(info?.mime);
        if (!url || !mime.startsWith(want === "video" ? "video/" : "image/")) {
          return null;
        }
        const size = asNumber(info?.size);
        const duration = asNumber(info?.duration);
        const dimensions =
          info?.width && info?.height ? `${info.width}×${info.height}` : "";
        return {
          title: decodeEntities((page.title ?? "").replace(/^File:/, "")),
          url,
          snippet: [
            dimensions,
            size != null ? `${Math.max(1, Math.round(size / 1024))} KB` : "",
            mime,
          ]
            .filter(Boolean)
            .join(" · "),
          source: want === "video" ? "Wikimedia video" : "Wikimedia Commons",
          date: isoDate(info?.timestamp),
          size,
          duration,
        } satisfies SearchRow;
      })
      .filter((row): row is SearchRow => row !== null)
      .slice(0, 12);
  } catch {
    return [];
  }
}

/** The Internet Archive: films, sound and scanned books, all keyless. */
async function archive(
  query: string,
  mediatype: "movies" | "audio" | "texts" | "data" | "software",
  label: string,
): Promise<SearchRow[]> {
  const fields = ["identifier", "title", "description", "year", "publicdate", "item_size"]
    .map((field) => `fl%5B%5D=${field}`)
    .join("&");

  try {
    const response = await fetchWithTimeout(
      `https://archive.org/advancedsearch.php?q=${encodeURIComponent(
        `${query} AND mediatype:(${mediatype})`,
      )}&${fields}&rows=8&page=1&output=json&sort%5B%5D=downloads+desc`,
      { headers: { "User-Agent": BROWSER_UA, Accept: "application/json" } },
    );
    if (!response.ok) return [];

    const data = (await response.json()) as {
      response?: {
        docs?: {
          identifier?: unknown;
          title?: unknown;
          description?: unknown;
          year?: unknown;
          publicdate?: unknown;
          item_size?: unknown;
        }[];
      };
    };

    return (data.response?.docs ?? [])
      .map((doc): SearchRow | null => {
        const identifier = asString(doc.identifier);
        if (!identifier) return null;
        const size = asNumber(doc.item_size);
        return {
          title: tidy(asString(doc.title), 140) || identifier,
          url: `https://archive.org/details/${identifier}`,
          snippet: [
            asString(doc.year),
            size != null ? `${Math.round(size / 1024 / 1024)} MB` : "",
            tidy(asString(doc.description), 160),
          ]
            .filter(Boolean)
            .join(" · "),
          source: label,
          date: isoDate(doc.publicdate) ?? yearDate(doc.year),
          size,
        } satisfies SearchRow;
      })
      .filter((row): row is SearchRow => row !== null);
  } catch {
    return [];
  }
}

/**
 * OpenStreetMap's own geocoder — a place, found on a map the world maintains,
 * with the map's own address for it. No key, no bot wall.
 */
async function maps(query: string): Promise<SearchRow[]> {
  try {
    const response = await fetchWithTimeout(
      `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8&q=${encodeURIComponent(query)}`,
      { headers: { "User-Agent": BROWSER_UA, Accept: "application/json" } },
    );
    if (!response.ok) return [];

    const data = (await response.json()) as unknown;
    if (!Array.isArray(data)) return [];

    return data
      .map((entry): SearchRow | null => {
        const place = entry as {
          lat?: unknown;
          lon?: unknown;
          display_name?: unknown;
          name?: unknown;
          type?: unknown;
        };
        const lat = asString(place.lat);
        const lon = asString(place.lon);
        const display = asString(place.display_name);
        if (!lat || !lon) return null;
        return {
          title:
            asString(place.name) ||
            display.split(",").slice(0, 2).join(",").trim() ||
            display,
          url: `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=15/${lat}/${lon}`,
          snippet: [asString(place.type), display].filter(Boolean).join(" · "),
          source: "OpenStreetMap",
        } satisfies SearchRow;
      })
      .filter((row): row is SearchRow => row !== null);
  } catch {
    return [];
  }
}

/** Open Library — books, by title or author, with the year they appeared. */
async function openLibrary(query: string): Promise<SearchRow[]> {
  try {
    const response = await fetchWithTimeout(
      `https://openlibrary.org/search.json?limit=6&fields=key,title,author_name,first_publish_year&q=${encodeURIComponent(query)}`,
      { headers: { "User-Agent": BROWSER_UA, Accept: "application/json" } },
    );
    if (!response.ok) return [];

    const data = (await response.json()) as {
      docs?: {
        key?: unknown;
        title?: unknown;
        author_name?: unknown;
        first_publish_year?: unknown;
      }[];
    };

    return (data.docs ?? [])
      .map((doc): SearchRow | null => {
        const key = asString(doc.key);
        if (!key) return null;
        const authors = Array.isArray(doc.author_name)
          ? doc.author_name.filter((name) => typeof name === "string").slice(0, 3)
          : [];
        return {
          title: tidy(asString(doc.title), 140) || key,
          url: `https://openlibrary.org${key}`,
          snippet: [
            authors.join(", "),
            asString(doc.first_publish_year),
            "Open Library",
          ]
            .filter(Boolean)
            .join(" · "),
          source: "Open Library",
          date: yearDate(doc.first_publish_year),
        } satisfies SearchRow;
      })
      .filter((row): row is SearchRow => row !== null);
  } catch {
    return [];
  }
}

/** The npm registry — tools people can actually install, with their dates. */
async function npm(query: string): Promise<SearchRow[]> {
  try {
    const response = await fetchWithTimeout(
      `https://registry.npmjs.org/-/v1/search?size=8&text=${encodeURIComponent(query)}`,
      { headers: { "User-Agent": BROWSER_UA, Accept: "application/json" } },
    );
    if (!response.ok) return [];

    const data = (await response.json()) as {
      objects?: {
        package?: {
          name?: unknown;
          description?: unknown;
          version?: unknown;
          date?: unknown;
        };
      }[];
    };

    return (data.objects ?? [])
      .map((entry): SearchRow | null => {
        const name = asString(entry.package?.name);
        if (!name) return null;
        return {
          title: name,
          url: `https://www.npmjs.com/package/${name}`,
          snippet: [asString(entry.package?.version), tidy(asString(entry.package?.description), 180)]
            .filter(Boolean)
            .join(" · "),
          source: "npm",
          date: isoDate(entry.package?.date),
        } satisfies SearchRow;
      })
      .filter((row): row is SearchRow => row !== null);
  } catch {
    return [];
  }
}

/**
 * Shopping without a key. The hub holds no catalogue and no price list, so it
 * does the honest thing: it hands back the shops' own searches, plainly named,
 * and says where they came from. Nothing here was priced by the hub.
 */
function shops(query: string): SearchRow[] {
  const asked = encodeURIComponent(query);
  return [
    { label: "Amazon", url: `https://www.amazon.com/s?k=${asked}` },
    { label: "eBay", url: `https://www.ebay.com/sch/i.html?_nkw=${asked}` },
    { label: "Etsy", url: `https://www.etsy.com/search?q=${asked}` },
  ].map((shop) => ({
    title: `Search ${shop.label} for “${query}”`,
    url: shop.url,
    snippet: `No shopping index is set on this deployment, so this opens ${shop.label}'s own search for “${query}”. The hub holds no price of its own.`,
    source: "Shop",
  }));
}

/* ----------------------------------------------------------------- gather */

type Gathered = { rows: SearchRow[]; via: string | null };

/**
 * The web index, when the family has a key for one. Brave leads — a keyword
 * index of its own — then Tavily, then Exa, so whichever key is on the
 * deployment is the one that answers. With none of them there is no index at
 * all, which is why the hub's own open sources are asked alongside rather than
 * after: All search is thin without a key, never empty.
 *
 * Only the open categories use it — images, shopping and maps have indexes of
 * their own.
 */
async function webIndex(
  query: string,
  filters: SearchFilters = {},
): Promise<Gathered> {
  // Operators are handed to the index, which understands them; the open
  // sources are asked the plain words and narrowed here afterwards (narrowRows).
  const asked = operatorQuery(query, filters);
  const braveHits = await brave(asked);
  if (braveHits.length) return { rows: braveHits, via: "Brave" };

  const tavilyHits = await tavily(asked);
  if (tavilyHits.length) return { rows: tavilyHits, via: "Tavily" };

  const exaHits = await exa(asked);
  if (exaHits.length) return { rows: exaHits, via: "Exa" };

  return { rows: [], via: null };
}

/** What a shelf is called in a sentence. */
const SHELF_LABELS: Record<SearchShelf, string> = {
  all: "the whole category",
  wiki: "Wikipedia",
  books: "Open Library",
  texts: "the Internet Archive's scanned books",
  audio: "the Internet Archive's sound",
  datasets: "the Internet Archive's datasets",
  software: "the Internet Archive's software",
  code: "Stack Overflow",
  discuss: "Hacker News",
  packages: "the npm registry",
};

/**
 * One shelf, asked on its own: the same words, one source, nothing alongside.
 * This is what makes "narrow the search" mean something — the answer is not a
 * mixture that happens to include the shelf, it is the shelf.
 */
async function shelfRows(
  query: string,
  shelf: SearchShelf,
): Promise<Gathered> {
  switch (shelf) {
    case "wiki":
      return { rows: await wikipedia(query), via: null };
    case "books":
      return { rows: await openLibrary(query), via: null };
    case "texts":
      return {
        rows: await archive(query, "texts", "Internet Archive books"),
        via: null,
      };
    case "audio":
      return {
        rows: await archive(query, "audio", "Internet Archive audio"),
        via: null,
      };
    case "datasets":
      return {
        rows: await archive(query, "data", "Internet Archive datasets"),
        via: null,
      };
    case "software":
      return {
        rows: await archive(query, "software", "Internet Archive software"),
        via: null,
      };
    case "code":
      return { rows: await stackOverflow(query), via: null };
    case "discuss":
      return { rows: await hackerNews(query), via: null };
    case "packages":
      return { rows: await npm(query), via: null };
    default:
      return { rows: [], via: null };
  }
}

/** Everything the hub asks for one query and one set of refinements. */
async function gather(
  query: string,
  category: SearchCategory,
  range: SearchRange,
  filters: SearchFilters,
  shelf: SearchShelf,
): Promise<Gathered> {
  // One shelf on its own answers before any category is considered: that is
  // what pointing a query at a shelf means.
  if (shelf !== "all") return await shelfRows(query, shelf);

  switch (category) {
    case "images": {
      const pictures = await braveImages(query);
      return {
        rows: [...pictures, ...(await commons(query, "image"))],
        via: pictures.length ? "Brave Images" : null,
      };
    }
    case "shopping": {
      const priced = await braveShopping(query);
      if (priced.length) return { rows: priced, via: "Brave Shopping" };

      // No shopping index: Tavily will at least find the shops' own pages,
      // and failing that the hub says plainly that it holds no prices.
      const found = await tavily(`buy ${query} price`);
      if (found.length) return { rows: found, via: "Tavily" };

      return { rows: shops(query), via: null };
    }
    case "videos":
      return {
        rows: [
          ...(await archive(query, "movies", "Internet Archive")),
          ...(await commons(query, "video")),
        ],
        via: null,
      };
    case "short-videos":
      return { rows: await commons(query, "video"), via: null };
    case "news": {
      const index = await webIndex(query, filters);
      return {
        rows: [...index.rows, ...(await news(query, range)), ...(await hackerNews(query))],
        via: index.via,
      };
    }
    case "maps":
      return { rows: await maps(query), via: null };
    case "more": {
      const index = await webIndex(query, filters);
      return {
        rows: [
          ...index.rows,
          ...(await openLibrary(query)),
          ...(await archive(query, "texts", "Internet Archive books")),
          ...(await archive(query, "audio", "Internet Archive audio")),
          ...(await stackOverflow(query)),
        ],
        via: index.via,
      };
    }
    case "tools": {
      const index = await webIndex(query, filters);
      return {
        rows: [
          ...index.rows,
          ...(await npm(query)),
          ...(await stackOverflow(query)),
          ...(await hackerNews(query)),
        ],
        via: index.via,
      };
    }
    default:
      break;
  }

  const index = await webIndex(query, filters);
  const [wiki, hacker, stack, feed] = await Promise.all([
    wikipedia(query),
    hackerNews(query),
    stackOverflow(query),
    news(query, range),
  ]);

  return {
    rows: [...index.rows, ...feed, ...wiki, ...hacker, ...stack],
    via: index.via,
  };
}

/** What to tell the reader about where these rows came from. */
function baseNote(category: SearchCategory, via: string | null): string {
  if (via) {
    switch (category) {
      case "images":
        return `Pictures from ${via}, with free files from Wikimedia Commons alongside.`;
      case "shopping":
        return `Prices from ${via}, as the shops it reads them from wrote them.`;
      case "news":
        return `News rows from ${via}, with the hub's live feeds alongside.`;
      default:
        return `Web-index rows from ${via}, with the hub's own open sources alongside.`;
    }
  }

  switch (category) {
    case "images":
      return "No image-index key is set, so these are files the hub found in Wikimedia Commons — free to show, free to keep, each one with its real size.";
    case "videos":
      return "Films and clips from the Internet Archive and Wikimedia Commons, keyless — nothing here was scraped from a video site.";
    case "short-videos":
      return "Short clips from Wikimedia Commons, listed shortest first.";
    case "news":
      return "Live news feeds the hub reads directly — nothing here was handed to a search page.";
    case "maps":
      return "Places from OpenStreetMap's own geocoder; each row opens the map itself.";
    case "more":
      return "The hub's other open shelves: books, archive texts and sound, and code answers.";
    case "tools":
      return "Tools and packages from the npm registry and Stack Overflow, keyless.";
    case "shopping":
      return "No shopping index is set on this deployment, so the hub hands back the shops' own searches rather than inventing prices.";
    default:
      return "No web-index key is set on this deployment, so these came from the hub's own keyless sources — a live news feed, Wikipedia, Hacker News and Stack Overflow. They are current, but thinner than a full web index.";
  }
}

/** Search the web from here — the hub's own sources, drawn as links. */
export const web = action({
  args: {
    query: v.string(),
    category: v.optional(v.string()),
    sort: v.optional(v.string()),
    range: v.optional(v.string()),
    /** One shelf of the open sources, or `all` for the whole category. */
    shelf: v.optional(v.string()),
    /** The narrowing a search page offers: a site, a phrase, words out, a kind. */
    site: v.optional(v.string()),
    exact: v.optional(v.string()),
    exclude: v.optional(v.string()),
    filetype: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { query, category, sort, range, shelf, site, exact, exclude, filetype },
  ): Promise<SearchAnswer> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return { ok: false, error: "Sign in to search the web." };
    }
    if (!(await ctx.runQuery(internal.access.unlocked, {}))) {
      return {
        ok: false,
        error: "This hub is locked. Enter the family password to continue.",
      };
    }

    const text = query.trim().slice(0, 300);
    if (!text) {
      return { ok: false, error: "There was nothing to search for." };
    }

    const wanted = pick(CATEGORIES, category, "all");
    const listed = pick(SORTS, sort, "relevance");
    const window = pick(RANGES, range, "any");
    const shelfWanted = pick(SHELVES, shelf, "all");
    const filters: SearchFilters = {
      site: site?.slice(0, 120),
      exact: exact?.slice(0, 120),
      exclude: exclude?.slice(0, 160),
      filetype: filetype?.slice(0, 12),
    };

    // A window is only visible if the newest rows are put first, so asking for
    // one re-lists by time unless a heavier order was asked for by name.
    const ordering: SearchSort =
      window !== "any" && listed === "relevance" ? "time" : listed;

    const { rows, via } = await gather(text, wanted, window, filters, shelfWanted);

    const narrowed = narrowRows(dedupe(rows), filters);
    let results = order(withinRange(narrowed.rows, window), ordering);
    if (wanted === "short-videos" && ordering === "relevance") {
      results = byDuration(results);
    }
    results = results.slice(0, MAX_ROWS);

    if (!results.length) {
      const narrowing = [
        filters.site ? `from ${filters.site}` : "",
        filters.exact ? `carrying “${filters.exact}”` : "",
        filters.exclude ? `without ${filters.exclude}` : "",
        filters.filetype ? `as .${filters.filetype}` : "",
      ]
        .filter(Boolean)
        .join(", ");
      return {
        ok: false,
        error: narrowing
          ? `Nothing came back ${narrowing}. Loosen one of those, or widen the window — the row would have to satisfy all of them at once.`
          : wanted === "all"
            ? "Nothing came back — every source the hub asks was unreachable. Try a different wording, or open an address directly."
            : `Nothing came back in ${wanted.replace("-", " ")} for that, from the sources the hub can reach. Try a different wording, a wider window, or the All search category.`,
      };
    }

    const parts = [
      shelfWanted === "all"
        ? baseNote(wanted, via)
        : `${SHELF_LABELS[shelfWanted]} alone, asked for those words — the point of pointing a search at one shelf is that nothing else answers with it.`,
    ];
    if (narrowed.notes.length) {
      // A phrase orders the rows only while the listing is relevance: ask for
      // the newest first and something else decides, so the note says that
      // rather than claiming an order the list does not have.
      const notes = narrowed.notes.map((note) =>
        ordering !== "relevance" &&
        filters.exact &&
        note.includes("first")
          ? `“${filters.exact}” was asked for, though the listing you chose decides the order`
          : note,
      );
      parts.push(`Narrowed: ${notes.join("; ")}.`);
    }
    if (ordering === "time") {
      parts.push(
        window === "any"
          ? "Listed newest first."
          : `Listed newest first, inside the past ${RANGE_WORDS[window]}.`,
      );
    } else if (ordering === "size") {
      parts.push("Listed largest first.");
    } else if (ordering === "price") {
      parts.push(
        via
          ? "Listed cheapest first."
          : "Listed cheapest first, among the rows that carry a price.",
      );
    }
    parts.push(
      `${results.length} row${results.length === 1 ? "" : "s"} the hub itself fetched.`,
    );

    return {
      ok: true,
      query: text,
      category: wanted,
      sort: listed,
      range: window,
      shelf: shelfWanted,
      filters,
      via,
      results,
      note: parts.filter(Boolean).join(" "),
    };
  },
});
