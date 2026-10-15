import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/convex/_generated/api";
import {
  CATEGORY_TABS,
  SHELF_CHOICES,
  isNarrowed,
  msLabel,
  narrowing,
  shelfLabel,
  sinceLabel,
  wordLabel,
  type SearchCategory,
  type SearchHistoryEntry,
  type SearchPrefs,
  type SearchRow,
  type SearchShelf,
} from "@/lib/browser-search";
import { readableSize, downloadText } from "@/lib/download";
import { cn } from "@/lib/utils";
import type { FunctionReturnType } from "convex/server";
import { useAction } from "convex/react";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Copy,
  Crosshair,
  Download,
  Eye,
  Filter,
  Globe,
  Layers,
  Link2,
  Loader2,
  Plus,
  Radar,
  RefreshCw,
  ScanSearch,
  Search,
  Server,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";

/**
 * The browser's boxes — the tools, the shelves and the bots.
 *
 * The bar at the top of the browser answers a question: it searches, or it opens
 * an address. What lives here is the other half of finding things, the half a
 * person does when one answer is not enough — narrowing a search to a single
 * site or a phrase, pointing it at one shelf instead of everything, walking a
 * site link by link, keeping an eye on a page, asking a server what it is, and
 * reading the best pages an answer found rather than only their one-line
 * summaries.
 *
 * Everything in these boxes is real, and each one says where its work happens:
 * the narrowing is applied by the hub to rows it fetched itself, the crawler
 * and the perch fetch pages through the reader's own door (`convex/crawl.ts`),
 * the survey asks the hub's search category by category, and the deep read
 * opens the pages it names. None of them is a placeholder waiting for a service
 * that was never connected: the ones that would need a key say so and fall back
 * to what the hub holds on its own.
 */

/* ------------------------------------------------------------- the pieces */

function Box({
  icon: Icon,
  title,
  note,
  right,
  children,
}: {
  icon: typeof Search;
  title: string;
  note: string;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-2 rounded-2xl border border-white/20 bg-card/60 p-2.5 backdrop-blur-sm">
      <header className="flex items-start gap-2">
        <span className="grid size-6 shrink-0 place-items-center rounded-lg bg-white/10 text-white">
          <Icon className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold tracking-tight">{title}</p>
          <p className="text-[9px] leading-4 text-muted-foreground">{note}</p>
        </div>
        {right}
      </header>
      {children}
    </section>
  );
}

/** A small pill that can be pressed: the shape of every choice in these boxes. */
function Chip({
  active,
  onClick,
  title,
  children,
  className,
}: {
  active?: boolean;
  onClick: () => void;
  title?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      title={title}
      onClick={onClick}
      className={cn(
        "flex cursor-pointer items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] transition-colors",
        active
          ? "border-white/30 bg-white/12 text-foreground"
          : "border-transparent text-muted-foreground hover:border-white/15 hover:bg-white/5 hover:text-foreground",
        className,
      )}
    >
      {children}
    </button>
  );
}

/** A key/value line, for the reports the probe and the crawler write. */
function Fact({
  label,
  value,
  mono,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
}) {
  return (
    <span className="flex min-w-0 items-baseline gap-1.5 text-[10px]">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span
        className={cn(
          "min-w-0 truncate text-foreground/90",
          mono && "font-mono text-[9px]",
        )}
      >
        {value}
      </span>
    </span>
  );
}

/** The host a row lives on, and the first step of its path. */
function hostLabel(url: string) {
  try {
    const parsed = new URL(url);
    const first = parsed.pathname.split("/").filter(Boolean)[0] ?? "";
    return first
      ? `${parsed.hostname.replace(/^www\./, "")}/${first.slice(0, 24)}`
      : parsed.hostname.replace(/^www\./, "");
  } catch {
    return url.slice(0, 40);
  }
}

