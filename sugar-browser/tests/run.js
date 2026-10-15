// SUGAR Browser — test runner.
//
// These are real tests against real files and real (faked-at-the-edge) network
// calls. They are the part of SUGAR Browser that *can* be verified on a machine
// with no display and no Electron: the portable path resolution, the local data
// store, the security path guards, the offline update check, and SUGAR's own
// command parser. The Electron window itself is verified only by parsing it.
//
// Run with: bun sugar-browser/tests/run.js   (or: node sugar-browser/tests/run.js)
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const portable = require("../src/portable.js");
const store = require("../src/store.js");
const security = require("../src/security.js");
const updates = require("../src/updates.js");
const sugar = require("../src/ai/sugar.js");
const providers = require("../src/ai/providers.js");

let passed = 0;
let failed = 0;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });

function tmp(prefix = "sugar-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A fake fetch that answers from a table of URL substrings. */
function fakeFetch(handler) {
  return async (url, options) => handler(url, options);
}

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

/* --------------------------------------------------- portable mode (§3, §10) */

test("portableRequested: a flag wins", () => {
  assert.equal(portable.portableRequested({ portableFlag: true }), true);
  assert.equal(portable.portableRequested({ env: { SUGAR_PORTABLE: "1" } }), true);
  assert.equal(portable.portableRequested({ env: { SUGAR_PORTABLE: "true" } }), true);
  assert.equal(portable.portableRequested({ env: { SUGAR_PORTABLE: "on" } }), true);
  assert.equal(portable.portableRequested({ env: { SUGAR_PORTABLE: "no" } }), false);
  assert.equal(portable.portableRequested({}), false);
});

test("resolveRoots: portable flag keeps everything beside the executable", () => {
  const exeDir = tmp();
  const roots = portable.resolveRoots({
    exeDir,
    appDataDir: "/somewhere/AppData",
    portableFlag: true,
  });
  assert.equal(roots.portable, true);
  assert.equal(roots.root, exeDir);
  assert.equal(roots.dirs.downloads, path.join(exeDir, "Downloads"));
  assert.equal(roots.dirs.settingsFile, path.join(exeDir, "Settings", "settings.json"));
});

test("resolveRoots: the marker file beside the executable turns portable on", () => {
  const exeDir = tmp();
  fs.writeFileSync(path.join(exeDir, portable.MARKER), "");
  const roots = portable.resolveRoots({ exeDir, appDataDir: "/x" });
  assert.equal(roots.portable, true);
  assert.equal(roots.root, exeDir);
  assert.equal(portable.markerPresent(exeDir), true);
});

test("resolveRoots: no flag and no marker installs under the user's app data", () => {
  const exeDir = tmp();
  const appDataDir = tmp();
  const roots = portable.resolveRoots({ exeDir, appDataDir });
  assert.equal(roots.portable, false);
  assert.equal(roots.root, path.join(appDataDir, "SUGAR Browser"));
});

test("resolveRoots: the drive letter never matters — the root follows the executable", () => {
  const first = portable.resolveRoots({
    exeDir: "/media/USB-A/SUGARBrowser",
    appDataDir: "/x",
    portableFlag: true,
  });
  const second = portable.resolveRoots({
    exeDir: "/media/OTHER-DRIVE/SUGARBrowser",
    appDataDir: "/x",
    portableFlag: true,
  });
  assert.equal(first.root, "/media/USB-A/SUGARBrowser");
  assert.equal(second.root, "/media/OTHER-DRIVE/SUGARBrowser");
  assert.notEqual(first.root, second.root);
});

test("resolveRoots: refuses to guess without an executable directory", () => {
  assert.throws(() => portable.resolveRoots({ appDataDir: "/x" }));
});

test("ensureTree: creates the whole local tree, and is safe to run twice", () => {
  const root = tmp();
  const dirs = portable.treeFor(root);
  portable.ensureTree(dirs);
  portable.ensureTree(dirs);
  for (const key of ["browserEngine", "resources", "ai", "characters", "extensions", "profiles", "data", "downloads", "logs", "updates"]) {
    assert.equal(fs.statSync(dirs[key]).isDirectory(), true, `${key} should exist`);
  }
  assert.equal(fs.statSync(path.dirname(dirs.settingsFile)).isDirectory(), true);
});

/* ------------------------------------------------------ local store (§2, §9) */

test("JsonStore: missing file reads as the defaults", () => {
  const file = path.join(tmp(), "settings.json");
  const j = new store.JsonStore(file, { home: "local:start", theme: "dark" });
  assert.deepEqual(j.read(), { home: "local:start", theme: "dark" });
});

test("JsonStore: write then read round-trips, and leaves no temp file", () => {
  const file = path.join(tmp(), "settings.json");
  const j = new store.JsonStore(file, { theme: "dark" });
  j.write({ theme: "light", extra: 1 });
  assert.deepEqual(j.read(), { theme: "light", extra: 1 });
  assert.equal(fs.existsSync(`${file}.tmp`), false);
});

test("JsonStore: a stored value overrides the default but keeps unknown defaults", () => {
  const file = path.join(tmp(), "settings.json");
  fs.writeFileSync(file, JSON.stringify({ theme: "light" }));
  const j = new store.JsonStore(file, { theme: "dark", search: "ddg" });
  assert.deepEqual(j.read(), { theme: "light", search: "ddg" });
});

test("JsonStore: corrupted file falls back to defaults instead of throwing", () => {
  const file = path.join(tmp(), "settings.json");
  fs.writeFileSync(file, "{ not json");
  const j = new store.JsonStore(file, { theme: "dark" });
  assert.deepEqual(j.read(), { theme: "dark" });
  assert.deepEqual(j.patch({ theme: "light" }), { theme: "light" });
});

test("ListStore: add, search, remove and clear", () => {
  const file = path.join(tmp(), "history.json");
  const l = new store.ListStore(file);
  l.add({ title: "Linux Mint", url: "https://linuxmint.com/" });
  l.add({ title: "Google", url: "https://google.com/" });
  assert.equal(l.read().length, 2);
  const found = l.search("mint");
  assert.equal(found.length, 1);
  assert.equal(found[0].url, "https://linuxmint.com/");
  l.remove((entry) => entry.title === "Google");
  assert.equal(l.read().length, 1);
  l.clear();
  assert.deepEqual(l.read(), []);
});

test("ListStore: the oldest fall off the end rather than growing forever", () => {
  const file = path.join(tmp(), "history.json");
  const l = new store.ListStore(file, { max: 3 });
  for (let i = 1; i <= 8; i += 1) l.add({ n: i });
  assert.deepEqual(
    l.read().map((entry) => entry.n),
    [6, 7, 8],
  );
});

test("createStores: wires every store to the portable tree", () => {
  const root = tmp();
  const dirs = portable.treeFor(root);
  portable.ensureTree(dirs);
  const stores = store.createStores(dirs);
  stores.settings.write({ ...store.DEFAULT_SETTINGS, home: "local:start" });
  stores.bookmarks.add({ title: "A", url: "https://a.example/" });
  assert.equal(stores.settings.read().home, "local:start");
  assert.equal(stores.bookmarks.read().length, 1);
  assert.equal(fs.existsSync(dirs.history), false); // never written until used
});

/* --------------------------------------------------------- security (§13) */

test("permissions: the browser's narrow set is allowed, the rest refused", () => {
  assert.equal(security.isAllowedPermission("media"), true);
  assert.equal(security.isAllowedPermission("display-capture"), true);
  assert.equal(security.isAllowedPermission("usb"), false);
  assert.equal(security.isAllowedPermission("serial"), false);
  assert.equal(security.isAllowedPermission("hid"), false);
});

test("isInside: the root itself and its children are inside; anything else is not", () => {
  const root = "/tmp/sugar-root";
  assert.equal(security.isInside(root, "/tmp/sugar-root"), true);
  assert.equal(security.isInside(root, "/tmp/sugar-root/Data/a.json"), true);
  assert.equal(security.isInside(root, "/tmp/other"), false);
  assert.equal(security.isInside(root, "/tmp/sugar-root/../escape"), false);
});

test("assertInside: traversal out of the browser's folder is refused", () => {
  const root = tmp();
  assert.ok(security.assertInside(root, path.join(root, "Downloads", "x.txt")));
  assert.throws(() => security.assertInside(root, path.join(root, "..", "outside.txt")));
});

test("safeFileName: separators, traversal and device names are neutralised", () => {
  assert.equal(security.safeFileName("report.pdf"), "report.pdf");
  assert.equal(security.safeFileName("../../etc/passwd"), "_.._etc_passwd");
  assert.equal(security.safeFileName("a/b\\c.txt"), "a_b_c.txt");
  assert.equal(security.safeFileName("nul"), "download");
  assert.equal(security.safeFileName(""), "download");
  assert.equal(security.safeFileName("CON"), "download");
});

/* ------------------------------------------------------------ updates (§14) */

test("compareVersions: the usual ordering", () => {
  assert.equal(updates.compareVersions("1.2.3", "1.2.4"), -1);
  assert.equal(updates.compareVersions("2.0.0", "1.9.9"), 1);
  assert.equal(updates.compareVersions("1.2", "1.2.0"), 0);
  assert.equal(updates.compareVersions("v1.2.3", "1.2.3"), 0);
});

test("localPackages: finds a dropped-in build and ignores hidden files", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "SUGARBrowser-0.2.0.zip"), "x");
  fs.writeFileSync(path.join(dir, ".DS_Store"), "");
  const found = updates.localPackages(dir);
  assert.equal(found.length, 1);
  assert.equal(found[0].version, "0.2.0");
  assert.equal(updates.localPackages(path.join(dir, "nope")).length, 0);
});

