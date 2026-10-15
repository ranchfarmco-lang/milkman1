import {
  AppWindow,
  BookOpen,
  Clapperboard,
  Database,
  Ellipsis,
  Headphones,
  Image as ImageIcon,
  LayoutGrid,
  Library,
  Map as MapIcon,
  MessageSquare,
  Newspaper,
  Package,
  Search,
  ShoppingCart,
  Terminal,
  Video,
  Wrench,
  type LucideIcon,
} from "lucide-react";

/**
 * What the browser's search is made of, in one place.
 *
 * The page draws these and the browser's boxes (`BrowserTools`) ask with them,
 * so the categories, the refinements, the shelves and the narrowing are defined
 * once. It is also where the *labels* live rather than in either component,
 * because the same words appear on a chip, in a results header and in the
 * sentence the hub writes about where the rows came from.
 */

/** One row of an answer, exactly as the hub hands it over. */
export type SearchRow = {
  title: string;
  url: string;
  snippet: string;
  source: string;
  date?: string;
  size?: number;
  duration?: number;
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

/** One shelf of the hub's open sources, asked on its own. */
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
 * The narrowing every search page has: a site, a phrase, words to leave out,
 * a file kind. Empty means "not narrowed", never "narrow it to nothing".
 */
export type SearchPrefs = {
  category: SearchCategory;
  sort: SearchSort;
  range: SearchRange;
  shelf: SearchShelf;
  site: string;
  exact: string;
  exclude: string;
  filetype: string;
};

export const DEFAULT_PREFS: SearchPrefs = {
  category: "all",
  sort: "relevance",
  range: "any",
  shelf: "all",
  site: "",
  exact: "",
  exclude: "",
  filetype: "",
};

/** The strip under the search bar: what to search. */
export const CATEGORY_TABS: {
  id: SearchCategory;
  label: string;
  icon: LucideIcon;
  what: string;
}[] = [
  { id: "all", label: "All search", icon: Search, what: "every source the hub knows, at once" },
  { id: "images", label: "Images", icon: ImageIcon, what: "pictures, shown as pictures" },
  { id: "shopping", label: "Shopping", icon: ShoppingCart, what: "shops and their prices" },
  { id: "short-videos", label: "Short videos", icon: Clapperboard, what: "clips, shortest first" },
  { id: "videos", label: "Videos", icon: Video, what: "films and archive video" },
  { id: "news", label: "News", icon: Newspaper, what: "live feeds, dated" },
  { id: "maps", label: "Maps", icon: MapIcon, what: "places on OpenStreetMap" },
  {
    id: "more",
    label: "More",
    icon: Ellipsis,
    what: "the hub's other shelves — books, sound, datasets, software",
  },
  {
    id: "tools",
    label: "Tools",
    icon: Wrench,
    what: "the toolbox — narrow, crawl, watch, probe, read",
  },
];

export const SORT_CHOICES: { id: SearchSort; label: string }[] = [
  { id: "relevance", label: "Relevance" },
  { id: "time", label: "Newest first" },
  { id: "size", label: "Largest first" },
  { id: "price", label: "Cheapest first" },
];

export const RANGE_CHOICES: { id: SearchRange; label: string }[] = [
  { id: "any", label: "Any time" },
  { id: "day", label: "Past 24 hours" },
  { id: "week", label: "Past week" },
  { id: "month", label: "Past month" },
  { id: "year", label: "Past year" },
];

/**
 * The shelves behind "More": one source each, so a query can be pointed at the
 * books and get only books. The hub's open sources are what these are — no key
 * behind any of them.
 */
export const SHELF_CHOICES: {
  id: Exclude<SearchShelf, "all">;
  label: string;
  what: string;
  icon: LucideIcon;
}[] = [
  { id: "wiki", label: "Wikipedia", what: "the encyclopaedia, no key", icon: Library },
  { id: "books", label: "Open Library", what: "books, by title or author", icon: BookOpen },
  { id: "texts", label: "Archive books", what: "the Internet Archive's scanned texts", icon: BookOpen },
  { id: "audio", label: "Archive sound", what: "recordings and music", icon: Headphones },
  { id: "datasets", label: "Archive data", what: "datasets people published", icon: Database },
  { id: "software", label: "Archive software", what: "old programs, kept playable", icon: AppWindow },
  { id: "code", label: "Stack Overflow", what: "answers about code", icon: Terminal },
  { id: "discuss", label: "Hacker News", what: "what people are building", icon: MessageSquare },
  { id: "packages", label: "npm", what: "packages and their versions", icon: Package },
];

/** The shelves' own icons, for the places that draw a whole list of them. */
export const SHELF_ICONS: Record<SearchShelf, LucideIcon> = {
  all: LayoutGrid,
  wiki: Library,
  books: BookOpen,
  texts: BookOpen,
  audio: Headphones,
  datasets: Database,
  software: AppWindow,
  code: Terminal,
  discuss: MessageSquare,
  packages: Package,
};

export function categoryLabel(value: SearchCategory) {
  return CATEGORY_TABS.find((tab) => tab.id === value)?.label ?? "All search";
}

export function sortLabel(value: SearchSort) {
  return SORT_CHOICES.find((choice) => choice.id === value)?.label ?? "Relevance";
}

export function rangeLabel(value: SearchRange) {
  return RANGE_CHOICES.find((choice) => choice.id === value)?.label ?? "Any time";
}

export function shelfLabel(value: SearchShelf) {
  return SHELF_CHOICES.find((shelf) => shelf.id === value)?.label ?? "Every shelf";
}

/** A date a source gave, written the way a reader reads one. */
export function whenLabel(iso: string) {
  const stamp = Date.parse(iso);
  if (!Number.isFinite(stamp)) return iso;
  return new Date(stamp).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** How long ago something happened, in the words a person would use. */
export function sinceLabel(stamp: number, now = Date.now()) {
  if (!stamp) return "not yet";
  const seconds = Math.max(0, Math.round((now - stamp) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  return new Date(stamp).toLocaleDateString();
}

export function sizeLabel(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function durationLabel(seconds: number) {
  const whole = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return `${minutes}:${rest.toString().padStart(2, "0")}`;
}

/**
 * A question this browser has already asked, with the refinements it was asked
 * with. Kept on the device so yesterday's narrowing can be pressed again.
 */
export type SearchHistoryEntry = {
  query: string;
  prefs: SearchPrefs;
  rows: number;
  at: number;
};

/** A count of words, written the way a reader reads one. */
export function wordLabel(words: number) {
  if (words >= 1000) return `${(words / 1000).toFixed(1)}k words`;
  return `${words} word${words === 1 ? "" : "s"}`;
}

/** What the narrowing comes to, in one line — or nothing when it is empty. */
export function narrowing(prefs: SearchPrefs): string[] {
  return [
    prefs.site.trim() ? `only ${prefs.site.trim().replace(/^https?:\/\//, "")}` : "",
    prefs.exact.trim() ? `“${prefs.exact.trim()}” word for word` : "",
    prefs.exclude.trim() ? `without ${prefs.exclude.trim()}` : "",
    prefs.filetype.trim() ? `only .${prefs.filetype.trim().replace(/^\./, "")} files` : "",
  ].filter(Boolean);
}

/** Whether anything is narrowed at all. */
export function isNarrowed(prefs: SearchPrefs) {
  return narrowing(prefs).length > 0;
}

/**
 * The argument the hub's search is handed. Written once so the page and every
 * box ask the same way — a search from a box is the same search as one from the
 * address bar, with the same category, shelf and narrowing behind it.
 */
export function searchArgs(
  query: string,
  prefs: SearchPrefs,
): {
  query: string;
  category: SearchCategory;
  sort: SearchSort;
  range: SearchRange;
  shelf: SearchShelf;
  site?: string;
  exact?: string;
  exclude?: string;
  filetype?: string;
} {
  return {
    query,
    category: prefs.category,
    sort: prefs.sort,
    range: prefs.range,
    shelf: prefs.shelf,
    site: prefs.site.trim() || undefined,
    exact: prefs.exact.trim() || undefined,
    exclude: prefs.exclude.trim() || undefined,
    filetype: prefs.filetype.trim() || undefined,
  };
}

/**
 * Where a browser keeps the questions it has asked, and how many it keeps.
 * Only the words and the refinements — never a result — and on the device.
 */
export const HISTORY_KEY = "browser:searches:v1";
export const HISTORY_MAX = 24;

/** How many occurrences of a find mark the reader will draw in one page. */
export const MAX_MARKS = 400;

/** The questions this browser has already asked, as this device kept them. */
export function loadHistory(store?: Pick<Storage, "getItem">): SearchHistoryEntry[] {
  try {
    const raw = (store ?? window.localStorage).getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as SearchHistoryEntry[];
    return Array.isArray(parsed)
      ? parsed
          .filter((row) => typeof row?.query === "string" && Boolean(row.prefs))
          .slice(0, HISTORY_MAX)
      : [];
  } catch {
    return [];
  }
}

/** The newest question first, one entry per question and shelf, nothing longer. */
export function rememberSearch(
  prev: SearchHistoryEntry[],
  entry: SearchHistoryEntry,
): SearchHistoryEntry[] {
  const rest = prev.filter(
    (row) =>
      row.query.toLowerCase() !== entry.query.toLowerCase() ||
      row.prefs.category !== entry.prefs.category ||
      row.prefs.shelf !== entry.prefs.shelf,
  );
  return [entry, ...rest].slice(0, HISTORY_MAX);
}

/**
 * A piece of a page's text: `hit` is which occurrence of the words being looked
 * for this is, or null for the text between them.
 */
export type MatchPart = { text: string; hit: number | null };

/**
 * Where the words being looked for are in a page's text. Every occurrence up to
 * a ceiling is marked, and the ones past it are counted rather than drawn — a
 * page with four thousand matches would otherwise be four thousand elements.
 */
export function splitMatches(
  text: string,
  term: string,
): { parts: MatchPart[]; matches: number } {
  const needle = term.trim().toLowerCase();
  if (!needle) return { parts: [{ text, hit: null }], matches: 0 };

  const lower = text.toLowerCase();
  const parts: MatchPart[] = [];
  let index = 0;
  let matches = 0;

  while (matches < MAX_MARKS) {
    const found = lower.indexOf(needle, index);
    if (found === -1) break;
    if (found > index) parts.push({ text: text.slice(index, found), hit: null });
    parts.push({ text: text.slice(found, found + needle.length), hit: matches });
    index = found + needle.length;
    matches += 1;
  }

  const rest = text.slice(index);
  if (rest) parts.push({ text: rest, hit: null });
  return { parts, matches };
}

/** A clock-face label for a stretch of milliseconds, as a crawler reports it. */
export function msLabel(ms: number) {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}
