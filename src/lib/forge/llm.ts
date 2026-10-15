/**
 * The unified LLM router — one door to every provider the forge may talk to.
 *
 * Bring-your-own-key, in the browser: the key is read from the encrypted
 * vault for the length of one request and put straight into the header (or
 * the single query parameter Google wants) of the call to that provider.
 * Nothing is proxied, nothing is stored in the clear, and no key ever goes
 * anywhere its provider did not.
 *
 * Providers come in two shapes — OpenAI-compatible chat completions, plus
 * Anthropic's and Google's own wire formats — so this file builds the request
 * for each shape (`chatSpec`) and flattens each answer back into one neutral
 * result (`normalize`). Everything above that is shape-agnostic.
 *
 * The pure builders are exported because they are the part worth testing
 * without a network: `scripts/forge-check.ts` asserts the URLs, headers and
 * payloads for all seven providers.
 */
import { readConfig } from "./config";
import { getSecret } from "./crypto";
import { recordError, type Tone } from "./db";
import { hubComplete, hubAiReady } from "./hub-ai";

export type ProviderId =
  // The hub's own models, on the deployment, behind the keys it already has.
  // The one entry that needs no setup at all, so it is the one the crew starts
  // on — see `ai.complete` for the door it goes through.
  | "hub"
  | "openai"
  | "anthropic"
  | "openrouter"
  | "gemini"
  | "groq"
  | "ollama"
  | "lmstudio";

export type ProviderMeta = {
  id: ProviderId;
  label: string;
  /** Runs on the owner's machine — no key, loopback by default. */
  local: boolean;
  /** Where to get a key, shown beside the input. */
  keyUrl: string;
  /** The environment name the hub would use for the same key, for reference. */
  keyHint: string;
  /** Default address (origin; paths are added per call below). */
  baseUrl: string;
  needsKey: boolean;
  /** Offered before any live model list has been fetched. */
  models: string[];
};

export const PROVIDERS: ProviderMeta[] = [
  {
    id: "hub",
    label: "This hub",
    local: false,
    keyUrl: "",
    keyHint: "",
    baseUrl: "",
    needsKey: false,
    models: ["auto"],
  },
  {
    id: "openai",
    label: "OpenAI",
    local: false,
    keyUrl: "https://platform.openai.com/api-keys",
    keyHint: "OPENAI_API_KEY",
    baseUrl: "https://api.openai.com",
    needsKey: true,
    models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini"],
  },
  {
    id: "anthropic",
    label: "Anthropic",
    local: false,
    keyUrl: "https://console.anthropic.com/settings/keys",
    keyHint: "ANTHROPIC_API_KEY",
    baseUrl: "https://api.anthropic.com",
    needsKey: true,
    models: ["claude-3-5-haiku-latest", "claude-sonnet-4-0"],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    local: false,
    keyUrl: "https://openrouter.ai/keys",
    keyHint: "OPENROUTER_API_KEY",
    baseUrl: "https://openrouter.ai/api",
    needsKey: true,
    models: ["deepseek/deepseek-chat", "meta-llama/llama-3.3-70b-instruct"],
  },
  {
    id: "gemini",
    label: "Google Gemini",
    local: false,
    keyUrl: "https://aistudio.google.com/apikey",
    keyHint: "GEMINI_API_KEY",
    baseUrl: "https://generativelanguage.googleapis.com",
    needsKey: true,
    models: ["gemini-2.0-flash", "gemini-1.5-flash"],
  },
  {
    id: "groq",
    label: "Groq",
    local: false,
    keyUrl: "https://console.groq.com/keys",
    keyHint: "GROQ_API_KEY",
    baseUrl: "https://api.groq.com/openai",
    needsKey: true,
    models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
  },
  {
    id: "ollama",
    label: "Ollama",
    local: true,
    keyUrl: "",
    keyHint: "",
    baseUrl: "http://127.0.0.1:11434",
    needsKey: false,
    models: ["llama3.2", "qwen2.5-coder:7b", "mistral"],
  },
  {
    id: "lmstudio",
    label: "LM Studio",
    local: true,
    keyUrl: "",
    keyHint: "",
    baseUrl: "http://127.0.0.1:1234",
    needsKey: false,
    models: ["local-model"],
  },
];

