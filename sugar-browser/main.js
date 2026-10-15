// SUGAR Browser — a real, local-first desktop browser with SUGAR built in.
//
// This is not a website and not a wrapper around one. It is Chromium — the same
// engine every modern browser uses — driving a window we own: one native view
// draws the browser's own chrome (tabs, omnibox, SUGAR), and one WebContentsView
// per tab draws the actual pages underneath it.
//
// Two things make it *SUGAR* Browser rather than any other Chromium shell:
//
//   · it is portable and self-contained. It works out its own folder at run
//     time (never a hard-coded path), keeps every setting, bookmark, history
//     entry and download inside that folder, and runs the same whether it lives
//     on a hard disk (C:\) or a USB stick (E:\) (§3, §9, §10).
//   · SUGAR is integrated with the browser and can actually drive it. The
//     sentence-to-plan layer works with no network and no model; a local AI is
//     an upgrade, never a requirement (§6, §8).
"use strict";

const {
  app,
  BaseWindow,
  WebContentsView,
  ipcMain,
  session,
  shell,
  net,
  clipboard,
  Menu,
  dialog,
  desktopCapturer,
} = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const portable = require("./src/portable.js");
const { createStores } = require("./src/store.js");
const security = require("./src/security.js");
const updates = require("./src/updates.js");
const { SugarController } = require("./src/sugar-controller.js");
const providers = require("./src/ai/providers.js");
const { parseCommand } = require("./src/ai/sugar.js");

const APP_VERSION = (() => {
  try {
    return require("./package.json").version;
  } catch {
    return "0.0.0";
  }
})();

const CHROME_HEIGHT = 110;
const CHROME_UI = path.join(__dirname, "ui", "index.html");
const START_PAGE_UI = path.join(__dirname, "ui", "start.html");
const PRELOAD = path.join(__dirname, "preload.js");

/** The sentinel a new tab and the Home button open: the local start page. */
const START_URL = "local:start";

/* ------------------------------------------------- portable roots (§3, §10) */

// Everything below the window depends on where SUGAR Browser lives, so this is
// decided once, before the app is ready. No path here is ever hard-coded to a
// drive letter: it comes from the executable that is actually running.
// electron-builder's portable .exe is extracted to a temp folder and sets
// PORTABLE_EXECUTABLE_DIR to the folder the user actually ran it from. That is
// the real "beside the executable" location in portable mode; otherwise the
// directory of the running executable is.
const exeDir = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath("exe"));
const roots = portable.resolveRoots({
  exeDir,
  appDataDir: app.getPath("appData"),
  env: process.env,
  portableFlag: process.argv.includes("--portable"),
});
portable.ensureTree(roots.dirs);

app.setName("SUGAR Browser");
app.setPath("userData", roots.dirs.profile);
app.setPath("sessionData", roots.dirs.session);
app.setPath("downloads", roots.dirs.downloads);
app.setPath("logs", roots.dirs.logs);

const stores = createStores(roots.dirs);

/* --------------------------------------------------------------- settings */

function settings() {
  return stores.settings.read();
}

