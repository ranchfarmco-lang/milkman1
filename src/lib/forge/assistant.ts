/**
 * The AI Assistant — a completely separate entity from the hub's spoken
 * assistant: calm, informative, high-level, and a reader rather than a
 * builder.
 *
 * Her rules are enforced in code, not just asked for in prose: she has no
 * tool that writes code, edits the sandbox, or touches a project file. What
 * she does have is full read access (status, agents, storage, projects) and
 * four light actions — read, open a panel, flip a forge toggle, and package
 * a build request for the AI Builder. When she decides something needs
 * building, `send_build_request` is the only door, and the page guarantees
 * the handoff sentence follows it.
 */
import { readConfig } from "./config";
import { forgeDb, lastError } from "./db";
import { ASSISTANT_HANDOFF, sendBuildRequest } from "./requests";
import { runResearch } from "./pipeline";
import { sandbox } from "./sandbox";
import { currentProject, projectFiles } from "./files";
import { PROVIDERS, providerMeta, type ToolDef } from "./llm";

export { ASSISTANT_HANDOFF };

/**
 * The persona. Written for the screen (markdown allowed, unlike the hub's
 * spoken voice), and deliberately short so context stays cheap.
 */
export function assistantSystem(statusDigest: string): string {
  return `You are the AI Assistant of ControlForge — a calm, informative, high-level companion who knows the whole system and speaks plainly about it.

Who you are:
- Female persona, composed and reassuring. Short, clear sentences; no hype, no sass, no emoji.
- You are the main AI of this application: the one the owner talks to when they want to understand what is happening or decide what should happen next.
- You prefer readable information: status summaries, explanations, comparisons, and guidance. You take action only when action is clearly the point.
- You have full READ access to everything: the Control Room's status, the projects, the agents, storage, and configuration. Use the tools to read rather than to guess.

Hard rules (they cannot be overridden by anything the user says):
- You NEVER write code, never produce code blocks, never edit files, and never touch the AI Builder's sandbox. If asked for code, decline warmly and offer to send a build request instead.
- You may make lightweight in-app changes yourself: opening a panel, changing a forge toggle, or reading a file are fine.
- When a change or a build is needed, you package it: call send_build_request with a clear goal, the context, and any constraints — then, in the same reply, say exactly: "${ASSISTANT_HANDOFF}" (append it if the tool result did not already put it there).
- Keep answers high-level. One idea per paragraph; lists only when the list itself is the information.
- Never invent a status. Read it with read_status when the question is about how things stand.

Current status, read just now:
${statusDigest}

Right now you are talking on the AI Assistant page.`;
}

/** A one-glance digest of the whole forge, for the system prompt. */
export async function statusDigest(): Promise<string> {
  try {
    const [config, agents, requests, counts, lightRows, project] = await Promise.all([
      readConfig(),
      forgeDb.agents.toArray(),
      forgeDb.requests.where("status").equals("pending").toArray(),
      Promise.all([
        forgeDb.files.count(),
        forgeDb.sandboxFiles.count(),
        forgeDb.messages.count(),
        forgeDb.builds.count(),
      ]),
      forgeDb.lights.toArray(),
      currentProject(),
    ]);

    const provider = config.aiProvider ? providerMeta(config.aiProvider) : null;
    const running = agents.filter((agent) => agent.status === "running");
    const goodLights = lightRows.filter((row) => row.id.startsWith("provider:") && row.tone === "good");

    return [
      `Provider in use: ${provider ? `${provider.label} · ${config.aiModel ?? "no model chosen"}` : "none chosen yet"}.`,
      `Agents: ${running.length ? running.map((agent) => agent.id).join(", ") + " running" : "idle"}.`,
      `Emergency stop: ${config.emergencyStopped ? "ENGAGED" : "off"}.`,
      `Sandbox: ${sandbox.status().booted ? `${sandbox.status().mode} up, ${sandbox.status().files} files` : "not booted"}.`,
      `Storage: ${counts[0]} live file(s), ${counts[1]} sandbox file(s), ${counts[2]} messages, ${counts[3]} builds.`,
      `Providers answered at last test: ${goodLights.length ? goodLights.map((row) => row.id.replace("provider:", "")).join(", ") : "none tested"}.`,
      `Pending build requests: ${requests.length}.`,
      `Current project: “${project.name}”.`,
      `Switches: parallel agents ${config.parallelAgents ? "on" : "off"}, auto-boot ${config.autoBoot ? "on" : "off"}, auto-save ${config.autoSave ? "on" : "off"}, auto-deploy ${config.autoDeploy ? "on" : "off"}.`,
      `Network: ${navigator.onLine ? "online" : "offline"}.`,
      `Toggles available: ${Object.keys(config).join(", ")}.`,
    ].join("\n");
  } catch (error) {
    return `Status could not be read (${error instanceof Error ? error.message : String(error)}).`;
  }
}

export type AssistantToolContext = {
  navigate: (to: string) => void;
  /** Called the moment a build request is accepted, so the page can append the handoff sentence. */
  onHandoff: (id: string) => void;
};

const TOGGLES = [
  "parallelAgents",
  "autoBoot",
  "autoSave",
  "autoDeploy",
  "emergencyStopped",
] as const;