const BY_ID = new Map(PROVIDERS.map((provider) => [provider.id, provider] as const));

export function providerMeta(id: string): ProviderMeta | null {
  return BY_ID.get(id as ProviderId) ?? null;
}

/** The encrypted-vault id a provider's key is kept under. */
export function providerSecretId(id: ProviderId): string {
  return `provider:${id}`;
}

/* ------------------------------------------------------------------ wire shapes */

export type LlmToolCall = { id: string; name: string; args: Record<string, unknown> };

/** The router's own message format; each provider serialises it differently. */
export type LlmMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: LlmToolCall[] }
  | { role: "tool"; name: string; content: string; callId: string };

export type ToolShape = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type ChatResult = { text: string; toolCalls: LlmToolCall[] };

export type RequestSpec = { url: string; init: RequestInit };

/** Join an origin with a path without doubling or dropping the slash. */
function at(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}

/** The chat and model-list addresses of one provider. */
export function endpointsOf(provider: ProviderId, base: string): { chat: string; models: string } {
  const root = base.replace(/\/+$/, "");
  switch (provider) {
    case "openai":
      return { chat: at(root, "/v1/chat/completions"), models: at(root, "/v1/models") };
    case "openrouter":
      return { chat: at(root, "/v1/chat/completions"), models: at(root, "/v1/models") };
    case "groq":
      return { chat: at(root, "/v1/chat/completions"), models: at(root, "/v1/models") };
    case "ollama":
      return { chat: at(root, "/v1/chat/completions"), models: at(root, "/api/tags") };
    case "lmstudio":
      return { chat: at(root, "/v1/chat/completions"), models: at(root, "/v1/models") };
    case "anthropic":
      return { chat: at(root, "/v1/messages"), models: at(root, "/v1/models") };
    case "gemini":
      return { chat: `${at(root, "/v1beta/models")}/`, models: at(root, "/v1beta/models") };
    // The hub's own models have no address out here: every call goes through
    // the deployment, which is what `chatOnce` does before this is reached.
    case "hub":
      return { chat: "", models: "" };
  }
}

/**
 * A message list as the one prompt `ai.complete` takes.
 *
 * The crew's own shape is a system prompt plus a short exchange — a single
 * message, and sometimes its own earlier answer with a line asking for JSON.
 * Both readings are kept apart so the model can tell what it said before.
 */
function messagesToPrompt(messages: LlmMessage[]): string {
  return messages
    .map((message) => {
      if (message.role === "user") return message.content;
      if (message.role === "assistant") {
        return `(your earlier answer)\n${message.content}`;
      }
      return `(result of ${message.name})\n${message.content}`;
    })
    .join("\n\n");
}

/* ------------------------------------------------------------------ builders */

type SpecInput = {
  provider: ProviderId;
  base: string;
  key: string | null;
  model: string;
  messages: LlmMessage[];
  system?: string | null;
  tools?: ToolShape[];
  maxTokens?: number;
  temperature?: number;
};

/** An OpenAI-compatible `/chat/completions` payload. */
function compatSpec(input: SpecInput): RequestSpec {
  const { chat } = endpointsOf(input.provider, input.base);
  const messages: unknown[] = [];
  if (input.system) messages.push({ role: "system", content: input.system });

  for (const message of input.messages) {
    if (message.role === "tool") {
      messages.push({
        role: "tool",
        tool_call_id: message.callId,
        content: message.content,
      });
      continue;
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      messages.push({
        role: "assistant",
        content: message.content || null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
        })),
      });
      continue;
    }
    messages.push({ role: message.role, content: message.content });
  }

  const body: Record<string, unknown> = {
    model: input.model,
    messages,
    temperature: input.temperature ?? 0.4,
    max_tokens: input.maxTokens ?? 4096,
  };
  if (input.tools?.length) {
    body.tools = input.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (input.key) headers.Authorization = `Bearer ${input.key}`;
  return { url: chat, init: { method: "POST", headers, body: JSON.stringify(body) } };
}