function countWords(text: string) {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/**
 * The lines of a page that carry the words somebody searched for. Sentences, not
 * a summary: a model never touches these, so what is shown is the page's own
 * words with the guesswork left out.
 */
function passages(text: string, terms: string[], max = 3) {
  const out: string[] = [];
  const chunks = text
    .split(/\n+/)
    .flatMap((line) => line.split(/[.!?]\s+/))
    .map((line) => line.replace(/\s+/g, " ").trim());
  for (const chunk of chunks) {
    if (chunk.length < 40) continue;
    const lower = chunk.toLowerCase();
    if (!terms.some((term) => lower.includes(term))) continue;
    out.push(chunk.slice(0, 320));
    if (out.length >= max) break;
  }
  return out;
}

async function copyText(text: string, what: string) {
  if (!text.trim()) {
    toast("There is nothing to copy yet.");
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    toast.success(what);
  } catch {
    toast.error("The browser would not let that be copied.");
  }
}

/* -------------------------------------------------------- 1 · narrowing it */

/**
 * The four ways a search page lets a search be narrowed, asked of the hub's own
 * search. A site and the words to leave out are filters over the rows; a phrase
 * is put in front of the list; a file kind keeps only what it names — and each
 * one says when it matched nothing rather than quietly emptying the page.
 */
function NarrowBox({
  query,
  prefs,
  onPrefs,
  onSearch,
}: {
  query: string;
  prefs: SearchPrefs;
  onPrefs: (patch: Partial<SearchPrefs>) => void;
  onSearch: (query: string, prefs: SearchPrefs) => void;
}) {
  // The fields start on the narrowing the browser is holding. The box is keyed
  // by those four values from the page, so a narrowing changed anywhere else
  // arrives here as a fresh box rather than as an effect that quietly rewrites
  // what somebody is in the middle of typing.
  const [draft, setDraft] = useState({
    site: prefs.site,
    exact: prefs.exact,
    exclude: prefs.exclude,
    filetype: prefs.filetype,
  });

  const active = narrowing({ ...prefs, ...draft });

  const ask = () => {
    onPrefs(draft);
    if (!query.trim()) {
      toast("Type the words to search for in the bar, then narrow them here.");
      return;
    }
    onSearch(query, { ...prefs, ...draft });
  };

  const clear = () => {
    const empty = { site: "", exact: "", exclude: "", filetype: "" };
    setDraft(empty);
    onPrefs(empty);
    if (query.trim()) onSearch(query, { ...prefs, ...empty });
  };

  const field = (
    key: "site" | "exact" | "exclude" | "filetype",
    label: string,
    placeholder: string,
  ) => (
    <label className="flex min-w-0 flex-col gap-0.5">
      <span className="text-[9px] text-muted-foreground">{label}</span>
      <Input
        value={draft[key]}
        onChange={(event) =>
          setDraft((prev) => ({ ...prev, [key]: event.target.value }))
        }
        onKeyDown={(event) => {
          if (event.key === "Enter") ask();
        }}
        placeholder={placeholder}
        data-spell="off"
        className="h-7 text-[10px]"
      />
    </label>
  );

  return (
    <Box
      icon={Filter}
      title="Narrow it down"
      note="A site, a phrase, words to leave out, a file kind. The hub's own search applies all four to what it fetched — nothing here is handed to somebody else's search page."
      right={
        isNarrowed(prefs) ? (
          <span className="shrink-0 rounded-full border border-white/20 px-1.5 py-px text-[8px] text-muted-foreground">
            on
          </span>
        ) : null
      }
    >
      <div className="grid grid-cols-2 gap-1.5">
        {field("site", "Only this site", "example.com")}
        {field("exact", "This phrase, word for word", "the whole phrase")}
        {field("exclude", "Not these words", "cheap, knockoff")}
        {field("filetype", "Only this kind of file", "pdf")}
      </div>

      <p className="text-[9px] leading-4 text-muted-foreground">
        {active.length
          ? `As it stands: ${active.join(", ")}.`
          : "Nothing narrowed — every source answers the words as they are."}
      </p>

      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          type="button"
          size="sm"
          onClick={ask}
          className="h-7 cursor-pointer rounded-lg text-[10px]"
        >
          <Search className="size-3" />
          Ask again, narrowed
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={clear}
          className="h-7 cursor-pointer rounded-lg text-[10px]"
        >
          <X className="size-3" />
          Clear
        </Button>
      </div>
    </Box>
  );
}

/* ------------------------------------------------------- 2 · the crawl bot */

// The bots live in their own module (`convex/crawl.ts`), because they are not
// the reader: `api.crawl.crawl` is the crawl, `api.crawl.perch` the watch and
// `api.crawl.probe` the look at a server's own answer.
type CrawlReport = FunctionReturnType<typeof api.crawl.crawl>;

/** The crawl written out as a tree, so it can be kept or handed to somebody. */
function crawlMap(report: Extract<CrawlReport, { ok: true }>) {
  const lines = [`Crawl of ${report.start} — ${report.note}`, ""];
  for (const page of report.pages) {
    const indent = "  ".repeat(page.depth);
    const status = page.error ? page.error : `HTTP ${page.status}`;
    lines.push(
      `${indent}${page.url}  [${status}, ${readableSize(page.bytes)}, ${wordLabel(page.words)}, ${page.links} link${page.links === 1 ? "" : "s"}, ${msLabel(page.ms)}]`,
    );
    if (page.title && page.title !== page.url) lines.push(`${indent}  ${page.title}`);
  }
  return lines.join("\n");
}

/**
 * A bot that walks a site: the page in front of you, then what it links to, then
 * what those link to, as far as it is told to go. It stays on the host unless
 * told otherwise, looks at pages rather than pictures and scripts, and hands
 * back the whole walk — statuses, sizes, word counts, times and the link each
 * page was found on — because the shape of a site is the point of crawling one.
 */
function CrawlBox({
  url,
  onOpen,
}: {
  url: string;
  onOpen: (url: string) => void;
}) {
  const crawl = useAction(api.crawl.crawl);
  // Seeded with the page in front of you, and left alone after that: a crawl is
  // aimed at an address somebody chose, so fetching a new page in the browser
  // does not throw away the walk already on screen.
  const [start, setStart] = useState(url);
  const [depth, setDepth] = useState(1);
  const [max, setMax] = useState(8);
  const [scope, setScope] = useState<"host" | "any">("host");
  const [report, setReport] = useState<CrawlReport | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    const target = start.trim();
    if (!target || busy) return;
    setBusy(true);
    setReport(null);
    try {
      const answer = await crawl({ start: target, depth, max, scope });
      setReport(answer);
      if (answer.ok) {
        toast.success(
          `Walked ${answer.pages.length} page${answer.pages.length === 1 ? "" : "s"} in ${msLabel(answer.stats.ms)}.`,
        );
      } else {
        toast.error(answer.error);
      }
    } catch (caught) {
      toast.error(
        caught instanceof Error ? caught.message : "The crawl did not complete.",
      );
    } finally {
      setBusy(false);
    }
  };

  const walked = report?.ok ? report : null;

  return (
    <Box
      icon={Bot}
      title="Crawl bot"
      note="Walks a site link by link. It fetches pages the way the reader does — one host at a time, a narrow wave at once, and a ceiling it will not pass — and reports every page it saw."
      right={
        busy ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        ) : null
      }
    >
      <Input
        value={start}
        onChange={(event) => setStart(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") void run();
        }}
        placeholder="https://example.com"
        aria-label="Where the crawl starts"
        data-spell="off"
        className="h-7 text-[10px]"
      />

      {url && url !== start ? (
        <button
          type="button"
          onClick={() => setStart(url)}
          className="w-fit cursor-pointer text-[9px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          use the page on screen: {hostLabel(url)}
        </button>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <label className="flex items-center gap-1 text-[9px] text-muted-foreground">
          Steps
          <select
            value={depth}
            onChange={(event) => setDepth(Number(event.target.value))}
            className="cursor-pointer rounded-lg border border-border/60 bg-background/60 px-1.5 py-0.5 text-[10px] text-foreground outline-none"
          >
            {[0, 1, 2, 3].map((value) => (
              <option key={value} value={value}>
                {value === 0 ? "the start page only" : `${value} from the start`}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1 text-[9px] text-muted-foreground">
          Pages
          <select
            value={max}
            onChange={(event) => setMax(Number(event.target.value))}
            className="cursor-pointer rounded-lg border border-border/60 bg-background/60 px-1.5 py-0.5 text-[10px] text-foreground outline-none"
          >
            {[1, 4, 8, 12, 16].map((value) => (
              <option key={value} value={value}>
                up to {value}
              </option>
            ))}
          </select>
        </label>
        <span className="flex items-center gap-1">
          <Chip
            active={scope === "host"}
            onClick={() => setScope("host")}
            title="Follow links only on the host you started from"
          >
            <Globe className="size-3" />
            this host
          </Chip>
          <Chip
            active={scope === "any"}
            onClick={() => setScope("any")}
            title="Follow links wherever they lead"
          >
            <Link2 className="size-3" />
            anywhere
          </Chip>
        </span>
        <Button
          type="button"
          size="sm"
          disabled={busy || !start.trim()}
          onClick={() => void run()}
          className="h-7 cursor-pointer rounded-lg text-[10px]"
        >
          {busy ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <Radar className="size-3" />
          )}
          {busy ? "Walking…" : "Crawl"}
        </Button>
      </div>

      {walked ? (
        <div className="flex flex-col gap-2">
          <p className="text-[9px] leading-4 text-muted-foreground">
            {walked.note}
          </p>

          <div className="grid grid-cols-2 gap-x-2 gap-y-1 rounded-xl border border-border/50 bg-background/40 p-1.5 sm:grid-cols-3">
            <Fact label="pages" value={walked.stats.crawled} />
            <Fact
              label="failed"
              value={walked.stats.failed ? walked.stats.failed : "none"}
            />
            <Fact label="took" value={msLabel(walked.stats.ms)} />
            <Fact label="fetched" value={readableSize(walked.stats.bytes)} />
            <Fact label="words" value={wordLabel(walked.stats.words)} />
            <Fact label="links" value={walked.edges.length} />
            <Fact label="deepest" value={`${walked.stats.depth} step${walked.stats.depth === 1 ? "" : "s"}`} />
            <Fact label="left behind" value={walked.stats.skipped} />
            <Fact label="hosts" value={walked.stats.hosts.length} />
          </div>

          <div className="flex max-h-56 flex-col gap-1 overflow-y-auto pr-0.5">
            {walked.pages.map((page, index) => (
              <div
                key={`${page.url}-${index}`}
                className="flex items-center gap-1.5 rounded-lg border border-border/50 px-1.5 py-1"
                style={{ marginLeft: Math.min(page.depth, 3) * 10 }}
              >
                <span
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    page.error
                      ? "bg-red-400"
                      : page.status >= 400
                        ? "bg-amber-300"
                        : "bg-emerald-300",
                  )}
                  title={page.error ?? `HTTP ${page.status}`}
                />
                <button
                  type="button"
                  onClick={() => onOpen(page.url)}
                  title={page.url}
                  className="min-w-0 flex-1 cursor-pointer text-left"
                >
                  <span className="block truncate text-[10px]">
                    {page.title || page.url}
                  </span>
                  <span className="block truncate text-[8px] text-muted-foreground">
                    {hostLabel(page.url)} · {page.error ? page.error : `HTTP ${page.status}`}
                    {page.from ? ` · found on ${hostLabel(page.from)}` : ""}
                  </span>
                </button>
                <span className="shrink-0 text-right text-[8px] leading-3 text-muted-foreground">
                  {msLabel(page.ms)}
                  <br />
                  {readableSize(page.bytes)}
                  <br />
                  {wordLabel(page.words)}
                </span>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void copyText(crawlMap(walked), "Crawl map copied.")}
              className="h-7 cursor-pointer rounded-lg text-[10px]"
            >
              <Copy className="size-3" />
              Copy the map
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() =>
                downloadText(
                  `crawl-${hostLabel(walked.start).replace(/[^\w.-]+/g, "-")}`,
                  crawlMap(walked),
                )
                  ? toast.success("Crawl map saved.")
                  : toast("There was nothing to save.")
              }
              className="h-7 cursor-pointer rounded-lg text-[10px]"
            >
              <Download className="size-3" />
              Save the map
            </Button>
            <span className="text-[9px] text-muted-foreground">
              {walked.stats.hosts
                .slice(0, 3)
                .map((host) => `${host.host} (${host.pages})`)
                .join(", ")}
              {walked.stats.hosts.length > 3
                ? ` +${walked.stats.hosts.length - 3} more`
                : ""}
            </span>
          </div>
        </div>
      ) : (
        <p className="text-[9px] leading-4 text-muted-foreground">
          The crawler keeps its rows while this box is open; nothing is begun on
          its own, and nothing is kept afterwards.
        </p>
      )}
    </Box>
  );
}

/* ------------------------------------------------------- 3 · the perch bot */

type Perch = {
  url: string;
  title: string;
  /** The shape of the page at the last look; empty before the first one. */
  fingerprint: string;
  words: number;
  bytes: number;
  status: number;
  at: number;
  checks: number;
  changedAt: number | null;
  wasWords: number | null;
  error?: string;
};

const PERCH_KEY = "browser:perches:v1";

function loadPerches(): Perch[] {
  try {
    const raw = window.localStorage.getItem(PERCH_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Perch[];
    return Array.isArray(parsed)
      ? parsed.filter((row) => typeof row?.url === "string").slice(0, 24)
      : [];
  } catch {
    return [];
  }
}

/**
 * The page watcher. A perch is a page somebody wants to keep an eye on: the bot
 * reads it, keeps a fingerprint of what it said, and reads it again when asked —
 * "changed" is that fingerprint differing from the last one, and "was 812 words,
 * now 940" is the size of the change. The list lives on this device, so it is
 * the person's own watching rather than a subscription the hub keeps for them.
 */
function PerchBox({ url, title }: { url: string; title: string }) {
  const perch = useAction(api.crawl.perch);
  const [rows, setRows] = useState<Perch[]>(() => loadPerches());
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    try {
      window.localStorage.setItem(PERCH_KEY, JSON.stringify(rows));
    } catch {
      /* a browser that refuses storage still watches this session */
    }
  }, [rows]);

  const check = useCallback(
    async (row: Perch) => {
      setBusy(row.url);
      try {
        const report = await perch({ url: row.url });
        setRows((prev) =>
          prev.map((entry) => {
            if (entry.url !== row.url) return entry;
            if (!report.ok) {
              return {
                ...entry,
                at: Date.now(),
                checks: entry.checks + 1,
                error: report.error,
              };
            }
            const changed =
              Boolean(entry.fingerprint) &&
              report.fingerprint !== entry.fingerprint;
            return {
              ...entry,
              title: report.title || entry.title,
              fingerprint: report.fingerprint,
              words: report.words,
              bytes: report.bytes,
              status: report.status,
              at: report.at,
              checks: entry.checks + 1,
              changedAt: changed ? report.at : entry.changedAt,
              wasWords: changed ? entry.words : entry.wasWords,
              error: undefined,
            };
          }),
        );
        if (!report.ok) toast.error(report.error);
        else if (row.fingerprint && report.fingerprint !== row.fingerprint) {
          toast.success(`${report.title || hostLabel(row.url)} has changed.`);
        }
      } catch (caught) {
        toast.error(
          caught instanceof Error ? caught.message : "That page could not be read.",
        );
      } finally {
        setBusy(null);
      }
    },
    [perch],
  );

  const watch = async () => {
    if (!url) {
      toast("Open a page first — the perch watches the address you are on.");
      return;
    }
    if (rows.some((row) => row.url === url)) {
      toast("That page is already on the watch list.");
      return;
    }
    const fresh: Perch = {
      url,
      title: title || url,
      fingerprint: "",
      words: 0,
      bytes: 0,
      status: 0,
      at: 0,
      checks: 0,
      changedAt: null,
      wasWords: null,
    };
    setRows((prev) => [fresh, ...prev].slice(0, 24));
    await check(fresh);
  };

  const checkAll = async () => {
    for (const row of rows) await check(row);
  };

  return (
    <Box
      icon={Eye}
      title="Perch bot"
      note="Keeps an eye on pages you name. Each check is a real read of the page; “changed” means what it says differs from the last look, and the list stays on this device."
      right={
        busy ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        ) : null
      }
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          type="button"
          size="sm"
          onClick={() => void watch()}
          disabled={!url || busy !== null}
          className="h-7 cursor-pointer rounded-lg text-[10px]"
        >
          <Plus className="size-3" />
          Watch this page
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void checkAll()}
          disabled={!rows.length || busy !== null}
          className="h-7 cursor-pointer rounded-lg text-[10px]"
        >
          <RefreshCw className="size-3" />
          Check all ({rows.length})
        </Button>
      </div>

      {rows.length ? (
        <div className="flex max-h-52 flex-col gap-1 overflow-y-auto pr-0.5">
          {rows.map((row) => (
            <div
              key={row.url}
              className="flex items-center gap-1.5 rounded-lg border border-border/50 px-1.5 py-1"
            >
              <span
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  row.error
                    ? "bg-red-400"
                    : row.changedAt
                      ? "animate-pulse bg-amber-300"
                      : row.checks
                        ? "bg-emerald-300"
                        : "bg-white/40",
                )}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[10px]">{row.title}</span>
                <span className="block truncate text-[8px] text-muted-foreground">
                  {hostLabel(row.url)} ·{" "}
                  {row.error
                    ? row.error
                    : row.checks
                      ? `checked ${sinceLabel(row.at)} · ${wordLabel(row.words)}${
                          row.wasWords != null
                            ? ` (was ${wordLabel(row.wasWords)})`
                            : ""
                        }`
                      : "waiting for its first check"}
                </span>
              </span>
              <span
                className={cn(
                  "shrink-0 rounded-full border px-1.5 py-px text-[8px]",
                  row.changedAt
                    ? "border-amber-300/40 text-amber-200"
                    : "border-white/15 text-muted-foreground",
                )}
              >
                {row.error
                  ? "unreachable"
                  : row.changedAt
                    ? `changed ${sinceLabel(row.changedAt)}`
                    : row.checks
                      ? "unchanged"
                      : "not read"}
              </span>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Read the page again"
                onClick={() => void check(row)}
                disabled={busy !== null}
                className="shrink-0 text-muted-foreground hover:text-foreground"
              >
                <RefreshCw className="size-3" />
              </Button>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Forget this page"
                onClick={() =>
                  setRows((prev) => prev.filter((entry) => entry.url !== row.url))
                }
                className="shrink-0 text-muted-foreground hover:text-foreground"
              >
                <Trash2 className="size-3" />
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-[9px] leading-4 text-muted-foreground">
          Nothing watched yet. Open a page and press Watch this page: the perch
          reads it now, and reading it again later is what tells you it changed.
        </p>
      )}
    </Box>
  );
}

