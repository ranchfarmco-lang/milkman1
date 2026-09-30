/**
 * One turn: a question comes in, an answer goes out.
 *
 * This is the loop itself — what the agent is told, which tools it may reach
 * for, what it does with each one, and what finally gets said. It sits next to
 * `ai.ts` rather than inside it because the two are asked different questions:
 * that file is "how do I get an answer out of a model", this one is "what do I
 * do with the answer", and a long job is easier to follow when the second is
 * not buried under the first.
 *
 * Everything it needs from the brain is imported from `./ai`. The dependency
 * runs one way only — nothing over there imports anything from here.
 */
import { getAuthUserId } from "@convex-dev/auth/server";
import { api, internal } from "./_generated/api";
import { action } from "./_generated/server";
import { LANGUAGE_ALIASES, LANGUAGE_MATCHERS } from "./ai_languages";
import {
  AGENT_NAME,
  REVIEW_PROMPT,
  assistantSystemPrompt,
  builderSystemPrompt,
  reviewUserMessage,
  type Agent,
} from "./ai_prompts";
import { patchOwnCode, readOwnCode, shortPath } from "./ai_self";
import { briefingDigest, briefingSections } from "./briefing";
import { runProgram, type BuildReport } from "./sandbox";
import { roomValidator } from "./schema";
import {
  BROWSER_UA,
  BUILDER_TOKENS,
  BUILDER_TOOLS,
  CHAT_TOKENS,
  CONTEXT,
  FALLBACK_TOKENS,
  MAX_ACTIONS,
  MAX_MINUTES,
  MIN_MINUTES,
  REVIEW_TOKENS,
  TOOL_ROUNDS,
  answerPublisher,
  asNumber,
  askModel,
  decodeEntities,
  fetchWithTimeout,
  httpUrl,
  makeTracer,
  modelsFor,
  parseToolCall,
  resolveProvider,
  resolveProviders,
  searchStackOverflow,
  stripHtml,
  type Provider,
  type Turn,
} from "./ai";

/** Everything else: Wikipedia's public API. No key either. */
async function searchWikipedia(query: string) {
  try {
    const response = await fetchWithTimeout(
      `https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=4&srsearch=${encodeURIComponent(query)}`,
      { headers: { "User-Agent": BROWSER_UA, Accept: "application/json" } },
    );
    if (!response.ok) return null;

    const data = (await response.json()) as {
      query?: { search?: { title?: string; snippet?: string }[] };
    };
    const hits = data.query?.search ?? [];
    if (!hits.length) return null;

    const lines = hits.map((hit) => {
      const title = decodeEntities(hit.title ?? "");
      const page = `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
      return `- ${title}: ${stripHtml(hit.snippet ?? "")}\n  ${page}`;
    });

    return `Wikipedia:\n${lines.join("\n")}`;
  } catch {
    return null;
  }
}

/** Brave's web index, when a key is present. */
async function searchBrave(query: string) {
  const key = process.env.BRAVE_API_KEY?.trim();
  if (!key) return null;

  try {
    const response = await fetchWithTimeout(
      `https://api.search.brave.com/res/v1/web/search?count=5&q=${encodeURIComponent(query)}`,
      {
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": key,
        },
      },
    );
    if (!response.ok) return null;

    const data = (await response.json()) as {
      web?: {
        results?: { title?: string; url?: string; description?: string }[];
      };
    };
    const results = data.web?.results ?? [];
    if (!results.length) return null;

    const lines = results.slice(0, 5).map((result) => {
      const title = stripHtml(result.title ?? "");
      const body = stripHtml(result.description ?? "").slice(0, 260);
      return `- ${title}\n  ${result.url ?? ""}\n  ${body}`;
    });

    return `Web results (Brave):\n${lines.join("\n")}`;
  } catch {
    return null;
  }
}

/** Tavily, if that is the key they gave instead. */
async function searchTavily(query: string) {
  const key = process.env.TAVILY_API_KEY?.trim();
  if (!key) return null;

  try {
    const response = await fetchWithTimeout("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: key,
        query,
        search_depth: "basic",
        include_answer: true,
        max_results: 5,
      }),
    });
    if (!response.ok) return null;

    const data = (await response.json()) as {
      answer?: string;
      results?: { title?: string; url?: string; content?: string }[];
    };
    const results = data.results ?? [];
    if (!results.length) return null;

    const lines = results.slice(0, 5).map((result) => {
      const body = (result.content ?? "").replace(/\s+/g, " ").slice(0, 260);
      return `- ${result.title ?? ""}\n  ${result.url ?? ""}\n  ${body}`;
    });

    const answer = data.answer ? `Quick answer: ${data.answer}\n\n` : "";
    return `Web results (Tavily):\n${answer}${lines.join("\n")}`;
  } catch {
    return null;
  }
}

/** One tag out of an RSS item, CDATA and entities and all. */
function rssTag(item: string, tag: string) {
  const match = item.match(
    new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"),
  );
  return decodeEntities(
    (match?.[1] ?? "")
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/<[^>]+>/g, " ")
      .trim(),
  );
}

/**
 * Bing hands out redirect links wearing the real address as a parameter, which
 * is no use to a model trying to read one. Hand back the address it points at.
 */
function cleanNewsLink(raw: string) {
  if (!raw) return "";
  try {
    const target = new URL(raw).searchParams.get("url");
    if (target) return target;
  } catch {
    // Not a link we can take apart; it is handed back as it came.
  }
  return raw;
}

/** Read one news feed, if it answers. */
async function newsFeed(url: string, label: string) {
  try {
    const response = await fetchWithTimeout(url, {
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "application/rss+xml,application/xml,text/xml,*/*",
      },
    });
    if (!response.ok) return null;

    const xml = await response.text();
    const items = xml.split(/<item[\s>]/i).slice(1, 6);
    if (!items.length) return null;

    const lines = items
      .map((item) => {
        const title = rssTag(item, "title");
        if (!title) return "";
        const link = cleanNewsLink(rssTag(item, "link"));
        const date = rssTag(item, "pubDate").slice(0, 22);
        const summary = stripHtml(rssTag(item, "description")).slice(0, 200);
        return [
          `- ${title}`,
          date ? `  ${date}` : "",
          link ? `  ${link}` : "",
          summary ? `  ${summary}` : "",
        ]
          .filter(Boolean)
          .join("\n");
      })
      .filter(Boolean);
    if (!lines.length) return null;

    return `${label}:\n${lines.join("\n")}`;
  } catch {
    return null;
  }
}

/**
 * Anything current: a real news feed, no key and no bot wall. Bing answers
 * first; Google's feed is asked when it does not.
 */
async function searchNews(query: string) {
  const bing = await newsFeed(
    `https://www.bing.com/news/search?format=RSS&q=${encodeURIComponent(query)}`,
    "Bing News",
  );
  if (bing) return bing;

  return newsFeed(
    `https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=${encodeURIComponent(query)}`,
    "Google News",
  );
}