/** Anthropic's `/v1/messages` payload — tool_use / tool_result blocks. */
function anthropicSpec(input: SpecInput): RequestSpec {
  const { chat } = endpointsOf("anthropic", input.base);
  const content: unknown[] = [];

  for (const message of input.messages) {
    if (message.role === "tool") {
      content.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: message.callId,
            content: message.content,
          },
        ],
      });
      continue;
    }
    if (message.role === "assistant") {
      const blocks: unknown[] = [];
      if (message.content) blocks.push({ type: "text", text: message.content });
      for (const call of message.toolCalls ?? []) {
        blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.args });
      }
      content.push({ role: "assistant", content: blocks.length ? blocks : message.content });
      continue;
    }
    content.push({ role: "user", content: message.content });
  }

  const body: Record<string, unknown> = {
    model: input.model,
    messages: content,
    max_tokens: input.maxTokens ?? 4096,
    temperature: input.temperature ?? 0.4,
  };
  if (input.system) body.system = input.system;
  if (input.tools?.length) {
    body.tools = input.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }));
  }

  return {
    url: chat,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": input.key ?? "",
        // Without this header the browser is refused CORS; with it, Anthropic
        // answers the request like any other first-party client.
        "anthropic-dangerous-direct-browser-access": "true",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    },
  };
}

/** Google's `:generateContent` payload — parts, functionCall, functionResponse. */
function geminiSpec(input: SpecInput): RequestSpec {
  const root = input.base.replace(/\/+$/, "");
  const url = `${at(root, "/v1beta/models")}/${encodeURIComponent(input.model)}:generateContent`;

  const contents: unknown[] = [];
  for (const message of input.messages) {
    if (message.role === "tool") {
      let parsed: unknown = message.content;
      try {
        parsed = JSON.parse(message.content);
      } catch {
        // The model reads a plain string back fine either way.
      }
      contents.push({
        role: "user",
        parts: [{ functionResponse: { name: message.name, response: { content: parsed } } }],
      });
      continue;
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      contents.push({
        role: "model",
        parts: [
          ...(message.content ? [{ text: message.content }] : []),
          ...message.toolCalls.map((call) => ({ functionCall: { name: call.name, args: call.args } })),
        ],
      });
      continue;
    }
    contents.push({ role: "user", parts: [{ text: message.content }] });
  }

  const body: Record<string, unknown> = {
    contents,
    generationConfig: {
      temperature: input.temperature ?? 0.4,
      maxOutputTokens: input.maxTokens ?? 4096,
    },
  };
  if (input.system) body.systemInstruction = { parts: [{ text: input.system }] };
  if (input.tools?.length) {
    body.tools = [
      {
        functionDeclarations: input.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        })),
      },
    ];
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (input.key) headers["x-goog-api-key"] = input.key;

  return { url, init: { method: "POST", headers, body: JSON.stringify(body) } };
}

/** The request for any provider, in its own wire format. */
export function chatSpec(input: SpecInput): RequestSpec {
  if (input.provider === "anthropic") return anthropicSpec(input);
  if (input.provider === "gemini") return geminiSpec(input);
  return compatSpec(input);
}