/* ------------------------------------------------------ 4 · the site probe */

type SiteReport = FunctionReturnType<typeof api.crawl.probe>;

function probeText(report: Extract<SiteReport, { ok: true }>) {
  const lines = [
    `Probe of ${report.finalUrl}`,
    `HTTP ${report.status} in ${msLabel(report.ms)} · ${report.contentType} · ${readableSize(report.bytes)}`,
    report.redirected ? "The address redirected before it answered." : "",
    "",
    "Headers",
    ...report.headers.map((header) => `  ${header.name}: ${header.value}`),
    "",
    "Document",
    `  title: ${report.document.title}`,
    `  description: ${report.document.description || "—"}`,
    `  canonical: ${report.document.canonical || "—"}`,
    `  language: ${report.document.language || "—"}`,
    `  headings ${report.document.headings} · links ${report.document.links} · images ${report.document.images} · forms ${report.document.forms} · scripts ${report.document.scripts}`,
    report.robots
      ? `\nrobots.txt: HTTP ${report.robots.status} (${report.robots.bytes} bytes)\n${report.robots.rules.map((rule) => `  ${rule}`).join("\n")}`
      : "\nrobots.txt: none reached",
    report.sitemap
      ? `\nsitemap.xml: HTTP ${report.sitemap.status} · ${report.sitemap.urls} addresses`
      : "\nsitemap.xml: none reached",
  ];
  return lines.filter((line) => line !== "").join("\n");
}

