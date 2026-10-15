/**
 * The multi-agent pipeline — the six-person crew, running only here in the
 * Builder's sandbox.
 *
 * Director → Planner (and Research, in parallel when it is wanted) → File &
 * Context → Implementation → Review & Debug. Each agent writes its live
 * status and its own words into IndexedDB as it works, which is what the
 * badges on the Builder's left panel and the Active Agents box in the Control
 * Room read. Every file write lands in the sandbox virtual file system and
 * nowhere else; leaving the sandbox takes the Apply flow, with a person.
 *
 * The same six ids as the hub's `ai_crew` roster, so the names match the
 * rest of the hub.
 */
import { z } from "zod";
import { readConfig } from "./config";
import { getSecret } from "./crypto";
import { forgeDb, recordError, type AgentId, type ConfigRow } from "./db";
import { postForge } from "./events";
import { chatOnce, type LlmMessage, type ProviderId } from "./llm";
import { registerAbort } from "./runtime";
import { sandbox, type BuildResult } from "./sandbox";

/* ------------------------------------------------------------------ status */

/** One crew member's live status — written, broadcast, read by both pages. */
export async function setAgent(
  id: AgentId,
  status: "idle" | "running" | "done" | "error" | "stopped",
  detail: string,
  sessionId: string | null = null,
): Promise<void> {
  const now = Date.now();
  const previous = await forgeDb.agents.get(id);
  await forgeDb.agents.put({
    id,
    status,
    detail,
    sessionId: status === "running" ? sessionId : (previous?.sessionId ?? sessionId),
    startedAt: status === "running" ? now : (previous?.startedAt ?? null),
    endedAt: status === "running" ? null : now,
    at: now,
  });
  postForge({ type: "agents", id });
}

/** A line in one agent's thought stream — the left panel reads these live. */
export async function logAgent(
  sessionId: string,
  agent: AgentId,
  text: string,
): Promise<void> {
  await forgeDb.agentLogs.add({ sessionId, agent, text, at: Date.now() });
  postForge({ type: "logs" });
}

/** Put the whole crew back to idle (Force Restart, page open, stop). */
export async function resetAgents(detail = "Waiting for work."): Promise<void> {
  const rows = await forgeDb.agents.toArray();
  const now = Date.now();
  for (const row of rows) {
    await forgeDb.agents.put({
      ...row,
      status: "idle",
      detail,
      sessionId: null,
      startedAt: null,
      endedAt: null,
      at: now,
    });
  }
  postForge({ type: "agents" });
}

/* -------------------------------------------------------------- structured */

/** Pull a JSON object out of a reply, fences and all. */
function parseJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("No JSON object in the reply.");
  return JSON.parse(candidate.slice(start, end + 1));
}

const directorSchema = z.object({
  approach: z.string().min(4),
  needsResearch: z.boolean(),
  summary: z.string().default(""),
});

const planSchema = z.object({
  files: z
    .array(
      z.object({
        path: z.string().min(1),
        action: z.enum(["create", "update", "delete"]),
        intent: z.string(),
      }),
    )
    .min(1),
  notes: z.string().default(""),
});

const writeSchema = z.object({ path: z.string().min(1), content: z.string() });

const fixSchema = z.object({
  files: z.array(writeSchema).min(1),
  note: z.string().default(""),
});

/* ---------------------------------------------------------------- research */

/** Cache freshness: a search from this session is still good. */
const RESEARCH_TTL = 60 * 60 * 1000;

/**
 * The Research agent's actual work: a real fetch to the chosen source, cached
 * by query. Wikipedia answers any origin; Brave and SearxNG need a key or an
 * address, and fall back to Wikipedia with a line in the log saying so.
 */
