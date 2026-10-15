/**
 * The boxes the assistant installs on the [LIVE] page.
 *
 * The board in `briefing.ts` is a fixed wall: every reading on it was written
 * here in code. This is the other half — a person says "put the Rifle rodeo on
 * my board" or "I want to watch the auction page", and the assistant installs
 * a box for it: the address, the pipeline that reads it, and the words it must
 * match. The hub then fetches that address itself, on the same timer as the
 * rest of the board, and the page draws whatever came back.
 *
 * Nothing here trusts the browser. Installing, refreshing and removing all ask
 * the same question the rest of the hub asks — `isUnlocked` — so a locked
 * account cannot spend the family's network on a box of its own, and the page
 * only ever draws rows the server itself fetched.
 */
import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type ActionCtx,
} from "./_generated/server";
import { isUnlocked } from "./guard";

/* ---------------------------------------------------------------- fetching */

const UA =
  "private-hub/1.0 (+https://github.com/ranchfarmco-lang/private-hub)";
const TIMEOUT_MS = 12_000;
const MAX_ROWS = 6;

/**
 * Every network call is capped, and a busy host gets a second and third try —
 * the same courtesy the [LIVE] board itself extends. A 4xx that is not a rate
 * limit is a real answer, so it is not hammered.
 */
async function request(url: string, accept: string): Promise<Response> {
  let lastError: unknown = new Error("It did not answer.");

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response: Response | null = null;
    let failure: unknown = null;

    try {
      response = await fetch(url, {
        headers: { "User-Agent": UA, Accept: accept },
        signal: controller.signal,
      });
    } catch (error) {
      failure = error;
    } finally {
      clearTimeout(timer);
    }

    if (response) {
      if (response.ok) return response;
      const status = response.status;
      if (status !== 429 && status < 500) {
        throw new Error(`The source answered ${status}.`);
      }
      lastError = new Error(`The source answered ${status}.`);
    } else {
      lastError = failure;
      if (failure instanceof Error && /abort/i.test(failure.message)) {
        throw failure;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
  }

  throw lastError;
}

async function getText(url: string): Promise<string> {
  const response = await request(
    url,
    "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, text/html;q=0.8, */*;q=0.7",
  );
  return await response.text();
}

function describe(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message.replace(/\s+/g, " ").slice(0, 200);
  }
  return "It did not answer.";
}

