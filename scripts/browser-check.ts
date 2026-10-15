/**
 * The browser's search and its bots, walked rather than read.
 *
 * The browser page grew a toolbox, and every part of it rests on a promise that
 * fails quietly if it is wrong:
 *
 *   1. **the narrowing** — a search can be pointed at one site, one phrase, a
 *      set of words to leave out and a kind of file. A filter that silently
 *      empties the page, or one that reports success while dropping nothing,
 *      both leave somebody believing they searched something they did not.
 *   2. **one page is one address** — the crawler, the perch and the site probe
 *      all compare addresses and pages with each other. If a fragment or a
 *      trailing slash counted as a different page, a crawl would walk the same
 *      page four times and a perch would announce a change that never happened.
 *   3. **the wiring, in the source** — Tools and More have to open their boxes,
 *      the boxes have to reach the bots, and the bots have to keep the reader's
 *      own refusals (a session, an unlocked hub, nothing on this deployment's
 *      own network). Each of those is a sentence somebody can delete without
 *      noticing.
 *
 * The first two halves walk the real functions — the same ones the deployment
 * runs, imported from `convex/search.ts` and `convex/crawl.ts`. The last is a
 * source check on purpose, in the same spirit as `scripts/access-check.ts`:
 * "there is only one of this" is exactly the property an innocuous-looking edit
 * can quietly undo.
 *
 * Run with: bun scripts/browser-check.ts
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { crawlUrl, fingerprint } from "../src/convex/crawl";
import { narrowRows, operatorQuery, type SearchRow } from "../src/convex/search";
import {
  DEFAULT_PREFS,
  HISTORY_MAX,
  MAX_MARKS,
  isNarrowed,
  loadHistory,
  narrowing,
  rememberSearch,
  searchArgs,
  splitMatches,
  type SearchHistoryEntry,
} from "../src/lib/browser-search";

const ROOT = new URL("..", import.meta.url).pathname;

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

const read = (path: string) => readFile(join(ROOT, path), "utf8");

const row = (over: Partial<SearchRow>): SearchRow => ({
  title: "a page",
  url: "https://example.com/a",
  snippet: "",
  source: "Test",
  ...over,
});

/* ------------------------------------------------------- narrowing a search */

const mixed = [
  row({ url: "https://docs.example.com/one", title: "one" }),
  row({ url: "https://example.com/two", title: "two" }),
  row({ url: "https://elsewhere.test/three", title: "three" }),
];

const siteKept = narrowRows(mixed, { site: "https://www.example.com/wiki" });
check(
  "a site narrowing keeps that host and its subdomains, and says so",
  siteKept.rows.length === 2 &&
    siteKept.rows.every((entry) => entry.url.includes("example.com")) &&
    siteKept.notes.some((note) => note.includes("restricted to example.com")),
);

const siteEmpty = narrowRows(mixed, { site: "nothing-here.test" });
check(
  "a site nothing came back from drops no rows and reports it",
  siteEmpty.rows.length === mixed.length &&
    siteEmpty.notes[0].includes("no row was dropped"),
);

const excluded = narrowRows(
  [row({ title: "cheap watch" }), row({ title: "good watch" })],
  { exclude: "cheap, knockoff" },
);
check(
  "words to leave out drop the rows that carry them",
  excluded.rows.length === 1 &&
    excluded.rows[0].title === "good watch" &&
    excluded.notes[0].includes("without cheap, knockoff"),
);

const excludedAll = narrowRows(
  [row({ title: "cheap one" }), row({ title: "cheap two" })],
  { exclude: "cheap" },
);
check(
  "leaving out a word every row carries drops nothing, rather than the page",
  excludedAll.rows.length === 2 && excludedAll.notes[0].includes("none were dropped"),
);

const kinds = narrowRows(
  [row({ url: "https://a.test/doc.pdf" }), row({ url: "https://a.test/page" })],
  { filetype: ".pdf" },
);
check(
  "a file kind keeps only that kind",
  kinds.rows.length === 1 && kinds.notes[0].includes("only .pdf files"),
);

const kindEmpty = narrowRows([row({ url: "https://a.test/page" })], {
  filetype: "pdf",
});
check(
  "a kind nothing came back in is reported, and the list left whole",
  kindEmpty.rows.length === 1 && kindEmpty.notes[0].includes("left whole"),
);

const exact = narrowRows(
  [
    row({ title: "a cat", snippet: "a cat" }),
    row({ title: "the black cat sat", snippet: "the black cat sat down" }),
  ],
  { exact: "black cat" },
);
check(
  "a phrase puts the rows that carry it first, and says so",
  exact.rows[0].title === "the black cat sat" &&
    exact.notes[0].includes("rows carrying") &&
    exact.notes[0].includes("first"),
);