export async function runResearch(
  goal: string,
  config: ConfigRow,
  sessionId: string,
): Promise<string> {
  const provider = config.researchProvider;
  const cacheKey = `${provider}:${goal.toLowerCase().slice(0, 200)}`;

  const cached = await forgeDb.research.get(cacheKey);
  if (cached && Date.now() - cached.at < RESEARCH_TTL) {
    await logAgent(sessionId, "research", "Fresh cache hit — no network needed.");
    return cached.text;
  }

  let text = "";
  let used = provider;

  try {
    if (provider === "brave") {
      const token = await getSecret("search:brave");
      if (token) {
        text = await braveSearch(goal, token);
      } else {
        await logAgent(sessionId, "research", "No Brave key saved — using Wikipedia instead.");
        used = "wikipedia";
      }
    } else if (provider === "searxng" && config.searxngUrl.trim()) {
      try {
        text = await searxSearch(config.searxngUrl.trim(), goal);
        used = "searxng";
      } catch (error) {
        await logAgent(
          sessionId,
          "research",
          `SearxNG failed (${error instanceof Error ? error.message : String(error)}) — using Wikipedia instead.`,
        );
        used = "wikipedia";
      }
    }

    if (!text) {
      used = "wikipedia";
      text = await wikipediaSearch(goal);
    }

    await forgeDb.research.put({ key: cacheKey, provider: used, text, at: Date.now() });
    await forgeDb.research.put({ key: `wikipedia:${goal.toLowerCase().slice(0, 200)}`, provider: used, text, at: Date.now() });
    await logAgent(sessionId, "research", `Found ${text.split("\n").length} notes from ${used}.`);
    return text;
  } catch (error) {
    await logAgent(
      sessionId,
      "research",
      `Search failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return `Research unavailable right now (${error instanceof Error ? error.message : String(error)}). Build from what is in the project.`;
  }
}

async function wikipediaSearch(goal: string): Promise<string> {
  const url =
    `https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=5&srsearch=${encodeURIComponent(goal)}`;
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(9000),
  });
  if (!response.ok) throw new Error(`Wikipedia answered ${response.status}.`);
  const data = (await response.json()) as {
    query?: { search?: { title: string; snippet: string }[] };
  };
  const hits = data.query?.search ?? [];
  return hits
    .map(
      (hit) =>
        `- ${hit.title}: ${hit.snippet.replace(/<[^>]+>/g, "").slice(0, 240)}`,
    )
    .join("\n");
}

async function braveSearch(goal: string, key: string): Promise<string> {
  const response = await fetch(
    `https://api.search.brave.com/res/v1/web/search?count=5&q=${encodeURIComponent(goal)}`,
    {
      headers: { Accept: "application/json", "X-Subscription-Token": key },
      signal: AbortSignal.timeout(9000),
    },
  );
  if (!response.ok) throw new Error(`Brave answered ${response.status}.`);
  const data = (await response.json()) as {
    web?: { results?: { title: string; url: string; description: string }[] };
  };
  const hits = data.web?.results ?? [];
  return hits
    .map((hit) => `- ${hit.title}\n  ${hit.url}\n  ${hit.description.slice(0, 240)}`)
    .join("\n");
}

async function searxSearch(base: string, goal: string): Promise<string> {
  const url = `${base.replace(/\/+$/, "")}/search?format=json&q=${encodeURIComponent(goal)}`;
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(9000),
  });
  if (!response.ok) throw new Error(`SearxNG answered ${response.status}.`);
  const data = (await response.json()) as {
    results?: { title: string; url: string; content?: string }[];
  };
  const hits = data.results ?? [];
  return hits
    .slice(0, 6)
    .map(
      (hit) =>
        `- ${hit.title}\n  ${hit.url}\n  ${(hit.content ?? "").slice(0, 240)}`,
    )
    .join("\n");
}

/* ---------------------------------------------------------------- prompts */

const DIRECTOR_SYSTEM = `You are the Director of a six-person build crew working inside an isolated sandbox.
Read the brief and decide the approach in a few lines: what kind of app this is, what shape it should take, and whether outside research is genuinely needed (most builds do not need it).
Reply with ONLY a JSON object and nothing else:
{"approach":"2-4 sentences","needsResearch":false,"summary":"one line naming what will be built"}`;