test("checkFeed: an unconfigured feed is reported honestly, not as success", async () => {
  const result = await updates.checkFeed({ url: "", currentVersion: "0.1.0" });
  assert.equal(result.ok, false);
  assert.equal(result.configured, false);
});

test("checkFeed: a newer version is reported but never installed", async () => {
  const result = await updates.checkFeed({
    url: "https://example.test/latest.json",
    currentVersion: "0.1.0",
    fetchImpl: fakeFetch(() => jsonResponse({ version: "0.2.0" })),
  });
  assert.equal(result.ok, true);
  assert.equal(result.newer, true);
  assert.equal(result.latest, "0.2.0");
});

test("checkFeed: an older feed is not newer", async () => {
  const result = await updates.checkFeed({
    url: "https://example.test/latest.json",
    currentVersion: "0.3.0",
    fetchImpl: fakeFetch(() => jsonResponse({ version: "0.2.0" })),
  });
  assert.equal(result.ok, true);
  assert.equal(result.newer, false);
});

test("checkFeed: a failed check reads as a failure, not as up to date", async () => {
  const result = await updates.checkFeed({
    url: "https://example.test/latest.json",
    currentVersion: "0.1.0",
    fetchImpl: fakeFetch(() => jsonResponse({}, { ok: false, status: 500 })),
  });
  assert.equal(result.ok, false);
  assert.equal(result.configured, true);
  assert.equal(result.newer, false);
});

