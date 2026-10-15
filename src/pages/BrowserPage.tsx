import { BrowserTools } from "@/components/browser/BrowserTools";
import { Button } from "@/components/ui/button";
import { api } from "@/convex/_generated/api";
import {
  CATEGORY_TABS,
  DEFAULT_PREFS,
  HISTORY_KEY,
  MAX_MARKS,
  RANGE_CHOICES,
  SORT_CHOICES,
  categoryLabel,
  durationLabel,
  loadHistory,
  narrowing,
  rangeLabel,
  rememberSearch,
  searchArgs,
  shelfLabel,
  sizeLabel,
  sortLabel,
  splitMatches,
  whenLabel,
  type SearchHistoryEntry,
  type SearchPrefs,
  type SearchRange,
  type SearchRow,
  type SearchSort,
} from "@/lib/browser-search";
import { cn } from "@/lib/utils";
import type { FunctionReturnType } from "convex/server";
import { useAction, useMutation, useQuery } from "convex/react";
import {
  ArrowDownWideNarrow,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Bookmark,
  BookmarkCheck,
  ChevronDown,
  ChevronUp,
  Clock,
  Copy,
  Download,
  Ellipsis,
  ExternalLink,
  FolderDown,
  Globe,
  Home,
  Image as ImageIcon,
  Loader2,
  MonitorPlay,
  Plus,
  RefreshCw,
  Ruler,
  Search,
  Star,
  Tag,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { toast } from "sonner";

type PageResult = FunctionReturnType<typeof api.browser.fetchPage>;
type DownloadRow = FunctionReturnType<typeof api.browser.downloads>[number];
type BookmarkRow = FunctionReturnType<typeof api.browser.bookmarks>[number];

/** A query's answer, drawn in place of a page while it is being looked up. */
type SearchState = {
  query: string;
  /** The options this answer was asked with, so the strip can show them. */
  prefs: SearchPrefs;
  results: SearchRow[];
  note: string;
  loading: boolean;
  error: string | null;
};

type Tab = {
  id: string;
  /** The address this tab is showing. Empty is the browser's own home. */
  url: string;
  input: string;
  result: PageResult | null;
  /** A search this tab ran, when it is showing results rather than a page. */
  search: SearchState | null;
  loading: boolean;
  /** The addresses this tab has visited, and where in them it stands. */
  history: string[];
  index: number;
};

const STORE_KEY = "browser:tabs:v1";

/** The refinements as the hub understood them, so the strip shows what ran. */
function landedPrefs(
  asked: SearchPrefs,
  answer: Extract<FunctionReturnType<typeof api.search.web>, { ok: true }>,
): SearchPrefs {
  return {
    ...asked,
    category: answer.category,
    sort: answer.sort,
    range: answer.range,
    shelf: answer.shelf,
    site: answer.filters.site ?? "",
    exact: answer.filters.exact ?? "",
    exclude: answer.filters.exclude ?? "",
    filetype: answer.filters.filetype ?? "",
  };
}

function newTab(url = ""): Tab {
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    url,
    input: url,
    result: null,
    search: null,
    loading: false,
    history: url ? [url] : [],
    index: url ? 0 : -1,
  };
}

/**
 * Whether what was typed is an address rather than something to search for.
 *
 * A bare word (or a sentence) is a query; a scheme, or something shaped like a
 * hostname, is an address. The two are kept apart here because they end in two
 * different places — an address is fetched, a query is answered by the hub
 * itself rather than handed off to somebody else's search page.
 */
function looksLikeUrl(input: string): boolean {
  const text = input.trim();
  if (!text) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return true;
  return /^[\w-]+(?:\.[\w-]+)+(?:[/:?#]|$)/.test(text);
}

/** The address to fetch, once it is known to be one. */
function toUrl(input: string): string {
  const text = input.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text;
  return `https://${text}`;
}

function loadTabs(): Tab[] {
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { urls?: string[]; active?: number };
      const urls = (parsed.urls ?? []).filter(
        (entry) => typeof entry === "string",
      );
      if (urls.length) {
        const tabs = urls.map((url) => newTab(url));
        const active = Math.min(
          Math.max(parsed.active ?? 0, 0),
          tabs.length - 1,
        );
        return [tabs[active], ...tabs.filter((_, index) => index !== active)];
      }
    }
  } catch {
    /* a browser with no saved tabs opens on its home */
  }
  return [newTab()];
}