const PLANNER_SYSTEM = `You are the Planner of a six-person build crew in an isolated sandbox.
Turn the approach into the exact file list. The sandbox builds static apps (HTML/CSS/JS) best; a framework app only builds when WebContainer is available.
Rules: relative paths only; index.html at the root for web apps; keep the file count small and each file complete in intent; "update" only for files that already exist in the project listing you are given.
Reply with ONLY a JSON object:
{"files":[{"path":"index.html","action":"create|update|delete","intent":"one line"}],"notes":"anything the implementer must honour (style, libraries via CDN, structure)"}`;

const IMPLEMENT_SYSTEM = `You are the Implementation Agent of a six-person build crew in an isolated sandbox.
Write the COMPLETE content of the file you are asked for — production-ready, no placeholders, no TODOs, no "rest of the code here". External libraries come from CDN URLs in HTML when needed; there is no npm install in this sandbox mode unless the Director said WebContainer is running.
Reply with ONLY a JSON object: {"path":"the exact path you were asked for","content":"the entire file"}`;

const FIX_SYSTEM = `You are the Review & Debug Agent, handing corrections back to the Implementation step.
Given the build errors and the current contents of the files, return corrected COMPLETE contents for the files that need changing.
Reply with ONLY a JSON object: {"files":[{"path":"...","content":"entire corrected file"}],"note":"one line on what you fixed"}`;

const SUMMARY_SYSTEM = `You are the Director wrapping up a build. In 2-3 plain sentences: what was built, which files carry it, and whether the build passed. No headers, no lists.`;

/* ------------------------------------------------------------ local checks */

/** The File & Context agent's real work: index the sandbox, read knowledge.md. */
async function indexFilesAgent(
  sessionId: string,
): Promise<{ digest: string; knowledge: string; count: number }> {
  await setAgent("files", "running", "Indexing the project…", sessionId);
  await sandbox.hydrate();
  const paths = sandbox.paths();
  const lines = paths.slice(0, 120).map((path) => {
    const content = sandbox.read(path) ?? "";
    const bytes = new TextEncoder().encode(content).length;
    return `${path} (${bytes} B)`;
  });
  const knowledge = (sandbox.read("knowledge.md") ?? "").slice(0, 4000);
  const digest = [
    `Project has ${paths.length} file(s):`,
    ...lines,
    knowledge ? `\nknowledge.md:\n${knowledge}` : "\nNo knowledge.md yet.",
  ].join("\n");
  await logAgent(
    sessionId,
    "files",
    `Indexed ${paths.length} file(s)${knowledge ? " and knowledge.md" : ""}.`,
  );
  await setAgent("files", "done", `${paths.length} file(s) indexed.`, sessionId);
  return { digest, knowledge, count: paths.length };
}

const NODE_BUILTINS = new Set([
  "fs", "path", "os", "crypto", "http", "https", "child_process", "process",
  "react", "react-dom", "module", "util", "stream", "buffer", "events",
]);