/* ----------------------------------------------------------- SUGAR (§6, §8) */

test("SUGAR: 'open google'", () => {
  const plan = sugar.parseCommand("open google");
  assert.deepEqual(plan.steps, [{ kind: "open", url: "https://www.google.com/" }]);
  assert.equal(plan.needsNetwork, true);
});

test("SUGAR: 'search for Linux Mint'", () => {
  const plan = sugar.parseCommand("search for Linux Mint");
  assert.deepEqual(plan.steps, [{ kind: "search", query: "Linux Mint" }]);
});

test("SUGAR: 'open these three websites' resolves a named list", () => {
  const plan = sugar.parseCommand("open google and youtube and wikipedia");
  assert.deepEqual(plan.steps, [
    { kind: "open", url: "https://www.google.com/" },
    { kind: "open", url: "https://www.youtube.com/" },
    { kind: "open", url: "https://en.wikipedia.org/" },
  ]);
});

test("SUGAR: a list with nothing named stays unresolved for the AI", () => {
  const plan = sugar.parseCommand("open these three websites");
  assert.deepEqual(plan.steps, [{ kind: "unknown", text: "open these three websites" }]);
  assert.equal(plan.unknown, true);
});

test("SUGAR: 'download this file'", () => {
  const plan = sugar.parseCommand("download this file");
  assert.deepEqual(plan.steps, [{ kind: "download" }]);
  assert.equal(plan.needsPermission, true);
});

test("SUGAR: 'open the downloaded file'", () => {
  assert.deepEqual(sugar.parseCommand("open the downloaded file").steps, [{ kind: "open-download" }]);
});

