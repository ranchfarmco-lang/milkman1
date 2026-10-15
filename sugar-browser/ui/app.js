// SUGAR Browser's own chrome: tabs, the omnibox, find, downloads, and SUGAR.
//
// It draws only the strip; the pages are native views the main process puts
// underneath it. So this file never touches a page — it asks the main process
// and draws whatever comes back. SUGAR works the same way: this file sends a
// sentence and draws the progress the main process streams back, which is what
// makes SUGAR's work visible rather than invisible (§8).
"use strict";

const api = window.browser;

// The strip's own pieces, so it can grow to fit what is showing.
// tabs (34) + toolbar (44) + the always-visible action bar (32).
const BASE_HEIGHT = 110;
const SUGAR_HEIGHT = 220;
const FIND_HEIGHT = 38;
const DOWNLOADS_HEIGHT = 34;

const el = (id) => document.getElementById(id);

let state = { tabs: [], activeId: null, downloads: [], settings: {}, isPrivate: false, portable: false, root: "" };
let findOpen = false;
let downloadsOpen = false;
let findResult = null;
let editingAddress = false;
let sugarOpen = false;
let settingsOpen = false;

/** SUGAR's visible progress log, newest last. */
let sugarLines = [];
let shouting = false;

async function applyHeight() {
  const height =
    BASE_HEIGHT +
    (sugarOpen ? SUGAR_HEIGHT : 0) +
    (findOpen ? FIND_HEIGHT : 0) +
    (downloadsOpen ? DOWNLOADS_HEIGHT : 0);
  await api.setChromeHeight(height);
}

/* ------------------------------------------------------------------ render */

function render() {
  const active = state.tabs.find((tab) => tab.id === state.activeId) || null;

  const strip = el("tabs");
  strip.textContent = "";
  for (const tab of state.tabs) {
    const node = document.createElement("div");
    node.className = `tab${tab.id === state.activeId ? " active" : ""}`;
    node.title = `${tab.title}\n${tab.url}`;
    node.addEventListener("click", () => void api.activateTab(tab.id));
    node.addEventListener("auxclick", (event) => {
      if (event.button === 1) void api.closeTab(tab.id);
    });

    if (tab.loading) {
      const spinner = document.createElement("span");
      spinner.className = "spinner";
      node.appendChild(spinner);
    }

    const title = document.createElement("span");
    title.className = "title";
    title.textContent = tab.title || tab.url || "New tab";
    node.appendChild(title);

    const close = document.createElement("button");
    close.className = "close";
    close.textContent = "×";
    close.title = "Close tab";
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      void api.closeTab(tab.id);
    });
    node.appendChild(close);

    strip.appendChild(node);
  }

  const add = document.createElement("button");
  add.className = "tab-add";
  add.textContent = "+";
  add.title = "New tab";
  add.addEventListener("click", () => void api.newTab());
  strip.appendChild(add);

  el("back").disabled = !active || !active.canGoBack;
  el("forward").disabled = !active || !active.canGoForward;
  el("zoom").textContent = active && active.zoom ? `${Math.round(Math.pow(1.2, active.zoom) * 100)}%` : "";

  const secure = active ? /^https:/i.test(active.url || "") : false;
  const lock = el("lock");
  lock.textContent = secure ? "🔒" : "●";
  lock.className = `lock${active && !secure ? " insecure" : ""}`;

  if (!editingAddress) el("address").value = active ? active.url || "" : "";

  const downloads = state.downloads || [];
  el("dl-badge").textContent = downloads.length ? String(downloads.length) : "";
  if (downloadsOpen) {
    const last = downloads[downloads.length - 1];
    el("dl-line").textContent = !last
      ? "No downloads yet."
      : last.state === "completed"
        ? `Saved ${last.name}`
        : last.state === "progress"
          ? `Downloading ${last.name}…`
          : `${last.name} — ${last.state}`;
  }

  el("sugar-toggle").classList.toggle("active", sugarOpen);
}

function renderFind() {
  if (!findResult) {
    el("find-matches").textContent = "";
    return;
  }
  const { activeMatchOrdinal, matches } = findResult;
  el("find-matches").textContent = matches ? `${activeMatchOrdinal}/${matches}` : "0/0";
}