/** What the people actually building things are saying, keyless. */
async function searchHackerNews(query: string) {
  try {
    const response = await fetchWithTimeout(
      `https://hn.algolia.com/api/v1/search?tags=story&hitsPerPage=5&query=${encodeURIComponent(query)}`,
      { headers: { "User-Agent": BROWSER_UA, Accept: "application/json" } },
    );
    if (!response.ok) return null;

    const data = (await response.json()) as {
      hits?: {
        title?: string;
        url?: string;
        objectID?: string;
        points?: number;
        num_comments?: number;
        created_at?: string;
      }[];
    };
    const hits = (data.hits ?? []).filter((hit) => hit.title);
    if (!hits.length) return null;

    const lines = hits.slice(0, 5).map((hit) => {
      const link =
        hit.url ??
        `https://news.ycombinator.com/item?id=${hit.objectID ?? ""}`;
      const meta = [
        hit.points ? `${hit.points} points` : "",
        hit.num_comments ? `${hit.num_comments} comments` : "",
        (hit.created_at ?? "").slice(0, 10),
      ]
        .filter(Boolean)
        .join(", ");
      return `- ${decodeEntities(hit.title ?? "")}${meta ? ` (${meta})` : ""}\n  ${link}`;
    });

    return `Hacker News:\n${lines.join("\n")}`;
  } catch {
    return null;
  }
}

/** A ceiling on the whole pile of sources, so one busy feed cannot flood it. */
const SEARCH_CHARS = 8000;

/**
 * Look something up, for real.
 *
 * A keyed web index leads when the family has one. Without it there is still a
 * live internet here: a news feed for anything current, Hacker News for what
 * builders are saying, Stack Overflow for code, Wikipedia for the rest. A plain
 * HTML search engine is deliberately not used — every one of them answers a
 * server with a bot wall, and pretending otherwise would be a lie.
 */
async function webSearch(query: string) {
  const [index, news, stack, hacker, wiki] = await Promise.all([
    (async () => (await searchBrave(query)) ?? (await searchTavily(query)))(),
    searchNews(query),
    searchStackOverflow(query),
    searchHackerNews(query),
    searchWikipedia(query),
  ]);

  const found = [index, news, stack, hacker, wiki].filter(
    (part): part is string => Boolean(part),
  );

  if (!found.length) {
    return "Nothing came back from search — every source was unreachable. Say plainly that you could not look it up, and answer only from what you already know.";
  }

  const sources = found.join("\n\n").slice(0, SEARCH_CHARS);
  const lead = index
    ? "Use these live results"
    : "There is no web-index key on this deployment, so these came from public news, code and reference feeds — they are live, but thinner than a full web index";

  return `Sources for “${query}”:\n\n${sources}\n\n${lead}. Ground your answer in them, say which source said what when it matters, and use fetch_url to read a page in full when you need the detail.`;
}

/* -------------------------------------------------------------- run it */

// Wandbox runs the code the assistant writes; its compiler list is cached.
const WANDBOX_LIST_URL = "https://wandbox.org/api/list.json";
const WANDBOX_RUN_URL = "https://wandbox.org/api/compile.json";
const COMPILER_TTL_MS = 10 * 60_000;

let compilerCache: { at: number; names: string[] } | null = null;


async function compilerNames() {
  if (compilerCache && Date.now() - compilerCache.at < COMPILER_TTL_MS) {
    return compilerCache.names;
  }

  try {
    const response = await fetchWithTimeout(WANDBOX_LIST_URL, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return compilerCache?.names ?? [];

    const data = (await response.json()) as { name?: unknown }[];
    const names = data
      .map((entry) => entry.name)
      .filter((name): name is string => typeof name === "string");

    compilerCache = { at: Date.now(), names };
    return names;
  } catch {
    return compilerCache?.names ?? [];
  }
}

/** Pick the newest version of a family, whatever they have that day. */
function newestVersion(names: string[]) {
  const score = (name: string) =>
    (name.match(/\d+/g) ?? []).map(Number).slice(0, 3);

  return ([
    ...names,
  ].sort((a, b) => {
    const left = score(a);
    const right = score(b);
    for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
      const diff = (right[i] ?? 0) - (left[i] ?? 0);
      if (diff !== 0) return diff;
    }
    return 0;
  })[0] ?? null);
}

async function resolveCompiler(language: string) {
  const wanted = language.trim().toLowerCase();
  const key = LANGUAGE_ALIASES[wanted] ?? wanted;
  const matcher = LANGUAGE_MATCHERS[key];
  if (!matcher) return null;

  const names = await compilerNames();
  return newestVersion(names.filter((name) => matcher.test(name)));
}

/**
 * Actually run the code and report what really happened. This is how an agent
 * checks its own work: run it, read the error, fix it, run it again.
 */
async function runCode(
  language: string,
  code: string,
  files: { path: string; code: string }[] = [],
) {
  if ((process.env.AI_CODE_RUNNER ?? "").trim().toLowerCase() === "off") {
    return "Running code is switched off. Say that you could not run it.";
  }

  // The workshop first, when this family has connected one: a real machine,
  // with the files already written on the bench sitting in it, real runtimes
  // installed, and no ten-second ceiling. The public runner below is the
  // fallback for languages that machine does not have.
  const inWorkshop = await runProgram(language, code, files);
  if (inWorkshop) return inWorkshop;

  const compiler = await resolveCompiler(language);
  if (!compiler) {
    return `I cannot run ${language}. Languages I can run: ${Object.keys(LANGUAGE_MATCHERS).join(", ")}.`;
  }

  try {
    const response = await fetchWithTimeout(
      WANDBOX_RUN_URL,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          compiler,
          code: code.slice(0, 20_000),
          // Extra files are handed to the runner as `codes`, which is how one
          // program is allowed to span more than one file.
          ...(files.length
            ? {
                codes: files.slice(0, 12).map((file) => ({
                  file: file.path.slice(0, 120),
                  code: file.code.slice(0, 40_000),
                })),
              }
            : {}),
        }),
      },
      30_000,
    );

    if (!response.ok) {
      return `The runner returned ${response.status}, so the code was not run. Do not claim it was.`;
    }

    const data = (await response.json()) as {
      status?: string;
      compiler_error?: string;
      program_output?: string;
      program_error?: string;
    };

    const parts = [
      `Ran with ${compiler}. Exit status ${data.status ?? "unknown"}.`,
    ];

    const compileError = (data.compiler_error ?? "").trim();
    if (compileError) {
      parts.push(`It did not compile:\n${compileError.slice(0, 1500)}`);
    }

    const output = (data.program_output ?? "").trim();
    if (output) parts.push(`Output:\n${output.slice(0, 1500)}`);

    const error = (data.program_error ?? "").trim();
    if (error) parts.push(`Error:\n${error.slice(0, 1500)}`);

    if (!compileError && !output && !error) {
      parts.push("It ran and printed nothing.");
    }

    return parts.join("\n\n");
  } catch (caught) {
    return `Could not reach the code runner: ${
      caught instanceof Error ? caught.message : "network error"
    }. Do not claim the code was run.`;
  }
}

async function fetchPage(rawUrl: string) {
  const url = httpUrl(rawUrl);
  if (!url) return "That does not look like a readable web address.";

  try {
    const response = await fetchWithTimeout(url, {
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "text/html,text/plain,application/json,*/*",
      },
    });
    if (!response.ok) return `That page returned ${response.status}.`;

    const text = stripHtml(await response.text()).slice(0, 4000);
    return text || "That page had no readable text.";
  } catch (error) {
    return `Could not read that page: ${
      error instanceof Error ? error.message : "network error"
    }`;
  }
}