/**
 * What a server says about itself, before anybody reads the page: the status and
 * how long it took, the headers it sent back, what the document declares, and
 * whether it keeps a `robots.txt` and a `sitemap.xml` for the bots that come by.
 * This is the one view of the web a reader never sees, and the one that says
 * whether a page is worth reading at all.
 */
function ProbeBox({
  url,
  onOpen,
}: {
  url: string;
  onOpen: (url: string) => void;
}) {
  const probe = useAction(api.crawl.probe);
  // Seeded with the page in front of you, then the person's own address: a
  // probe looks at a server, and that choice should not move under them.
  const [target, setTarget] = useState(url);
  const [report, setReport] = useState<SiteReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [allHeaders, setAllHeaders] = useState(false);

  const run = async () => {
    const asked = target.trim();
    if (!asked || busy) return;
    setBusy(true);
    setReport(null);
    try {
      const answer = await probe({ url: asked });
      setReport(answer);
      if (!answer.ok) toast.error(answer.error);
    } catch (caught) {
      toast.error(
        caught instanceof Error ? caught.message : "The probe did not complete.",
      );
    } finally {
      setBusy(false);
    }
  };

  const answer = report?.ok ? report : null;

  return (
    <Box
      icon={Server}
      title="Probe the server"
      note="Asks the address for everything but the page: the status, the timing, the headers, what the document claims about itself, and whether a robots.txt or sitemap is kept for bots."
      right={
        busy ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        ) : null
      }
    >
      <div className="flex items-center gap-1.5">
        <Input
          value={target}
          onChange={(event) => setTarget(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void run();
          }}
          placeholder="https://example.com"
          aria-label="The address to probe"
          data-spell="off"
          className="h-7 text-[10px]"
        />
        <Button
          type="button"
          size="sm"
          disabled={busy || !target.trim()}
          onClick={() => void run()}
          className="h-7 shrink-0 cursor-pointer rounded-lg text-[10px]"
        >
          <Crosshair className="size-3" />
          Probe
        </Button>
      </div>

      {url && url !== target ? (
        <button
          type="button"
          onClick={() => setTarget(url)}
          className="w-fit cursor-pointer text-[9px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          use the page on screen: {hostLabel(url)}
        </button>
      ) : null}

      {answer ? (
        <div className="flex flex-col gap-2">
          <p className="flex flex-wrap items-center gap-1.5 text-[10px]">
            <span
              className={cn(
                "rounded-full border px-1.5 py-px text-[9px]",
                answer.status >= 400
                  ? "border-amber-300/40 text-amber-200"
                  : "border-emerald-300/40 text-emerald-200",
              )}
            >
              HTTP {answer.status}
            </span>
            <span className="text-muted-foreground">
              {msLabel(answer.ms)} · {readableSize(answer.bytes)} ·{" "}
              {answer.contentType.split(";")[0]}
            </span>
            {answer.redirected ? (
              <span className="text-[9px] text-muted-foreground">
                (redirected to {hostLabel(answer.finalUrl)})
              </span>
            ) : null}
          </p>

          <div className="flex flex-col gap-0.5 rounded-xl border border-border/50 bg-background/40 p-1.5">
            <Fact label="title" value={answer.document.title || "—"} />
            <Fact label="description" value={answer.document.description || "—"} />
            <Fact
              label="canonical"
              value={answer.document.canonical || "—"}
              mono={Boolean(answer.document.canonical)}
            />
            <Fact label="language" value={answer.document.language || "—"} />
            <Fact
              label="document"
              value={`${answer.document.headings} headings · ${answer.document.links} links · ${answer.document.images} images · ${answer.document.scripts} scripts · ${answer.document.forms} forms`}
            />
            {answer.document.openGraph.length ? (
              <Fact
                label="open graph"
                value={answer.document.openGraph.join(" · ")}
              />
            ) : null}
          </div>

          <div className="flex flex-col gap-0.5">
            <span className="text-[9px] tracking-[0.14em] text-muted-foreground uppercase">
              Headers ({answer.headers.length})
            </span>
            <div className="flex flex-col gap-0.5">
              {(allHeaders ? answer.headers : answer.headers.slice(0, 6)).map(
                (header) => (
                  <Fact
                    key={header.name}
                    label={header.name}
                    value={header.value}
                    mono
                  />
                ),
              )}
            </div>
            {answer.headers.length > 6 ? (
              <button
                type="button"
                onClick={() => setAllHeaders((value) => !value)}
                className="w-fit cursor-pointer text-[9px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
              >
                {allHeaders
                  ? "show fewer"
                  : `show the other ${answer.headers.length - 6}`}
              </button>
            ) : null}
          </div>

          <div className="flex flex-col gap-0.5">
            <span className="flex items-center gap-1 text-[9px] tracking-[0.14em] text-muted-foreground uppercase">
              <Server className="size-2.5" />
              For the bots
            </span>
            <Fact
              label="robots.txt"
              value={
                answer.robots
                  ? `HTTP ${answer.robots.status} · ${answer.robots.rules.length} rules`
                  : "not reachable"
              }
            />
            {answer.robots?.rules.length ? (
              <div className="flex flex-wrap gap-1">
                {answer.robots.rules.slice(0, 6).map((rule) => (
                  <span
                    key={rule}
                    className="rounded-full border border-white/15 px-1.5 py-px font-mono text-[8px] text-muted-foreground"
                  >
                    {rule}
                  </span>
                ))}
              </div>
            ) : null}
            <Fact
              label="sitemap.xml"
              value={
                answer.sitemap
                  ? answer.sitemap.ok
                    ? `${answer.sitemap.urls} address${answer.sitemap.urls === 1 ? "" : "es"}`
                    : `HTTP ${answer.sitemap.status}`
                  : "not reachable"
              }
            />
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void copyText(probeText(answer), "Probe report copied.")}
              className="h-7 cursor-pointer rounded-lg text-[10px]"
            >
              <Copy className="size-3" />
              Copy report
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() =>
                downloadText(`probe-${hostLabel(answer.finalUrl)}`, probeText(answer))
                  ? toast.success("Probe report saved.")
                  : toast("There was nothing to save.")
              }
              className="h-7 cursor-pointer rounded-lg text-[10px]"
            >
              <Download className="size-3" />
              Save report
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => onOpen(new URL("/robots.txt", answer.finalUrl).href)}
              className="h-7 cursor-pointer rounded-lg text-[10px]"
            >
              <Link2 className="size-3" />
              Open robots.txt
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-[9px] leading-4 text-muted-foreground">
          {report && !report.ok ? report.error : "Nothing probed yet."}
        </p>
      )}
    </Box>
  );
}