function toUrl(input) {
  const text = String(input || "").trim();
  const config = settings();
  if (!text) return START_URL;
  if (text === START_URL) return START_URL;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text;
  if (
    /^[\w-]+(\.[\w-]+)+((:\d+)?)([/?#].*)?$/.test(text) ||
    /^localhost(:\d+)?([/?#].*)?$/.test(text) ||
    /^\d{1,3}(\.\d{1,3}){3}(:\d+)?([/?#].*)?$/.test(text)
  ) {
    return `https://${text}`;
  }
  return searchFor(text);
}

/** The configured search engine, with the query filled in. */
function searchFor(query) {
  const search = settings().search || "https://duckduckgo.com/?q=%s";
  return String(search).replace("%s", encodeURIComponent(String(query || "")));
}

/** A short, single-line version of a string, for a menu label. */
function preview(text, max = 40) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/* ------------------------------------------------------- SUGAR's AI (§6) */

/** The local model servers found recently, so a slow probe isn't paid per question. */
let detected = { at: 0, list: [] };
const DETECT_TTL_MS = 60000;

/** Model servers running on *this* machine (auto-detect, §6), remembered for a minute. */
async function detectedProviders(config) {
  if (config?.ai?.autoDetectLocal === false) return [];
  if (Date.now() - detected.at < DETECT_TTL_MS) return detected.list;
  let list = [];
  try {
    list = await providers.detectLocal(fetch);
  } catch {
    list = [];
  }
  detected = { at: Date.now(), list };
  return list;
}

/**
 * Ask a model a question: the ones on this machine first, then the configured
 * ones, each failure honestly reported as a failure so the caller falls back to
 * its own local answers. Returns null when no model is available at all.
 */
async function askModel({ system, user, timeoutMs = 30000 }) {
  const config = settings();
  const found = await detectedProviders(config);
  for (const provider of providers.askOrder(config, found)) {
    const result = await providers.planWithProvider(provider, { system, user }, fetch, timeoutMs);
    if (result.ok && result.text) return result.text;
    if (found.includes(provider)) detected = { at: 0, list: [] }; // it went away; look again next time
  }
  return null;
}

/* -------------------------------------------------------------- the window */

let nextTabId = 1;

class SugarWindow {
  constructor({ isPrivate = false } = {}) {
    this.id = `win-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    this.isPrivate = isPrivate;
    this.tabs = [];
    this.activeId = null;
    this.downloads = [];
    this.chromeHeight = CHROME_HEIGHT;

    this.window = new BaseWindow({
      width: 1280,
      height: 860,
      minWidth: 480,
      minHeight: 360,
      title: isPrivate ? "SUGAR Browser — Private" : "SUGAR Browser",
      backgroundColor: isPrivate ? "#141414" : "#07090d",
    });

    this.partition = isPrivate ? `private-${this.id}` : "persist:sugar-browser";

    this.chrome = new WebContentsView({
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.window.contentView.addChildView(this.chrome);
    this.chrome.webContents.loadFile(CHROME_UI);

    this.window.on("resize", () => this.layout());
    this.window.on("closed", () => {
      for (const tab of this.tabs) {
        try {
          tab.view.webContents.close();
        } catch {
          /* the window is going away regardless */
        }
      }
      this.tabs = [];
    });

    this.controller = new SugarController({
      browser: this.adapter(),
      stores,
      events: (event) => this.sendSugar(event),
      isOnline: () => isOnline(),
      requestPermission: (request) => this.confirm(request),
    });

    this.newTab(START_URL);
  }

  /* ------------------------------------------------------------ layout */

  layout() {
    const { width, height } = this.window.getContentBounds();
    const strip = this.chromeHeight;
    this.chrome.setBounds({ x: 0, y: 0, width, height: strip });
    for (const tab of this.tabs) {
      const shown = tab.id === this.activeId;
      const bounds = { x: 0, y: strip, width, height: Math.max(0, height - strip) };
      tab.view.setBounds(shown ? bounds : { x: 0, y: strip, width: 0, height: 0 });
      if (typeof tab.view.setVisible === "function") tab.view.setVisible(shown);
    }
  }

  /* ------------------------------------------------------------- tabs */

  newTab(url) {
    const id = `tab-${nextTabId++}`;
    const view = new WebContentsView({
      webPreferences: {
        partition: this.partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });

    const tab = { id, view, title: "New tab", url: url || START_URL, loading: false };
    this.tabs.push(tab);
    this.window.contentView.addChildView(view);
    this.activeId = id;

    this.wire(tab);
    this.load(tab, tab.url);

    this.layout();
    this.push();
    return id;
  }

  /** Load a tab, honouring the local start page and recording history. */
  load(tab, url) {
    const target = url === START_URL || !url ? START_URL : url;
    tab.url = target;
    tab.loading = true;
    if (target === START_URL) {
      tab.view.webContents.loadFile(START_PAGE_UI).catch(() => undefined);
    } else {
      tab.view.webContents.loadURL(target).catch(() => undefined);
    }
  }

  wire(tab) {
    const wc = tab.view.webContents;
    const changed = () => this.push();

    wc.on("page-title-updated", (_event, title) => {
      tab.title = title;
      changed();
    });
    wc.on("did-start-loading", () => {
      tab.loading = true;
      changed();
    });
    wc.on("did-stop-loading", () => {
      tab.loading = false;
      changed();
      this.recordHistory(tab);
    });
    wc.on("did-navigate", (_event, url) => {
      tab.url = url;
      changed();
    });
    wc.on("did-navigate-in-page", (_event, url) => {
      tab.url = url;
      changed();
    });
    wc.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return; // -3 is a cancelled load
      tab.title = `Did not load — ${description}`;
      changed();
    });
    wc.on("found-in-page", (_event, result) => this.send({ find: result }));
    wc.on("enter-html-full-screen", () => this.send({ fullscreen: true }));
    wc.on("leave-html-full-screen", () => this.send({ fullscreen: false }));

    wc.setWindowOpenHandler(({ url, disposition }) => {
      if (disposition === "save-to-disk") {
        wc.downloadURL(url);
      } else {
        this.newTab(url);
        this.layout();
      }
      return { action: "deny" };
    });

    // Right-clicking a page gets the menu every other browser has. It is built
    // from what was actually clicked, so a menu on a link is about that link
    // and a menu on text is about that text.
    wc.on("context-menu", (_event, params) => this.showContextMenu(params));
  }

  /**
   * The page's own right-click menu: edit, copy and paste, follow or copy a
   * link, save a picture, move through history, and inspect — the standard set,
   * always there, rather than a page with no way to copy a link out of it.
   */
  showContextMenu(params) {
    const wc = this.active()?.view.webContents;
    if (!wc) return;
    const template = [];

    if (params.isEditable) {
      template.push(
        { label: "Undo", enabled: params.editFlags?.canUndo !== false, click: () => wc.undo() },
        { label: "Redo", enabled: params.editFlags?.canRedo !== false, click: () => wc.redo() },
        { type: "separator" },
        { label: "Cut", enabled: params.editFlags?.canCut !== false, click: () => wc.cut() },
        { label: "Copy", enabled: params.editFlags?.canCopy !== false, click: () => wc.copy() },
        { label: "Paste", enabled: params.editFlags?.canPaste !== false, click: () => wc.paste() },
        { label: "Select all", enabled: params.editFlags?.canSelectAll !== false, click: () => wc.selectAll() },
      );
    } else if (params.selectionText) {
      template.push(
        { label: "Copy", click: () => wc.copy() },
        { label: `Search for “${preview(params.selectionText, 30)}”`, click: () => this.openUrl(searchFor(params.selectionText)) },
        { type: "separator" },
        { label: "Select all", click: () => wc.selectAll() },
      );
    } else {
      template.push(
        { label: "Select all", click: () => wc.selectAll() },
        { label: "Copy page address", click: () => clipboard.writeText(wc.getURL()) },
      );
    }

    if (params.linkURL) {
      template.push(
        { type: "separator" },
        { label: "Open link in a new tab", click: () => { this.newTab(params.linkURL); this.layout(); } },
        { label: "Open link in a new window", click: () => createWindow({}).navigate(params.linkURL) },
        { label: "Copy link address", click: () => clipboard.writeText(params.linkURL) },
        { label: "Save link as…", click: () => wc.downloadURL(params.linkURL) },
      );
    }

    if (params.mediaType === "image" && params.srcURL) {
      template.push(
        { type: "separator" },
        { label: "Open image in a new tab", click: () => { this.newTab(params.srcURL); this.layout(); } },
        { label: "Copy image", click: () => wc.copyImageAt(params.x, params.y) },
        { label: "Copy image address", click: () => clipboard.writeText(params.srcURL) },
        { label: "Save image as…", click: () => wc.downloadURL(params.srcURL) },
      );
    }

    const history = wc.navigationHistory;
    template.push(
      { type: "separator" },
      { label: "Back", enabled: history.canGoBack(), click: () => history.goBack() },
      { label: "Forward", enabled: history.canGoForward(), click: () => history.goForward() },
      { label: "Reload", click: () => wc.reload() },
      { type: "separator" },
      { label: "Bookmark this page", click: () => { try { this.bookmarkActive(); } catch { /* nothing here to bookmark */ } } },
      { label: "Save page as…", click: () => { void this.saveActivePage().catch(() => undefined); } },
      { type: "separator" },
      { label: "Inspect element", click: () => wc.inspectElement(params.x, params.y) },
    );

    Menu.buildFromTemplate(template).popup({ window: this.window });
  }

  recordHistory(tab) {
    const url = tab.view.webContents.getURL();
    if (!url || url.startsWith("file://")) return;
    const list = stores.history.read();
    const last = list[list.length - 1];
    if (last && last.url === url) return;
    stores.history.add({ title: tab.title, url, at: Date.now() });
  }

  closeTab(id) {
    const index = this.tabs.findIndex((tab) => tab.id === id);
    if (index === -1) return;
    const [tab] = this.tabs.splice(index, 1);
    try {
      this.window.contentView.removeChildView(tab.view);
      tab.view.webContents.close();
    } catch {
      /* already gone */
    }
    if (this.activeId === id) {
      const next = this.tabs[index] ?? this.tabs[index - 1] ?? null;
      this.activeId = next ? next.id : null;
      if (!this.activeId) {
        this.newTab(START_URL);
        return;
      }
    }
    this.layout();
    this.push();
  }

  activate(id) {
    if (!this.tabs.some((tab) => tab.id === id)) return;
    this.activeId = id;
    this.layout();
    this.push();
  }

  active() {
    return this.tabs.find((tab) => tab.id === this.activeId) ?? null;
  }

  navigate(input) {
    const tab = this.active();
    if (!tab) return this.newTab(toUrl(input));
    this.load(tab, toUrl(input));
    this.push();
  }

  openUrl(url) {
    const tab = this.active();
    if (!tab) {
      this.newTab(toUrl(url));
      return;
    }
    // A SUGAR-issued open reuses the current tab, which is what "open google"
    // means from the address bar's point of view.
    this.load(tab, toUrl(url));
    this.push();
  }

  onDownload(entry) {
    this.downloads.push(entry);
    if (this.downloads.length > 20) this.downloads.shift();
    this.push();
  }

  state() {
    return {
      activeId: this.activeId,
      isPrivate: this.isPrivate,
      portable: roots.portable,
      root: roots.root,
      settings: settings(),
      downloads: this.downloads.slice(-8),
      tabs: this.tabs.map((tab) => {
        const wc = tab.view.webContents;
        const history = wc.navigationHistory;
        return {
          id: tab.id,
          title: tab.title,
          url: tab.url,
          loading: tab.loading,
          canGoBack: history ? history.canGoBack() : false,
          canGoForward: history ? history.canGoForward() : false,
          zoom: wc.getZoomLevel(),
        };
      }),
    };
  }

  push() {
    this.send({});
  }

  send(payload) {
    try {
      if (!this.chrome.webContents.isDestroyed()) {
        this.chrome.webContents.send("browser:state", { ...this.state(), ...payload });
      }
    } catch {
      /* the window is closing */
    }
  }

  sendSugar(event) {
    try {
      if (!this.chrome.webContents.isDestroyed()) {
        this.chrome.webContents.send("browser:sugar-event", event);
      }
    } catch {
      /* the window is closing */
    }
  }

  async confirm(request) {
    const { response } = await dialog.showMessageBox({
      type: "question",
      buttons: ["Allow", "No"],
      defaultId: 0,
      cancelId: 1,
      title: "SUGAR asks first",
      message: `SUGAR wants to: ${request.description}`,
      detail: "This touches a local file or a page's contents. SUGAR always asks first (§13).",
    });
    return response === 0;
  }

  /* ------------------------------------------------ page-reading helpers */

  async pageText(tab, max = 20000) {
    if (!tab) return "";
    try {
      const text = await tab.view.webContents.executeJavaScript(
        "document.body ? (document.body.innerText || '') : ''",
        true,
      );
      return String(text || "").slice(0, max);
    } catch {
      return "";
    }
  }

  /** The first couple of sentences of a page — the honest local answer. */
  localSummary(text, sentences = 3) {
    const clean = String(text || "").replace(/\s+/g, " ").trim();
    if (!clean) return "";
    const parts = clean.match(/[^.!?]+[.!?]?/g) ?? [clean];
    return parts.slice(0, sentences).join(" ").trim();
  }

  /* ------------------------------------------------ SUGAR's browser side */

  adapter() {
    return {
      open: async (url) => this.openUrl(url),
      search: async (query) =>
        this.openUrl(String(settings().search).replace("%s", encodeURIComponent(query))),
      newTab: async () => this.newTab(START_URL),
      closeTab: async (which) => this.closeTabs(which),
      switchTab: async (direction) => this.switchTab(direction),
      nav: async (action) => this.navAction(action),
      bookmark: async () => this.bookmarkActive(),
      listBookmarks: async () => stores.bookmarks.read(),
      download: async () => this.downloadActive(),
      openDownload: async () => this.openLastDownload(),
      readPage: async () => this.readPage(),
      explain: async () => this.explainPage(),
      summarise: async () => this.summarisePage(),
      compare: async () => this.comparePages(),
      find: async (text) => this.findOnPage(text),
      savePage: async () => this.saveActivePage(),
      fillForm: async () => this.fillActiveForm(),
    };
  }

  closeTabs(which) {
    if (which === "other") {
      for (const tab of [...this.tabs]) if (tab.id !== this.activeId) this.closeTab(tab.id);
      return;
    }
    if (this.activeId) this.closeTab(this.activeId);
  }

  switchTab(direction) {
    if (this.tabs.length < 2) return;
    const index = this.tabs.findIndex((tab) => tab.id === this.activeId);
    const next =
      direction === "prev"
        ? (index - 1 + this.tabs.length) % this.tabs.length
        : (index + 1) % this.tabs.length;
    this.activate(this.tabs[next].id);
  }

  navAction(action) {
    const tab = this.active();
    if (!tab) return;
    const wc = tab.view.webContents;
    const history = wc.navigationHistory;
    if (action === "back" && history.canGoBack()) history.goBack();
    else if (action === "forward" && history.canGoForward()) history.goForward();
    else if (action === "reload") wc.reload();
    else if (action === "stop") wc.stop();
    else if (action === "home") this.load(tab, START_URL);
  }

  bookmarkActive() {
    const tab = this.active();
    if (!tab) throw new Error("There is no page open.");
    const url = tab.view.webContents.getURL() || tab.url;
    if (!url || url.startsWith("file://")) throw new Error("There is nothing here to bookmark.");
    const entry = { title: tab.title || url, url, at: Date.now() };
    stores.bookmarks.remove((item) => item.url === url);
    stores.bookmarks.add(entry);
    this.push();
    return entry;
  }

  downloadActive() {
    const tab = this.active();
    if (!tab) throw new Error("There is no page open.");
    const wc = tab.view.webContents;
    const url = wc.getURL();
    if (/\.(pdf|zip|7z|rar|tar|gz|tgz|mp3|mp4|mkv|webm|png|jpe?g|gif|webp|svg|docx?|xlsx?|pptx?|csv|txt|exe|msi|dmg|apk|iso|epub)([?#].*)?$/i.test(url)) {
      wc.downloadURL(url);
      return;
    }
    return wc
      .executeJavaScript(
        "(() => { const a=[...document.querySelectorAll('a')].find(x=>x.hasAttribute('download')||/\\.(pdf|zip|7z|tar\\.gz|tgz|mp3|mp4|png|jpe?g|docx?|xlsx?|pptx?|csv|txt|exe|msi|iso|epub)([?#].*)?$/i.test(x.getAttribute('href')||'')); return a ? a.href : null; })()",
        true,
      )
      .then((href) => {
        if (!href) throw new Error("I could not find a file to download on this page.");
        wc.downloadURL(href);
      });
  }

  openLastDownload() {
    const list = stores.downloads.read();
    const last = list[list.length - 1];
    if (!last || !last.path) return null;
    const target = security.assertInside(roots.root, last.path);
    void shell.openPath(target);
    return last.name || target;
  }

  async readPage() {
    const tab = this.active();
    if (!tab) throw new Error("There is no page open.");
    const text = await this.pageText(tab, 4000);
    if (!text) throw new Error("There was nothing on the page to read.");
    // Read in full by the UI; the controller only keeps the preview.
    this.sendSugar({ type: "speak", text });
    return text;
  }

  async explainPage() {
    const tab = this.active();
    if (!tab) throw new Error("There is no page open.");
    const text = await this.pageText(tab, 8000);
    const model = await askModel({
      system: "You explain web pages in at most three short sentences. Plain language, no preamble.",
      user: `Page title: ${tab.title}\nURL: ${tab.url}\n\n${text}`,
    });
    if (model) return model;
    return this.localSummary(text, 3) || `This is ${tab.title || tab.url}.`;
  }

  async summarisePage() {
    const tab = this.active();
    if (!tab) throw new Error("There is no page open.");
    const text = await this.pageText(tab, 12000);
    const model = await askModel({
      system: "You summarise web pages in a short paragraph followed by at most five bullet points.",
      user: `Page title: ${tab.title}\nURL: ${tab.url}\n\n${text}`,
    });
    if (model) return model;
    return this.localSummary(text, 5) || `This is ${tab.title || tab.url}.`;
  }

  async comparePages() {
    const tabs = this.tabs.filter((tab) => {
      const url = tab.view.webContents.getURL();
      return url && !url.startsWith("file://");
    });
    if (tabs.length < 2) throw new Error("Open at least two pages and I can compare them.");
    const parts = [];
    for (const tab of tabs.slice(0, 4)) {
      const text = await this.pageText(tab, 3000);
      parts.push({ title: tab.title, url: tab.url, excerpt: this.localSummary(text, 2) });
    }
    const model = await askModel({
      system: "You compare web pages. Name the differences that matter, in a short paragraph.",
      user: JSON.stringify(parts),
    });
    if (model) return model;
    return parts.map((part) => `${part.title}: ${part.excerpt}`).join("\n\n");
  }

  findOnPage(text) {
    const tab = this.active();
    if (!tab || !text) return false;
    const result = tab.view.webContents.findInPage(text);
    return Boolean(result && result.matches);
  }

  async saveActivePage() {
    const tab = this.active();
    if (!tab) throw new Error("There is no page open.");
    const name = security.safeFileName(`${tab.title || "page"}.html`, "page.html");
    const target = security.assertInside(roots.root, path.join(roots.dirs.downloads, name));
    await tab.view.webContents.savePage(target, "HTMLComplete");
    stores.downloads.add({ name, url: tab.url, path: target, at: Date.now(), state: "saved" });
    return target;
  }

  async fillActiveForm() {
    const tab = this.active();
    if (!tab) throw new Error("There is no page open.");
    const wc = tab.view.webContents;
    const fields = await wc
      .executeJavaScript(
        "(() => [...document.querySelectorAll('input,textarea,select')].filter(e=>e.offsetParent!==null && e.type!=='hidden').map(e=>({name:e.name||e.id||'',type:e.type||e.tagName.toLowerCase(),label:(e.labels&&e.labels[0]&&e.labels[0].innerText)||e.placeholder||''})))()",
        true,
      )
      .catch(() => []);
    if (!fields || !fields.length) throw new Error("There is no form on this page.");
    const model = await askModel({
      system:
        'You fill web forms. Reply with ONLY a JSON object mapping each field name to a value string. Use "" when you cannot know a value.',
      user: JSON.stringify(fields),
    });
    if (!model) {
      throw new Error(
        "Filling a form needs a local AI model so SUGAR knows what to type. Configure one in SUGAR settings, or fill it in yourself.",
      );
    }
    let values = {};
    try {
      values = JSON.parse(model.replace(/^```(?:json)?|```$/g, "").trim());
    } catch {
      throw new Error("The model's answer was not usable as form values, so nothing was typed.");
    }
    await wc.executeJavaScript(
      `(() => { const values = ${JSON.stringify(values)}; for (const [name, value] of Object.entries(values)) { const el = document.querySelector('[name="'+name+'"], #'+name); if (el && value) { el.focus(); el.value = value; el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); } } return true; })()`,
      true,
    );
    return true;
  }
}

/* ----------------------------------------------------------------- windows */

const windows = new Set();

function createWindow(options) {
  const win = new SugarWindow(options);
  windows.add(win);
  win.window.on("closed", () => windows.delete(win));
  return win;
}

function windowFor(event) {
  for (const win of windows) {
    if (win.chrome.webContents.id === event.sender.id) return win;
  }
  return null;
}

/* --------------------------------------------------------------- sessions */

function isOnline() {
  try {
    return net.isOnline();
  } catch {
    return true;
  }
}

function hardenSession(partition) {
  const ses = session.fromPartition(partition);

  // Spelling, on by default and in English, so prose fields carry Chromium's
  // squiggles and its correction menu. If the platform ships no dictionary
  // this is a no-op rather than a failure.
  try {
    ses.setSpellCheckerEnabled(true);
    ses.setSpellCheckerLanguages(["en-US"]);
  } catch {
    /* no dictionaries on this platform — the browser still works */
  }

  // §13: the narrowest set a browser can work with. Everything a browser has no
  // business with (USB, serial, HID) is refused rather than handed over.
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(security.isAllowedPermission(permission));
  });
  ses.setPermissionCheckHandler((_wc, permission) => security.isAllowedPermission(permission));

  ses.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer
      .getSources({ types: ["screen", "window"] })
      .then((sources) => callback({ video: sources[0], audio: "loopback" }))
      .catch(() => callback({}));
  });

  return ses;
}

function wireDownloads(ses) {
  ses.on("will-download", (event, item) => {
    // Real downloads, into the SUGAR Browser folder in portable mode and into
    // the machine's Downloads folder otherwise.
    const name = security.safeFileName(item.getFilename(), "download");
    const target = security.assertInside(roots.root, path.join(roots.dirs.downloads, name));
    item.setSavePath(target);

    const entry = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      name,
      url: item.getURL(),
      path: target,
      received: 0,
      total: item.getTotalBytes(),
      state: "progress",
      at: Date.now(),
    };
    for (const win of windows) win.onDownload({ ...entry });

    item.on("updated", (_e, state) => {
      entry.received = item.getReceivedBytes();
      entry.total = item.getTotalBytes();
      entry.state = state === "interrupted" ? "interrupted" : "progress";
      for (const win of windows) win.onDownload({ ...entry });
    });

    item.on("done", (_e, state) => {
      entry.state = state;
      entry.received = item.getReceivedBytes();
      stores.downloads.add({ ...entry });
      for (const win of windows) win.onDownload({ ...entry });
    });
  });
}

/* ------------------------------------------------------------------- menu */

function buildMenu() {
  const send = (channel, payload) => {
    const focused = BaseWindow.getFocusedWindow();
    for (const win of windows) {
      if (focused && win.window.id !== focused.id) continue;
      win.send({ menu: channel, ...(payload ?? {}) });
    }
  };

  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    {
      label: "File",
      submenu: [
        { label: "New Tab", accelerator: "CmdOrCtrl+T", click: () => send("new-tab") },
        { label: "New Window", accelerator: "CmdOrCtrl+N", click: () => createWindow({}) },
        { label: "New Private Window", accelerator: "CmdOrCtrl+Shift+N", click: () => createWindow({ isPrivate: true }) },
        { type: "separator" },
        { label: "Close Tab", accelerator: "CmdOrCtrl+W", click: () => send("close-tab") },
        { role: isMac ? "close" : "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
        { type: "separator" },
        { label: "Find in Page", accelerator: "CmdOrCtrl+F", click: () => send("find") },
      ],
    },
    {
      label: "SUGAR",
      submenu: [
        { label: "Ask SUGAR…", accelerator: "CmdOrCtrl+K", click: () => send("sugar") },
        { label: "Read This Page Aloud", click: () => send("sugar-command", { text: "read this page to me" }) },
        { label: "Explain This Page", click: () => send("sugar-command", { text: "explain what I'm looking at" }) },
        { label: "Compare Open Pages", click: () => send("sugar-command", { text: "compare these pages" }) },
        { type: "separator" },
        { label: "Bookmark This Page", accelerator: "CmdOrCtrl+D", click: () => send("sugar-command", { text: "bookmark this page" }) },
        { type: "separator" },
        { label: "SUGAR Settings…", accelerator: "CmdOrCtrl+,", click: () => send("sugar-settings") },
      ],
    },
    {
      label: "View",
      submenu: [
        { label: "Reload", accelerator: "CmdOrCtrl+R", click: () => send("reload") },
        { label: "Stop", click: () => send("stop") },
        { type: "separator" },
        { label: "Zoom In", accelerator: "CmdOrCtrl+Plus", click: () => send("zoom", { delta: 0.5 }) },
        { label: "Zoom Out", accelerator: "CmdOrCtrl+-", click: () => send("zoom", { delta: -0.5 }) },
        { label: "Reset Zoom", accelerator: "CmdOrCtrl+0", click: () => send("zoom", { delta: null }) },
        { type: "separator" },
        { label: "Developer Tools", accelerator: isMac ? "Alt+Cmd+I" : "Ctrl+Shift+I", click: () => send("devtools") },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "History",
      submenu: [
        { label: "Back", accelerator: isMac ? "Cmd+[" : "Alt+Left", click: () => send("back") },
        { label: "Forward", accelerator: isMac ? "Cmd+]" : "Alt+Right", click: () => send("forward") },
        { type: "separator" },
        { label: "Home", accelerator: isMac ? "Cmd+Shift+H" : "Alt+Home", click: () => send("home") },
      ],
    },
    {
      label: "Privacy",
      submenu: [
        { label: "Clear Browsing Data…", click: () => send("clear-data") },
        { type: "separator" },
        { label: "Open a page in the system browser", click: () => send("open-external") },
      ],
    },
    { role: "windowMenu" },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ------------------------------------------------------------------ start */

app.whenReady().then(() => {
  hardenSession("persist:sugar-browser");
  wireDownloads(session.fromPartition("persist:sugar-browser"));
  buildMenu();
  createWindow({});

  app.on("activate", () => {
    if (!windows.size) createWindow({});
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

/* --------------------------------------------------------------- the IPC */

ipcMain.handle("browser:state", (event) => windowFor(event)?.state() ?? null);
ipcMain.handle("browser:settings", (event) => ({ ...settings(), root: roots.root, portable: roots.portable }));
ipcMain.handle("browser:online", () => isOnline());

ipcMain.handle("browser:new-tab", (event, url) => {
  const win = windowFor(event);
  if (!win) return null;
  return win.newTab(url || START_URL);
});

ipcMain.handle("browser:close-tab", (event, id) => {
  windowFor(event)?.closeTab(id);
  return true;
});

ipcMain.handle("browser:activate-tab", (event, id) => {
  windowFor(event)?.activate(id);
  return true;
});

ipcMain.handle("browser:go", (event, url) => {
  windowFor(event)?.navigate(url);
  return true;
});

const withTab = (event, fn) => {
  const tab = windowFor(event)?.active();
  if (!tab) return null;
  return fn(tab.view.webContents);
};

ipcMain.handle("browser:back", (event) =>
  withTab(event, (wc) => {
    if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  }),
);
ipcMain.handle("browser:forward", (event) =>
  withTab(event, (wc) => {
    if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  }),
);
ipcMain.handle("browser:reload", (event) => withTab(event, (wc) => wc.reload()));
ipcMain.handle("browser:stop", (event) => withTab(event, (wc) => wc.stop()));
ipcMain.handle("browser:home", (event) => {
  const win = windowFor(event);
  const tab = win?.active();
  if (win && tab) win.load(tab, START_URL);
  return null;
});

ipcMain.handle("browser:find", (event, { text, forward, findNext }) =>
  withTab(event, (wc) => {
    if (!text) {
      wc.stopFindInPage("clearSelection");
      return null;
    }
    return wc.findInPage(text, { forward: forward !== false, findNext: Boolean(findNext) });
  }),
);
ipcMain.handle("browser:find-stop", (event) => withTab(event, (wc) => wc.stopFindInPage("clearSelection")));

ipcMain.handle("browser:zoom", (event, delta) =>
  withTab(event, (wc) => {
    const next = delta === null || delta === undefined ? 0 : wc.getZoomLevel() + delta;
    wc.setZoomLevel(Math.max(-3, Math.min(5, next)));
    return wc.getZoomLevel();
  }),
);

ipcMain.handle("browser:devtools", (event) => withTab(event, (wc) => wc.openDevTools({ mode: "detach" })));

ipcMain.handle("browser:open-external", (event, url) => {
  const win = windowFor(event);
  const target = url || win?.active()?.url;
  if (target && !target.startsWith("file://")) void shell.openExternal(target);
  return true;
});

ipcMain.handle("browser:new-window", () => {
  createWindow({});
  return true;
});
ipcMain.handle("browser:new-private-window", () => {
  const win = createWindow({ isPrivate: true });
  hardenSession(win.partition);
  wireDownloads(session.fromPartition(win.partition));
  return true;
});

ipcMain.handle("browser:clear-data", async (event) => {
  const win = windowFor(event);
  const ses = session.fromPartition(win?.partition ?? "persist:sugar-browser");
  await ses.clearStorageData();
  await ses.clearCache();
  return true;
});

ipcMain.handle("browser:set-chrome-height", (event, height) => {
  const win = windowFor(event);
  if (!win) return null;
  win.chromeHeight = Math.max(CHROME_HEIGHT, Math.min(520, Number(height) || CHROME_HEIGHT));
  win.layout();
  return win.chromeHeight;
});

ipcMain.handle("browser:open-downloads", () => {
  void shell.openPath(roots.dirs.downloads);
  return true;
});

// The Edit actions the always-visible toolbar offers, applied to the page.
ipcMain.handle("browser:edit", (event, action) =>
  withTab(event, (wc) => {
    const actions = {
      undo: () => wc.undo(),
      redo: () => wc.redo(),
      cut: () => wc.cut(),
      copy: () => wc.copy(),
      paste: () => wc.paste(),
      selectAll: () => wc.selectAll(),
    };
    if (typeof actions[action] === "function") actions[action]();
    return true;
  }),
);

ipcMain.handle("browser:copy-link", (event) => {
  const tab = windowFor(event)?.active();
  if (!tab) return false;
  clipboard.writeText(tab.view.webContents.getURL() || tab.url || "");
  return true;
});

ipcMain.handle("browser:save-page", async (event) => {
  const win = windowFor(event);
  if (!win) return false;
  try {
    await win.saveActivePage();
    return true;
  } catch {
    return false;
  }
});

/* ---------------------------------------------------------------- SUGAR */

ipcMain.handle("browser:sugar", async (event, text) => {
  const win = windowFor(event);
  if (!win) return { ok: false, results: [], note: "No window is listening." };
  const plan = parseCommand(text);
  return win.controller.execute(plan, { source: "user" });
});

ipcMain.handle("browser:sugar-providers", async () => {
  try {
    const found = await providers.detectLocal(fetch);
    detected = { at: Date.now(), list: found }; // the panel's probe is the next question's, too
    return found.map((entry) => ({ id: entry.id, name: entry.name, models: entry.models, base: entry.base }));
  } catch {
    return [];
  }
});

ipcMain.handle("browser:bookmarks", () => stores.bookmarks.read());
ipcMain.handle("browser:history", (event, query) => stores.history.search(query ?? "", 50));

ipcMain.handle("browser:settings-save", (_event, patch) => {
  const clean = {};
  if (patch && typeof patch === "object") {
    if (typeof patch.home === "string") clean.home = patch.home;
    if (typeof patch.search === "string") clean.search = patch.search;
    if (typeof patch.theme === "string") clean.theme = patch.theme;
    if (typeof patch.askBeforeAi === "boolean") clean.askBeforeAi = patch.askBeforeAi;
    if (typeof patch.restoreTabs === "boolean") clean.restoreTabs = patch.restoreTabs;
    if (patch.ai && typeof patch.ai === "object") clean.ai = { ...settings().ai, ...patch.ai };
    if (patch.updates && typeof patch.updates === "object") clean.updates = { ...settings().updates, ...patch.updates };
  }
  stores.settings.patch(clean);
  if (patch && typeof patch === "object" && patch.ai) detected = { at: 0, list: [] };
  for (const win of windows) win.push();
  return { ...settings(), root: roots.root, portable: roots.portable };
});

ipcMain.handle("browser:updates-local", () => updates.localPackages(roots.dirs.updates));

ipcMain.handle("browser:update-check", async () => {
  const config = settings();
  return updates.checkFeed({
    url: config.updates?.feed || "",
    currentVersion: APP_VERSION,
    fetchImpl: fetch,
  });
});
