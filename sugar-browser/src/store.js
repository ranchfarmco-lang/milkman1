// SUGAR Browser — the local data store.
//
// Everything the browser remembers about itself lives in plain JSON files under
// the browser's own directory: the settings, the bookmarks, the history, the
// downloads index, and what SUGAR has been asked to do. No database to install,
// no server to reach, nothing in the cloud — a person can open these files in a
// text editor and see exactly what the browser knows (§2, §17).
//
// Writes are atomic: a temporary file is written and then renamed over the real
// one, so a crash or a yanked USB stick cannot leave a half-written file behind.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

class JsonStore {
  constructor(file, defaults = {}) {
    this.file = file;
    this.defaults = defaults;
  }

  read() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...this.defaults };
      return { ...this.defaults, ...raw };
    } catch {
      // Missing, empty, or unreadable: the defaults are the honest answer, and
      // the caller is never handed a half-loaded object.
      return { ...this.defaults };
    }
  }

  write(value) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.renameSync(temporary, this.file);
    return value;
  }

  patch(partial) {
    return this.write({ ...this.read(), ...partial });
  }
}

class ListStore {
  constructor(file, { max = 5000 } = {}) {
    this.file = file;
    this.max = max;
  }

  read() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }

  write(list) {
    const trimmed = list.length > this.max ? list.slice(list.length - this.max) : list;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(trimmed, null, 2)}\n`, "utf8");
    fs.renameSync(temporary, this.file);
    return trimmed;
  }

  /** Newest last, and the oldest fall off the end rather than growing forever. */
  add(entry) {
    const list = this.read();
    list.push(entry);
    return this.write(list);
  }

  remove(predicate) {
    const kept = this.read().filter((entry) => !predicate(entry));
    this.write(kept);
    return kept;
  }

  clear() {
    this.write([]);
  }

  search(query, limit = 50) {
    const needle = String(query || "").trim().toLowerCase();
    if (!needle) return [];
    const found = [];
    const list = this.read();
    for (let i = list.length - 1; i >= 0 && found.length < limit; i -= 1) {
      const entry = list[i];
      const haystack = `${entry.title ?? ""} ${entry.url ?? ""} ${entry.text ?? ""}`.toLowerCase();
      if (haystack.includes(needle)) found.push(entry);
    }
    return found;
  }
}

/** The whole local data layer, wired to the portable tree. */
function createStores(dirs) {
  return {
    settings: new JsonStore(dirs.settingsFile, DEFAULT_SETTINGS),
    bookmarks: new ListStore(dirs.bookmarks, { max: 5000 }),
    history: new ListStore(dirs.history, { max: 5000 }),
    downloads: new ListStore(dirs.downloadsIndex, { max: 2000 }),
    commands: new ListStore(dirs.commands, { max: 2000 }),
  };
}

/**
 * The defaults SUGAR Browser starts from. Every one of them is local: nothing
 * here reaches a network, and the browser is fully usable with the whole file
 * deleted and rebuilt (§11, §12).
 */
const DEFAULT_SETTINGS = {
  home: "local:start",
  search: "https://duckduckgo.com/?q=%s",
  theme: "dark",
  restoreTabs: true,
  askBeforeAi: true,
  // AI is optional. With no provider configured, SUGAR still runs its own
  // local command parser and never needs the network.
  ai: {
    preferLocal: true,
    providers: [],
    autoDetectLocal: true,
  },
  // Updates are never automatic. A feed is only ever checked to *tell* you.
  updates: {
    feed: "",
    checkOnLaunch: false,
  },
};

module.exports = { JsonStore, ListStore, createStores, DEFAULT_SETTINGS };