function setFace(mode) {
  el("sugar-face").dataset.state = mode;
}

function renderSugar() {
  const log = el("sugar-log");
  log.textContent = "";
  for (const line of sugarLines) {
    const node = document.createElement("div");
    node.className = `sugar-line ${line.role}${line.status ? ` ${line.status}` : ""}`;
    const mark = document.createElement("span");
    mark.className = "mark";
    mark.textContent =
      line.role === "you" ? "›" : line.status === "error" ? "✕" : line.status === "done" ? "✓" : line.status === "start" ? "…" : "•";
    const text = document.createElement("span");
    text.className = "text";
    text.textContent = line.text;
    node.append(mark, text);
    log.appendChild(node);
  }
  log.scrollTop = log.scrollHeight;
}

function pushLine(line) {
  sugarLines.push(line);
  if (sugarLines.length > 80) sugarLines.splice(0, sugarLines.length - 80);
  renderSugar();
}

function updateStepLine(index, patch) {
  for (let i = sugarLines.length - 1; i >= 0; i -= 1) {
    if (sugarLines[i].stepIndex === index) {
      sugarLines[i] = { ...sugarLines[i], ...patch };
      renderSugar();
      return;
    }
  }
  pushLine({ role: "step", stepIndex: index, ...patch });
}

/* ------------------------------------------------------------ SUGAR panel */

function openSugar() {
  sugarOpen = true;
  el("sugar").classList.remove("hidden");
  void applyHeight();
  el("sugar-input").focus();
}
function closeSugar() {
  sugarOpen = false;
  settingsOpen = false;
  el("sugar").classList.add("hidden");
  void applyHeight();
}
function toggleSugar() {
  if (sugarOpen) closeSugar();
  else openSugar();
}

function toggleSettings() {
  settingsOpen = !settingsOpen;
  el("sugar-settings").classList.toggle("hidden", !settingsOpen);
  el("sugar-log").classList.toggle("hidden", settingsOpen);
  if (settingsOpen) void loadSettings();
}

async function loadSettings() {
  let config = {};
  try {
    config = (await api.settings()) || {};
  } catch {
    config = {};
  }
  state.settings = config;
  el("set-home").value = config.home ?? "local:start";
  el("set-search").value = config.search ?? "";
  el("set-theme").value = config.theme ?? "dark";
  el("set-ask").checked = config.askBeforeAi !== false;
  el("set-autodetect").checked = config.ai?.autoDetectLocal !== false;
  el("set-feed").value = config.updates?.feed ?? "";
  el("set-check").checked = Boolean(config.updates?.checkOnLaunch);
  el("set-info").textContent = `${config.portable ? "Portable" : "Installed"} · ${config.root || ""}`;
  void refreshLocalModels();
}

/** Show which model servers on this machine answered the panel's probe (§6). */
async function refreshLocalModels() {
  const box = el("set-models");
  if (!el("set-autodetect").checked) {
    box.textContent = "Automatic detection is off, so only the AI providers you configured yourself will be asked.";
    return;
  }
  box.textContent = "Looking for a model on this machine…";
  try {
    const found = (await api.sugarProviders()) || [];
    if (!found.length) {
      box.textContent =
        "No model answered. Start Ollama, LM Studio or a similar local model and open this panel again.";
      return;
    }
    box.textContent = `Answering from: ${found
      .map((entry) => {
        const models = Array.isArray(entry.models) ? entry.models : [];
        if (!models.length) return entry.name;
        const shown = models.slice(0, 3).join(", ");
        return `${entry.name} (${shown}${models.length > 3 ? `, +${models.length - 3} more` : ""})`;
      })
      .join(" · ")}`;
  } catch {
    box.textContent = "Could not check for a local model right now.";
  }
}

async function saveSettings() {
  const patch = {
    home: el("set-home").value.trim() || "local:start",
    search: el("set-search").value.trim() || "https://duckduckgo.com/?q=%s",
    theme: el("set-theme").value,
    askBeforeAi: el("set-ask").checked,
    ai: { autoDetectLocal: el("set-autodetect").checked },
    updates: { feed: el("set-feed").value.trim(), checkOnLaunch: el("set-check").checked },
  };
  const saved = await api.saveSettings(patch);
  state.settings = saved;
  pushLine({ role: "note", status: "done", text: "Settings saved to the browser's own folder." });
}