/* ------------------------------------------------- 5 · the deep reader bot */

type BriefRow = {
  url: string;
  title: string;
  source: string;
  words: number;
  passages: string[];
  error?: string;
};

function briefText(query: string, rows: BriefRow[]) {
  const lines = [`Brief for “${query}”`, ""];
  for (const row of rows) {
    lines.push(`## ${row.title}`);
    lines.push(row.url);
    if (row.error) lines.push(`   (not read: ${row.error})`);
    for (const passage of row.passages) lines.push(`   — ${passage}`);
    if (!row.error && !row.passages.length) {
      lines.push("   (read, but no line carried those words)");
    }
    lines.push(`   (${wordLabel(row.words)} read · ${row.source})`, "");
  }
  return lines.join("\n");
}

/**
 * The reader that goes past the result list: it asks the hub's own search, then
 * opens the best pages it found and keeps the lines that carry the words asked
 * for. No model is involved and nothing is summarised — the lines are the
 * pages' own, so the brief can be checked against them.
 */
function BriefBox({
  query,
  onOpen,
}: {
  query: string;
  onOpen: (url: string) => void;
}) {
  const search = useAction(api.search.web);
  const fetchPage = useAction(api.browser.fetchPage);
  // Seeded with the words the browser is working with, and left to the person
  // after that: a read is aimed at what they want read, not at whatever the bar
  // happens to hold a moment later.
  const [words, setWords] = useState(query);
  const [rows, setRows] = useState<BriefRow[]>([]);
  const [asked, setAsked] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");

  const run = async () => {
    const text = words.trim();
    if (!text || busy) return;
    setBusy(true);
    setRows([]);
    setAsked(text);
    setProgress("asking the hub's own sources…");

    let found: SearchRow[] = [];
    try {
      const answer = await search({
        query: text,
        category: "all",
        sort: "relevance",
        range: "any",
        shelf: "all",
      });
      if (!answer.ok) {
        toast.error(answer.error);
        setProgress("");
        setBusy(false);
        return;
      }
      found = answer.results.slice(0, 5);
    } catch (caught) {
      toast.error(
        caught instanceof Error ? caught.message : "That search did not complete.",
      );
      setProgress("");
      setBusy(false);
      return;
    }

    const terms = text
      .toLowerCase()
      .split(/\s+/)
      .filter((term) => term.length > 2)
      .slice(0, 6);

    const brief: BriefRow[] = [];
    for (const [index, row] of found.entries()) {
      setProgress(
        `reading ${index + 1} of ${found.length} — ${hostLabel(row.url)}`,
      );
      try {
        const page = await fetchPage({ url: row.url });
        brief.push(
          page.ok
            ? {
                url: page.finalUrl,
                title: page.title || row.title,
                source: row.source,
                words: countWords(page.text),
                passages: passages(page.text, terms),
              }
            : {
                url: row.url,
                title: row.title,
                source: row.source,
                words: 0,
                passages: [],
                error: page.error,
              },
        );
      } catch (caught) {
        brief.push({
          url: row.url,
          title: row.title,
          source: row.source,
          words: 0,
          passages: [],
          error:
            caught instanceof Error ? caught.message : "the page could not be read",
        });
      }
      setRows([...brief]);
    }

    setProgress("");
    setBusy(false);
    const read = brief.filter((row) => !row.error).length;
    toast.success(
      `Read ${read} of ${found.length} page${found.length === 1 ? "" : "s"}${
        read !== found.length ? ` (${found.length - read} would not open)` : ""
      }.`,
    );
  };

  return (
    <Box
      icon={ScanSearch}
      title="Read it properly"
      note="The result list is one line each. This opens the five best pages the hub's search finds and keeps the lines that carry your words — the pages' own sentences, nothing invented between them."
      right={
        busy ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        ) : null
      }
    >
      <div className="flex items-center gap-1.5">
        <Input
          value={words}
          onChange={(event) => setWords(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void run();
          }}
          placeholder="the words to read about"
          aria-label="What to read about"
          data-spell="off"
          className="h-7 text-[10px]"
        />
        <Button
          type="button"
          size="sm"
          disabled={busy || !words.trim()}
          onClick={() => void run()}
          className="h-7 shrink-0 cursor-pointer rounded-lg text-[10px]"
        >
          <Search className="size-3" />
          Read the top five
        </Button>
      </div>

      {query && query !== words ? (
        <button
          type="button"
          onClick={() => setWords(query)}
          className="w-fit cursor-pointer text-left text-[9px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          use the words in the bar: “{query}”
        </button>
      ) : null}

      {progress ? (
        <p className="flex items-center gap-1.5 text-[9px] text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          {progress}
        </p>
      ) : null}

      {rows.length ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex max-h-60 flex-col gap-1.5 overflow-y-auto pr-0.5">
            {rows.map((row) => (
              <div
                key={row.url}
                className="rounded-lg border border-border/50 px-2 py-1.5"
              >
                <button
                  type="button"
                  onClick={() => onOpen(row.url)}
                  title={row.url}
                  className="min-w-0 cursor-pointer text-left text-[10px] font-medium underline-offset-2 hover:underline"
                >
                  {row.title}
                </button>
                <span className="block truncate text-[8px] text-muted-foreground">
                  {hostLabel(row.url)} · {row.source}
                  {row.error
                    ? ` · not read: ${row.error}`
                    : ` · ${wordLabel(row.words)} read · ${row.passages.length} line${row.passages.length === 1 ? "" : "s"} kept`}
                </span>
                {row.passages.map((passage, index) => (
                  <span
                    key={`${row.url}-${index}`}
                    className="mt-1 block border-l border-white/20 pl-2 text-[10px] leading-4 text-foreground/85"
                  >
                    {passage}
                  </span>
                ))}
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() =>
                void copyText(briefText(asked, rows), "Brief copied.")
              }
              className="h-7 cursor-pointer rounded-lg text-[10px]"
            >
              <Copy className="size-3" />
              Copy the brief
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() =>
                downloadText(`brief-${asked.slice(0, 40)}`, briefText(asked, rows))
                  ? toast.success("Brief saved.")
                  : toast("There was nothing to save.")
              }
              className="h-7 cursor-pointer rounded-lg text-[10px]"
            >
              <Download className="size-3" />
              Save the brief
            </Button>
            <span className="text-[9px] text-muted-foreground">
              Read from the live pages just now — nothing here is cached.
            </span>
          </div>
        </div>
      ) : !progress ? (
        <p className="text-[9px] leading-4 text-muted-foreground">
          Nothing read yet. Words in the bar above work here too: press the
          button and five pages are opened and read for you.
        </p>
      ) : null}
    </Box>
  );
}