/* ------------------------------------------------------------------ responses */

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Flatten any provider's answer into text plus neutral tool calls. */
export function normalize(provider: ProviderId, raw: unknown): ChatResult {
  const root = asRecord(raw);
  const toolCalls: LlmToolCall[] = [];
  let text = "";

  if (provider === "anthropic") {
    const blocks = asArray(root?.content);
    const parts: string[] = [];
    let index = 0;
    for (const block of blocks) {
      const item = asRecord(block);
      if (!item) continue;
      if (item.type === "text") parts.push(textOf(item.text));
      if (item.type === "tool_use") {
        index += 1;
        toolCalls.push({
          id: textOf(item.id) || `call_${index}`,
          name: textOf(item.name),
          args: (asRecord(item.input) ?? {}) as Record<string, unknown>,
        });
      }
    }
    return { text: parts.join("\n").trim(), toolCalls };
  }

  if (provider === "gemini") {
    const candidates = asArray(root?.candidates);
    const first = asRecord(candidates[0]);
    const parts = asArray(asRecord(first?.content)?.parts);
    const texts: string[] = [];
    let index = 0;
    for (const part of parts) {
      const item = asRecord(part);
      if (!item) continue;
      if (typeof item.text === "string") texts.push(item.text);
      const call = asRecord(item.functionCall);
      if (call) {
        index += 1;
        toolCalls.push({
          id: `call_${index}`,
          name: textOf(call.name),
          args: (asRecord(call.args) ?? {}) as Record<string, unknown>,
        });
      }
    }
    return { text: texts.join("\n").trim(), toolCalls };
  }

  // OpenAI-compatible.
  const choices = asArray(root?.choices);
  const message = asRecord(asRecord(choices[0])?.message);
  text = textOf(message?.content);
  for (const rawCall of asArray(message?.tool_calls)) {
    const call = asRecord(rawCall);
    const fn = asRecord(call?.function);
    if (!call || !fn) continue;
    let args: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(textOf(fn.arguments) || "{}");
      if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>;
    } catch {
      // A malformed argument blob still reaches the handler as {} and says so.
    }
    toolCalls.push({ id: textOf(call.id) || `call_${toolCalls.length + 1}`, name: textOf(fn.name), args });
  }
  return { text: text.trim(), toolCalls };
}

/* ------------------------------------------------------------------ transport */

/** A readable failure for the light beside every Test button. */
export function explainFailure(provider: ProviderId, base: string, error: unknown): string {
  const meta = providerMeta(provider);
  const label = meta?.label ?? provider;
  if (error instanceof DOMException && error.name === "AbortError") {
    return `${label} did not answer within the time allowed (${base}).`;
  }
  if (error instanceof TypeError) {
    return `${label} could not be reached at ${base} — the request was refused or blocked by the browser (CORS), or this device is offline.`;
  }
  return `${label}: ${error instanceof Error ? error.message : String(error)}`;
}