async function showLocalUpdates() {
  const found = await api.updatesLocal();
  if (!found || !found.length) {
    pushLine({ role: "note", text: "No updates dropped in the Updates folder. Put a newer build there and SUGAR will notice it." });
    return;
  }
  pushLine({ role: "note", status: "done", text: found.map((f) => `${f.name}${f.version ? ` (v${f.version})` : ""}`).join(", ") });
}

/* ------------------------------------------------------------------ voice */

function startVoice() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    pushLine({ role: "note", status: "error", text: "This machine's Chromium has no voice input available. Type instead." });
    return;
  }
  const recognition = new Recognition();
  recognition.lang = navigator.language || "en-US";
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  setFace("listening");
  el("sugar-mic").classList.add("active");
  recognition.onresult = (event) => {
    const transcript = event.results[0][0].transcript;
    el("sugar-input").value = transcript;
    void runCommand(transcript);
  };
  recognition.onerror = () => {
    pushLine({ role: "note", status: "error", text: "I did not catch that. Try again, or type it." });
  };
  recognition.onend = () => {
    el("sugar-mic").classList.remove("active");
    if (el("sugar-face").dataset.state === "listening") setFace("idle");
  };
  recognition.start();
}

function speak(text) {
  if (!text || !window.speechSynthesis) return;
  const utterance = new SpeechSynthesisUtterance(String(text).slice(0, 4000));
  setFace("speaking");
  shouting = true;
  utterance.onend = () => {
    shouting = false;
    setFace("idle");
  };
  utterance.onerror = () => {
    shouting = false;
    setFace("idle");
  };
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

/* --------------------------------------------------------- SUGAR commands */

async function runCommand(text) {
  const value = String(text || "").trim();
  if (!value) return;
  sugarLines = [];
  pushLine({ role: "you", text: value });
  renderSugar();
  setFace("working");
  el("sugar-input").value = "";
  try {
    const result = await api.sugar(value);
    if (result && result.note) pushLine({ role: "note", status: result.ok ? "done" : "error", text: result.note });
    if (!shouting) setFace("idle");
  } catch (error) {
    pushLine({ role: "note", status: "error", text: String(error && error.message ? error.message : error) });
    setFace("idle");
  }
}

/* ----------------------------------------------------------------- actions */

el("back").addEventListener("click", () => void api.back());
el("forward").addEventListener("click", () => void api.forward());
el("reload").addEventListener("click", () => {
  const active = state.tabs.find((tab) => tab.id === state.activeId);
  if (active && active.loading) void api.stop();
  else void api.reload();
});
el("home").addEventListener("click", () => void api.home());
el("external").addEventListener("click", () => void api.openExternal());
el("devtools").addEventListener("click", () => void api.devtools());

// the always-visible page actions
el("act-cut").addEventListener("click", () => void api.edit("cut"));
el("act-copy").addEventListener("click", () => void api.edit("copy"));
el("act-paste").addEventListener("click", () => void api.edit("paste"));
el("act-selectall").addEventListener("click", () => void api.edit("selectAll"));
el("act-copylink").addEventListener("click", () => void api.copyLink());
el("act-openlink").addEventListener("click", () => {
  const active = state.tabs.find((tab) => tab.id === state.activeId);
  if (active?.url) void api.newTab(active.url);
});
el("act-savepage").addEventListener("click", () => void api.savePage());
el("act-bookmark").addEventListener("click", () => void runCommand("bookmark this page"));
el("act-find").addEventListener("click", openFind);
el("act-delete").addEventListener("click", () => void api.clearBrowsingData());

el("omni").addEventListener("submit", (event) => {
  event.preventDefault();
  editingAddress = false;
  void api.go(el("address").value);
  el("address").blur();
});
el("address").addEventListener("focus", () => {
  editingAddress = true;
  el("address").select();
});
el("address").addEventListener("blur", () => {
  editingAddress = false;
});
el("address").addEventListener("keydown", (event) => {
  if (event.key === "Escape") el("address").blur();
});

// SUGAR
el("sugar-toggle").addEventListener("click", toggleSugar);
el("sugar-close").addEventListener("click", closeSugar);
el("sugar-gear").addEventListener("click", toggleSettings);
el("sugar-run").addEventListener("click", () => void runCommand(el("sugar-input").value));
el("sugar-mic").addEventListener("click", startVoice);
el("sugar-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter") void runCommand(el("sugar-input").value);
  if (event.key === "Escape") closeSugar();
});
el("set-save").addEventListener("click", () => void saveSettings());
el("set-updates").addEventListener("click", () => void showLocalUpdates());
el("set-autodetect").addEventListener("change", () => void refreshLocalModels());