/* ------------------------------------------------ 6 · the survey (scout) bot */

type ScoutRun = {
  category: SearchCategory;
  rows: number;
  ms: number;
  note: string;
  error?: string;
};

/**
 * The survey bot: one question, asked of several of the hub's searches at once,
 * one after another, with each shelf's answer counted as it arrives. This is how
 * a person finds out which shelf actually holds what they are after — searching
 * "all" and getting ten rows of one kind tells you nothing about where the rest
 * was.
 */
function ScoutBox({
  query,
  prefs,
  onOpen,
}: {
  query: string;
  prefs: SearchPrefs;
  onOpen: (url: string) => void;
}) {
  const search = useAction(api.search.web);
  const [words, setWords] = useState(query);
  const [chosen, setChosen] = useState<SearchCategory[]>([
    "all",
    "news",
    "images",
    "more",
    "tools",
  ]);
  const [runs, setRuns] = useState<ScoutRun[]>([]);
  const [merged, setMerged] = useState<SearchRow[]>([]);
  const [busy, setBusy] = useState(false);

  const toggle = (category: SearchCategory) =>
    setChosen((prev) =>
      prev.includes(category)
        ? prev.filter((entry) => entry !== category)
        : [...prev, category],
    );

  const run = async () => {
    const text = words.trim();
    if (!text || busy || !chosen.length) return;
    setBusy(true);
    setRuns([]);
    setMerged([]);

    const found: SearchRow[] = [];
    const seen = new Set<string>();
    const tally: ScoutRun[] = [];

    for (const category of chosen) {
      const started = performance.now();
      let rows: SearchRow[] = [];
      let note = "";
      let error: string | undefined;
      try {
        const answer = await search({
          query: text,
          category,
          sort: prefs.sort,
          range: prefs.range,
          shelf: "all",
          site: prefs.site.trim() || undefined,
          exact: prefs.exact.trim() || undefined,
          exclude: prefs.exclude.trim() || undefined,
          filetype: prefs.filetype.trim() || undefined,
        });
        if (answer.ok) {
          rows = answer.results;
          note = answer.note;
        } else {
          error = answer.error;
        }
      } catch (caught) {
        error =
          caught instanceof Error ? caught.message : "that ask did not complete";
      }
      tally.push({
        category,
        rows: rows.length,
        ms: Math.round(performance.now() - started),
        note,
        error,
      });
      setRuns([...tally]);
      for (const row of rows) {
        if (seen.has(row.url)) continue;
        seen.add(row.url);
        found.push(row);
      }
      setMerged(found.slice(0, 48));
    }

    setBusy(false);
    const empty = tally.filter((entry) => !entry.rows).length;
    toast.success(
      `Asked ${tally.length} ${tally.length === 1 ? "search" : "searches"} — ${seen.size} distinct addresses${empty ? `, ${empty} with nothing` : ""}.`,
    );
  };

  return (
    <Box
      icon={Radar}
      title="Survey bot"
      note="One question, several shelves, counted as each answers. It says which shelf held what — and which came back empty — instead of mixing everything into one list."
      right={
        busy ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        ) : null
      }
    >
      <div className="flex items-center gap-1.5">
        <Input
          value={words}
          onChange={(event) => setWords(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void run();
          }}
          placeholder="what to survey"
          aria-label="What to survey"
          data-spell="off"
          className="h-7 text-[10px]"
        />
        <Button
          type="button"
          size="sm"
          disabled={busy || !words.trim() || !chosen.length}
          onClick={() => void run()}
          className="h-7 shrink-0 cursor-pointer rounded-lg text-[10px]"
        >
          <Radar className="size-3" />
          {busy ? "Asking…" : "Survey"}
        </Button>
      </div>

      {query && query !== words ? (
        <button
          type="button"
          onClick={() => setWords(query)}
          className="w-fit cursor-pointer text-left text-[9px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          use the words in the bar: “{query}”
        </button>
      ) : null}

      <div className="flex flex-wrap gap-1">
        {CATEGORY_TABS.map(({ id, label, icon: Icon }) => (
          <Chip
            key={id}
            active={chosen.includes(id)}
            onClick={() => toggle(id)}
            title={`Ask ${label.toLowerCase()} too`}
          >
            <Icon className="size-3" />
            {label}
          </Chip>
        ))}
      </div>

      {runs.length ? (
        <div className="flex flex-wrap gap-1">
          {runs.map((entry) => (
            <span
              key={entry.category}
              title={entry.error ?? entry.note}
              className={cn(
                "flex items-center gap-1 rounded-full border px-1.5 py-px text-[9px]",
                entry.error
                  ? "border-red-400/40 text-red-300"
                  : entry.rows
                    ? "border-white/20 text-foreground/90"
                    : "border-white/10 text-muted-foreground",
              )}
            >
              {entry.error ? (
                <AlertTriangle className="size-2.5" />
              ) : entry.rows ? (
                <CheckCircle2 className="size-2.5" />
              ) : (
                <X className="size-2.5" />
              )}
              {entry.category === "all" ? "all" : entry.category.replace("-", " ")}
              {" · "}
              {entry.error ? "failed" : `${entry.rows} rows`}
              {" · "}
              {msLabel(entry.ms)}
            </span>
          ))}
        </div>
      ) : null}

      {merged.length ? (
        <div className="flex max-h-44 flex-col gap-1 overflow-y-auto pr-0.5">
          {merged.slice(0, 24).map((row, index) => (
            <button
              key={`${row.url}-${index}`}
              type="button"
              onClick={() => onOpen(row.url)}
              title={row.url}
              className="cursor-pointer rounded-lg border border-border/50 px-1.5 py-1 text-left transition-colors hover:bg-white/5"
            >
              <span className="block truncate text-[10px]">{row.title}</span>
              <span className="block truncate text-[8px] text-muted-foreground">
                {row.source} · {hostLabel(row.url)}
              </span>
            </button>
          ))}
          {merged.length > 24 ? (
            <span className="text-[9px] text-muted-foreground">
              …and {merged.length - 24} more distinct addresses, kept in the
              survey's own list.
            </span>
          ) : null}
        </div>
      ) : (
        <p className="text-[9px] leading-4 text-muted-foreground">
          Press Survey and each chosen search is asked in turn — the counts
          appear as they arrive, so a slow shelf never hides the rest.
        </p>
      )}
    </Box>
  );
}