const exactMissing = narrowRows([row({ title: "a cat" })], { exact: "dog" });
check(
  "a phrase no row carries is said plainly instead of hiding the answer",
  exactMissing.rows.length === 1 &&
    exactMissing.notes[0].includes("no row carries") &&
    exactMissing.notes[0].includes("word for word"),
);

const asked = operatorQuery("kittens", {
  site: "https://www.example.com/x",
  exact: "black cat",
  exclude: "cheap, knockoff",
  filetype: ".pdf",
});
check(
  "the keyed index is handed the operators it understands",
  asked === 'kittens site:example.com "black cat" -cheap -knockoff filetype:pdf',
  asked,
);
check(
  "a search with nothing narrowed is handed the plain words",
  operatorQuery("kittens", {}) === "kittens",
);
check(
  "a one-letter word is not used to drop rows",
  operatorQuery("cats", { exclude: "a, the" }) === "cats -the",
  operatorQuery("cats", { exclude: "a, the" }),
);

/* ------------------------------------------- one page is one address */

check(
  "a fragment is not a different page",
  crawlUrl("https://a.test/x#part") === "https://a.test/x",
);
check(
  "a trailing slash is not a different page either",
  crawlUrl("https://a.test/x/") === "https://a.test/x",
);
check(
  "the root keeps its slash",
  crawlUrl("https://a.test/") === "https://a.test/",
);
check(
  "only http and https can be walked",
  crawlUrl("mailto:someone@a.test") === null && crawlUrl("not a url") === null,
);
check(
  "the same page fingerprints the same",
  fingerprint("a page of words") === fingerprint("a page of words"),
);
check(
  "a changed page fingerprints differently",
  fingerprint("a page of words") !== fingerprint("a page of wordz"),
);

/* ------------------------------------------------- finding inside a page */

const marks = splitMatches("cat dog cat", "cat");
check(
  "find counts every occurrence and marks each one",
  marks.matches === 2 && marks.parts.filter((part) => part.hit !== null).length === 2,
);
check(
  "the text between the marks is kept whole",
  marks.parts.map((part) => part.text).join("") === "cat dog cat",
);
check(
  "an empty find marks nothing and leaves the page as it was",
  splitMatches("cat dog", "   ").matches === 0 &&
    splitMatches("cat dog", " ").parts.map((part) => part.text).join("") ===
      "cat dog",
);
check(
  "the find is case-blind, as a find should be",
  splitMatches("Cat and cat", "CAT").matches === 2,
);

const crowded = splitMatches(
  Array.from({ length: MAX_MARKS + 80 }, () => "x").join(" "),
  "x",
);
check(
  "a page with more matches than the ceiling is counted, not drawn",
  crowded.matches === MAX_MARKS &&
    crowded.parts.some((part) => part.hit === null),
);

/* ------------------------------------------------------ the history kept */

const entry = (
  query: string,
  at: number,
  over: Partial<SearchHistoryEntry["prefs"]> = {},
): SearchHistoryEntry => ({
  query,
  prefs: { ...DEFAULT_PREFS, ...over },
  rows: 3,
  at,
});

let history = rememberSearch([], entry("first", 1));
history = rememberSearch(history, entry("second", 2));
check(
  "the newest question is first",
  history[0].query === "second" && history[1].query === "first",
);

history = rememberSearch(history, entry("first", 3));
check(
  "asking the same question again moves it to the front, not beside itself",
  history.length === 2 && history[0].query === "first",
);

const twoShelves = rememberSearch(
  rememberSearch([], entry("cats", 1)),
  entry("cats", 2, { shelf: "books" }),
);
check(
  "the same words asked of another shelf is its own question",
  twoShelves.length === 2,
);

const capped = Array.from({ length: HISTORY_MAX + 12 }, (_, index) =>
  entry(`q${index}`, index),
).reduce<SearchHistoryEntry[]>((acc, next) => rememberSearch(acc, next), []);
check(
  `the history stops at ${HISTORY_MAX} questions`,
  capped.length === HISTORY_MAX && capped[0].query === `q${HISTORY_MAX + 11}`,
);

check(
  "a history that cannot be read is simply no history",
  loadHistory({ getItem: () => "{not json" }).length === 0,
);
check(
  "a history holding the wrong shape is dropped, not drawn",
  loadHistory({ getItem: () => JSON.stringify([{ nope: 1 }]) }).length === 0,
);

/* ------------------------------------------------ what a search is asked */