/** The handful of entities a feed actually uses, turned back into characters. */
function decodeEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
      String.fromCharCode(parseInt(code, 16)),
    )
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/** A headline as plain text — markup inside a title belongs in a page, not a sentence. */
function plain(value: string): string {
  return decodeEntities(value.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function tag(block: string, name: string): string {
  const match = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return match ? plain(match[1].replace(/<!\[CDATA\[|\]\]>/g, "")) : "";
}

/** The `href` of an Atom `<link>`, which carries its address as an attribute. */
function atomLink(block: string): string {
  const match = block.match(/<link[^>]*href=["']([^"']+)["']/i);
  return match ? match[1].trim() : "";
}

/** The host, said as a person would — used when a feed names no outlet. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

type BoxRow = { title: string; link: string; at: number | null; from: string };

/** A box as the digest reads it — declared here so nothing has to be inferred. */
type BoxRowOut = {
  title: string;
  url: string;
  pipeline: string;
  filter: string | null;
  why: string;
  data: unknown;
  readAt: number | null;
  error: string | null;
};

/** One RSS or Atom feed, read the way the board reads its own. */
function readFeed(xml: string, from: string): BoxRow[] {
  const blocks = xml.includes("<item")
    ? xml.split("<item").slice(1)
    : xml.split("<entry").slice(1);
  const rows: BoxRow[] = [];

  for (const block of blocks) {
    const title = tag(block, "title");
    if (!title) continue;
    const published = tag(block, "pubDate") || tag(block, "published") || tag(block, "updated") || tag(block, "dc:date");
    const link = tag(block, "link") || atomLink(block);
    rows.push({
      title,
      link,
      at: published ? Date.parse(published) || null : null,
      from,
    });
  }

  if (!rows.length) throw new Error("The feed answered nothing.");
  return rows.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** A month-name passage turned into a timestamp, so a dated thing sorts right. */
function monthStamp(text: string): number | null {
  const match = text.match(
    /([A-Z][a-z]{2})[a-z]*\.?\s*(\d{1,2})?(?:\s*[-–]\s*\d{1,2})?,?\s*(20\d\d)/,
  );
  if (!match) return null;
  const index = MONTHS.findIndex((month) =>
    month.toLowerCase().startsWith(match[1].toLowerCase()),
  );
  if (index < 0) return null;
  return Date.UTC(Number(match[3]), index, Number(match[2] ?? "1"));
}

/**
 * The sale listings on a board, kept to the ones that are actually sales.
 * A classifieds feed carries a lot that is not a listing; this is the line
 * between "garage sale, Saturday" and an article about one.
 */
const SALE_WORDS =
  /(sale|garage|estate|auction|classified|yard|rummage|moving|thrift|marketplace|flea)/i;

/** A page's own text, split into lines — for a feed that is not a feed. */
function readLines(html: string, from: string): BoxRow[] {
  const text = plain(
    html
      // The head holds the page's own title and its metadata, which is not
      // something anybody reads off a board — only the body is read.
      .replace(/<head[\s\S]*?<\/head>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " "),
  );
  const rows: BoxRow[] = [];
  for (const piece of text.split(/[·•|]\s*|\n+/)) {
    const line = piece.trim();
    if (line.length < 12 || line.length > 200) continue;
    // A line that is only an address, or only punctuation, is markup that
    // survived — not something a person would read on a board.
    if (/^(https?:\/\/|www\.)\S+$/i.test(line)) continue;
    if (!/[a-z]{3}/i.test(line)) continue;
    if (rows.some((row) => row.title === line)) continue;
    rows.push({ title: line, link: "", at: monthStamp(line), from });
    if (rows.length >= 24) break;
  }
  if (!rows.length) throw new Error("Nothing readable came back from that page.");
  return rows;
}

/* -------------------------------------------------------------- pipelines */

/**
 * The pipelines the assistant may name. Each one takes what the address
 * answered and turns it into rows the page can draw. They are named here, and
 * only here, so a box cannot ask for a pipeline that does not exist.
 */
const PIPELINES: Record<
  string,
  { id: string; title: string; what: string; read: (body: string, from: string) => BoxRow[] }
> = {
  rss: {
    id: "rss",
    title: "A news feed",
    what: "an RSS or Atom feed — headlines, newest first",
    read: readFeed,
  },
  sales: {
    id: "sales",
    title: "A sale board",
    what: "a classifieds or garage-sale feed, kept to the actual listings",
    read: (body, from) => {
      const rows = readFeed(body, from).filter((row) => SALE_WORDS.test(row.title));
      if (!rows.length) throw new Error("No sale listings came back from that feed.");
      return rows;
    },
  },
  events: {
    id: "events",
    title: "A calendar or events feed",
    what: "an events feed or calendar page, with the dated things first",
    read: (body, from) => {
      // A calendar that answers as a feed is read as one — and a feed with no
      // items in it has honestly answered nothing, which is what it says. Only
      // a page that is not a feed at all is read line by line, so an empty
      // calendar never turns its own channel header into a listing.
      const isFeed =
        body.includes("<item") ||
        body.includes("<entry") ||
        /<\?xml|<rss[\s>]|<feed[\s>]/i.test(body);

      const rows = isFeed
        ? readFeed(body, from).map((row) => ({
            ...row,
            at: row.at ?? monthStamp(row.title),
          }))
        : readLines(body, from);
      const dated = rows.filter((row) => row.at !== null);
      return (dated.length ? dated : rows).sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
    },
  },
  feed: {
    id: "feed",
    title: "A page's own lines",
    what: "a plain page the hub reads line by line, when it is not a feed at all",
    read: readLines,
  },
};

/** What the assistant may ask for, written out for its prompt. */
export function pipelineNames(): { id: string; title: string; what: string }[] {
  return Object.values(PIPELINES).map(({ id, title, what }) => ({ id, title, what }));
}

/** Whatever the assistant said, folded onto a pipeline that actually exists. */
function pipelineFor(value: unknown): string {
  if (typeof value === "string") {
    const wanted = value.trim().toLowerCase();
    if (PIPELINES[wanted]) return wanted;
    if (/sale|classif|garage|auction/.test(wanted)) return "sales";
    if (/event|calendar|happening/.test(wanted)) return "events";
    if (/feed|news|headline|rss|wire/.test(wanted)) return "rss";
    if (/line|page|text|scrape/.test(wanted)) return "feed";
  }
  return "rss";
}

/** Only a real http address is ever fetched. */
function httpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, 500);
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    new URL(trimmed);
    return trimmed;
  } catch {
    return null;
  }
}

type Fetched = { rows: BoxRow[]; source: string; at: number };

/** Go out to one box's address and read it with its own pipeline. */
async function fetchBox(box: {
  url: string;
  pipeline: string;
  filter: string | null;
}): Promise<Fetched> {
  const pipeline = PIPELINES[box.pipeline] ?? PIPELINES.rss;
  const body = await getText(box.url);
  let rows = pipeline.read(body, hostOf(box.url));

  const wanted = box.filter?.trim();
  if (wanted) {
    const needle = wanted.toLowerCase();
    rows = rows.filter(
      (row) =>
        row.title.toLowerCase().includes(needle) ||
        row.from.toLowerCase().includes(needle),
    );
    if (!rows.length) {
      throw new Error(`Nothing in that feed matched “${wanted}”.`);
    }
  }

  return { rows: rows.slice(0, MAX_ROWS), source: hostOf(box.url), at: Date.now() };
}