/* -------------------------------------------------------- 7 · the shelves */

/**
 * The shelves behind More: the hub's open sources, one at a time. Pointing a
 * search at a shelf changes what answers, not just how it is listed — "books" is
 * Open Library asked alone, so nothing else can pad the answer out.
 */
function ShelfBox({
  query,
  prefs,
  onSearch,
}: {
  query: string;
  prefs: SearchPrefs;
  onSearch: (query: string, prefs: SearchPrefs) => void;
}) {
  const run = (shelf: SearchShelf) => {
    if (!query.trim()) {
      toast("Search for something first — the shelf is asked the words in the bar.");
      return;
    }
    onSearch(query, { ...prefs, shelf });
  };

  return (
    <Box
      icon={Layers}
      title="Point at one shelf"
      note="Every one of these is a keyless source the hub asks directly. Pick a shelf and the same words are asked of it alone — that is what makes a narrow search narrow."
      right={
        prefs.shelf !== "all" ? (
          <span className="shrink-0 rounded-full border border-white/20 px-1.5 py-px text-[8px] text-muted-foreground">
            {shelfLabel(prefs.shelf)}
          </span>
        ) : null
      }
    >
      <div className="flex flex-wrap gap-1">
        <Chip
          active={prefs.shelf === "all"}
          onClick={() => run("all")}
          title="Ask the whole category again"
        >
          Every shelf
        </Chip>
        {SHELF_CHOICES.map(({ id, label, icon: Icon, what }) => (
          <Chip
            key={id}
            active={prefs.shelf === id}
            onClick={() => run(id)}
            title={what}
          >
            <Icon className="size-3" />
            {label}
          </Chip>
        ))}
      </div>
      <p className="text-[9px] leading-4 text-muted-foreground">
        {prefs.shelf === "all"
          ? "Nothing chosen, so the category above decides: All search asks every open source the hub has."
          : `${shelfLabel(prefs.shelf)} alone is being asked. Choose Every shelf to let the category answer again.`}
      </p>
    </Box>
  );
}