test("SUGAR: 'go back' and other navigation", () => {
  assert.deepEqual(sugar.parseCommand("go back").steps, [{ kind: "nav", action: "back" }]);
  assert.deepEqual(sugar.parseCommand("go forward").steps, [{ kind: "nav", action: "forward" }]);
  assert.deepEqual(sugar.parseCommand("reload").steps, [{ kind: "nav", action: "reload" }]);
  assert.deepEqual(sugar.parseCommand("home").steps, [{ kind: "nav", action: "home" }]);
});

test("SUGAR: 'open another tab' and 'close that tab'", () => {
  assert.deepEqual(sugar.parseCommand("open another tab").steps, [{ kind: "new-tab" }]);
  assert.deepEqual(sugar.parseCommand("open a new tab").steps, [{ kind: "new-tab" }]);
  assert.deepEqual(sugar.parseCommand("close that tab").steps, [{ kind: "close-tab", which: "active" }]);
  assert.deepEqual(sugar.parseCommand("go to the next tab").steps, [{ kind: "switch-tab", direction: "next" }]);
});

test("SUGAR: 'compare these pages'", () => {
  assert.deepEqual(sugar.parseCommand("compare these pages").steps, [{ kind: "compare" }]);
});

test("SUGAR: 'save this website' and 'bookmark this page'", () => {
  assert.deepEqual(sugar.parseCommand("save this website").steps, [{ kind: "save-page" }]);
  assert.deepEqual(sugar.parseCommand("bookmark this page").steps, [{ kind: "bookmark" }]);
});

test("SUGAR: 'read this page to me' and 'explain what I'm looking at'", () => {
  assert.deepEqual(sugar.parseCommand("read this page to me").steps, [{ kind: "read-page" }]);
  assert.deepEqual(sugar.parseCommand("explain what I'm looking at").steps, [{ kind: "explain" }]);
});

test("SUGAR: 'find the information on this page'", () => {
  assert.deepEqual(sugar.parseCommand("find the information on this page").steps, [
    { kind: "find", text: "the information" },
  ]);
});

test("SUGAR: 'find the cheapest option' is left for the AI to resolve", () => {
  const plan = sugar.parseCommand("find the cheapest option");
  assert.deepEqual(plan.steps, [{ kind: "unknown", text: "find the cheapest option" }]);
});

test("SUGAR: 'fill this form' asks permission", () => {
  const plan = sugar.parseCommand("fill this form");
  assert.deepEqual(plan.steps, [{ kind: "fill-form" }]);
  assert.equal(plan.needsPermission, true);
});

test("SUGAR: a bare address is opened, a bare site name too", () => {
  assert.deepEqual(sugar.parseCommand("example.com").steps, [{ kind: "open", url: "https://example.com" }]);
  assert.deepEqual(sugar.parseCommand("wikipedia").steps, [{ kind: "open", url: "https://en.wikipedia.org/" }]);
});

test("SUGAR: chained commands become chained steps", () => {
  const plan = sugar.parseCommand("open google; search for cats");
  assert.deepEqual(plan.steps, [
    { kind: "open", url: "https://www.google.com/" },
    { kind: "search", query: "cats" },
  ]);
});

test("SUGAR: every step kind has a spoken description", () => {
  for (const kind of sugar.STEP_KINDS) {
    const described = sugar.describeStep({ kind, url: "u", query: "q", text: "t", action: "back", which: "other", direction: "next" });
    assert.equal(typeof described, "string");
    assert.ok(described.length > 0);
  }
});

test("SUGAR: an empty command plans nothing", () => {
  const plan = sugar.parseCommand("   ");
  assert.deepEqual(plan.steps, []);
  assert.equal(plan.unknown, false);
});

/* ------------------------------------------------------- AI providers (§6) */

test("providers: extractModels understands both model spellings", () => {
  assert.deepEqual(providers.extractModels({ models: [{ name: "llama3" }] }), ["llama3"]);
  assert.deepEqual(providers.extractModels({ data: [{ id: "gpt-x" }] }), ["gpt-x"]);
  assert.deepEqual(providers.extractModels({}), []);
});

test("providers: a local provider needs no key, a remote one does", () => {
  assert.equal(providers.isUsable({ kind: "local", base: "http://127.0.0.1:11434" }), true);
  assert.equal(providers.isUsable({ kind: "remote", base: "https://api.example/" }), false);
  assert.equal(providers.isUsable({ kind: "remote", base: "https://api.example/", apiKey: "k" }), true);
  assert.equal(providers.isUsable(null), false);
});