/* --------------------------------------------------------- the boxes' rows */

/** Everything on the wall, newest box last, in the order it was installed. */
export const list = query({
  args: {},
  handler: async (ctx): Promise<
    {
      _id: Id<"liveBoxes">;
      title: string;
      url: string;
      pipeline: string;
      filter: string | null;
      town: string | null;
      why: string;
      data: unknown;
      readAt: number | null;
      error: string | null;
    }[]
  > => {
    if (!(await isUnlocked(ctx))) return [];
    const rows = await ctx.db.query("liveBoxes").collect();
    return rows
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((row) => ({
        _id: row._id,
        title: row.title,
        url: row.url,
        pipeline: row.pipeline,
        filter: row.filter,
        town: row.town,
        why: row.why,
        data: row.data,
        readAt: row.readAt,
        error: row.error,
      }));
  },
});

/**
 * Install a box. The row is written first and fetched immediately, so the
 * assistant can say "installed it, and here is what it found" in one breath
 * rather than promising something that has not been tried yet.
 */
export const install = action({
  args: {
    title: v.string(),
    url: v.string(),
    pipeline: v.optional(v.string()),
    filter: v.optional(v.string()),
    town: v.optional(v.string()),
    why: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    id: Id<"liveBoxes">;
    title: string;
    pipeline: string;
    ok: boolean;
    rows: BoxRow[];
    source: string;
    error: string | null;
  }> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Sign in to install a box.");
    if (!(await ctx.runQuery(internal.access.unlocked, {}))) {
      throw new Error("This hub is locked. Enter the family password to continue.");
    }

    const url = httpUrl(args.url);
    if (!url) throw new Error("That is not an http address the hub can fetch.");
    const title = args.title.trim().slice(0, 60) || hostOf(url);
    const pipeline = pipelineFor(args.pipeline);
    const filter = args.filter?.trim().slice(0, 60) || null;
    const town = args.town?.trim().slice(0, 40) || null;

    const id = await ctx.runMutation(internal.live_boxes.add, {
      title,
      url,
      pipeline,
      filter,
      town,
      why: args.why?.trim().slice(0, 160) ?? "",
      ownerId: userId,
    });

    const found = await readNow(ctx, id);
    return { id, title, pipeline, ...found };
  },
});

/** Add the row itself, so the fetch that follows has somewhere to land. */
export const add = internalMutation({
  args: {
    title: v.string(),
    url: v.string(),
    pipeline: v.string(),
    filter: v.union(v.string(), v.null()),
    town: v.union(v.string(), v.null()),
    why: v.string(),
    ownerId: v.id("users"),
  },
  handler: async (ctx, args): Promise<Id<"liveBoxes">> => {
    return await ctx.db.insert("liveBoxes", {
      ...args,
      data: null,
      readAt: null,
      error: null,
      createdAt: Date.now(),
    });
  },
});

/** Read one box now and put what came back on its row. */
async function readNow(
  ctx: ActionCtx,
  id: Id<"liveBoxes">,
): Promise<{ ok: boolean; rows: BoxRow[]; source: string; error: string | null }> {
  const box = await ctx.runQuery(internal.live_boxes.get, { id });

  if (!box) {
    return { ok: false, rows: [], source: "", error: "That box is no longer installed." };
  }

  try {
    const found = await fetchBox(box);
    await ctx.runMutation(internal.live_boxes.saved, {
      id,
      data: { rows: found.rows, source: found.source },
      readAt: found.at,
    });
    return { ok: true, rows: found.rows, source: found.source, error: null };
  } catch (error) {
    const message = describe(error);
    await ctx.runMutation(internal.live_boxes.saved, {
      id,
      data: null,
      readAt: Date.now(),
      error: message,
    });
    return { ok: false, rows: [], source: hostOf(box.url), error: message };
  }
}

/** One box, for the fetch that is about to read it. */
export const get = internalQuery({
  args: { id: v.id("liveBoxes") },
  handler: async (ctx, { id }) => {
    const row = await ctx.db.get(id);
    return row
      ? { url: row.url, pipeline: row.pipeline, filter: row.filter }
      : null;
  },
});

/** Put what a fetch found back on the box's row. */
export const saved = internalMutation({
  args: {
    id: v.id("liveBoxes"),
    data: v.any(),
    readAt: v.number(),
    error: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, { id, data, readAt, error }) => {
    const row = await ctx.db.get(id);
    if (!row) return null;
    await ctx.db.patch(id, { data, readAt, error: error ?? null });
    return null;
  },
});