/* -------------------------------------------------------- 8 · the history */

/**
 * Where the searches have been. Every question the browser runs is kept here —
 * on this device, and only the words and the refinements, never a result — so
 * yesterday's narrowing can be pressed again instead of retyped.
 */
function HistoryBox({
  history,
  onRun,
  onClear,
}: {
  history: SearchHistoryEntry[];
  onRun: (entry: SearchHistoryEntry) => void;
  onClear: () => void;
}) {
  return (
    <Box
      icon={Search}
      title="Where your searches have been"
      note="The last questions asked of the hub's own search, with the refinements they were asked with. Kept on this device; press one to ask it again."
      right={
        history.length ? (
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Forget the search history"
            title="Forget the search history"
            onClick={onClear}
            className="shrink-0 text-muted-foreground hover:text-foreground"
          >
            <Trash2 className="size-3" />
          </Button>
        ) : null
      }
    >
      {history.length ? (
        <div className="flex max-h-44 flex-col gap-1 overflow-y-auto pr-0.5">
          {history.map((entry, index) => {
            const bits = [
              entry.prefs.shelf !== "all" ? shelfLabel(entry.prefs.shelf) : "",
              entry.prefs.category !== "all"
                ? CATEGORY_TABS.find((tab) => tab.id === entry.prefs.category)
                    ?.label ?? ""
                : "",
              ...narrowing(entry.prefs),
            ].filter(Boolean);
            return (
              <button
                key={`${entry.query}-${index}`}
                type="button"
                onClick={() => onRun(entry)}
                title={`Ask again: ${entry.query}`}
                className="cursor-pointer rounded-lg border border-border/50 px-1.5 py-1 text-left transition-colors hover:bg-white/5"
              >
                <span className="block truncate text-[10px]">{entry.query}</span>
                <span className="block truncate text-[8px] text-muted-foreground">
                  {bits.length ? `${bits.join(" · ")} · ` : ""}
                  {entry.rows} row{entry.rows === 1 ? "" : "s"} ·{" "}
                  {sinceLabel(entry.at)}
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <p className="text-[9px] leading-4 text-muted-foreground">
          Nothing yet. Once a search runs, the words and the refinements it ran
          with wait here to be asked again.
        </p>
      )}
    </Box>
  );
}

/* ------------------------------------------------------------- the toolbox */

export type BrowserToolsProps = {
  panel: "tools" | "more";
  /** The words the browser is working with: the running search, or the bar. */
  query: string;
  prefs: SearchPrefs;
  url: string;
  title: string;
  history: SearchHistoryEntry[];
  onPrefs: (patch: Partial<SearchPrefs>) => void;
  onSearch: (query: string, prefs: SearchPrefs) => void;
  onOpen: (url: string) => void;
  onClearHistory: () => void;
  onClose: () => void;
};

/**
 * The boxes a person opens under the search bar. Which ones appear is decided by
 * whether they pressed Tools or More; the boxes themselves are the components
 * above, each owning its own work and its own results.
 */
export function BrowserTools({
  panel,
  query,
  prefs,
  url,
  title,
  history,
  onPrefs,
  onSearch,
  onOpen,
  onClearHistory,
  onClose,
}: BrowserToolsProps) {
  const boxes =
    panel === "tools" ? (
      <>
        {/*
          Keyed by the narrowing itself: when the browser's narrowing changes
          for any other reason — a history entry pressed, a shelf chosen — the
          box is rebuilt around the new one instead of an effect rewriting the
          fields somebody may be typing in.
        */}
        <NarrowBox
          key={`${prefs.site}|${prefs.exact}|${prefs.exclude}|${prefs.filetype}`}
          query={query}
          prefs={prefs}
          onPrefs={onPrefs}
          onSearch={onSearch}
        />
        <BriefBox query={query} onOpen={onOpen} />
        <CrawlBox url={url} onOpen={onOpen} />
        <ProbeBox url={url} onOpen={onOpen} />
        <PerchBox url={url} title={title} />
        <ScoutBox query={query} prefs={prefs} onOpen={onOpen} />
      </>
    ) : (
      <>
        <ShelfBox query={query} prefs={prefs} onSearch={onSearch} />
        <ScoutBox query={query} prefs={prefs} onOpen={onOpen} />
        <HistoryBox
          history={history}
          onRun={(entry) => onSearch(entry.query, entry.prefs)}
          onClear={onClearHistory}
        />
      </>
    );

  return (
    <section
      id={panel === "tools" ? "browser-tools" : "browser-more"}
      className="shrink-0 scroll-mt-4 rounded-2xl border border-white/25 bg-card/40 p-2"
    >
      <header className="flex items-start gap-2 pb-2">
        <span className="grid size-6 shrink-0 place-items-center rounded-lg bg-white/10 text-white">
          {panel === "tools" ? (
            <Wrench className="size-3.5" />
          ) : (
            <Layers className="size-3.5" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold tracking-tight">
            {panel === "tools"
              ? "The browser's toolbox"
              : "More shelves, and more ways to ask"}
          </p>
          <p className="text-[9px] leading-4 text-muted-foreground">
            {panel === "tools"
              ? "Everything here does real work: on the page in front of you, on the address in the bar, or on the words you last searched. Nothing is fetched until you press something."
              : "The hub's other shelves one at a time or surveyed together, and the questions this browser has already asked."}
          </p>
        </div>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Close these boxes"
          title="Close"
          onClick={onClose}
          className="shrink-0 text-muted-foreground hover:text-foreground"
        >
          <X className="size-3.5" />
        </Button>
      </header>

      <div className="grid max-h-[46vh] gap-2 overflow-y-auto pr-0.5 md:grid-cols-2 xl:grid-cols-3">
        {boxes}
      </div>
    </section>
  );
}