test("providers: probe reports a running server and its models", async () => {
  const result = await providers.probe(
    { id: "lmstudio", kind: "local", base: "http://127.0.0.1:1234", modelsPath: "/v1/models" },
    fakeFetch(() => jsonResponse({ data: [{ id: "mistral" }] })),
  );
  assert.equal(result.available, true);
  assert.deepEqual(result.models, ["mistral"]);
});

test("providers: a server that is not running is reported as unavailable, not as an error", async () => {
  const result = await providers.probe(
    { id: "ollama", kind: "local", base: "http://127.0.0.1:11434", modelsPath: "/api/tags" },
    fakeFetch(() => {
      throw new Error("ECONNREFUSED");
    }),
  );
  assert.equal(result.available, false);
  assert.deepEqual(result.models, []);
});

test("providers: detectLocal keeps only what answered", async () => {
  const found = await providers.detectLocal(
    fakeFetch((url) => (url.includes("11434") ? jsonResponse({ models: [{ name: "a" }] }) : Promise.reject(new Error("no")))),
  );
  assert.equal(found.length, 1);
  assert.equal(found[0].id, "ollama");
});

test("providers: providerList puts local first when asked", () => {
  const list = providers.providerList({
    ai: {
      preferLocal: true,
      providers: [
        { id: "cloud", kind: "remote", base: "https://api.example/", apiKey: "k" },
        { id: "pico", kind: "local", base: "http://127.0.0.1:9/" },
      ],
    },
  });
  assert.equal(list[0].id, "pico");
});

test("providers: askOrder asks this machine first, once, and honours detection being off", () => {
  const config = {
    ai: {
      providers: [
        { id: "cloud", kind: "remote", base: "https://api.example/", apiKey: "k" },
        { id: "nokey", kind: "remote", base: "https://other.example/" },
        { id: "ollama-cfg", kind: "local", base: "http://127.0.0.1:11434/" },
      ],
    },
  };
  const detected = [
    { id: "ollama", kind: "local", base: "http://127.0.0.1:11434" },
    { id: "lmstudio", kind: "local", base: "http://127.0.0.1:1234" },
  ];

  assert.deepEqual(
    providers.askOrder(config, detected).map((entry) => entry.id),
    // the configured Ollama entry is the same address as the detected one, so
    // it is not asked a second time
    ["ollama", "lmstudio", "cloud"],
  );
  assert.deepEqual(
    providers.askOrder({ ai: { ...config.ai, autoDetectLocal: false } }, detected).map((entry) => entry.id),
    // detection is off, so only the configured list is used — still local first
    ["ollama-cfg", "cloud"],
  );
  assert.deepEqual(providers.askOrder({}, detected).map((entry) => entry.id), ["ollama", "lmstudio"]);
});

test("providers: detectLocal reports what answered and not what did not", async () => {
  const fetchImpl = (url) =>
    String(url).includes("11434")
      ? jsonResponse({ models: [{ name: "llama3.2" }] })
      : Promise.reject(new Error("ECONNREFUSED"));
  const found = await providers.detectLocal(fetchImpl);
  assert.equal(found.length, 1);
  assert.equal(found[0].id, "ollama");
  assert.equal(found[0].available, true);
  assert.deepEqual(found[0].models, ["llama3.2"]);
});

test("providers: planWithProvider returns the model's text, and fails honestly", async () => {
  const ok = await providers.planWithProvider(
    { kind: "local", base: "http://127.0.0.1:1234", chatPath: "/v1/chat/completions" },
    { system: "s", user: "u" },
    fakeFetch(() => jsonResponse({ choices: [{ message: { content: '{"steps":[]}' } }] })),
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.text, '{"steps":[]}');

  const refused = await providers.planWithProvider(
    { kind: "remote", base: "https://api.example/" },
    { system: "s", user: "u" },
    fakeFetch(() => jsonResponse({})),
  );
  assert.equal(refused.ok, false);
});

/* ------------------------------------------------------ SUGAR controller */

const { SugarController } = require("../src/sugar-controller.js");