/** Refresh one box from the page. */
export const refresh = action({
  args: { id: v.id("liveBoxes") },
  handler: async (
    ctx,
    { id },
  ): Promise<{
    ok: boolean;
    rows: BoxRow[];
    source: string;
    error: string | null;
  }> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Sign in to refresh a box.");
    if (!(await ctx.runQuery(internal.access.unlocked, {}))) {
      throw new Error("This hub is locked. Enter the family password to continue.");
    }
    return await readNow(ctx, id);
  },
});

/** Take a box down again. */
export const remove = mutation({
  args: { id: v.id("liveBoxes") },
  handler: async (ctx, { id }): Promise<null> => {
    if (!(await isUnlocked(ctx))) {
      throw new Error("This hub is locked. Enter the family password to continue.");
    }
    const row = await ctx.db.get(id);
    if (!row) return null;
    await ctx.db.delete(id);
    return null;
  },
});

/**
 * Take a box down by the name it is shown under — what the assistant has when
 * somebody says "take the rodeo box off my board". The name is matched loosely,
 * because they will say it the way it reads, not the way it was stored.
 */
export const removeByTitle = mutation({
  args: { title: v.string() },
  handler: async (ctx, { title }): Promise<string | null> => {
    if (!(await isUnlocked(ctx))) {
      throw new Error("This hub is locked. Enter the family password to continue.");
    }
    const wanted = title.trim().toLowerCase();
    const rows = await ctx.db.query("liveBoxes").collect();
    const row =
      rows.find((one) => one.title.toLowerCase() === wanted) ??
      rows.find(
        (one) =>
          one.title.toLowerCase().includes(wanted) ||
          wanted.includes(one.title.toLowerCase()),
      );
    if (!row) return null;
    await ctx.db.delete(row._id);
    return row.title;
  },
});

/**
 * Read every installed box again, on the same timer as the rest of the board.
 * One box failing takes only its own row down, exactly as one feed failing on
 * the board takes only its own box down.
 */
export const refreshAll = internalAction({
  args: {},
  handler: async (ctx): Promise<number> => {
    const rows = await ctx.runQuery(internal.live_boxes.ids, {});
    for (const id of rows) {
      await readNow(ctx, id);
    }
    return rows.length;
  },
});

/** Every installed box's id, for the timer. */
export const ids = internalQuery({
  args: {},
  handler: async (ctx): Promise<Id<"liveBoxes">[]> => {
    const rows = await ctx.db.query("liveBoxes").collect();
    return rows.map((row) => row._id);
  },
});

/* --------------------------------------------------------- saying them back */

/**
 * The installed boxes, said out loud — for the assistant. This is what makes
 * "what is on my board" answerable with the person's own boxes in it, and what
 * lets it read back what a box it installed actually found.
 */
export async function boxesDigest(ctx: ActionCtx): Promise<string> {
  const rows = await ctx.runQuery(internal.live_boxes.every, {});

  if (!rows.length) {
    return "They have installed no boxes of their own on the [LIVE] page yet. You can install one whenever they ask — give it a name, the address, and the pipeline, and the hub will fetch it on its own timer and put it on the wall.";
  }

  const lines = (rows as BoxRowOut[]).map((row) => {
    const pipeline = PIPELINES[row.pipeline] ?? PIPELINES.rss;
    const head = `“${row.title}” (${pipeline.title.toLowerCase()}) — ${row.url}${
      row.filter ? `, kept to rows matching “${row.filter}”` : ""
    }${row.why ? ` — installed because ${row.why}` : ""}.`;

    if (row.error) return `${head} Right now it is not answering: ${row.error}`;
    const data = row.data as { rows?: BoxRow[]; source?: string } | null;
    if (!data?.rows?.length) return `${head} It has not been read yet.`;
    return `${head} It last found, newest first:\n${data.rows
      .map(
        (item) =>
          `  - ${item.title}${item.from ? ` (${item.from})` : ""}${
            item.at ? ` — ${new Date(item.at).toISOString().slice(0, 16).replace("T", " ")}` : ""
          }`,
      )
      .join("\n")}`;
  });

  return `Boxes they installed themselves on the [LIVE] page (${rows.length}), in the order they were installed:\n${lines.join("\n")}`;
}

/** Every box, whole, for the digest above. */
export const every = internalQuery({
  args: {},
  handler: async (ctx): Promise<BoxRowOut[]> => {
    const rows = await ctx.db.query("liveBoxes").collect();
    return rows.sort((a, b) => a.createdAt - b.createdAt).map((row) => ({
      title: row.title,
      url: row.url,
      pipeline: row.pipeline,
      filter: row.filter,
      why: row.why,
      data: row.data,
      readAt: row.readAt,
      error: row.error,
    }));
  },
});