const args = searchArgs("cats", {
  ...DEFAULT_PREFS,
  site: " example.com ",
  exact: "",
  shelf: "books",
});
check(
  "a search carries the shelf and only the narrowing that is set",
  args.shelf === "books" && args.site === "example.com" && args.exact === undefined,
);
check(
  "nothing narrowed reads as nothing narrowed",
  !isNarrowed(DEFAULT_PREFS) && narrowing(DEFAULT_PREFS).length === 0,
);
check(
  "the narrowing is written out for the reader",
  narrowing({ ...DEFAULT_PREFS, filetype: ".pdf" }).join() === "only .pdf files",
);

/* -------------------------------------------------------- the wiring, read */

const page = await read("src/pages/BrowserPage.tsx");
const boxes = await read("src/components/browser/BrowserTools.tsx");
const search = await read("src/convex/search.ts");
const bots = await read("src/convex/crawl.ts");

check(
  "Tools and More open their own boxes",
  page.includes('if (patch.category === "tools") setPanel("tools")') &&
    page.includes('else if (patch.category === "more") setPanel("more")'),
);
check(
  "any other category closes the boxes again",
  page.includes('open === "tools" || open === "more" ? "none" : open'),
);
check(
  "the boxes are drawn between the bar and the page",
  page.includes("<BrowserTools"),
);
check(
  "the toolbox reaches every bot it names",
  boxes.includes("api.crawl.crawl") &&
    boxes.includes("api.crawl.perch") &&
    boxes.includes("api.crawl.probe"),
);
check(
  "the survey asks the hub's search, never somebody else's page",
  boxes.includes("api.search.web") && !boxes.includes("google.com/search"),
);
check(
  "the narrowing is applied to what came back, not promised to the sources",
  search.includes("narrowRows(dedupe(rows), filters)"),
);
check(
  "operators go to the keyed index by name",
  search.includes("const asked = operatorQuery(query, filters);"),
);
check(
  "one shelf answers before any category is considered",
  search.includes('if (shelf !== "all") return await shelfRows(query, shelf);'),
);
check(
  "a real web index answers when the family has a key for one",
  search.includes("process.env.BRAVE_API_KEY") &&
    search.includes("process.env.TAVILY_API_KEY") &&
    search.includes("process.env.EXA_API_KEY") &&
    search.includes('via: "Exa"'),
);
check(
  "the hub's own sources are asked whether or not an index is set",
  search.includes("await wikipedia(query)") &&
    search.includes("await hackerNews(query)") &&
    search.includes("await stackOverflow(query)"),
);
check(
  "a bot keeps the reader's own refusals",
  bots.includes("assertPublicUrl") && bots.includes("refusal(ctx)"),
);
check(
  "the crawler has a depth, a page count and a budget",
  bots.includes("MAX_PAGES") &&
    bots.includes("MAX_DEPTH") &&
    bots.includes("CRAWL_BUDGET_MS") &&
    bots.includes("if (!roomForMore)"),
);
check(
  "a perch reads a page and stores nothing",
  bots.includes("fingerprint(`") && !bots.includes("ctx.db"),
);
check(
  "the probe says what a server answered, headers and all",
  bots.includes("pickHeaders(response)") &&
    bots.includes("/robots.txt") &&
    bots.includes("/sitemap.xml"),
);

/* ----------------------------------------------------------- every button */

// A toolbar is the part of a browser nobody reads: it is pressed. So a button
// that draws perfectly and does nothing is the quietest failure in the whole
// page — no error, no console line, just a press that goes nowhere. The checks
// here walk the buttons themselves, on both browser surfaces:
//
//   * the hub's own browser area (`BrowserPage`, the toolbox beside it, the
//     dock that opens it), where each `<Button>` must carry a handler or be a
//     Radix trigger its parent opens;
//   * the desktop SUGAR browser's chrome (`sugar-browser/ui/`), where every
//     control in the markup must be wired in `app.js`, every `api.*` it calls
//     must be the method `preload.js` actually exposes, and every channel that
//     bridge invokes must be one the main process answers.
//
// The last of those is the one that cannot be seen from either file alone: a
// button, a bridge method and an IPC handler are three files agreeing by name,
// and nothing but a check like this notices when one of them is renamed.

/** The whole opening tag from `from`, braces, arrows and strings included. */
function openingTag(source: string, from: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let at = from; at < source.length; at += 1) {
    const char = source[at];
    if (quote) {
      if (char === "\\") at += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
    else if (char === ">" && depth === 0) return source.slice(from, at + 1);
  }
  return source.slice(from);
}

/** Every `<Button>`/`<button>` opening tag in a file, with where it starts. */
function buttonTags(source: string): { line: number; tag: string; at: number }[] {
  const found: { line: number; tag: string; at: number }[] = [];
  const re = /<(?:Button|button)\b/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const tag = openingTag(source, match.index);
    found.push({
      line: source.slice(0, match.index).split("\n").length,
      tag,
      at: match.index,
    });
    re.lastIndex = match.index + tag.length;
  }
  return found;
}

