// SUGAR — the browser's own command layer (§6, §8).
//
// This is the part that works with no AI service, no network and no account.
// SUGAR turns a sentence into a plan: a list of concrete things to do to the
// browser. The plan is the same shape an AI provider is asked to produce, so a
// model is an *upgrade* to the understanding, never a requirement for using the
// browser or for the common commands working.
//
// Nothing here touches the browser or the network. It is a pure function, which
// is why it can be tested on a machine that cannot open a window.
"use strict";

/** Names people use, and where they go. */
const SITES = {
  google: "https://www.google.com/",
  youtube: "https://www.youtube.com/",
  wikipedia: "https://en.wikipedia.org/",
  github: "https://github.com/",
  reddit: "https://www.reddit.com/",
  amazon: "https://www.amazon.com/",
  duckduckgo: "https://duckduckgo.com/",
  "linux mint": "https://linuxmint.com/",
  maps: "https://www.openstreetmap.org/",
  weather: "https://www.weather.gov/",
  news: "https://news.google.com/",
  gmail: "https://mail.google.com/",
  email: "https://mail.google.com/",
  bank: "https://www.google.com/search?q=my+bank",
};

/** An address typed or spoken, or null if it is really a phrase. */
function normaliseUrl(text) {
  const value = String(text || "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/[.,;]+$/, "");
  if (!value) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
  if (/^(?:localhost|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:[/?#].*)?$/i.test(value)) {
    return `http://${value}`;
  }
  if (/^[\w-]+(?:\.[\w-]+)+(?::\d+)?(?:[/?#].*)?$/.test(value)) return `https://${value}`;
  return null;
}

/** A site name, or a name plus a path ("google maps"), if it is one. */
function siteUrl(name) {
  const key = String(name || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!key) return null;
  if (SITES[key]) return SITES[key];
  const [first, ...rest] = key.split(" ");
  if (rest.length && SITES[first]) return SITES[first];
  return null;
}

/** Split a sentence into the separate things it asks for. */
function splitCommands(text) {
  return String(text || "")
    .split(/\s*(?:;|\s+and then\s+|\s+then\s+)\s*/i)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** "open these three websites" style lists: split the argument on "and". */
function openMany(argument) {
  const parts = String(argument || "")
    .split(/\s+and\s+/i)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;
  const targets = parts.map((part) => normaliseUrl(part) ?? siteUrl(part));
  return targets.every(Boolean) ? targets : null;
}

const STEP_KINDS = [
  "open",
  "search",
  "new-tab",
  "close-tab",
  "switch-tab",
  "nav",
  "bookmark",
  "bookmarks-list",
  "download",
  "open-download",
  "read-page",
  "explain",
  "summarise",
  "compare",
  "find",
  "save-page",
  "fill-form",
  "unknown",
];

/** One command, turned into steps. */
function parseOne(raw) {
  const text = raw.trim();
  const lower = text.toLowerCase();

  // -- navigation ---------------------------------------------------------
  if (/^(?:please\s+)?(?:go\s+)?back$/.test(lower)) return [{ kind: "nav", action: "back" }];
  if (/^(?:go\s+)?forward$/.test(lower)) return [{ kind: "nav", action: "forward" }];
  if (/^(?:reload|refresh)(?:\s+the\s+page)?$/.test(lower)) return [{ kind: "nav", action: "reload" }];
  if (/^stop$/.test(lower)) return [{ kind: "nav", action: "stop" }];
  if (/^(?:go\s+)?home$|^start(?:\s+page)?$/.test(lower)) return [{ kind: "nav", action: "home" }];

  // -- tabs ---------------------------------------------------------------
  if (/^(?:open\s+)?(?:a\s+|another\s+|one\s+more\s+)?new\s+tab$/.test(lower)) return [{ kind: "new-tab" }];
  if (/^(?:open|add|give\s+me)\s+(?:a\s+|another\s+|one\s+more\s+)?tab$/.test(lower)) return [{ kind: "new-tab" }];
  if (/^(?:close|shut)\s+(?:that|this|the\s+current|the\s+active)\s+tab$/.test(lower)) {
    return [{ kind: "close-tab", which: "active" }];
  }
  if (/^close\s+(?:all\s+)?(?:the\s+)?other\s+tabs$/.test(lower)) {
    return [{ kind: "close-tab", which: "other" }];
  }
  if (/^(?:go\s+to\s+the\s+)?next\s+tab$/.test(lower)) return [{ kind: "switch-tab", direction: "next" }];
  if (/^(?:go\s+to\s+the\s+)?(?:previous|prev|last)\s+tab$/.test(lower)) {
    return [{ kind: "switch-tab", direction: "prev" }];
  }

  // -- the page in front of you -------------------------------------------
  if (/^read\s+(?:this\s+page|the\s+page|this|it)(?:\s+to\s+me)?(?:\s+aloud)?$/.test(lower)) {
    return [{ kind: "read-page" }];
  }
  if (/^(?:explain|what\s+is)\s+(?:this|the\s+page|what\s+i(?:'|\s+a)?m\s+looking\s+at)/.test(lower)) {
    return [{ kind: "explain" }];
  }
  if (/^(?:summari[sz]e|sum\s+up)/.test(lower)) return [{ kind: "summarise" }];
  if (/^compare\s+(?:these|the|my)?\s*(?:two\s+)?(?:pages|tabs|sites|websites)$/.test(lower)) {
    return [{ kind: "compare" }];
  }
  if (/^(?:find|search)\s+(?:for\s+)?(.+?)\s+(?:on|in)\s+(?:this|the)\s+page$/.test(lower)) {
    const match = /^(?:find|search)\s+(?:for\s+)?(.+?)\s+(?:on|in)\s+(?:this|the)\s+page$/.exec(lower);
    return [{ kind: "find", text: match ? match[1].replace(/^["']|["']$/g, "") : "" }];
  }
  if (/^find\s+on\s+(?:this|the)\s+page[:,\s]+(.+)$/.test(lower)) {
    const match = /^find\s+on\s+(?:this|the)\s+page[:,\s]+(.+)$/.exec(lower);
    return [{ kind: "find", text: match ? match[1].replace(/^["']|["']$/g, "") : "" }];
  }
  if (/^(?:save|download)\s+this\s+(?:page|website|site)$/.test(lower)) return [{ kind: "save-page" }];
  if (/^(?:download|get)\s+this\s+file$/.test(lower)) return [{ kind: "download" }];
  if (/^open\s+(?:the\s+)?(?:downloaded\s+file|last\s+download|file\s+i\s+downloaded)$/.test(lower)) {
    return [{ kind: "open-download" }];
  }
  if (/^(?:bookmark|save)\s+this\s+(?:page|website|site)$/.test(lower)) return [{ kind: "bookmark" }];
  if (/^(?:show|list|open)\s+(?:my\s+)?bookmarks$/.test(lower)) return [{ kind: "bookmarks-list" }];
  if (/^(?:fill|complete)\s+(?:this|the)\s+form$/.test(lower)) return [{ kind: "fill-form" }];

  // -- search and open ----------------------------------------------------
  if (/^search\s+(?:for\s+)?(.+)$/.test(lower)) {
    const match = /^search\s+(?:for\s+)?(.+)$/.exec(text);
    return [{ kind: "search", query: (match ? match[1] : text).replace(/^["']|["']$/g, "") }];
  }
  if (/^(?:look\s+up|google)\s+(.+)$/.test(lower)) {
    const match = /^(?:look\s+up|google)\s+(.+)$/.exec(text);
    return [{ kind: "search", query: (match ? match[1] : text).replace(/^["']|["']$/g, "") }];
  }

  if (/^(?:open|go\s+to|visit|launch|navigate\s+to)\s+(.+)$/.test(lower)) {
    const argument = /^(?:open|go\s+to|visit|launch|navigate\s+to)\s+(.+)$/.exec(text)[1];
    const many = openMany(argument);
    if (many) return many.map((url) => ({ kind: "open", url }));
    const url = normaliseUrl(argument);
    if (url) return [{ kind: "open", url }];
    const site = siteUrl(argument);
    if (site) return [{ kind: "open", url: site }];
    // "open the cheapest one" and the like are for the AI to resolve, not the
    // local parser, so they stay unresolved rather than becoming a bad guess.
    return [{ kind: "unknown", text: raw.trim() }];
  }

  // -- a bare address -----------------------------------------------------
  const bare = normaliseUrl(text);
  if (bare) return [{ kind: "open", url: bare }];
  const bareSite = siteUrl(text);
  if (bareSite) return [{ kind: "open", url: bareSite }];

  return [{ kind: "unknown", text: raw.trim() }];
}

/**
 * A sentence into a plan. `needsNetwork` is true when the plan cannot work with
 * the cable out; `needsPermission` is true when it writes a file, opens a local
 * file, or asks SUGAR to act on a page's contents (§13).
 */
function parseCommand(input) {
  const text = String(input || "").trim();
  const steps = [];
  if (text) {
    for (const part of splitCommands(text)) steps.push(...parseOne(part));
  }

  const needsNetwork = steps.some((step) => step.kind === "open" || step.kind === "search");
  const needsPermission = steps.some(
    (step) =>
      step.kind === "fill-form" ||
      step.kind === "save-page" ||
      step.kind === "download" ||
      step.kind === "open-download",
  );
  const unknown = steps.length > 0 && steps.every((step) => step.kind === "unknown");

  return { text, steps, needsNetwork, needsPermission, unknown };
}

/** One line for the progress list, so the person can see what is happening. */
function describeStep(step) {
  switch (step.kind) {
    case "open":
      return `Open ${step.url}`;
    case "search":
      return `Search for “${step.query}”`;
    case "new-tab":
      return "Open a new tab";
    case "close-tab":
      return step.which === "other" ? "Close the other tabs" : "Close this tab";
    case "switch-tab":
      return `Go to the ${step.direction} tab`;
    case "nav":
      return { back: "Go back", forward: "Go forward", reload: "Reload the page", stop: "Stop loading", home: "Go home" }[step.action] ?? "Navigate";
    case "bookmark":
      return "Bookmark this page";
    case "bookmarks-list":
      return "Show the bookmarks";
    case "download":
      return "Download the file on this page";
    case "open-download":
      return "Open the file that was downloaded";
    case "read-page":
      return "Read the page aloud";
    case "explain":
      return "Explain this page";
    case "summarise":
      return "Summarise this page";
    case "compare":
      return "Compare the open pages";
    case "find":
      return `Find “${step.text}” on the page`;
    case "save-page":
      return "Save this page";
    case "fill-form":
      return "Fill the form on this page";
    default:
      return `I did not understand “${step.text}”`;
  }
}

module.exports = {
  SITES,
  STEP_KINDS,
  normaliseUrl,
  siteUrl,
  splitCommands,
  parseCommand,
  describeStep,
};