/** Which imports name a package package.json does not declare. */
export function missingPackages(
  files: ReadonlyMap<string, string>,
): { path: string; pkg: string }[] {
  const pkgText = files.get("package.json");
  if (!pkgText) return [];
  let declared: Record<string, string> = {};
  try {
    const pkg = JSON.parse(pkgText) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    declared = { ...pkg.dependencies, ...pkg.devDependencies };
  } catch {
    return [];
  }

  const issues: { path: string; pkg: string }[] = [];
  const pattern = /(?:from\s*|require\(\s*|import\s*\(\s*|import\s+)(["'])([^"'\n]+)\1/g;
  for (const path of files.keys()) {
    if (!/\.(m?js|jsx|ts|tsx)$/.test(path)) continue;
    const code = files.get(path) ?? "";
    for (const match of code.matchAll(pattern)) {
      const spec = match[2] ?? "";
      if (!spec || spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("data:")) continue;
      const base = spec.startsWith("@")
        ? spec.split("/").slice(0, 2).join("/")
        : spec.split("/")[0];
      if (NODE_BUILTINS.has(base) || base in declared) continue;
      issues.push({ path, pkg: base });
    }
  }
  return issues;
}

/* ------------------------------------------------------------------ run */

export type PipelineInput = {
  sessionId: string;
  goal: string;
  provider: ProviderId;
  model: string;
  /** Extra goal/context/constraints packaged by the Assistant, if any. */
  context?: string;
  constraints?: string;
  /** Aborting this stops the run (the page's Stop button uses it). */
  signal?: AbortSignal;
};

export type PipelineResult = {
  ok: boolean;
  stopped: boolean;
  summary: string;
  written: string[];
  build: BuildResult | null;
  errors: string[];
};

/**
 * Run the whole crew over one brief. Every agent's status and words land in
 * IndexedDB as the run progresses, so the badges, the thought stream and the
 * Control Room lights are readings rather than decorations.
 */
export async function runPipeline(input: PipelineInput): Promise<PipelineResult> {
  const config = await readConfig();
  if (config.emergencyStopped) {
    throw new Error("Emergency stop is on — release it in the Control Room before building.");
  }
  if (!input.provider || !input.model) {
    throw new Error("No model is chosen — pick a provider and model in the Control Room's BYOK hub.");
  }

  const controller = new AbortController();
  const unregister = registerAbort(controller);
  const forward = () => controller.abort();
  input.signal?.addEventListener("abort", forward);

  const sessionId = input.sessionId;
  const written: string[] = [];
  const errors: string[] = [];
  let currentAgent: AgentId = "director";
  let build: BuildResult | null = null;

  const stopCheck = async () => {
    if (controller.signal.aborted) {
      await setAgent(currentAgent, "stopped", "Stopped.", sessionId);
      throw new DOMException("Stopped.", "AbortError");
    }
  };

  /** One model call from inside a named agent, honouring the stop. */
  const ask = async (
    agent: AgentId,
    system: string,
    messages: LlmMessage[],
    maxTokens?: number,
  ): Promise<string> => {
    await stopCheck();
    currentAgent = agent;
    const result = await chatOnce({
      provider: input.provider,
      model: input.model,
      system,
      messages,
      maxTokens,
      signal: controller.signal,
    });
    return result.text;
  };

  /** The same call, insisting on a JSON answer (one repair round if fumbled). */
  const askJson = async (
    agent: AgentId,
    system: string,
    messages: LlmMessage[],
    maxTokens?: number,
  ): Promise<unknown> => {
    const text = await ask(agent, system, messages, maxTokens);
    try {
      return parseJson(text);
    } catch {
      await logAgent(sessionId, agent, "That answer was not JSON — asking again.");
      const retry = await ask(
        agent,
        system,
        [
          ...messages,
          { role: "assistant", content: text },
          { role: "user", content: "Reply with only the JSON object, nothing around it." },
        ],
        maxTokens,
      );
      return parseJson(retry);
    }
  };

  const brief = [
    input.goal,
    input.context ? `\nContext from the assistant: ${input.context}` : "",
    input.constraints ? `\nConstraints: ${input.constraints}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    /* ------------------------------------------------------------ director */
    await setAgent("director", "running", "Reading the brief…", sessionId);
    await logAgent(sessionId, "director", `Brief: ${input.goal.slice(0, 240)}`);
    const director = directorSchema.parse(
      await askJson("director", DIRECTOR_SYSTEM, [{ role: "user", content: brief }]),
    );
    await logAgent(sessionId, "director", director.summary || director.approach);

    /* ------------------------------------------------------------- planner */
    await setAgent("planner", "running", "Shaping the work…", sessionId);
    const existing = sandbox.paths();
    const researchFirst =
      config.parallelAgents && director.needsResearch
        ? runResearch(input.goal, config, sessionId).catch((error) => {
            void logAgent(
              sessionId,
              "research",
              `Search failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            return "";
          })
        : null;

    const plan = planSchema.parse(
      await askJson(
        "planner",
        PLANNER_SYSTEM,
        [
          {
            role: "user",
            content: `Brief:\n${brief}\n\nDirector's approach: ${director.approach}\n\nExisting files in the sandbox:\n${
              existing.length ? existing.join("\n") : "(none — this is a fresh project)"
            }`,
          },
        ],
        2000,
      ),
    );
    await logAgent(
      sessionId,
      "planner",
      `Plan: ${plan.files.length} file(s) — ${plan.files
        .map((file) => `${file.action} ${file.path}`)
        .slice(0, 8)
        .join(", ")}${plan.files.length > 8 ? "…" : ""}`,
    );
    await setAgent("planner", "done", `${plan.files.length} file(s) planned.`, sessionId);

    /* -------------------------------------------------------- file & context */
    const indexed = await indexFilesAgent(sessionId);

    /* ------------------------------------------------------------ research */
    let researchText = "";
    if (director.needsResearch) {
      await setAgent("research", "running", "Looking things up…", sessionId);
      researchText = researchFirst ? await researchFirst : await runResearch(input.goal, config, sessionId);
      await setAgent(
        "research",
        "done",
        researchText ? "Notes ready." : "Nothing usable found.",
        sessionId,
      );
    } else {
      await setAgent("research", "idle", "Not needed for this brief.", sessionId);
    }

    /* -------------------------------------------------------- implementation */
    const targets = plan.files.filter((file) => file.action !== "delete");
    await setAgent("implement", "running", `Writing ${targets.length} file(s)…`, sessionId);

    const context = [
      `Director's approach: ${director.approach}`,
      plan.notes ? `Planner's notes: ${plan.notes}` : "",
      indexed.digest,
      researchText ? `\nResearch notes:\n${researchText.slice(0, 3000)}` : "",
    ]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 14000);

    const writeOne = async (target: { path: string; intent: string }) => {
      await stopCheck();
      const existingContent = sandbox.read(target.path);
      const raw = await askJson(
        "implement",
        IMPLEMENT_SYSTEM,
        [
          {
            role: "user",
            content: `Write the file "${target.path}".\nIts purpose: ${target.intent}\n${
              existingContent
                ? `It already exists — return the full updated file:\n\n${existingContent.slice(0, 8000)}`
                : "It does not exist yet."
            }\n\nProject context:\n${context}`,
          },
        ],
        8192,
      );
      const parsed = writeSchema.parse(raw);
      // The path asked for is the path written — a model cannot redirect a file.
      await sandbox.write(target.path, parsed.content);
      written.push(target.path);
      await logAgent(sessionId, "implement", `Wrote ${target.path}`);
    };

    const chunkSize = config.parallelAgents ? 3 : 1;
    for (let index = 0; index < targets.length; index += chunkSize) {
      const chunk = targets.slice(index, index + chunkSize);
      if (chunkSize > 1 && chunk.length > 1) {
        const settled = await Promise.allSettled(chunk.map((target) => writeOne(target)));
        for (const outcome of settled) {
          if (outcome.status === "rejected") {
            const message =
              outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
            if (controller.signal.aborted) throw outcome.reason;
            errors.push(message);
            await logAgent(sessionId, "implement", `Failed: ${message}`);
          }
        }
      } else {
        for (const target of chunk) await writeOne(target);
      }
    }

    for (const file of plan.files.filter((entry) => entry.action === "delete")) {
      await sandbox.remove(file.path);
      await logAgent(sessionId, "implement", `Deleted ${file.path}`);
    }

    if (written.length) {
      await setAgent("implement", "done", `${written.length} file(s) written.`, sessionId);
    } else if (!errors.length) {
      await setAgent("implement", "done", "Nothing to write.", sessionId);
    } else {
      await setAgent("implement", "error", `${errors.length} write(s) failed.`, sessionId);
    }

    /* ------------------------------------------------------ review & debug */
    await setAgent("review", "running", "Checking the build…", sessionId);
    await logAgent(sessionId, "review", "Running the sandbox build.");
    build = await sandbox.build();

    for (let round = 1; round <= 2 && !build.ok; round += 1) {
      await logAgent(
        sessionId,
        "review",
        `Round ${round}: ${build.errors.length} problem(s) — sending corrections back.`,
      );
      const raw = await askJson(
        "review",
        FIX_SYSTEM,
        [
          {
            role: "user",
            content: JSON.stringify({
              errors: build.errors,
              failedSteps: build.steps
                .filter((step) => !step.ok)
                .map((step) => `${step.label}: ${step.detail}`),
              files: written
                .map((path) => ({ path, content: (sandbox.read(path) ?? "").slice(0, 12000) }))
                .slice(0, 12),
            }),
          },
        ],
        8192,
      );
      const fix = fixSchema.parse(raw);
      for (const file of fix.files) {
        await sandbox.write(file.path, file.content);
        if (!written.includes(file.path)) written.push(file.path);
      }
      await logAgent(sessionId, "review", fix.note || `Applied ${fix.files.length} correction(s).`);
      build = await sandbox.build();
    }

    const missing = missingPackages(
      new Map(sandbox.paths().map((path): [string, string] => [path, sandbox.read(path) ?? ""])),
    );
    if (missing.length) {
      build.steps.push({
        label: "Import check",
        ok: false,
        detail: `Not declared in package.json: ${[...new Set(missing.map((item) => item.pkg))].join(", ")} (warning).`,
      });
      await logAgent(
        sessionId,
        "review",
        `Imports missing from package.json: ${[...new Set(missing.map((item) => item.pkg))].join(", ")}`,
      );
    }

    await setAgent(
      "review",
      build.ok ? "done" : "error",
      build.ok ? "Build passed." : `${build.errors.length} problem(s) left.`,
      sessionId,
    );

    /* ------------------------------------------------------------- wrap up */
    let summary = "";
    try {
      summary = await ask("director", SUMMARY_SYSTEM, [
        {
          role: "user",
          content: `Goal: ${input.goal}\nWrote: ${written.join(", ") || "(nothing new)"}\nBuild: ${
            build.ok ? "passed" : `failed — ${build.errors.join(" / ")}`
          }`,
        },
      ], 400);
    } catch (error) {
      if (controller.signal.aborted) throw error;
      summary = `Built ${written.length} file(s): ${written.slice(0, 6).join(", ")}${
        written.length > 6 ? "…" : ""
      }. ${build.ok ? "The build passed." : `The build still reports ${build.errors.length} problem(s).`}`;
    }
    await setAgent("director", "done", "Run finished.", sessionId);

    return {
      ok: build.ok && errors.length === 0,
      stopped: false,
      summary,
      written,
      build,
      errors,
    };
  } catch (error) {
    const stopped =
      controller.signal.aborted ||
      (error instanceof DOMException && error.name === "AbortError");
    if (stopped) {
      await setAgent(currentAgent, "stopped", "Stopped.", sessionId);
      await logAgent(sessionId, currentAgent, "Run stopped before it finished.");
      return { ok: false, stopped: true, summary: "The run was stopped.", written, build, errors };
    }
    const message = error instanceof Error ? error.message : String(error);
    await recordError("forge pipeline", error);
    await setAgent(currentAgent, "error", message, sessionId);
    await logAgent(sessionId, currentAgent, `Failed: ${message}`);
    errors.push(message);
    return { ok: false, stopped: false, summary: `The run failed: ${message}`, written, build, errors };
  } finally {
    unregister();
    input.signal?.removeEventListener("abort", forward);
  }
}