function fakeBrowser(overrides = {}) {
  const calls = [];
  const record = (name) => (...args) => {
    calls.push({ name, args });
    return undefined;
  };
  const browser = {
    calls,
    open: record("open"),
    search: record("search"),
    newTab: record("newTab"),
    closeTab: record("closeTab"),
    switchTab: record("switchTab"),
    nav: record("nav"),
    bookmark: async () => {
      calls.push({ name: "bookmark", args: [] });
      return { title: "Linux Mint" };
    },
    listBookmarks: async () => {
      calls.push({ name: "listBookmarks", args: [] });
      return [{ title: "A" }, { title: "B" }];
    },
    download: record("download"),
    openDownload: async () => {
      calls.push({ name: "openDownload", args: [] });
      return "report.pdf";
    },
    readPage: async () => {
      calls.push({ name: "readPage", args: [] });
      return "The page begins here and goes on for a while.";
    },
    explain: async () => {
      calls.push({ name: "explain", args: [] });
      return "This is a page about mint.";
    },
    summarise: record("summarise"),
    compare: record("compare"),
    find: async (text) => {
      calls.push({ name: "find", args: [text] });
      return true;
    },
    savePage: async () => {
      calls.push({ name: "savePage", args: [] });
      return "/tmp/sugar/Downloads/page.html";
    },
    fillForm: record("fillForm"),
    ...overrides,
  };
  return browser;
}

test("controller: executes a plan and reports progress step by step", async () => {
  const browser = fakeBrowser();
  const events = [];
  const controller = new SugarController({ browser, events: (event) => events.push(event) });
  const result = await controller.run("open google");
  assert.equal(result.ok, true);
  assert.deepEqual(browser.calls, [{ name: "open", args: ["https://www.google.com/"] }]);
  assert.equal(events[0].type, "start");
  assert.equal(events[1].type, "step");
  assert.equal(events[1].status, "start");
  assert.equal(events[2].status, "done");
  assert.equal(events.at(-1).type, "done");
  assert.equal(events.at(-1).ok, true);
});

test("controller: a needs-network plan is refused offline instead of failing silently", async () => {
  const browser = fakeBrowser();
  const controller = new SugarController({ browser, isOnline: () => false });
  const result = await controller.run("open google");
  assert.equal(result.ok, false);
  assert.equal(browser.calls.length, 0);
  assert.match(result.note, /internet/);
});

test("controller: a local command still runs with no internet", async () => {
  const browser = fakeBrowser();
  const controller = new SugarController({ browser, isOnline: () => false });
  const result = await controller.run("go back");
  assert.equal(result.ok, true);
  assert.deepEqual(browser.calls, [{ name: "nav", args: ["back"] }]);
});

test("controller: a step that needs permission asks, and stopping is honoured", async () => {
  const browser = fakeBrowser();
  let asked = null;
  const controller = new SugarController({
    browser,
    requestPermission: async (request) => {
      asked = request;
      return false;
    },
  });
  const result = await controller.run("download this file");
  assert.equal(result.ok, false);
  assert.equal(asked.kind, "download");
  assert.equal(browser.calls.length, 0);
});

test("controller: a page-reading step has something to speak", async () => {
  const browser = fakeBrowser();
  const controller = new SugarController({ browser });
  const result = await controller.run("read this page to me");
  assert.equal(result.ok, true);
  assert.match(result.results[0].note, /Read it aloud/);
});

test("controller: chained commands run in order", async () => {
  const browser = fakeBrowser();
  const controller = new SugarController({ browser });
  const result = await controller.run("open google; search for mint; open another tab");
  assert.equal(result.ok, true);
  assert.deepEqual(
    browser.calls.map((call) => call.name),
    ["open", "search", "newTab"],
  );
});

test("controller: an unresolved command is reported, not guessed at", async () => {
  const browser = fakeBrowser();
  const controller = new SugarController({ browser });
  const result = await controller.run("find the cheapest option");
  assert.equal(result.ok, false);
  assert.equal(browser.calls.length, 0);
  assert.match(result.results[0].note, /did not understand/);
});

/* ------------------------------------------------------------------- report */

(async () => {
  for (const { name, fn } of cases) {
    try {
      await fn();
      passed += 1;
    } catch (error) {
      failed += 1;
      console.error(`\u2717 ${name}`);
      console.error(`  ${error && error.message ? error.message : error}`);
    }
  }
  const total = passed + failed;
  console.log(`\nSUGAR Browser tests — ${passed}/${total} passed${failed ? `, ${failed} failed` : ""}`);
  if (failed) process.exitCode = 1;
})();