// find
function openFind() {
  findOpen = true;
  el("findbar").classList.remove("hidden");
  void applyHeight();
  el("find-input").focus();
  el("find-input").select();
}
function closeFind() {
  findOpen = false;
  el("findbar").classList.add("hidden");
  void api.findStop();
  void applyHeight();
}
el("find-toggle").addEventListener("click", () => (findOpen ? closeFind() : openFind()));
el("find-close").addEventListener("click", closeFind);
el("find-input").addEventListener("input", () => {
  const text = el("find-input").value;
  if (text) void api.find(text, { findNext: false });
  else void api.findStop();
});
el("find-next").addEventListener("click", () => void api.find(el("find-input").value, { findNext: true, forward: true }));
el("find-prev").addEventListener("click", () => void api.find(el("find-input").value, { findNext: true, forward: false }));

// downloads
function toggleDownloads() {
  downloadsOpen = !downloadsOpen;
  el("dls").classList.toggle("hidden", !downloadsOpen);
  void applyHeight();
  render();
}
el("downloads").addEventListener("click", toggleDownloads);
el("dl-open").addEventListener("click", () => void api.openDownloadsFolder());

/* ------------------------------------------------------- the main process */

async function handleMenu(message) {
  switch (message.menu) {
    case "new-tab":
      await api.newTab();
      break;
    case "close-tab":
      if (state.activeId) await api.closeTab(state.activeId);
      break;
    case "reload":
      await api.reload();
      break;
    case "stop":
      await api.stop();
      break;
    case "back":
      await api.back();
      break;
    case "forward":
      await api.forward();
      break;
    case "home":
      await api.home();
      break;
    case "find":
      openFind();
      break;
    case "zoom":
      await api.zoom(message.delta === undefined ? null : message.delta);
      break;
    case "devtools":
      await api.devtools();
      break;
    case "clear-data":
      await api.clearBrowsingData();
      break;
    case "open-external":
      await api.openExternal();
      break;
    case "sugar":
      openSugar();
      break;
    case "sugar-settings":
      openSugar();
      if (!settingsOpen) toggleSettings();
      break;
    case "sugar-command":
      openSugar();
      await runCommand(message.text);
      break;
  }
}

api.onSugar((event) => {
  if (!event) return;
  if (event.type === "start") {
    if (!sugarLines.some((line) => line.role === "you")) sugarLines = [];
    setFace("working");
  } else if (event.type === "step") {
    updateStepLine(event.index, {
      role: "step",
      text: event.status === "done" && event.note ? `${event.description} — ${event.note}` : event.description,
      status: event.status,
    });
  } else if (event.type === "done") {
    if (event.note) pushLine({ role: "note", status: event.ok ? "done" : "error", text: event.note });
    if (!shouting) setFace(event.ok ? "happy" : "idle");
    if (event.ok) setTimeout(() => { if (!shouting) setFace("idle"); }, 1600);
  } else if (event.type === "speak") {
    speak(event.text);
  }
});

api.onState((next) => {
  if (!next) return;
  if (next.find) {
    findResult = next.find;
    renderFind();
  }
  if (next.menu) void handleMenu(next);
  state = { ...state, ...next };
  render();
});

render();
void applyHeight();
api
  .state()
  .then((initial) => {
    if (initial) {
      state = { ...state, ...initial };
      render();
    }
  })
  .catch(() => undefined);