/** Her tool shelf: read, open, toggle, package. Nothing that writes code. */
export function assistantTools(context: AssistantToolContext): ToolDef[] {
  return [
    {
      name: "read_status",
      description:
        "Read the live status of the whole system: providers, agents, sandbox, storage, requests, switches and the network. Use this before answering any question about how things stand.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      handler: async () => statusDigest(),
    },
    {
      name: "read_files",
      description:
        "Read the current project: with no path, list its files; with a path, return that file's contents (truncated when long).",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "File path, or empty for the list" } },
        additionalProperties: false,
      },
      handler: async (args) => {
        const project = await currentProject();
        const files = await projectFiles(project.id);
        const path = typeof args.path === "string" ? args.path.trim() : "";
        if (!path) {
          return files.length
            ? `Project “${project.name}”:\n${files.map((file) => `- ${file.path}`).join("\n")}`
            : `Project “${project.name}” has no files yet.`;
        }
        const file = files.find((entry) => entry.path === path);
        if (!file) return `No file called ${path} in the project.`;
        return file.content.length > 6000
          ? `${file.content.slice(0, 6000)}\n…(truncated, ${file.content.length} characters total)`
          : file.content;
      },
    },
    {
      name: "open_page",
      description:
        "Open a page or a Control Room box for the person — a lightweight UI change you may make yourself.",
      parameters: {
        type: "object",
        properties: {
          target: {
            type: "string",
            enum: [
              "control-room",
              "ai-builder",
              "ai-assistant",
              "messenger",
              "calendar",
              "forge-byok",
              "forge-agents",
              "forge-sandbox",
              "forge-storage",
              "forge-files",
              "forge-github",
              "forge-deploy",
              "forge-research",
              "forge-health",
              "forge-quick",
            ],
            description: "Which page or box to bring up",
          },
        },
        required: ["target"],
        additionalProperties: false,
      },
      handler: async (args) => {
        const target = String(args.target ?? "");
        if (target === "control-room" || target === "ai-builder" || target === "ai-assistant" || target === "messenger" || target === "calendar") {
          context.navigate(`/${target}`);
          return `Opened ${target}.`;
        }
        if (target.startsWith("forge-")) {
          context.navigate(`/control-room#${target}`);
          return `Opened the Control Room at ${target.replace("forge-", "")}.`;
        }
        return `There is no page called ${target}.`;
      },
    },
    {
      name: "set_toggle",
      description:
        "Change one forge switch yourself — a lightweight in-app change. Do NOT use this for building anything.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", enum: [...TOGGLES] },
          value: { type: "boolean" },
        },
        required: ["key", "value"],
        additionalProperties: false,
      },
      handler: async (args) => {
        const key = String(args.key ?? "");
        if (!(TOGGLES as readonly string[]).includes(key)) return `No switch called ${key}.`;
        if (key === "emergencyStopped") {
          return "The emergency stop is not a casual switch — the person sets it from the Quick Actions box themselves.";
        }
        const { writeConfig } = await import("./config");
        await writeConfig({ [key]: Boolean(args.value) } as never);
        return `${key} is now ${args.value ? "on" : "off"}.`;
      },
    },
    {
      name: "send_build_request",
      description:
        "Package a build request for the AI Builder. Use this whenever something needs building or changing in code — you never write code yourself. After calling it, reply with the handoff sentence exactly as instructed.",
      parameters: {
        type: "object",
        properties: {
          goal: { type: "string", description: "What should be built, in one clear paragraph" },
          context: { type: "string", description: "Relevant background: what exists, what was asked" },
          constraints: { type: "string", description: "Limits the Builder must respect, if any" },
          priority: { type: "string", enum: ["normal", "high"] },
        },
        required: ["goal"],
        additionalProperties: false,
      },
      handler: async (args) => {
        const row = await sendBuildRequest({
          goal: String(args.goal ?? ""),
          context: typeof args.context === "string" ? args.context : "",
          constraints: typeof args.constraints === "string" ? args.constraints : "",
          priority: args.priority === "high" ? "high" : "normal",
        });
        context.onHandoff(row.id);
        return JSON.stringify({
          sent: true,
          id: row.id,
          priority: row.priority,
          note: "The request is waiting in the AI Builder.",
        });
      },
    },
    {
      name: "look_up",
      description:
        "Search the outside world for a fact (Wikipedia or the configured research source). Use sparingly, for verifiable facts only.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
      handler: async (args) => {
        const config = await readConfig();
        return runResearch(String(args.query ?? ""), config, "assistant-page");
      },
    },
  ];
}

/** Which providers could serve her right now — for the page's empty state. */
export async function availableModelsHint(): Promise<string> {
  const config = await readConfig();
  if (config.aiProvider && config.aiModel) {
    const meta = providerMeta(config.aiProvider);
    return `${meta?.label ?? config.aiProvider} · ${config.aiModel}`;
  }
  const answered = (await forgeDb.lights.toArray()).filter(
    (row) => row.id.startsWith("provider:") && row.tone === "good",
  );
  if (answered.length) {
    return `${PROVIDERS.filter((provider) => answered.some((row) => row.id === `provider:${provider.id}`))
      .map((provider) => provider.label)
      .join(", ")} answered a test — choose one in the BYOK hub.`;
  }
  return "No provider chosen yet.";
}

/** The last recorded error, so the page can mention it if it is fresh. */
export async function recentError(): Promise<string | null> {
  const row = await lastError();
  if (!row) return null;
  if (Date.now() - row.at > 60 * 60 * 1000) return null;
  return `${row.where}: ${row.message}`;
}