/** A button that presses, not merely draws. */
function presses(tag: string): boolean {
  return (
    /on(Click|Submit|KeyDown|PointerDown|MouseDown|Change)/.test(tag) ||
    /type="submit"/.test(tag) ||
    /href=/.test(tag) ||
    /\{\.\.\./.test(tag)
  );
}

/** The trigger a button can sit inside and have the trigger do the work. */
function radixTrigger(source: string, at: number): boolean {
  const before = source.slice(Math.max(0, at - 4000), at);
  const lastOpen = before.lastIndexOf("<");
  if (lastOpen < 0) return false;
  return /\basChild\b/.test(openingTag(before, lastOpen));
}

const SURFACES = [
  "src/pages/BrowserPage.tsx",
  "src/components/browser/BrowserTools.tsx",
  "src/components/BrowserDock.tsx",
];

const surfaceSource = new Map<string, string>();
for (const path of SURFACES) surfaceSource.set(path, await read(path));

const loose: string[] = [];
let drawn = 0;
for (const [path, source] of surfaceSource) {
  for (const { line, tag, at } of buttonTags(source)) {
    drawn += 1;
    if (!presses(tag) && !radixTrigger(source, at)) {
      loose.push(`${path}:${line} ${tag.replace(/\s+/g, " ").slice(0, 70)}`);
    }
  }
}

check(
  "every button on the hub's browser surfaces is wired to something",
  loose.length === 0,
  loose.length ? loose.join(" | ") : `${drawn} buttons across ${SURFACES.length} files`,
);

const chrome = await read("sugar-browser/ui/index.html");
const chromeScript = await read("sugar-browser/ui/app.js");
const bridge = await read("sugar-browser/preload.js");
const mainProcess = await read("sugar-browser/main.js");

/** Every id the chrome puts on something a person can press or type into. */
const controls = chrome
  .split("\n")
  .filter((line) => /<(button|input|select|form)\b/.test(line))
  .flatMap((line) => [...line.matchAll(/id="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]));

const unwired = controls.filter((id) => !chromeScript.includes(`"${id}"`));
check(
  "every control in the desktop browser's chrome is wired in app.js",
  controls.length > 20 && unwired.length === 0,
  unwired.length ? `not wired: ${unwired.join(", ")}` : `${controls.length} controls`,
);

/** What the chrome asks the host to do, by the name it asks under. */
const called = [
  ...new Set([
    ...[...chromeScript.matchAll(/\bapi\.([A-Za-z0-9_]+)\s*\(/g)].map((m) => m[1]),
  ]),
].sort();

const exposed = [...bridge.matchAll(/^\s{2}([A-Za-z0-9_]+):/gm)].map((m) => m[1]);
const notExposed = called.filter((name) => !exposed.includes(name));
check(
  "every call the chrome makes is a method the bridge really exposes",
  called.length > 15 && notExposed.length === 0,
  notExposed.length
    ? `not in preload.js: ${notExposed.join(", ")}`
    : `${called.length} methods, all exposed`,
);

const channels = (source: string, pattern: RegExp) =>
  [...new Set([...source.matchAll(pattern)].map((m) => m[1]))].sort();

const invoked = channels(bridge, /ipcRenderer\.invoke\("([A-Za-z:-]+)"/g);
const handled = channels(mainProcess, /ipcMain\.handle\("([A-Za-z:-]+)"/g);
const unanswered = invoked.filter((channel) => !handled.includes(channel));
const unheard = handled.filter((channel) => !invoked.includes(channel));
check(
  "every channel the bridge invokes is one the main process answers",
  invoked.length > 25 && unanswered.length === 0 && unheard.length === 0,
  unanswered.length || unheard.length
    ? `${unanswered.length} unanswered (${unanswered.join(", ")}), ` +
      `${unheard.length} with no caller (${unheard.join(", ")})`
    : `${invoked.length} channels, both sides`, 
);

const pushed = channels(bridge, /ipcRenderer\.on\("([A-Za-z:-]+)"/g);
const sent = channels(mainProcess, /webContents\.send\("([A-Za-z:-]+)"/g);
const silent = pushed.filter((channel) => !sent.includes(channel));
check(
  "every update the chrome listens for is one the main process sends",
  pushed.length > 0 && silent.length === 0,
  silent.length ? `never sent: ${silent.join(", ")}` : pushed.join(", "),
);

console.log(
  failures === 0
    ? "\nEvery browser check passed."
    : `\n${failures} browser check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