/* ---------------------------------------------------------- the replica */

/**
 * A build report, written out for the model that asked for it.
 *
 * The whole arrangement exists so that the answer to "did my change break it?"
 * can be a fact rather than a hope: the app is copied into a sandbox of its
 * own, built there, and never the one running in front of the family. So the
 * report leads with what was built and where, then each step and its real
 * output, and then the one thing nobody else can tell the builder — which files
 * it has made different from the app's own.
 */
function describeBuild(report: BuildReport): string {
  if (report.error) return `The replica was not built. ${report.error}`;

  const parts: string[] = [
    "Built the replica of this app inside its own sandbox: a copy of the real files, on another machine, so nothing done there can reach the app the family is using.",
    report.seededFiles > 0
      ? `The copy was out of date, so ${report.seededFiles} files of it were brought up to the version of the app that is running — every file except the ones you have changed, which are left exactly as you wrote them. The first build after that is the slow one: it installs the app's own dependencies, once per package.json.`
      : "The copy was already current, so no files were rewritten.",
    `Steps:\n${report.steps
      .map(
        (one) =>
          `- ${one.name}: ${one.ok ? "passed" : "FAILED"} in ${one.seconds}s\n${one.detail}`,
      )
      .join("\n\n")}`,
  ];

  if (report.changed === null) {
    parts.push(
      "Could not compare the copy against the app's own files this time, so there is no list of what it changed.",
    );
  } else if (report.changed.length === 0) {
    parts.push("Nothing in the copy differs from the app's own files.");
  } else {
    parts.push(
      `No longer the app's own files (${report.changed.length}):\n${report.changed
        .map((one) => `- ${one}`)
        .join("\n")}\n\nThose are the copy's changes, and they are what has to be carried into the real app by a person — nothing here can write to it, which is exactly why this is safe.`,
    );
  }

  if (!report.ok) {
    parts.push(
      "Something in there failed. Read the output above before changing anything, fix the smallest thing that explains it, and build again: a claim that something works means nothing until this passes.",
    );
  }

  return parts.join("\n\n").slice(0, 7000);
}

/* ------------------------------------- every AI system we can reach */

/** How many systems one question may be sent to at once. */
const CONSULT_LIMIT = 5;

/**
 * What a consulted system is asked to be: a careful researcher handing over
 * everything that matters, not another personality. The asking agent has to be
 * able to weigh the answer, so it asks for the working, not just the verdict.
 */
const CONSULT_PROMPT = `You are one AI system among several, and another assistant has asked you a question on someone else's behalf. Answer the way a careful researcher would.

- Lead with the answer. No greeting, no preamble, no restating the question.
- Give the facts that matter: numbers, dates, names, versions, exact steps — and how you know, or where it comes from.
- Say the part that is easy to get wrong: the exception, the recent change, the thing that used to be true and is not any more, the case where the usual advice fails.
- If you do not know, or it depends, say so in one line and say what it depends on. Never invent facts, APIs, versions, prices, quotes or sources.
- Plain prose. No JSON, no markdown headings, nothing about yourself.

Answer this:
`;

/** One system, asked one question — its own models, or one it was named. */
async function consultSystem(
  provider: Provider,
  question: string,
  model: string | null = null,
) {
  const result = await askModel(
    provider,
    model
      ? [model, ...modelsFor(provider, "assistant")]
      : modelsFor(provider, "assistant"),
    CONSULT_PROMPT,
    [{ role: "user", text: question }],
    0.3,
    FALLBACK_TOKENS,
  );

  return result.ok
    ? {
        label: provider.label,
        ok: true as const,
        text: result.text.trim().slice(0, 4000),
      }
    : {
        label: provider.label,
        ok: false as const,
        text: result.error.slice(0, 200),
      };
}

/**
 * How a model words "whichever ones you have". They cannot see the list, so
 * these all mean the same thing: ask everyone reachable.
 */
const EVERYONE =
  /^(all|any|anyone|any other|every|everyone|everything|other|others|the rest|both|whoever|the best|no preference)$/i;

/** Match a name the model used onto the systems that actually exist. */
function findSystems(wanted: string, providers: Provider[]) {
  const needle = wanted.trim().toLowerCase();
  if (!needle) return [];

  const exact = providers.filter(
    (provider) =>
      provider.id === needle || provider.label.toLowerCase() === needle,
  );
  if (exact.length) return exact;

  return providers.filter(
    (provider) =>
      provider.label.toLowerCase().includes(needle) ||
      (needle.length > 3 && needle.includes(provider.id)) ||
      provider.models.some((model) => model.toLowerCase() === needle),
  );
}

/** The honest list an agent is shown when it asks who is out there. */
function systemList(providers: Provider[]) {
  return providers
    .map((provider, index) => {
      const models = provider.models.slice(0, 3).join(", ");
      const marks = [
        index === 0 ? "leads the conversation" : "",
        provider.free ? "free, no key" : "",
      ]
        .filter(Boolean)
        .join(", ");
      return `- ${provider.id} — ${provider.label}${
        marks ? ` (${marks})` : ""
      }: ${models || "model chosen by the endpoint"}`;
    })
    .join("\n");
}

/**
 * Ask another AI system — or every one of them — and hand the answers back
 * together, so the asking agent can weigh them instead of trusting the first
 * confident voice it hears.
 */
async function consultSystems(input: {
  providers: Provider[];
  system: string;
  question: string;
  model?: string | null;
}): Promise<{ text: string; labels: string[] }> {
  const { providers, system, question, model = null } = input;
  const leading = providers[0];
  const others = providers.filter((provider) => provider.id !== leading.id);
  const everyOne = EVERYONE.test(system.trim()) || !system.trim();

  if (everyOne && !others.length) {
    return {
      text: `${leading.label} is the only AI system reachable from here, so there is nobody else to ask. Look it up with web_search or fetch_url instead of relying on one model's memory.`,
      labels: [],
    };
  }

  const targets = everyOne
    ? others.slice(0, CONSULT_LIMIT)
    : findSystems(system, providers).slice(0, 3);

  if (!targets.length) {
    return {
      text: `There is no ${system} reachable from here. These are:\n${systemList(
        providers,
      )}\n\nName one of those, or use "all" to put the same question to every one of them at once.`,
      labels: [],
    };
  }

  // A named model only means something to the one system it belongs to, so a
  // fan-out uses each system's own models instead.
  const answers = await Promise.all(
    targets.map((target) =>
      consultSystem(target, question, targets.length === 1 ? model : null),
    ),
  );

  const body = answers
    .map((answer) =>
      answer.ok
        ? `${answer.label}:\n${answer.text}`
        : `${answer.label}: could not be reached (${answer.text})`,
    )
    .join("\n\n");

  const tail =
    answers.length > 1
      ? `\n\n${answers.length} systems were asked the same question. Where they disagree, say so plainly and go with the one that showed its sources or its working — do not blend them into mush, and do not treat agreement as proof.`
      : "";

  return {
    text: `${body}${tail}\n\nCheck anything load-bearing against web_search or fetch_url before you pass it on.`,
    labels: answers.filter((answer) => answer.ok).map((answer) => answer.label),
  };
}