export default function BrowserPage() {
  const pageRef = useRef<HTMLDivElement | null>(null);

  const fetchPage = useAction(api.browser.fetchPage);
  const searchWeb = useAction(api.search.web);
  const startDownload = useAction(api.browser.startDownload);
  const addBookmark = useMutation(api.browser.addBookmark);
  const removeBookmark = useMutation(api.browser.removeBookmark);
  const removeDownload = useMutation(api.browser.removeDownload);

  const saved = useQuery(api.browser.bookmarks);
  const downloads = useQuery(api.browser.downloads);

  const [tabs, setTabs] = useState<Tab[]>(() => loadTabs());
  const [activeId, setActiveId] = useState<string>(() => tabs[0].id);
  /**
   * What is open beside the page: the two lists that have always been here —
   * saved pages, downloads — and the two boxes the browser's own tools live in.
   * Pressing Tools or More opens theirs; either can be closed again from its
   * own header.
   */
  const [panel, setPanel] = useState<
    "none" | "saved" | "downloads" | "tools" | "more"
  >("none");
  const [live, setLive] = useState(false);
  const [busy, setBusy] = useState(false);
  /** The questions already asked here, newest first, kept on this device. */
  const [history, setHistory] = useState<SearchHistoryEntry[]>(() =>
    loadHistory(),
  );
  /** The words being looked for in the page on screen, and which one is on. */
  const [find, setFind] = useState("");
  const [currentMatch, setCurrentMatch] = useState(0);
  const booted = useRef(false);

  // How the next search will be asked: the category, the order it comes back
  // in, and how far back it may reach. One setting for the whole browser, the
  // way a search bar keeps its own — change it and the results on screen are
  // asked again with it.
  const [prefs, setPrefs] = useState<SearchPrefs>(DEFAULT_PREFS);

  const tabsRef = useRef(tabs);
  const prefsRef = useRef(prefs);
  // The refs are kept in step in an effect rather than during a render: a ref
  // written mid-render is a value React cannot reason about.
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);
  useEffect(() => {
    prefsRef.current = prefs;
  }, [prefs]);

  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[0];
  const currentUrl = active.history[active.index] ?? "";

  /* --------------------------------------------------------------- loading */

  const load = useCallback(
    async (tabId: string, url: string) => {
      if (!url) {
        setTabs((prev) =>
          prev.map((tab) =>
            tab.id === tabId ? { ...tab, loading: false, result: null } : tab,
          ),
        );
        return;
      }
      setTabs((prev) =>
        prev.map((tab) => (tab.id === tabId ? { ...tab, loading: true } : tab)),
      );
      let result: PageResult;
      try {
        result = await fetchPage({ url });
      } catch (error) {
        result = {
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : "The page could not be fetched.",
        };
      }
      setTabs((prev) =>
        prev.map((tab) =>
          tab.id === tabId ? { ...tab, loading: false, result } : tab,
        ),
      );
    },
    [fetchPage],
  );

  /**
   * Answer a query from the hub's own search, in this tab.
   *
   * This is what makes the browser its own: nothing typed here is bounced out
   * to a third-party search page. The rows come back from `search.ts`, which
   * reads the same sources the assistant does, and each one opens here like any
   * other link.
   *
   * The category and the refinements travel with the query, so the same words
   * can be asked of Images or News, listed newest or cheapest first, and held
   * to the past week — all of it answered here.
   */
  const runSearch = useCallback(
    async (tabId: string, query: string, options?: SearchPrefs) => {
      const asked = options ?? prefsRef.current;
      setTabs((prev) =>
        prev.map((tab) =>
          tab.id === tabId
            ? {
                ...tab,
                url: "",
                input: query,
                result: null,
                loading: false,
                history: [],
                index: -1,
                search: {
                  query,
                  prefs: asked,
                  results: [],
                  note: "",
                  loading: true,
                  error: null,
                },
              }
            : tab,
        ),
      );

      try {
        const answer = await searchWeb(searchArgs(query, asked));
        if (answer.ok) {
          // Remember the question and the refinements it was asked with, so it
          // can be pressed again later rather than retyped.
          setHistory((prev) =>
            rememberSearch(prev, {
              query,
              prefs: landedPrefs(asked, answer),
              rows: answer.results.length,
              at: Date.now(),
            }),
          );
        }
        setTabs((prev) =>
          prev.map((tab) => {
            if (tab.id !== tabId || !tab.search) return tab;
            if (!answer.ok) {
              return {
                ...tab,
                search: { ...tab.search, loading: false, error: answer.error },
              };
            }
            return {
              ...tab,
              search: {
                ...tab.search,
                loading: false,
                prefs: landedPrefs(tab.search.prefs, answer),
                results: answer.results,
                note: answer.note,
              },
            };
          }),
        );
      } catch (error) {
        setTabs((prev) =>
          prev.map((tab) =>
            tab.id === tabId && tab.search
              ? {
                  ...tab,
                  search: {
                    ...tab.search,
                    loading: false,
                    error:
                      error instanceof Error
                        ? error.message
                        : "The search did not complete.",
                  },
                }
              : tab,
          ),
        );
      }
    },
    [searchWeb],
  );

  /**
   * Change how the search is asked — another category, another order, a window
   * — and ask the query again when its results are the thing on screen.
   */
  const refine = useCallback(
    (patch: Partial<SearchPrefs>) => {
      const current = active.search ? active.search.prefs : prefs;
      const next = { ...current, ...patch };
      setPrefs(next);

      // More and Tools are categories the hub answers out of a box, so choosing
      // one opens its box; choosing any other category closes the boxes again.
      if (patch.category === "tools") setPanel("tools");
      else if (patch.category === "more") setPanel("more");
      else if (patch.category) {
        setPanel((open) =>
          open === "tools" || open === "more" ? "none" : open,
        );
      }

      if (active.search) void runSearch(active.id, active.search.query, next);
    },
    [active, prefs, runSearch],
  );

  /** Ask again from somewhere else — the history, a shelf, a tool's own box. */
  const searchNow = useCallback(
    (query: string, next: SearchPrefs) => {
      setPrefs(next);
      void runSearch(active.id, query, next);
    },
    [active.id, runSearch],
  );

  const open = useCallback(
    (input: string) => {
      const text = input.trim();

      // Cleared: the browser's own start page comes back.
      if (!text) {
        setTabs((prev) =>
          prev.map((tab) =>
            tab.id === active.id
              ? {
                  ...tab,
                  url: "",
                  input: "",
                  result: null,
                  search: null,
                  loading: false,
                  history: [],
                  index: -1,
                }
              : tab,
          ),
        );
        return;
      }

      // Not an address, so it is a query — answered here, not redirected away.
      if (!looksLikeUrl(text)) {
        void runSearch(active.id, text);
        return;
      }

      const target = toUrl(text);
      setTabs((prev) =>
        prev.map((tab) => {
          if (tab.id !== active.id) return tab;
          const history = [...tab.history.slice(0, tab.index + 1), target];
          return {
            ...tab,
            url: target,
            input: target,
            result: null,
            search: null,
            loading: Boolean(target),
            history,
            index: history.length - 1,
          };
        }),
      );
      void load(active.id, target);
    },
    [active.id, load, runSearch],
  );

  const step = useCallback(
    (delta: number) => {
      const tab = tabsRef.current.find((entry) => entry.id === active.id);
      if (!tab) return;
      const index = tab.index + delta;
      if (index < 0 || index >= tab.history.length) return;
      const url = tab.history[index];
      setTabs((prev) =>
        prev.map((entry) =>
          entry.id === tab.id
            ? {
                ...entry,
                index,
                url,
                input: url,
                result: null,
                loading: Boolean(url),
              }
            : entry,
        ),
      );
      void load(tab.id, url);
    },
    [active.id, load],
  );

  // A restored tab needs its page fetched once, when the page first opens.
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    const first = tabsRef.current.find((tab) => tab.id === active.id);
    if (first && first.url) void load(first.id, first.url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Remember the open tabs on this device, so the browser opens where it was.
  useEffect(() => {
    try {
      window.localStorage.setItem(
        STORE_KEY,
        JSON.stringify({
          urls: tabs.map((tab) => tab.url),
          active: tabs.findIndex((tab) => tab.id === activeId),
        }),
      );
    } catch {
      /* a browser that refuses storage still browses this session */
    }
  }, [tabs, activeId]);

  // The questions already asked, for the same reason and on the same device.
  useEffect(() => {
    try {
      window.localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    } catch {
      /* a browser that refuses storage still keeps this session's history */
    }
  }, [history]);

  // What the boxes under the bar work on: the words being searched for, or the
  // last ones this browser asked — never the address of a page, which is not a
  // question and would be searched for as one.
  const boxQuery = active.search
    ? active.search.query
    : (history[0]?.query ?? "");

  const pageText = active.result?.ok ? active.result.text : "";
  const found = useMemo(
    () => splitMatches(pageText, find),
    [pageText, find],
  );

  // Follow the match being moved through, so pressing the arrows goes somewhere.
  useEffect(() => {
    if (!find.trim() || !found.matches) return;
    const node = document.getElementById(`find-${currentMatch}`);
    node?.scrollIntoView({ block: "center" });
  }, [currentMatch, find, found.matches]);

  // A new page means a new find: the words were for the page that is gone.
  useEffect(() => {
    setFind("");
    setCurrentMatch(0);
  }, [active.result]);

  /* --------------------------------------------------------------- actions */

  const addTab = useCallback(
    (url = "") => {
      const tab = newTab(url);
      setTabs((prev) => [...prev, tab]);
      setActiveId(tab.id);
      if (url) void load(tab.id, url);
    },
    [load],
  );

  const closeTab = useCallback(
    (id: string) => {
      setTabs((prev) => {
        if (prev.length === 1) return [newTab()];
        const next = prev.filter((tab) => tab.id !== id);
        if (id === activeId) setActiveId(next[0].id);
        return next;
      });
    },
    [activeId],
  );

  const isSaved = Boolean(
    saved?.some((row: BookmarkRow) => row.url === currentUrl) && currentUrl,
  );

  const toggleBookmark = useCallback(async () => {
    if (!currentUrl) return;
    if (!saved) return;
    const existing = saved.find((row: BookmarkRow) => row.url === currentUrl);
    try {
      if (existing) {
        await removeBookmark({ id: existing._id });
        toast.success("Removed from saved pages.");
      } else {
        const title = active.result?.ok ? active.result.title : currentUrl;
        await addBookmark({ url: currentUrl, title });
        toast.success("Saved. It is here on every device.");
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "That did not save.",
      );
    }
  }, [active.result, addBookmark, currentUrl, removeBookmark, saved]);

  const download = useCallback(async () => {
    if (!currentUrl) return;
    setBusy(true);
    try {
      const result = await startDownload({ url: currentUrl });
      if (result.ok) toast.success(`Saved ${result.name}.`);
      else toast.error(result.error);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "The download failed.",
      );
    } finally {
      setBusy(false);
    }
  }, [currentUrl, startDownload]);

  const copyText = useCallback(async (text: string, what = "Copied.") => {
    const value = String(text ?? "");
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      toast.success(what);
    } catch {
      toast.error("The browser would not let that be copied.");
    }
  }, []);

  const copyLink = useCallback(async () => {
    if (!currentUrl) return;
    await copyText(currentUrl, "Link copied.");
  }, [copyText, currentUrl]);

  const copyPage = useCallback(async () => {
    const selected = window.getSelection?.()?.toString() ?? "";
    const text = selected || (active.result?.ok ? active.result.text : "");
    await copyText(
      text.slice(0, 100000),
      selected ? "Selection copied." : "Page text copied.",
    );
  }, [active.result, copyText]);

  const selectAllPage = useCallback(() => {
    const node = pageRef.current?.querySelector("article") ?? pageRef.current;
    const selection = window.getSelection();
    if (!node || !selection) return;
    const range = document.createRange();
    range.selectNodeContents(node);
    selection.removeAllRanges();
    selection.addRange(range);
  }, []);

  const pasteAddress = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        setTabs((prev) =>
          prev.map((tab) =>
            tab.id === active.id ? { ...tab, input: text } : tab,
          ),
        );
        toast.success("Pasted into the address bar.");
      }
    } catch {
      toast.error("The browser would not let the clipboard be read.");
    }
  }, [active.id]);

  const deletePage = useCallback(async () => {
    const existing = saved?.find((row: BookmarkRow) => row.url === currentUrl);
    if (existing) {
      try {
        await removeBookmark({ id: existing._id });
      } catch {
        /* already gone */
      }
    }
    open("");
    toast.success(existing ? "Removed from saved pages." : "Closed the page.");
  }, [currentUrl, open, removeBookmark, saved]);

  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    items: { label: string; onClick: () => void; danger?: boolean }[];
  } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Keep the menu on screen. It is placed at the point that was pressed, and on
  // a phone that point is often close enough to the edge that part of the menu
  // — including the item last in the list — would sit outside the window with
  // no way to reach it. Every menu in this app is nudged the same way.
  useLayoutEffect(() => {
    const node = menuRef.current;
    if (!menu || !node) return;
    const rect = node.getBoundingClientRect();
    const left = Math.min(menu.x, window.innerWidth - rect.width - 8);
    const top = Math.min(menu.y, window.innerHeight - rect.height - 8);
    node.style.left = `${Math.max(8, left)}px`;
    node.style.top = `${Math.max(8, top)}px`;
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [menu]);

  /** The right-click menu: the same standard actions every browser offers. */
  const onPageContextMenu = useCallback(
    (event: ReactMouseEvent) => {
      const target = event.target as HTMLElement | null;
      const anchor = target?.closest("a") ?? null;
      const image = target?.closest("img") ?? null;
      const selected = window.getSelection?.()?.toString() ?? "";
      const items: { label: string; onClick: () => void; danger?: boolean }[] =
        [];
      if (selected)
        items.push({
          label: "Copy",
          onClick: () => void copyText(selected, "Copied."),
        });
      items.push({ label: "Copy page text", onClick: () => void copyPage() });
      items.push({ label: "Select all", onClick: selectAllPage });
      items.push({
        label: "Paste into the address",
        onClick: () => void pasteAddress(),
      });
      if (anchor) {
        const href = anchor.getAttribute("href") ?? "";
        if (href) {
          items.push({ label: "Open link", onClick: () => open(href) });
          items.push({
            label: "Copy link address",
            onClick: () => void copyText(href, "Link copied."),
          });
        }
      } else if (currentUrl) {
        items.push({
          label: "Copy page address",
          onClick: () => void copyText(currentUrl, "Link copied."),
        });
      }
      if (image) {
        const src = image.getAttribute("src") ?? "";
        if (src)
          items.push({
            label: "Copy image address",
            onClick: () => void copyText(src, "Image address copied."),
          });
      }
      if (currentUrl) {
        items.push({
          label: isSaved ? "Delete from saved" : "Delete this page",
          onClick: () => void deletePage(),
          danger: true,
        });
      }
      event.preventDefault();
      if (!items.length) return;
      setMenu({ x: event.clientX, y: event.clientY, items });
    },
    [
      copyPage,
      copyText,
      currentUrl,
      deletePage,
      isSaved,
      open,
      pasteAddress,
      selectAllPage,
    ],
  );

  const submit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      open(active.input);
    },
    [active.input, open],
  );

  /* ------------------------------------------------------------------ view */

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      {/* tabs */}
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveId(tab.id)}
            className={cn(
              "group/tab flex min-w-0 max-w-[190px] shrink-0 items-center gap-1.5 rounded-t-lg border border-b-0 px-2 py-1 text-[10px] transition-colors",
              tab.id === activeId
                ? "border-border/70 bg-card/70 text-foreground"
                : "border-transparent text-muted-foreground hover:bg-white/5",
            )}
          >
            <Globe className="size-3 shrink-0" />
            <span className="min-w-0 truncate">
              {tab.result?.ok ? tab.result.title : tab.url || "Home"}
            </span>
            {tabs.length > 1 ? (
              <span
                role="button"
                tabIndex={0}
                aria-label="Close tab"
                onClick={(event) => {
                  event.stopPropagation();
                  closeTab(tab.id);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") closeTab(tab.id);
                }}
                className="shrink-0 text-muted-foreground hover:text-foreground"
              >
                <X className="size-2.5" />
              </span>
            ) : null}
          </button>
        ))}
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="New tab"
          onClick={() => addTab()}
          className="shrink-0 text-muted-foreground hover:text-foreground"
        >
          <Plus className="size-3.5" />
        </Button>
      </div>

      {/* toolbar */}
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 rounded-xl border border-border/70 bg-card/70 px-2 py-1.5">
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Back"
          disabled={active.index <= 0}
          onClick={() => step(-1)}
          className="text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Forward"
          disabled={active.index >= active.history.length - 1}
          onClick={() => step(1)}
          className="text-muted-foreground hover:text-foreground"
        >
          <ArrowRight className="size-3.5" />
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Reload"
          onClick={() =>
            currentUrl ? void load(active.id, currentUrl) : undefined
          }
          className="text-muted-foreground hover:text-foreground"
        >
          {active.loading ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Home"
          onClick={() => open("")}
          className="text-muted-foreground hover:text-foreground"
        >
          <Home className="size-3.5" />
        </Button>

        <form
          onSubmit={submit}
          className="flex min-w-[180px] flex-1 items-center gap-1.5"
        >
          <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-border/60 bg-background/60 px-2">
            <Search className="size-3 shrink-0 text-muted-foreground" />
            <input
              value={active.input}
              onChange={(event) =>
                setTabs((prev) =>
                  prev.map((tab) =>
                    tab.id === active.id
                      ? { ...tab, input: event.target.value }
                      : tab,
                  ),
                )
              }
              placeholder="Search the hub, or type an address"
              className="h-7 min-w-0 flex-1 bg-transparent text-[11px] outline-none placeholder:text-muted-foreground"
              data-spell="off"
              spellCheck={false}
            />
          </div>
          <Button
            type="submit"
            size="sm"
            className="h-7 cursor-pointer rounded-lg text-[10px]"
          >
            Go
          </Button>
        </form>

        <div className="flex items-center gap-1">
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={isSaved ? "Forget this page" : "Save this page"}
            title={isSaved ? "Forget this page" : "Save this page"}
            onClick={() => void toggleBookmark()}
            className="text-muted-foreground hover:text-foreground"
          >
            {isSaved ? (
              <BookmarkCheck className="size-3.5" />
            ) : (
              <Bookmark className="size-3.5" />
            )}
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Download this page's file"
            title="Download to your files"
            disabled={!currentUrl || busy}
            onClick={() => void download()}
            className="text-muted-foreground hover:text-foreground"
          >
            {busy ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Download className="size-3.5" />
            )}
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Saved pages"
            title="Saved pages"
            onClick={() => setPanel(panel === "saved" ? "none" : "saved")}
            className={cn(
              "text-muted-foreground hover:text-foreground",
              panel === "saved" && "bg-white/10 text-foreground",
            )}
          >
            <Star className="size-3.5" />
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Downloads"
            title="Downloads"
            onClick={() =>
              setPanel(panel === "downloads" ? "none" : "downloads")
            }
            className={cn(
              "text-muted-foreground hover:text-foreground",
              panel === "downloads" && "bg-white/10 text-foreground",
            )}
          >
            <FolderDown className="size-3.5" />
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Show the page as text"
            title="Read the page as text"
            onClick={() => setLive((value) => !value)}
            className={cn(
              "text-muted-foreground hover:text-foreground",
              live && "bg-white/10 text-foreground",
            )}
          >
            {live ? (
              <MonitorPlay className="size-3.5" />
            ) : (
              <BookOpen className="size-3.5" />
            )}
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Copy link"
            title="Copy the address"
            disabled={!currentUrl}
            onClick={() => void copyLink()}
            className="text-muted-foreground hover:text-foreground"
          >
            <Copy className="size-3.5" />
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Open outside the hub"
            title="Open in a full browser tab (the site's own scripts run there)"
            disabled={!currentUrl}
            onClick={() =>
              window.open(currentUrl, "_blank", "noopener,noreferrer")
            }
            className="text-muted-foreground hover:text-foreground"
          >
            <ExternalLink className="size-3.5" />
          </Button>
          <span className="mx-0.5 h-4 w-px shrink-0 bg-border/70" />
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Tools"
            title="Tools — narrow a search, crawl a site, watch a page, probe a server, read the best pages"
            onClick={() =>
              setPanel((open) => (open === "tools" ? "none" : "tools"))
            }
            className={cn(
              "text-muted-foreground hover:text-foreground",
              panel === "tools" && "bg-white/10 text-foreground",
            )}
          >
            <Wrench className="size-3.5" />
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="More"
            title="More — the hub's other shelves, and where your searches have been"
            onClick={() =>
              setPanel((open) => (open === "more" ? "none" : "more"))
            }
            className={cn(
              "text-muted-foreground hover:text-foreground",
              panel === "more" && "bg-white/10 text-foreground",
            )}
          >
            <Ellipsis className="size-3.5" />
          </Button>
        </div>
      </div>

      {/*
        The browser's own boxes: the toolbox, and the shelves behind More. They
        sit between the bar and the page, the way a browser's panels do, and they
        take only the height they need — the page keeps the rest, scrolled as
        ever.
      */}
      {panel === "tools" || panel === "more" ? (
        <BrowserTools
          panel={panel}
          query={boxQuery}
          prefs={active.search ? active.search.prefs : prefs}
          url={currentUrl}
          title={active.result?.ok ? active.result.title : currentUrl}
          history={history}
          onPrefs={refine}
          onSearch={searchNow}
          onOpen={open}
          onClearHistory={() => {
            setHistory([]);
            toast.success("The questions this browser had kept are gone.");
          }}
          onClose={() => setPanel("none")}
        />
      ) : null}

      {/*
        The search's own options, right under the bar: what to search and how
        to list it. They belong to the search, so they are here while a search
        is — on the browser's home, and over the results themselves.
      */}
      {active.search || !currentUrl ? (
        <SearchOptions
          value={active.search ? active.search.prefs : prefs}
          busy={active.search?.loading ?? false}
          onChange={refine}
        />
      ) : null}

      {/*
        The page and its side panel. Side by side when there is room, stacked
        when there is not: the panel used to be a fixed 300px column beside the
        page whatever the width, which on a phone left the page itself about
        40px wide. Below `lg` the panel now sits under the page at full width —
        the app's own `aside` rules cap its height and give it its own scroll.
      */}
      <div className="flex min-h-0 flex-1 flex-col gap-2 lg:flex-row">
        {/* the page */}
        <div
          ref={pageRef}
          onContextMenu={onPageContextMenu}
          className="min-h-0 min-w-0 flex-1 overflow-y-auto rounded-xl border border-border/70 bg-card/40 p-3"
        >
          {active.search ? (
            <SearchResults search={active.search} onOpen={open} />
          ) : active.loading ? (
            <div className="flex h-full items-center justify-center gap-2 text-[11px] text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Fetching {active.input || currentUrl}…
            </div>
          ) : !currentUrl ? (
            <BrowserHome onOpen={open} />
          ) : live ? (
            <div className="flex h-full min-h-[320px] flex-col gap-2">
              <p className="text-[10px] text-muted-foreground">
                Live view. Many sites refuse to be shown inside another app, so
                this one may stay blank — the reader has it either way.
              </p>
              <iframe
                title={currentUrl}
                src={currentUrl}
                referrerPolicy="no-referrer"
                sandbox="allow-scripts allow-same-origin allow-forms"
                className="min-h-[300px] flex-1 rounded-lg border border-border/60 bg-white"
              />
            </div>
          ) : active.result?.ok && active.result.media ? (
            <MediaView
              media={active.result.media}
              title={active.result.title}
              url={active.result.finalUrl}
            />
          ) : active.result?.ok ? (
            <article className="flex flex-col gap-4">
              <header className="flex flex-col gap-1 border-b border-border/60 pb-3">
                <p className="text-[10px] text-muted-foreground">
                  {active.result.finalUrl} · HTTP {active.result.status} ·{" "}
                  {Math.round(active.result.bytes / 1024)} KB
                </p>
                <h1 className="text-lg leading-tight font-semibold">
                  {active.result.title}
                </h1>

                {/*
                  Find on this page: the words are marked where they fall and
                  the arrows walk from one mark to the next, which is what the
                  reader of a long page actually needs — the address bar looks
                  for pages, this looks inside the one on screen.
                */}
                {active.result.text ? (
                  <div className="flex flex-wrap items-center gap-1.5 pt-1">
                    <div className="flex items-center gap-1 rounded-lg border border-border/60 bg-background/60 px-2">
                      <Search className="size-3 shrink-0 text-muted-foreground" />
                      <input
                        value={find}
                        onChange={(event) => {
                          setFind(event.target.value);
                          setCurrentMatch(0);
                        }}
                        placeholder="Find on this page"
                        aria-label="Find on this page"
                        data-spell="off"
                        spellCheck={false}
                        className="h-6 w-40 bg-transparent text-[10px] outline-none placeholder:text-muted-foreground"
                      />
                      {find.trim() ? (
                        <span
                          className={cn(
                            "shrink-0 text-[9px]",
                            found.matches
                              ? "text-muted-foreground"
                              : "text-amber-200",
                          )}
                        >
                          {found.matches
                            ? `${Math.min(currentMatch + 1, found.matches)} of ${found.matches}`
                            : "nowhere on this page"}
                        </span>
                      ) : null}
                    </div>
                    {found.matches > 1 ? (
                      <>
                        <Button
                          type="button"
                          size="icon-sm"
                          variant="ghost"
                          aria-label="Previous match"
                          title="Previous match"
                          onClick={() =>
                            setCurrentMatch(
                              (value) =>
                                (value - 1 + found.matches) % found.matches,
                            )
                          }
                          className="text-muted-foreground hover:text-foreground"
                        >
                          <ChevronUp className="size-3.5" />
                        </Button>
                        <Button
                          type="button"
                          size="icon-sm"
                          variant="ghost"
                          aria-label="Next match"
                          title="Next match"
                          onClick={() =>
                            setCurrentMatch(
                              (value) => (value + 1) % found.matches,
                            )
                          }
                          className="text-muted-foreground hover:text-foreground"
                        >
                          <ChevronDown className="size-3.5" />
                        </Button>
                      </>
                    ) : null}
                    {found.matches > MAX_MARKS ? (
                      <span className="text-[9px] text-muted-foreground">
                        the first {MAX_MARKS} are marked
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </header>

              {active.result.text ? (
                <p className="max-w-[70ch] text-[12px] leading-5 whitespace-pre-wrap text-foreground/90">
                  {find.trim()
                    ? found.parts.map((part, index) =>
                        part.hit === null ? (
                          <span key={index}>{part.text}</span>
                        ) : (
                          <mark
                            key={index}
                            id={`find-${part.hit}`}
                            className={cn(
                              "rounded text-black",
                              part.hit === currentMatch
                                ? "bg-amber-300"
                                : "bg-amber-200/60",
                            )}
                          >
                            {part.text}
                          </mark>
                        ),
                      )
                    : active.result.text}
                </p>
              ) : (
                <p className="text-[11px] text-muted-foreground">
                  This page had no readable text.
                </p>
              )}

              {active.result.links.length ? (
                <section className="flex flex-col gap-2">
                  <h2 className="text-[10px] tracking-[0.14em] text-muted-foreground uppercase">
                    Links on this page
                  </h2>
                  <div className="flex flex-col gap-1">
                    {active.result.links.slice(0, 120).map((link, index) => (
                      <button
                        key={`${link.href}-${index}`}
                        type="button"
                        onClick={() => open(link.href)}
                        className="cursor-pointer truncate rounded-lg border border-border/50 px-2 py-1 text-left text-[11px] transition-colors hover:bg-white/5"
                        title={link.href}
                      >
                        {link.text}
                      </button>
                    ))}
                  </div>
                </section>
              ) : null}
            </article>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="rounded-lg border border-dashed border-border/70 px-3 py-2 text-[11px] text-muted-foreground">
                {active.result?.ok === false
                  ? active.result.error
                  : "That page could not be opened."}
              </p>
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  currentUrl ? void load(active.id, currentUrl) : undefined
                }
                className="h-8 w-fit cursor-pointer rounded-lg text-[11px]"
              >
                <RefreshCw className="size-3" />
                Try again
              </Button>
            </div>
          )}
        </div>

        {/*
          the side panel.

          Full width under the page below `lg`, and deliberately no width
          utility above it: the `aside` rules in `src/index.css` are unlayered,
          so they own this element's width (13.25rem) and its scroll on a wide
          screen, and a utility here would be silently overridden.
        */}
        {panel !== "none" ? (
          <aside className="flex w-full shrink-0 flex-col gap-2 overflow-y-auto rounded-xl border border-border/70 bg-card/60 p-2.5">
            {panel === "saved" ? (
              <SavedPanel
                saved={saved}
                onOpen={(url) => open(url)}
                onRemove={(id) => void removeBookmark({ id })}
              />
            ) : (
              <DownloadsPanel
                downloads={downloads}
                onRemove={(id) => void removeDownload({ id })}
              />
            )}
          </aside>
        ) : null}
      </div>

      {menu ? (
        <div
          ref={menuRef}
          className="fixed z-50 min-w-[190px] max-w-[calc(100vw-1rem)] overflow-hidden rounded-lg border border-border/70 bg-popover p-1 shadow-2xl"
          style={{ left: menu.x, top: menu.y }}
          onContextMenu={(event) => event.preventDefault()}
        >
          {menu.items.map((item, index) => (
            <button
              key={`${item.label}-${index}`}
              type="button"
              onClick={() => {
                setMenu(null);
                item.onClick();
              }}
              className={cn(
                "block w-full cursor-pointer rounded-md px-2.5 py-1.5 text-left text-[11px] transition-colors hover:bg-white/10",
                item.danger && "text-red-400",
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------------- media --- */

/**
 * A picture, a sound, a film or a PDF, shown as itself. The app hands the
 * address to the element and the element streams it, so a long film plays
 * without the hub ever holding its bytes.
 */
function MediaView({
  media,
  title,
  url,
}: {
  media: { kind: "image" | "audio" | "video" | "pdf"; url: string };
  title: string;
  url: string;
}) {
  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-lg leading-tight font-semibold">{title}</h1>

      {media.kind === "image" ? (
        <img
          src={media.url}
          alt={title}
          className="max-h-[70vh] w-fit rounded-lg border border-border/60 object-contain"
        />
      ) : media.kind === "audio" ? (
        <audio src={media.url} controls className="w-full" />
      ) : media.kind === "video" ? (
        <video
          src={media.url}
          controls
          className="max-h-[70vh] w-full rounded-lg border border-border/60 bg-black"
        />
      ) : (
        <iframe
          title={title}
          src={media.url}
          className="h-[70vh] w-full rounded-lg border border-border/60 bg-white"
        />
      )}

      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="w-fit text-[10px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
      >
        Open the original
      </a>
    </div>
  );
}

/* ------------------------------------------------------------- the search */

/**
 * The categories and refinements, in one strip under the search bar.
 *
 * A category decides which of the hub's sources is asked — files from Wikimedia
 * Commons for Images, the shops' own pages for Shopping, a live feed for News,
 * OpenStreetMap for Maps. The two lists decide the answer's shape: the order the
 * rows come back in, and how far back a source is allowed to reach.
 */
function SearchOptions({
  value,
  busy,
  onChange,
}: {
  value: SearchPrefs;
  busy: boolean;
  onChange: (patch: Partial<SearchPrefs>) => void;
}) {
  return (
    <div className="flex shrink-0 flex-col gap-1.5 rounded-xl border border-border/70 bg-card/50 px-2 py-1.5">
      <div className="flex flex-wrap items-center gap-1">
        <span className="mr-0.5 flex items-center gap-1 pr-1 text-[9px] tracking-[0.14em] text-muted-foreground uppercase">
          <Search className="size-3" />
          {busy ? "Searching" : "Search"}
        </span>
        {CATEGORY_TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            aria-pressed={value.category === id}
            onClick={() => onChange({ category: id })}
            title={`Ask the hub's own sources for ${label.toLowerCase()}`}
            className={cn(
              "flex cursor-pointer items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] transition-colors",
              value.category === id
                ? "border-white/25 bg-white/12 text-foreground"
                : "border-transparent text-muted-foreground hover:border-white/15 hover:bg-white/5 hover:text-foreground",
            )}
          >
            <Icon className="size-3" />
            {label}
          </button>
        ))}
        {busy ? (
          <Loader2 className="size-3 animate-spin text-muted-foreground" />
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1 text-[9px] text-muted-foreground">
          <ArrowDownWideNarrow className="size-3" />
          List by
          <select
            value={value.sort}
            onChange={(event) =>
              onChange({ sort: event.target.value as SearchSort })
            }
            title="The order the rows come back in"
            className="cursor-pointer rounded-lg border border-border/60 bg-background/60 px-1.5 py-0.5 text-[10px] text-foreground outline-none"
          >
            {SORT_CHOICES.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-1 text-[9px] text-muted-foreground">
          <Clock className="size-3" />
          Dated
          <select
            value={value.range}
            onChange={(event) =>
              onChange({ range: event.target.value as SearchRange })
            }
            title="How far back a source may reach"
            className="cursor-pointer rounded-lg border border-border/60 bg-background/60 px-1.5 py-0.5 text-[10px] text-foreground outline-none"
          >
            {RANGE_CHOICES.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>

        <span
          title="Every row is fetched by the hub from its own sources. A date, a size or a price is shown only where that source gave one — nothing is invented to fill a column."
          className="flex items-center gap-1 text-[9px] text-muted-foreground"
        >
          <Ruler className="size-3" />
          <Tag className="size-3" />
          Dates, sizes and prices as the sources give them
        </span>
      </div>
    </div>
  );
}

/**
 * A query's answer, drawn the way a results page is — except every row was
 * fetched and shaped by the hub itself, and every row opens in this browser.
 */
function SearchResults({
  search,
  onOpen,
}: {
  search: SearchState;
  onOpen: (url: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <header className="flex flex-col gap-1 border-b border-border/60 pb-3">
        <p className="text-[10px] text-muted-foreground">
          SUGAR search · {search.query}
        </p>
        <h1 className="text-lg leading-tight font-semibold">
          Results for “{search.query}”
        </h1>
        <p className="flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
          <span className="rounded-full border border-white/15 px-1.5 py-px">
            {categoryLabel(search.prefs.category)}
          </span>
          <span className="rounded-full border border-white/15 px-1.5 py-px">
            {sortLabel(search.prefs.sort)}
          </span>
          <span className="rounded-full border border-white/15 px-1.5 py-px">
            {rangeLabel(search.prefs.range)}
          </span>
          {search.prefs.shelf !== "all" ? (
            <span className="rounded-full border border-white/30 px-1.5 py-px text-foreground/90">
              {shelfLabel(search.prefs.shelf)} only
            </span>
          ) : null}
          {narrowing(search.prefs).map((line) => (
            <span
              key={line}
              className="rounded-full border border-white/30 px-1.5 py-px text-foreground/90"
            >
              {line}
            </span>
          ))}
          {!search.loading && !search.error ? (
            <span>
              {search.results.length} row
              {search.results.length === 1 ? "" : "s"}, fetched by the hub
            </span>
          ) : null}
        </p>
        {search.note ? (
          <p className="max-w-[70ch] text-[10px] leading-4 text-muted-foreground">
            {search.note}
          </p>
        ) : null}
      </header>

      {search.loading ? (
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Searching the hub's own sources…
        </div>
      ) : search.error ? (
        <p className="rounded-lg border border-dashed border-border/70 px-3 py-2 text-[11px] leading-4 text-muted-foreground">
          {search.error}
        </p>
      ) : search.prefs.category === "images" ? (
        /* pictures are shown as pictures, each one opening here as itself */
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {search.results.map((row, index) => (
            <button
              key={`${row.url}-${index}`}
              type="button"
              onClick={() => onOpen(row.url)}
              title={row.url}
              className="flex cursor-pointer flex-col gap-1 rounded-xl border border-border/50 p-1.5 text-left transition-colors hover:border-white/25 hover:bg-white/[0.06]"
            >
              <Thumb url={row.url} title={row.title} />
              <span className="truncate text-[10px] font-medium">
                {row.title}
              </span>
              <span className="truncate text-[9px] text-muted-foreground">
                {row.source}
              </span>
              <RowMeta row={row} />
            </button>
          ))}
        </div>
      ) : (
        <ol className="flex flex-col gap-1">
          {search.results.map((row, index) => (
            <li
              key={`${row.url}-${index}`}
              className="flex flex-col gap-0.5 rounded-xl border border-border/50 p-2.5 transition-colors hover:bg-white/5"
            >
              <button
                type="button"
                onClick={() => onOpen(row.url)}
                className="cursor-pointer text-left text-[12px] font-medium underline-offset-2 hover:underline"
              >
                {row.title}
              </button>
              <span className="truncate text-[9px] text-muted-foreground">
                {row.source} · {row.url}
              </span>
              {row.snippet ? (
                <span className="text-[11px] leading-4 text-muted-foreground">
                  {row.snippet}
                </span>
              ) : null}
              <RowMeta row={row} />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/**
 * What a source said about a row — when it was dated, how big the file is, how
 * long the film runs, what it costs. A chip appears only where the source gave
 * the number; nothing is invented to fill the row out.
 */
function RowMeta({ row }: { row: SearchRow }) {
  const hasMeta =
    Boolean(row.date) ||
    row.size != null ||
    row.duration != null ||
    Boolean(row.price);

  if (!hasMeta) return null;

  return (
    <span className="flex flex-wrap items-center gap-1.5 pt-0.5 text-[9px] text-muted-foreground">
      {row.date ? (
        <span className="flex items-center gap-0.5">
          <Clock className="size-2.5" />
          {whenLabel(row.date)}
        </span>
      ) : null}
      {row.size != null ? (
        <span className="flex items-center gap-0.5">
          <Ruler className="size-2.5" />
          {sizeLabel(row.size)}
        </span>
      ) : null}
      {row.duration != null ? (
        <span className="flex items-center gap-0.5">
          <MonitorPlay className="size-2.5" />
          {durationLabel(row.duration)}
        </span>
      ) : null}
      {row.price ? (
        <span className="flex items-center gap-0.5 font-medium text-foreground/80">
          <Tag className="size-2.5" />
          {row.price}
        </span>
      ) : null}
    </span>
  );
}

/** A picture in the grid, with something honest where the picture will not load. */
function Thumb({ url, title }: { url: string; title: string }) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <span className="flex h-24 w-full items-center justify-center rounded-lg border border-dashed border-border/60 bg-black/20 text-muted-foreground">
        <ImageIcon className="size-4" />
      </span>
    );
  }

  return (
    <img
      src={url}
      alt={title}
      loading="lazy"
      onError={() => setFailed(true)}
      className="h-24 w-full rounded-lg border border-border/50 bg-black/20 object-cover"
    />
  );
}

/* --------------------------------------------------------------- the home */

function BrowserHome({ onOpen }: { onOpen: (url: string) => void }) {
  const [query, setQuery] = useState("");
  return (
    <div className="flex flex-col gap-4">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const text = query.trim();
          if (text) onOpen(text);
        }}
        className="flex items-center gap-1.5"
      >
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-border/60 bg-background/60 px-3">
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search from the hub, or type an address"
            className="h-10 min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-muted-foreground"
            data-spell="off"
            spellCheck={false}
            autoFocus
          />
        </div>
        <Button
          type="submit"
          className="h-10 cursor-pointer rounded-xl text-[11px]"
        >
          Search
        </Button>
      </form>

      <header className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold">The hub's browser</h1>
        <p className="max-w-[70ch] text-[11px] leading-5 text-muted-foreground">
          Type an address above, or a question — a search is answered by the
          hub's own sources rather than sent to somebody else's search page.
          Pick a category under the bar and the same words are asked of that
          shelf instead: images, shopping, videos, news, maps, books and tools;
          list them by relevance, time, size or price to change the order they
          come back in. Save a page with the bookmark and keep a file with the
          download; both are here on every device.
        </p>
        <p className="max-w-[70ch] text-[11px] leading-5 text-muted-foreground">
          <span className="text-foreground/90">Tools</span> opens the
          browser's own toolbox: narrow a search to one site or one phrase, walk
          a site link by link with the crawl bot, keep watch on a page with the
          perch, ask a server what it is before reading it, or have the best
          pages an answer found read properly. <span className="text-foreground/90">More</span>{" "}
          opens the hub's other shelves — books, scanned texts, sound, datasets,
          software, code, packages — one at a time or surveyed together, beside
          the questions this browser has already asked.
        </p>
      </header>
    </div>
  );
}

/* --------------------------------------------------------------- the panels */

function SavedPanel({
  saved,
  onOpen,
  onRemove,
}: {
  saved: BookmarkRow[] | undefined;
  onOpen: (url: string) => void;
  onRemove: (id: BookmarkRow["_id"]) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-[10px] tracking-[0.14em] text-muted-foreground uppercase">
        Saved pages
      </h2>
      {saved?.length ? (
        saved.map((row) => (
          <div key={row._id} className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => onOpen(row.url)}
              className="min-w-0 flex-1 cursor-pointer text-left"
              title={row.url}
            >
              <span className="block truncate text-[11px]">{row.title}</span>
              <span className="block truncate text-[9px] text-muted-foreground">
                {row.url}
              </span>
            </button>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="Forget this page"
              onClick={() => onRemove(row._id)}
              className="shrink-0 text-muted-foreground hover:text-foreground"
            >
              <Trash2 className="size-3" />
            </Button>
          </div>
        ))
      ) : (
        <p className="text-[10px] text-muted-foreground">
          Nothing saved yet. The star keeps a page here, on every device.
        </p>
      )}
    </div>
  );
}

function DownloadsPanel({
  downloads,
  onRemove,
}: {
  downloads: DownloadRow[] | undefined;
  onRemove: (id: DownloadRow["_id"]) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-[10px] tracking-[0.14em] text-muted-foreground uppercase">
        Downloads
      </h2>
      {downloads?.length ? (
        downloads.map((row) => (
          <div key={row._id} className="flex items-center gap-1.5">
            <a
              href={row.href ?? "#"}
              target="_blank"
              rel="noopener noreferrer"
              className="min-w-0 flex-1"
              title={row.href ?? row.pageUrl}
            >
              <span className="block truncate text-[11px]">{row.name}</span>
              <span className="block truncate text-[9px] text-muted-foreground">
                {Math.round(row.bytes / 1024)} KB ·{" "}
                {new Date(row.at).toLocaleString()}
              </span>
            </a>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="Forget this download"
              onClick={() => onRemove(row._id)}
              className="shrink-0 text-muted-foreground hover:text-foreground"
            >
              <Trash2 className="size-3" />
            </Button>
          </div>
        ))
      ) : (
        <p className="text-[10px] text-muted-foreground">
          Nothing downloaded yet. The download button keeps a file here, in the
          hub, rather than in this browser's profile.
        </p>
      )}
    </div>
  );
}