/** POST a spec and parse the JSON, with a hard timeout and honest errors. */
async function sendSpec(
  spec: RequestSpec,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort);

  try {
    const response = await fetch(spec.url, {
      ...spec.init,
      signal: controller.signal,
      cache: "no-store",
    });
    const body = await response.text();
    if (!response.ok) {
      let detail = body.slice(0, 400);
      try {
        const parsed = asRecord(JSON.parse(body));
        const err = asRecord(parsed?.error);
        detail = textOf(err?.message) || textOf(parsed?.message) || detail;
      } catch {
        // The raw body is the best it gets.
      }
      throw new Error(`${response.status} ${response.statusText} — ${detail || "no detail"}`);
    }
    try {
      return JSON.parse(body);
    } catch {
      throw new Error("The answer was not JSON — the endpoint may not be a model server.");
    }
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

export type ChatInput = {
  provider: ProviderId;
  model: string;
  messages: LlmMessage[];
  system?: string | null;
  tools?: ToolShape[];
  base?: string;
  key?: string | null;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
};

/**
 * One chat turn, resolved through the vault and the endpoint settings.
 * A missing key for a cloud provider fails with a sentence that says where
 * to get one, rather than a bare 401.
 */
export async function chatOnce(input: ChatInput): Promise<ChatResult> {
  const meta = providerMeta(input.provider);
  if (!meta) throw new Error(`Unknown provider: ${input.provider}`);

  // The hub's own models: one question, one answer, through the deployment.
  // No key of the browser's, no address, and no tools — the crew asks for JSON
  // in the message, which is the shape it reads back.
  if (input.provider === "hub") {
    const asked = await hubComplete({
      system: input.system ?? "",
      prompt: messagesToPrompt(input.messages),
      maxTokens: input.maxTokens,
      temperature: input.temperature,
    });
    if (!asked.ok) throw new Error(asked.error);
    return { text: asked.text, toolCalls: [] };
  }

  const config = await readConfig();
  const base =
    input.base ?? config.endpoints[input.provider]?.baseUrl ?? meta.baseUrl;

  let key = input.key ?? null;
  if (key === null && meta.needsKey) {
    key = await getSecret(providerSecretId(input.provider));
  }
  if (meta.needsKey && !key) {
    throw new Error(
      `No key saved for ${meta.label} yet — open the Control Room and add one in the BYOK hub.`,
    );
  }

  const spec = chatSpec({
    provider: input.provider,
    base,
    key,
    model: input.model,
    messages: input.messages,
    system: input.system ?? null,
    tools: input.tools,
    temperature: input.temperature,
    maxTokens: input.maxTokens,
  });

  try {
    const raw = await sendSpec(spec, { signal: input.signal });
    return normalize(input.provider, raw);
  } catch (error) {
    await recordError(`chat:${input.provider}`, error);
    throw new Error(explainFailure(input.provider, base, error));
  }
}

/* ------------------------------------------------------------------ testing */

export type TestResult = {
  tone: Tone;
  detail: string;
  models: string[];
  ms: number;
};

/** Pull the model list out of any provider's list endpoint. */
function modelNames(provider: ProviderId, raw: unknown): string[] {
  const root = asRecord(raw);
  if (provider === "gemini") {
    return asArray(root?.models)
      .map((model) => textOf(asRecord(model)?.name))
      .filter((name) => name)
      .map((name) => name.replace(/^models\//, ""));
  }
  if (provider === "ollama") {
    return asArray(root?.models)
      .map((model) => textOf(asRecord(model)?.name))
      .filter((name) => name);
  }
  return asArray(root?.data)
    .map((model) => textOf(asRecord(model)?.id))
    .filter((name) => name);
}

/**
 * Test a provider for real: fetch its model list. A light that has not been
 * tested says so (muted) instead of guessing green.
 */
export async function testProvider(
  provider: ProviderId,
  options: { base?: string; key?: string | null } = {},
): Promise<TestResult> {
  const meta = providerMeta(provider);
  if (!meta) return { tone: "bad", detail: "Unknown provider.", models: [], ms: 0 };

  // The hub's own models are tested by asking them something tiny, because
  // there is no model list to fetch and "is a key present" is not the question
  // — the question is whether this hub can answer the crew at all.
  if (provider === "hub") {
    if (!hubAiReady()) {
      return {
        tone: "warn",
        detail:
          "Waiting for the hub — open the AI Builder inside the app, signed in, and test again.",
        models: meta.models,
        ms: 0,
      };
    }
    const started = performance.now();
    const asked = await hubComplete({
      system: "You are a connection test. Reply with the single word: ok",
      prompt: "say ok",
      maxTokens: 16,
    });
    const ms = Math.round(performance.now() - started);
    return asked.ok
      ? { tone: "good", detail: `Answered in ${ms} ms — ${asked.by}.`, models: meta.models, ms }
      : { tone: "bad", detail: asked.error.slice(0, 400), models: meta.models, ms };
  }

  const config = await readConfig();
  const base = options.base ?? config.endpoints[provider]?.baseUrl ?? meta.baseUrl;

  let key = options.key;
  if (key === undefined) key = meta.needsKey ? await getSecret(providerSecretId(provider)) : null;

  if (meta.needsKey && !key) {
    return {
      tone: "warn",
      detail: `No key saved yet — paste one in ${meta.label}'s row.`,
      models: meta.models,
      ms: 0,
    };
  }

  const { models } = endpointsOf(provider, base);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (provider === "anthropic") {
    headers["x-api-key"] = key ?? "";
    headers["anthropic-version"] = "2023-06-01";
    headers["anthropic-dangerous-direct-browser-access"] = "true";
  } else if (provider === "gemini" && key) {
    headers["x-goog-api-key"] = key;
  } else if (key) {
    headers.Authorization = `Bearer ${key}`;
  }

  const started = performance.now();
  try {
    const raw = await sendSpec({ url: models, init: { method: "GET", headers } }, { timeoutMs: 9000 });
    const ms = Math.round(performance.now() - started);
    const names = modelNames(provider, raw);
    if (!names.length && provider !== "anthropic") {
      return {
        tone: "warn",
        detail: `Answered in ${ms} ms but listed no models.`,
        models: meta.models,
        ms,
      };
    }
    return {
      tone: "good",
      detail: `Answered in ${ms} ms — ${names.length || "some"} model${names.length === 1 ? "" : "s"} on offer.`,
      models: names.length ? names : meta.models,
      ms,
    };
  } catch (error) {
    const ms = Math.round(performance.now() - started);
    const refused = error instanceof Error && /^401 |^403 /.test(error.message);
    return {
      tone: "bad",
      detail: refused
        ? `The key was refused (${error.message.slice(0, 80)}).`
        : explainFailure(provider, base, error),
      models: meta.models,
      ms,
    };
  }
}

/** Probe both local model servers — the Detect button's actual work. */
export async function detectLocal(): Promise<
  { provider: ProviderId; base: string; models: string[] }[]
> {
  const config = await readConfig();
  const found: { provider: ProviderId; base: string; models: string[] }[] = [];
  for (const provider of ["ollama", "lmstudio"] as const) {
    const meta = providerMeta(provider)!;
    const base = config.endpoints[provider]?.baseUrl ?? meta.baseUrl;
    const result = await testProvider(provider, { base, key: null });
    if (result.tone === "good") found.push({ provider, base, models: result.models });
  }
  return found;
}

/* ------------------------------------------------------------------ tool loop */

export type ToolDef = ToolShape & {
  handler: (args: Record<string, unknown>) => string | Promise<string>;
};

export type ToolLoopResult = {
  text: string;
  used: string[];
  rounds: number;
};

/**
 * A conversation with tools: call the model, run whatever it asked to run,
 * feed the answers back, repeat — until it speaks plainly or the round limit
 * is reached, at which point one final tool-less call turns the work into a
 * sentence the person can read.
 */
export async function runToolLoop(input: {
  provider: ProviderId;
  model: string;
  system: string;
  messages: LlmMessage[];
  tools?: ToolDef[];
  maxRounds?: number;
  signal?: AbortSignal;
  onRound?: (info: { name: string; ok: boolean; note: string }) => void;
}): Promise<ToolLoopResult> {
  const maxRounds = input.maxRounds ?? 6;
  const history: LlmMessage[] = [...input.messages];
  const used: string[] = [];

  const throwIfStopped = () => {
    if (input.signal?.aborted) throw new DOMException("Stopped.", "AbortError");
  };

  for (let round = 1; round <= maxRounds; round += 1) {
    throwIfStopped();
    const result = await chatOnce({
      provider: input.provider,
      model: input.model,
      system: input.system,
      messages: history,
      tools: input.tools?.length ? input.tools : undefined,
      signal: input.signal,
    });

    if (!result.toolCalls.length) {
      return { text: result.text, used, rounds: round };
    }

    history.push({
      role: "assistant",
      content: result.text,
      toolCalls: result.toolCalls,
    });

    for (const call of result.toolCalls) {
      throwIfStopped();
      const tool = input.tools?.find((candidate) => candidate.name === call.name);
      let content: string;
      let ok = true;
      if (!tool) {
        ok = false;
        content = JSON.stringify({ error: `No tool called ${call.name}.` });
      } else {
        try {
          content = await tool.handler(call.args);
          if (!content) content = "(done, nothing to report)";
        } catch (error) {
          ok = false;
          content = JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      used.push(call.name);
      input.onRound?.({
        name: call.name,
        ok,
        note: ok ? "done" : content.slice(0, 160),
      });
      history.push({ role: "tool", name: call.name, content, callId: call.id });
    }
  }

  // Out of rounds: one last call without tools, so the person still gets prose.
  throwIfStopped();
  const final = await chatOnce({
    provider: input.provider,
    model: input.model,
    system: input.system,
    messages: [...history, { role: "user", content: "Summarise what you did and what remains, in plain sentences." }],
    signal: input.signal,
  });
  return { text: final.text, used, rounds: maxRounds };
}