/* --------------------------------------------------------- assistant actions */

type AssistantAction = Record<string, unknown> & { type: string };

function asString(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function clampMinutes(value: number | null) {
  if (value === null) return 5;
  return Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Math.round(value)));
}

/** Keep only actions we recognise, with primitive fields only. */
function normalizeActions(raw: unknown): AssistantAction[] {
  if (!Array.isArray(raw)) return [];
  const actions: AssistantAction[] = [];

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const source = item as Record<string, unknown>;
    if (typeof source.type !== "string") continue;

    const clean: AssistantAction = { type: source.type };
    for (const [key, value] of Object.entries(source)) {
      if (key === "type") continue;
      if (typeof value === "string") clean[key] = value.slice(0, 500);
      else if (typeof value === "number" && Number.isFinite(value)) {
        clean[key] = value;
      } else if (typeof value === "boolean") clean[key] = value;
    }

    actions.push(clean);
    if (actions.length >= MAX_ACTIONS) break;
  }

  return actions;
}

function hostOf(url: string) {
  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`).hostname;
  } catch {
    return url;
  }
}

/** Human names for the Control Room switches an AI is allowed to flip. */
/** The note left on a line the assistant volunteered without being asked. */
const NUDGE_NOTE = "Spoke up on her own";

/**
 * The instruction for speaking first. Same voice, no question to answer — just
 * a person looking up from across the room.
 */
const NUDGE_PROMPT = `You are the same voice, and nobody has said a word to you for a while. You are speaking up first, without being asked.

Say one short thing out loud in the same voice — warm, quick, with a flick of sass, glad to be useful, never remarking on how long they have been quiet, and never asking for attention. Keep the spark gentle: you are interrupting, so be a delight, not a distraction.

Say it only when the notes below hold something real: a timer that is nearly up, a reminder that is due, something you remember that matters now, a meal or an entry coming up. If there is nothing real in them, reply with an empty "say" and stay quiet — an empty silence is better than filling it for the sake of it.

Rules: one or two sentences. No markdown, no emoji, no lists. Never mention being an AI, a model or a program. Never complain about the same thing twice. Never sound like a system message.

Reply with exactly one JSON object and nothing else:
{"say":"what you say out loud","actions":[]}`;

const SETTING_LABELS: Record<string, string> = {
  silence: "silence",
  vibrate_messages: "vibrate",
  alert_tone: "the message tone",
  notify_messages: "notifications",
  notification_preview: "message previews",
  do_not_disturb: "do not disturb",
  fullscreen: "fullscreen",
  screen_rotation: "screen rotation",
  keep_screen_awake: "keep-awake",
};

/** Plain english for what just happened, stored with the reply. */
function describeAction(action: AssistantAction) {
  const label = asString(action.label);
  const text = asString(action.text);

  switch (action.type) {
    case "open_url":
      return `Opened ${hostOf(asString(action.url))}`;
    case "search_web":
      return `Searched for “${asString(action.query).slice(0, 60)}”`;
    case "timer": {
      const minutes = clampMinutes(asNumber(action.in_minutes));
      return label
        ? `Started a ${minutes} minute timer for ${label}`
        : `Started a ${minutes} minute timer`;
    }
    case "reminder": {
      const minutes = clampMinutes(asNumber(action.in_minutes));
      return `Reminder set in ${minutes} minutes${text ? `: ${text.slice(0, 60)}` : ""}`;
    }
    case "tell_family":
      return "Shared it with your family";
    case "set_voice":
      return `Changed my voice to ${asString(action.voice)}`;
    case "set_setting": {
      const on = action.on !== false;
      const key = asString(action.key);
      const name = SETTING_LABELS[key] ?? key;
      return name ? `Turned ${name} ${on ? "on" : "off"}` : "Changed a setting";
    }
    case "remember":
      return "Saved to memory";
    case "forget":
      return "Forgot that";
    case "copy":
      return "Copied to the clipboard";
    case "notify":
      return "Sent a notification";
    case "go_to":
      return `Opened the ${asString(action.page, "assistant")} page`;
    case "set_my_name":
      return `Changed your name to ${asString(action.name)}`;
    case "fullscreen":
      return action.on === false ? "Left fullscreen" : "Went fullscreen";
    case "vibrate":
      return "Buzzed the device";
    default:
      return "";
  }
}

/** The assistant answers with JSON; be forgiving if it wraps it in anything. */
function parseAssistantReply(raw: string) {
  const trimmed = raw.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");

  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1)) as {
        say?: unknown;
        actions?: unknown;
      };
      const say = asString(parsed.say).trim();
      if (say) {
        return { say, actions: normalizeActions(parsed.actions) };
      }
    } catch {
      // Fall through and treat the whole answer as speech.
    }
  }

  return { say: trimmed, actions: [] as AssistantAction[] };
}

/* ----------------------------------------------------------------- review */

/**
 * A second, fresh look at the answer before the person sees it — the part that
 * catches its own mistakes. Failure here is never fatal: the draft stands.
 */
async function reviewAnswer(args: {
  provider: Provider;
  models: string[];
  question: string;
  draft: string;
}): Promise<{ text: string; fixed: string | null }> {
  const result = await askModel(
    args.provider,
    args.models,
    REVIEW_PROMPT,
    [{ role: "user", text: reviewUserMessage(args.question, args.draft) }],
    0.2,
    REVIEW_TOKENS,
  );

  if (!result.ok) return { text: args.draft, fixed: null };

  const start = result.text.indexOf("{");
  const end = result.text.lastIndexOf("}");
  if (start === -1 || end <= start) return { text: args.draft, fixed: null };

  try {
    const parsed = JSON.parse(result.text.slice(start, end + 1)) as {
      ok?: unknown;
      why?: unknown;
      fixed?: unknown;
    };

    if (parsed.ok === true) return { text: args.draft, fixed: null };

    const fixed = asString(parsed.fixed).trim();
    if (!fixed || fixed.length < 40) return { text: args.draft, fixed: null };

    return { text: fixed, fixed: asString(parsed.why, "caught a mistake") };
  } catch {
    return { text: args.draft, fixed: null };
  }
}

/* ------------------------------------------------------------------ handler */

export const respond = action({
  args: { room: roomValidator },
  handler: async (
    ctx,
    { room },
  ): Promise<
    | { ok: true; say: string; actions: AssistantAction[] }
    | { ok: false; error: string }
  > => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return { ok: false, error: "Sign in to chat" };

    // The messenger belongs to the people in it; the models are not it.
    if (room === "messenger") {
      return { ok: false, error: "Nothing to answer here." };
    }

    // The pane. One row per turn, written to as the work happens instead of
    // after it: from here on, every step below is something the person can
    // watch arrive, and a turn that fails leaves the reason behind rather than
    // vanishing into a spinner.
    const traceId = await ctx.runMutation(internal.traces.start, {
      room,
      ownerId: userId,
    });
    const tracer = makeTracer(ctx, traceId);

    /** Give up, in the reply and in the pane at once. */
    const giveUp = async (error: string) => {
      await tracer.finish("failed", undefined, error);
      return { ok: false as const, error };
    };

    const providers = resolveProviders();
    const provider = providers[0] ?? null;
    if (!provider) {
      return giveUp(
        "Every AI system is switched off. The Control Room lists all of them and the exact variable each one needs — paste any one of those in the Keys tab, or turn the free public systems back on.",
      );
    }

    const agent: Agent = room === "builder" ? "builder" : "assistant";
    const isAssistant = agent === "assistant";

    tracer.step("step", "Reading the thread");
    const history = await ctx.runQuery(internal.messages.history, {
      room,
      ownerId: userId,
      limit: isAssistant ? CONTEXT.assistant : CONTEXT.builder,
    });
    if (history.length === 0) {
      return giveUp("Nothing to reply to yet.");
    }

    const [profile, memories] = await Promise.all([
      ctx.runQuery(internal.family.profile, { userId }),
      ctx.runQuery(internal.memories.context, { userId }),
    ]);

    const now = new Date().toLocaleString("en-GB", {
      timeZoneName: "short",
      dateStyle: "full",
      timeStyle: "short",
    });

    const system = isAssistant
      ? assistantSystemPrompt({
          name: profile.name,
          memories,
          now,
          canConsult: true,
        })
      : builderSystemPrompt({
          name: profile.name,
          memories,
          now,
          canConsult: true,
        });

    const models = modelsFor(provider, agent);
    // Loose for conversation, precise for code.
    const temperature = isAssistant ? 0.9 : 0.5;
    const maxTokens = isAssistant ? CHAT_TOKENS : BUILDER_TOKENS;

    const question =
      [...history].reverse().find((message) => message.role === "user")
        ?.text ?? "";

    /* ------------------------------------------------- talk, look, act */

    const notes: string[] = [];
    const pendingActions: AssistantAction[] = [];
    let conversation: Turn[] = history.map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      text: message.text,
    }));
    let answer: string | null = null;

    /**
     * A line for the note under the reply, and a step in the pane, at once.
     *
     * One call writes both, which is the point of it: the note a person reads
     * afterwards and the line they watched go by are the same sentence, so the
     * pane cannot drift into describing a turn that did not happen.
     */
    const did = (line: string) => {
      notes.push(line);
      tracer.step("tool", line);
    };

    /** Store an action the page will carry out when the reply lands. */
    const rememberAction = (action: AssistantAction) => {
      const note = describeAction(action);
      if (note) did(note);
      pendingActions.push(action);
    };

    /** Flip one of the Control Room switches for them. */
    const changeSetting = async (action: AssistantAction) => {
      const key = asString(action.key);
      const on = action.on !== false;
      const flipped = await ctx.runMutation(internal.settings.setForUser, {
        userId,
        key,
        value: on,
      });
      const name = SETTING_LABELS[key] ?? key;
      did(
        flipped.ok
          ? `Turned ${name} ${on ? "on" : "off"}`
          : "That is not a setting this app has",
      );
    };

    /** Change the voice they hear back. */
    const changeVoice = async (action: AssistantAction) => {
      const id = asString(action.voice).trim().toLowerCase();
      const changed = await ctx.runMutation(internal.voice.setForUser, {
        userId,
        id,
      });
      did(
        changed.ok
          ? `Changed my voice to ${id}`
          : "I do not have a voice by that name",
      );
    };

    /** Put something into the family's shared room for them. */
    const shareWithFamily = async (action: AssistantAction) => {
      const posted = await ctx.runMutation(internal.messages.postToFamily, {
        userId,
        text: asString(action.text),
        authoredBy: asString(action.from) || undefined,
      });
      did(
        posted.ok
          ? "Shared it with your family"
          : "Nothing to share with yet — you are not in a family",
      );
    };

    const rounds = TOOL_ROUNDS[agent];
    /** Which system and model actually answered, for the pane to name. */
    let answeredBy: string | undefined;
    /** Whether the reply was written out live, or held back as plumbing. */
    let answerShown = false;

    // Say who is about to be asked, before the silence starts.
    //
    // A turn opens with a wait — connecting, reading the thread, thinking — and
    // a pane that names the system is the difference between watching it work
    // and wondering whether the connection dropped. The free public model is
    // called out as what it is, because a hub running on nothing but that one
    // is the case where the wait ends in a refusal nobody can fix from here.
    tracer.step(
      "step",
      provider.free
        ? `Asking ${provider.label} — the free public model, no key of your own set`
        : `Asking ${provider.label}`,
    );

    for (let round = 0; round <= rounds; round += 1) {
      // On the final round the tools are withdrawn, so it has to answer.
      const allowTools = round < rounds;

      // Both halves of what the model says reach the pane as it says them: the
      // reasoning it narrates, when the system streams one at all, and then the
      // answer itself — once it is clear the answer is prose and not the JSON
      // these agents use to ask for a tool.
      const thinking = tracer.stream("reasoning");
      const writing = tracer.stream("answer");
      const published = answerPublisher(writing);

      const result = await askModel(
        provider,
        models,
        system,
        conversation,
        temperature,
        maxTokens,
        (kind, text) => {
          if (kind === "reasoning") thinking.push(text);
          else published.push(text);
        },
        // Down the list, out loud. The turn is a silence punctuated by one
        // finished line, so a system that could not answer is worth saying
        // while it is being walked past — and it is a step in the pane rather
        // than a note on the reply, so it never crowds out what the AI
        // actually did with the answer.
        (from, to) => {
          tracer.step("step", `${from} did not answer — asking ${to}`);
        },
      );

      published.done();
      await thinking.done();
      await writing.done();

      if (result.ok) {
        answerShown = answerShown || published.shown();
        if (!answeredBy && result.by) answeredBy = result.by;
        // A system that cannot stream hands its reasoning over in one piece
        // when the answer lands, so it is written here rather than shown as it
        // came. A system that streamed it has already been shown, and says so
        // by leaving this unset.
        if (result.reasoning) tracer.step("reasoning", result.reasoning);
      }

      if (!result.ok) {
        if (answer) break;
        return giveUp(result.error);
      }

      const toolCall = allowTools ? parseToolCall(result.text) : null;
      if (!toolCall) {
        answer = result.text;
        break;
      }

      let toolResult = "";

      if (toolCall.name === "list_ai") {
        toolResult = `Every AI system reachable from this deployment right now (${providers.length}), best first:\n${systemList(
          providers,
        )}\n\nAsk one of them with {"tool":"ask_ai","system":"<id>","question":"..."}, or put the same question to every one of them at once with "system":"all".`;
        did("Checked which AI systems it can reach");
      } else if (toolCall.name === "ask_ai") {
        const consulted = await consultSystems({
          providers,
          system: toolCall.system,
          model: toolCall.model,
          question: toolCall.question,
        });
        toolResult = consulted.text;

        if (consulted.labels.length === 1) {
          did(`Asked ${consulted.labels[0]}`);
        } else if (consulted.labels.length > 1) {
          did(`Asked ${consulted.labels.length} AI systems`);
        }
      } else if (toolCall.name === "run_code" && toolCall.files.length > 0) {
        // A program spanning more than one file: hand them all to the runner.
        toolResult = await runCode(
          toolCall.language,
          toolCall.code,
          toolCall.files,
        );
        did(`Ran the ${toolCall.language} code`);
      } else if (toolCall.name === "list_files") {
        const bench = await ctx.runQuery(internal.workspace.list, {
          ownerId: userId,
        });
        toolResult = bench.files.length
          ? `On your bench: ${bench.files.length} files, ${bench.totalChars} characters in all.\n${bench.files
              .map(
                (file) =>
                  `${file.path}${file.language ? ` (${file.language})` : ""} — ${file.chars} chars`,
              )
              .join("\n")}`
          : "Your bench is empty. Write something with write_file and it will still be there next time.";
        did("Looked over its bench");
      } else if (toolCall.name === "write_file") {
        const written = await ctx.runMutation(internal.workspace.write, {
          ownerId: userId,
          path: toolCall.path,
          content: toolCall.content,
          language: toolCall.language ?? undefined,
        });
        toolResult = written.ok
          ? `${written.created ? "Wrote" : "Overwrote"} ${written.path} — ${written.chars} characters.${written.truncated ? " It was longer than I keep, so it was cut short." : ""}`
          : written.reason;
        if (written.ok) did(`Wrote ${shortPath(written.path)}`);
      } else if (toolCall.name === "read_file") {
        const file = await ctx.runQuery(internal.workspace.read, {
          ownerId: userId,
          path: toolCall.path,
        });
        if (!file) {
          toolResult = `There is no ${toolCall.path} on your bench. list_files shows what is.`;
        } else {
          const lines = file.content.split("\n");
          const start = toolCall.from
            ? Math.min(toolCall.from - 1, lines.length)
            : 0;
          const end = toolCall.to
            ? Math.min(toolCall.to, lines.length)
            : lines.length;
          const slice = lines.slice(start, end).join("\n");
          toolResult = `${file.path} — lines ${start + 1}-${Math.min(
            end,
            lines.length,
          )} of ${lines.length}, ${file.content.length} characters:\n\n${
            slice.length > 32_000
              ? `${slice.slice(0, 32_000)}\n\n… clipped. Ask again with from and to for the rest.`
              : slice
          }`;
        }
      } else if (toolCall.name === "search_files") {
        const found = await ctx.runQuery(internal.workspace.search, {
          ownerId: userId,
          query: toolCall.query,
        });
        toolResult = found.matches.length
          ? `${found.matches.length} matching lines${found.truncated ? " (stopped early)" : ""}:\n${found.matches
              .map((hit) => `${hit.path}:${hit.line}: ${hit.text}`)
              .join("\n")}`
          : `Nothing on your bench matches "${toolCall.query}".`;
        did(`Searched the bench for "${toolCall.query.slice(0, 40)}"`);
      } else if (toolCall.name === "delete_file") {
        const gone = await ctx.runMutation(internal.workspace.remove, {
          ownerId: userId,
          path: toolCall.path,
        });
        toolResult = gone.ok ? `Deleted ${gone.path}.` : gone.reason;
        if (gone.ok) did(`Deleted ${shortPath(gone.path)}`);
      } else if (toolCall.name === "read_own_code") {
        toolResult = readOwnCode(
          toolCall.path,
          toolCall.search,
          toolCall.from,
          toolCall.to,
        );
        did("Read its own code");
      } else if (toolCall.name === "patch_own_code") {
        const patch = patchOwnCode(
          toolCall.path,
          toolCall.search,
          toolCall.replace,
        );

        if (!patch.ok) {
          toolResult = patch.message;
        } else {
          // The fix is kept on the bench, because nothing here can reach the
          // real project — a person has to put it back.
          const saved = await ctx.runMutation(internal.workspace.write, {
            ownerId: userId,
            path: patch.path,
            content: patch.content,
          });
          toolResult = saved.ok
            ? `${patch.message}\n\nThe whole fixed file is saved on your bench as ${patch.path} too.`
            : patch.message;
          did(`Patched its own ${shortPath(patch.path)}`);
        }
      } else if (toolCall.name === "think") {
        // A reasoning scratchpad: nothing happens on the far side, but writing
        // the plan down before acting is what keeps a long job honest — and it
        // is the nearest thing to the model's own thinking there is, so it is
        // written into the pane where the person can watch it arrive.
        tracer.step("think", toolCall.thought);
        toolResult =
          "Shown to the person as you wrote it. Carry out the next step of that plan now, then check it before you answer.";
      } else if (toolCall.name === "edit_file") {
        const edited = await ctx.runMutation(internal.workspace.patch, {
          ownerId: userId,
          path: toolCall.path,
          search: toolCall.search,
          replace: toolCall.replace,
        });
        toolResult = edited.message;
        if (edited.ok) did(`Edited ${shortPath(edited.path)}`);
      } else if (toolCall.name === "move_file") {
        const moved = await ctx.runMutation(internal.workspace.move, {
          ownerId: userId,
          path: toolCall.path,
          to: toolCall.to,
        });
        toolResult = moved.message;
        if (moved.ok) did(`Moved ${shortPath(moved.path)}`);
      } else if (toolCall.name === "scaffold_project") {
        const scaffolded = await ctx.runMutation(internal.workspace.scaffold, {
          ownerId: userId,
        });
        toolResult = `Put this whole project on the bench: ${scaffolded.files} files, ${scaffolded.chars} characters.${
          scaffolded.skipped
            ? ` ${scaffolded.skipped} were already there and left alone.`
            : ""
        } Every one of those files is on the workshop machine too, so run_code with language "bash" can install, typecheck, build or run it there — and edit_file changes any file without rewriting it.`;
        did("Scaffolded the whole project");
      } else if (toolCall.name === "build_app") {
        // The whole of the isolation is in this call and the one it makes: the
        // replica is a copy in a sandbox on another machine, so a change that
        // will not compile takes down a copy and the hub keeps serving.
        const report = await ctx.runAction(internal.sandbox.buildReplica, {
          quick: toolCall.quick,
        });
        toolResult = describeBuild(report);
        did(
          report.ok
            ? "Built the replica of this app and it passed"
            : "Built the replica of this app and it failed",
        );
      } else if (isAssistant && BUILDER_TOOLS.has(toolCall.name)) {
        // The voice has no bench, and it is never told these tools exist.
        toolResult =
          "That tool belongs to the AI Builder, not to you. Answer with what you have.";
      } else if (toolCall.name === "web_search") {
        toolResult = await webSearch(toolCall.query);
        did(`Looked up “${toolCall.query.slice(0, 60)}”`);
      } else if (toolCall.name === "fetch_url") {
        toolResult = await fetchPage(toolCall.url);
        const host = hostOf(toolCall.url);
        did(`Read ${host}`);
      } else if (toolCall.name === "run_code") {
        toolResult = await runCode(toolCall.language, toolCall.code);
        did(`Ran the ${toolCall.language} code`);
      } else if (toolCall.name === "ask_agent") {
        // One AI reaching out to the other, with its own brain and its own
        // model, and the exchange is left in the thread for the person to see.
        const otherSystem = builderSystemPrompt({
          name: profile.name,
          memories,
          now,
          canConsult: false,
          askedBy: agent,
        });

        const consulted = await askModel(
          provider,
          modelsFor(provider, toolCall.agent),
          otherSystem,
          [
            ...conversation.slice(-8),
            {
              role: "user",
              text: `${AGENT_NAME[agent].replace("the ", "The ")} asks you: ${toolCall.question}`,
            },
          ],
          0.6,
          maxTokens,
        );

        if (consulted.ok) {
          toolResult = `${AGENT_NAME[toolCall.agent].replace("the ", "The ")} answered:\n${consulted.text}`;
          did(`Asked ${AGENT_NAME[toolCall.agent]}`);

          await ctx.runMutation(internal.messages.appendFromAgent, {
            room,
            ownerId: userId,
            authorName:
              toolCall.agent === "builder" ? "AI Builder" : "AI Assistant",
            text: consulted.text,
          });
        } else {
          toolResult = `Could not reach ${AGENT_NAME[toolCall.agent]}: ${consulted.error}`;
        }
      } else if (toolCall.name === "read_briefing") {
        // The cached board first; if it has never been gathered, ask for it
        // once and try again. Either way the assistant reads words it was
        // given, rather than numbers it would have to guess the shape of.
        let board = await ctx.runQuery(internal.briefing.snapshot, {});
        if (!board) {
          await ctx.runAction(internal.briefing.run, {});
          board = await ctx.runQuery(internal.briefing.snapshot, {});
        }
        if (!board) {
          toolResult =
            "The [LIVE] board is empty and its feeds would not answer just now. Say so plainly, and offer to try again in a moment. It does hold these sections: " +
            briefingSections()
              .map((entry) => entry.id)
              .join(", ") +
            ".";
        } else {
          toolResult = briefingDigest(board.updatedAt, board.data, toolCall.section);
        }
        did("Read the [LIVE] board");
      } else if (toolCall.name === "read_rundown") {
        // The day and the board in one read. Only one tool runs per turn, so a
        // rundown needing both would otherwise cost two round trips — and the
        // person would hear half of it now and half of it a moment later.
        const days = toolCall.days ?? 7;
        const calendar = await ctx.runQuery(internal.calendar.digest, {
          userId,
          days,
        });
        let board = await ctx.runQuery(internal.briefing.snapshot, {});
        if (!board) {
          await ctx.runAction(internal.briefing.run, {});
          board = await ctx.runQuery(internal.briefing.snapshot, {});
        }
        const live = board
          ? briefingDigest(board.updatedAt, board.data, null)
          : "The [LIVE] board has not gathered anything yet.";
        toolResult = `The calendar, read just now:
${calendar}

The [LIVE] board, read just now:
${live}

Give them their rundown: today first — the date and the time, what is on, and what the weather and any alerts are doing — then everything coming up after that. Read the entries and the readings out rather than summarizing the numbers away.`;
        did("Read the calendar and the [LIVE] board");
      } else if (toolCall.name === "read_family") {
        const family = await ctx.runQuery(internal.messages.familyRecent, {
          userId,
          limit: toolCall.limit ?? 20,
        });

        if (!family) {
          toolResult =
            "They are not in a family yet, so there is no shared room to read.";
        } else {
          const who = `${family.members} in the family, ${family.online} online right now.`;
          toolResult = family.messages.length
            ? `${who}\nRecent messages, oldest first:\n${family.messages
                .map((message) => `${message.author}: ${message.text}`)
                .join("\n")}`
            : `${who} Nothing has been said in the shared room yet.`;
        }
        did("Read the family messages");
      } else if (toolCall.name === "act") {
        const actions = normalizeActions(toolCall.actions);

        for (const action of actions) {
          // Timers, reminders and memory live on the server; the rest is done
          // by the page when the reply arrives.
          if (action.type === "timer" || action.type === "reminder") {
            const minutes = clampMinutes(asNumber(action.in_minutes));
            await ctx.runMutation(internal.reminders.create, {
              userId,
              text:
                action.type === "timer"
                  ? asString(action.label, "Timer")
                  : asString(action.text, "Reminder"),
              kind: action.type,
              dueAt: Date.now() + minutes * 60_000,
            });
            const note = describeAction(action);
            if (note) did(note);
          } else if (action.type === "tell_family") {
            await shareWithFamily(action);
          } else if (action.type === "set_setting") {
            await changeSetting(action);
          } else if (action.type === "set_voice") {
            await changeVoice(action);
          } else if (action.type === "remember") {
            await ctx.runMutation(internal.memories.add, {
              userId,
              text: asString(action.fact),
            });
            did("Saved to memory");
          } else if (action.type === "forget") {
            await ctx.runMutation(internal.memories.forget, {
              userId,
              match: asString(action.fact),
            });
            did("Forgot that");
          } else {
            rememberAction(action);
          }
        }

        toolResult = "Done. Those are carried out as soon as you answer.";
      }

      conversation = [
        ...conversation,
        { role: "assistant", text: result.text },
        {
          role: "user",
          text: `Result of ${toolCall.name}:\n${toolResult}\n\nNow continue, or give your final answer.`,
        },
      ];
    }

    if (!answer) {
      tracer.step("step", "Out of tool rounds — asking for the answer");
      const last = await askModel(
        provider,
        models,
        system,
        conversation,
        temperature,
        maxTokens,
        undefined,
        (from, to) => {
          tracer.step("step", `${from} did not answer — asking ${to}`);
        },
      );
      if (!last.ok) return giveUp(last.error);
      if (!answeredBy && last.by) answeredBy = last.by;
      if (last.reasoning) tracer.step("reasoning", last.reasoning);
      answer = last.text;
    }

    /* ----------------------------------------------------------- finish */

    if (isAssistant) {
      const parsed = parseAssistantReply(answer);
      if (!parsed.say) {
        return giveUp("The model returned an empty answer.");
      }

      let say = parsed.say;
      const actions = parsed.actions;

      // The spoken answer gets the same second look the code does.
      if (shouldReview(say, true)) {
        const reviewed = await reviewAnswer({
          provider,
          models,
          question,
          draft: say,
        });
        say = reviewed.text;
        if (reviewed.fixed) {
          did(`Checked itself and fixed: ${reviewed.fixed}`);
        }
      }

      for (const action of actions) {
        if (action.type === "timer" || action.type === "reminder") {
          const minutes = clampMinutes(asNumber(action.in_minutes));
          await ctx.runMutation(internal.reminders.create, {
            userId,
            text:
              action.type === "timer"
                ? asString(action.label, "Timer")
                : asString(action.text, "Reminder"),
            kind: action.type,
            dueAt: Date.now() + minutes * 60_000,
          });
        } else if (action.type === "tell_family") {
          await shareWithFamily(action);
        } else if (action.type === "set_setting") {
          await changeSetting(action);
        } else if (action.type === "set_voice") {
          await changeVoice(action);
        } else if (action.type === "remember") {
          await ctx.runMutation(internal.memories.add, {
            userId,
            text: asString(action.fact),
          });
        } else if (action.type === "forget") {
          await ctx.runMutation(internal.memories.forget, {
            userId,
            match: asString(action.fact),
          });
        }
      }

      // Whatever the page has to do: the actions from the answer, plus any it
      // sent through the act tool along the way.
      const carried = Array.from(
        new Map(
          [...pendingActions, ...actions.filter((one) => !isServerAction(one))].map(
            (one) => [JSON.stringify(one), one],
          ),
        ).values(),
      ).slice(0, MAX_ACTIONS);

      const note = unique([...notes, ...carried.map(describeAction)])
        .slice(0, 3)
        .join(" · ");

      await ctx.runMutation(internal.messages.appendReply, {
        room,
        ownerId: userId,
        text: say,
        note: note || undefined,
        // The reasoning and the steps come with the reply, and stay under it,
        // named with the system that produced them: the trace is closed a line
        // later, so the feed cannot read the name off it yet.
        traceId,
        by: answeredBy,
      });

      // An assistant answers in JSON, which the pane deliberately held back as
      // plumbing rather than showing. The prose it turned into is what it was
      // really saying, so that is what the pane is left holding.
      if (!answerShown) tracer.step("answer", say);
      await tracer.finish("done", answeredBy);

      return { ok: true, say, actions: carried };
    }

    // The builder answers in prose and code, so it gets checked as written.
    let written = answer;
    if (shouldReview(written, false)) {
      const reviewed = await reviewAnswer({
        provider,
        models,
        question,
        draft: written,
      });
      written = reviewed.text;
      if (reviewed.fixed) {
        did(`Checked itself and fixed: ${reviewed.fixed}`);
      }
    }

    const note = unique(notes).slice(0, 3).join(" · ");

    await ctx.runMutation(internal.messages.appendReply, {
      room,
      ownerId: userId,
      text: written,
      note: note || undefined,
      // The reasoning and the steps come with the reply, and stay under it,
      // named with the system that produced them: the trace is closed a line
      // later, so the feed cannot read the name off it yet.
      traceId,
      by: answeredBy,
    });

    // Normally the builder's answer has already gone past live. The exception
    // is a reply the reviewer rewrote, where what the pane holds is the draft
    // rather than the thing that was actually said.
    if (!answerShown || written !== answer) tracer.step("answer", written);
    await tracer.finish("done", answeredBy);

    return { ok: true, say: written, actions: pendingActions };
  },
});

/* ------------------------------------------------------------------ nudges */

/**
 * The assistant speaking up first. It gets one short, in-character line, built
 * from what it actually knows: their memories, the timers still running, and
 * how long they have been quiet. It refuses if it already spoke into this
 * silence, so nothing is ever repeated at them.
 */
export const nudge = action({
  args: {},
  handler: async (
    ctx,
  ): Promise<{ ok: true; say: string } | { ok: false; error: string }> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return { ok: false, error: "Sign in first" };

    const provider = resolveProvider();
    if (!provider) return { ok: false, error: "No AI key yet." };

    const timing = await ctx.runQuery(internal.messages.assistantTiming, {
      ownerId: userId,
    });
    if (!timing.hasHistory || timing.lastUserAt === null) {
      return { ok: false, error: "Nothing has been said yet." };
    }
    // One reply follows every message; anything past that is already a nudge.
    if (timing.assistantSinceUser > 1) {
      return { ok: false, error: "Already spoken up." };
    }

    const [profile, memories, pending] = await Promise.all([
      ctx.runQuery(internal.family.profile, { userId }),
      ctx.runQuery(internal.memories.context, { userId }),
      ctx.runQuery(api.reminders.pending, {}),
    ]);

    const minutes = Math.max(
      0,
      Math.round((Date.now() - timing.lastUserAt) / 60_000),
    );

    const now = new Date().toLocaleString("en-GB", {
      timeZoneName: "short",
      dateStyle: "full",
      timeStyle: "short",
    });

    const clock = pending.map(
      (one) =>
        `${one.text} (${one.kind}) due ${new Date(one.dueAt).toLocaleTimeString(
          [],
          { hour: "2-digit", minute: "2-digit" },
        )}`,
    );

    const notes = [
      `Right now it is ${now}.`,
      `They have not said anything to you for about ${minutes} minutes.`,
      profile.name ? `Their name is ${profile.name}.` : "",
      memories.length
        ? `Things you remember about them:\n- ${memories.join("\n- ")}`
        : "You do not remember anything about them yet.",
      clock.length
        ? `Timers and reminders still running:\n- ${clock.join("\n- ")}`
        : "They have nothing on the clock right now.",
    ]
      .filter(Boolean)
      .join("\n\n");

    // Written down before the model is asked, so the decision to speak up —
    // and the thinking behind it — is visible while it is being made rather
    // than only after a line appears in the conversation.
    const deciding = await ctx.runMutation(internal.ai_behind.open, {
      source: "nudge",
      label: "Deciding whether to speak up on its own",
      detail: `Nobody has said anything to it for about ${minutes} minutes. It is reading what it remembers about them, and what is still on the clock, before deciding whether the quiet needs filling.`,
      ownerId: userId,
    });

    const asked = await askModel(
      provider,
      modelsFor(provider, "assistant"),
      NUDGE_PROMPT,
      [{ role: "user", text: notes }],
      0.95,
      FALLBACK_TOKENS,
    );

    if (!asked.ok) {
      await ctx.runMutation(internal.ai_behind.close, {
        id: deciding,
        status: "failed",
        detail: asked.error,
      });
      return { ok: false, error: asked.error };
    }

    const say = parseAssistantReply(asked.text).say.trim();
    if (!say) {
      await ctx.runMutation(internal.ai_behind.close, {
        id: deciding,
        status: "failed",
        detail: "It had nothing it wanted to say.",
      });
      return { ok: false, error: "Nothing came back." };
    }

    // The write re-checks how many times the assistant has already spoken
    // since the person's last message. Other tabs asked for their own nudge at
    // the same moment and all of them got past the check above, so this is
    // what stops one silence turning into three near-identical lines.
    const stored = await ctx.runMutation(internal.messages.appendReply, {
      room: "assistant",
      ownerId: userId,
      text: say,
      note: NUDGE_NOTE,
      oncePerSilence: true,
    });
    if (!stored.written) {
      await ctx.runMutation(internal.ai_behind.close, {
        id: deciding,
        status: "done",
        detail: "Nothing needed saying — another tab had already spoken.",
      });
      return { ok: false, error: "Already spoken up." };
    }

    // Both halves of the decision: what it thought, and what it decided to
    // say. The thinking is the reason this feed exists — without it the row
    // would only be the line, which is already in the conversation.
    await ctx.runMutation(internal.ai_behind.close, {
      id: deciding,
      status: "done",
      detail: [asked.reasoning?.trim(), `Said: ${say}`]
        .filter(Boolean)
        .join("\n\n"),
    });

    return { ok: true, say };
  },
});

/**
 * Timers, reminders, memory and sharing with the family are all done by the
 * server, not the page.
 */
function isServerAction(action: AssistantAction) {
  return (
    action.type === "timer" ||
    action.type === "reminder" ||
    action.type === "remember" ||
    action.type === "forget" ||
    action.type === "tell_family" ||
    action.type === "set_setting" ||
    action.type === "set_voice"
  );
}

function unique(items: string[]) {
  return Array.from(new Set(items.filter(Boolean)));
}

/** Code and long answers get a second look; one-liners do not need one. */
function shouldReview(text: string, isAssistant: boolean) {
  if ((process.env.AI_REVIEW ?? "").trim().toLowerCase() === "off") return false;
  if (text.includes("```")) return true;
  if (!isAssistant) return text.length > 280;
  return text.length > 400;
}
