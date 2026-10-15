// SUGAR Browser — the controller that carries out a plan (§6, §8).
//
// The command layer (`ai/sugar.js`) turns a sentence into steps. This file takes
// those steps and *does* them, one at a time, reporting progress as it goes so
// the person can watch SUGAR work rather than being told afterwards.
//
// It never touches Electron or the network itself. Everything it can do is a
// method on a `browser` adapter handed to it, which is what makes it testable on
// a machine that cannot open a window — and what keeps the privileged code in
// one place (the main process) instead of scattered through the UI.
"use strict";

const { parseCommand, describeStep } = require("./ai/sugar.js");

/** The steps that write a file, open a local file, or act on a page's contents. */
const PERMISSION_STEPS = new Set(["fill-form", "download", "open-download", "save-page"]);

function preview(text, max = 140) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

class SugarController {
  constructor({
    browser,
    stores = null,
    events = () => {},
    isOnline = () => true,
    requestPermission = async () => true,
  } = {}) {
    if (!browser) throw new Error("SugarController needs a browser adapter.");
    this.browser = browser;
    this.stores = stores;
    this.events = events;
    this.isOnline = isOnline;
    this.requestPermission = requestPermission;
    this.running = false;
  }

  emit(event) {
    try {
      this.events(event);
    } catch {
      /* a listener that throws must not stop SUGAR working */
    }
  }

  /** Carry out a plan. Accepts either a parsed plan or a raw sentence. */
  async execute(planOrText, { source = "local" } = {}) {
    const plan = typeof planOrText === "string" ? parseCommand(planOrText) : planOrText;
    const steps = Array.isArray(plan?.steps) ? plan.steps : [];

    this.emit({ type: "start", text: plan?.text ?? "", total: steps.length, source });

    if (!steps.length) {
      const note = "I did not hear anything to do.";
      this.emit({ type: "done", ok: false, results: [], note });
      return { ok: false, results: [], note };
    }

    // §6: the person is told when something needs the internet, rather than the
    // command silently failing. SUGAR's local commands keep working offline.
    if (plan.needsNetwork && !this.isOnline()) {
      const note = "That needs the internet, and this machine is offline. SUGAR's local commands still work.";
      this.emit({ type: "done", ok: false, results: [], note });
      return { ok: false, results: [], note };
    }

    if (this.running) {
      const note = "SUGAR is already busy. Give it a moment.";
      this.emit({ type: "done", ok: false, results: [], note });
      return { ok: false, results: [], note };
    }

    this.running = true;
    const results = [];
    try {
      for (let index = 0; index < steps.length; index += 1) {
        const step = steps[index];
        const description = describeStep(step);
        this.emit({ type: "step", index, total: steps.length, step, description, status: "start" });
        try {
          const note = await this.runStep(step);
          results.push({ step, ok: true, note });
          this.emit({ type: "step", index, total: steps.length, step, description, status: "done", note });
        } catch (error) {
          const note = error instanceof Error ? error.message : String(error);
          results.push({ step, ok: false, note });
          this.emit({ type: "step", index, total: steps.length, step, description, status: "error", note });
        }
      }
    } finally {
      this.running = false;
    }

    const ok = results.length > 0 && results.every((result) => result.ok);
    this.emit({ type: "done", ok, results });
    return { ok, results };
  }

  /** A sentence in, a plan carried out. */
  run(input, options) {
    return this.execute(parseCommand(input), options);
  }

  async runStep(step) {
    const browser = this.browser;

    // §13: a step that writes a file or acts on a page asks first.
    if (PERMISSION_STEPS.has(step.kind)) {
      const allowed = await this.requestPermission({ kind: step.kind, description: describeStep(step) });
      if (!allowed) throw new Error("You did not allow that, so SUGAR stopped.");
    }

    switch (step.kind) {
      case "open":
        await browser.open(step.url);
        return `Opened ${step.url}`;

      case "search":
        await browser.search(step.query);
        return `Searched for “${step.query}”`;

      case "new-tab":
        await browser.newTab();
        return "Opened a new tab";

      case "close-tab":
        await browser.closeTab(step.which);
        return describeStep(step);

      case "switch-tab":
        await browser.switchTab(step.direction);
        return describeStep(step);

      case "nav":
        await browser.nav(step.action);
        return describeStep(step);

      case "bookmark": {
        const bookmark = await browser.bookmark();
        return bookmark?.title ? `Bookmarked ${bookmark.title}` : "Bookmarked this page";
      }

      case "bookmarks-list": {
        const list = (await browser.listBookmarks()) ?? [];
        return list.length ? `${list.length} bookmark${list.length === 1 ? "" : "s"}` : "There are no bookmarks yet";
      }

      case "download":
        await browser.download();
        return "Started the download";

      case "open-download": {
        const opened = await browser.openDownload();
        return opened ? `Opened ${preview(opened, 60)}` : "There is nothing downloaded to open";
      }

      case "read-page": {
        const text = await browser.readPage();
        return text ? `Read it aloud: “${preview(text)}”` : "There was nothing on the page to read";
      }

      case "explain": {
        const text = await browser.explain();
        return text ? preview(text) : "I could not explain this page";
      }

      case "summarise": {
        const text = await browser.summarise();
        return text ? preview(text) : "I could not summarise this page";
      }

      case "compare": {
        const text = await browser.compare();
        return text ? preview(text) : "There is nothing open to compare";
      }

      case "find": {
        const found = await browser.find(step.text);
        return found ? `Found “${step.text}”` : `Did not find “${step.text}”`;
      }

      case "save-page": {
        const saved = await browser.savePage();
        return saved ? `Saved to ${preview(saved, 60)}` : "Saved this page";
      }

      case "fill-form":
        await browser.fillForm();
        return "Filled the form";

      default:
        throw new Error(`I did not understand “${step.text ?? ""}”`);
    }
  }
}

module.exports = { SugarController, PERMISSION_STEPS };
