import { getAuthUserId } from "@convex-dev/auth/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action, query, type ActionCtx } from "./_generated/server";
import type { Agent } from "./ai_prompts";
import type { TraceStepKind } from "./schema";

/**
 * A number, when the JSON actually held one.
 *
 * It lives here rather than beside the actions because reading a tool call back
 * off what a model wrote is this half's job — the parser below needs it — and
 * the turn engine imports it from here, so there is only ever one of it.
 */
export function asNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * What the turn engine is handed.
 *
 * This file is the brain: which systems can answer, how a question is carried
 * to one of them, and how the reply comes back — streamed, with its own
 * reasoning — and it ends at the point where an answer exists. What a *turn*
 * does with that answer lives next door in `ai_turn.ts`, and the pieces it
 * needs are listed in one place here.
 *
 * Keeping the list in a single clause rather than scattering `export` keywords
 * through the file is deliberate: the dependency runs one way only. The loop
 * knows about the model layer; the model layer never knows about the loop.
 */
export {
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
};
export type { CallResult, OnDelta, Provider, Tracer, Turn };

// Google's Gemini endpoints. The last model in the list is the fallback.
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

const GEMINI_MODELS = [
  "gemini-3.8-flash",
  "gemini-flash-latest",
  "gemini-3.5-flash",
];

const MAX_ACTIONS = 8;
const MIN_MINUTES = 1;
const MAX_MINUTES = 60 * 24 * 7;

const CHAT_TOKENS = 6144;
const BUILDER_TOKENS = 8192;
const REVIEW_TOKENS = 4096;
const FALLBACK_TOKENS = 3072;

/**
 * How many times an agent may use a tool before it must commit to an answer.
 * The builder gets more: it reads its own code, writes files, runs them and
 * fixes what broke, and a real job takes several rounds before there is
 * anything worth handing over.
 */
const TOOL_ROUNDS: Record<Agent, number> = { assistant: 10, builder: 24 };
// How much of the thread each one is handed back. The assistant keeps a longer
// memory of the conversation than it used to, because the thread is where most
// of what it "remembers" between sessions actually lives.
const CONTEXT = { assistant: 48, builder: 64 } as const;

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const FETCH_TIMEOUT_MS = 12_000;

/**
 * How long a model gets, which is not the same question as how long a web page
 * gets.
 *
 * A request without streaming does not come back until the model has stopped
 * writing, so this budget has to cover the whole answer rather than a
 * handshake. The builder asks for 8192 tokens and the assistant for 6144, and a
 * small shared model writing that much takes far longer than twelve seconds.
 * Handing it twelve was aborting real answers mid-sentence — "the signal has
 * been aborted" — and reading as a flaky connection, which is what it was.
 */
const MODEL_TIMEOUT_FLOOR_MS = 22_000;
const MODEL_TIMEOUT_CEILING_MS = 45_000;
/** A deliberately pessimistic pace, for a slow and shared model. */
const MS_PER_TOKEN = 4;

/** Room to connect, think, and write the whole answer. */
function modelTimeout(maxTokens: number) {
  return Math.min(
    MODEL_TIMEOUT_FLOOR_MS + maxTokens * MS_PER_TOKEN,
    MODEL_TIMEOUT_CEILING_MS,
  );
}

/**
 * How long the free public system is given, which is a different question.
 *
 * A keyed system earns the wait above, because the answer is on its way and it
 * is worth having. A free public one that has not answered in twenty seconds is
 * not being slow, it is not there — and spending the full forty-five out, and
 * then spending it a second time on the non-streaming attempt, is a minute and
 * a half of a pane with nothing in it. That reads as a dropped connection
 * rather than a model that is missing, and it is what the person actually sees.
 * Capped, the same failure is over in seconds and says what it is.
 */
const FREE_MODEL_TIMEOUT_MS = 20_000;

function budgetFor(provider: Provider, maxTokens: number) {
  const full = modelTimeout(maxTokens);
  return provider.free ? Math.min(full, FREE_MODEL_TIMEOUT_MS) : full;
}

/**
 * A free public system is shared and thin. Pollinations holds one request at a
 * time per address, so a second one arriving while the first is still in flight
 * is refused with 429 — even though nothing is wrong with this hub. That is a
 * busy signal rather than a broken setup, so it is waited out and asked again
 * rather than reported as a failure, and it should never read as the family's
 * own mistake.
 *
 * Note that this is only reachable on *new* text: the service caches identical
 * prompts, so a repeated health check never queues and never sees a 429.
 */
const TRANSIENT_RETRIES = 2;
const TRANSIENT_BACKOFF_MS = 1_500;

/**
 * The statuses that pass on their own, and so are waited out rather than
 * reported: a refusal to queue, a gateway having a bad afternoon, a request the
 * clock ran out on. None of them say anything is wrong with this hub or its
 * keys. A 502 used to be handed straight to the reader as an error, though it
 * is never theirs to fix.
 */
const TRANSIENT_STATUSES = [408, 425, 429, 500, 502, 503, 504];

/** How long one system's models may be walked before the question moves on. */
const MODEL_WALK_DEADLINE_MS = 90_000;
/**
 * How long the whole chain of systems may take. It sits under the action's own
 * ceiling, so a run of dead systems is reported as a failure rather than being
 * cut off by the platform with nothing to say.
 */
const PROVIDER_CHAIN_DEADLINE_MS = 150_000;

function pause(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Reading the clock out loud, tolerantly.
 *
 * A reply opens by saying when it was written, and both places that do that ask
 * for a full date, a short time and the time-zone name in one call. ECMA-402
 * forbids pairing dateStyle/timeStyle with timeZoneName, and the runtime is
 * entitled to throw on it — which failed the whole reply rather than one line
 * of the prompt. The zone name is dropped instead of the answer.
 */
const plainToLocaleString = Date.prototype.toLocaleString;

function toLocaleStringTolerant(
  this: Date,
  locales?: Intl.LocalesArgument,
  options?: Intl.DateTimeFormatOptions,
): string {
  if ((options?.dateStyle ?? options?.timeStyle) && options?.timeZoneName) {
    const withoutZone: Intl.DateTimeFormatOptions = { ...options };
    delete withoutZone.timeZoneName;
    return plainToLocaleString.call(this, locales, withoutZone);
  }

  return plainToLocaleString.call(this, locales, options);
}Date.prototype.toLocaleString = toLocaleStringTolerant;

/**
 * What a system costs, in the one word the Control Room is allowed to say.
 *
 * "free" needs nobody's key at all, "free-tier" answers for nothing once the
 * family adds one, "paid" bills per token, and "own" is the endpoint they
 * pointed the hub at themselves — which costs whatever it costs.
 *
 * It is a promise about money, not about quality. Which system leads is `rank`,
 * below; which systems are worth the money is the family's own call, which is
 * what `AI_LEAD` is for.
 */
type Tier = "free" | "free-tier" | "paid" | "own";

/** Free first, then free with a key, then paid. Groups the catalog, only. */
const TIER_RANK: Record<Tier, number> = {
  free: 0,
  "free-tier": 1,
  paid: 2,
  own: 3,
};

/**
 * Every system this hub knows how to speak to, with the variable that turns it
 * on.
 *
 * It is a roster rather than a list of what is connected: what is connected is
 * worked out from which of these variables actually holds a value, so adding a
 * key is the whole of the setup. A key in any of them is enough — the host, its
 * URL and a sensible first model all live here.
 *
 * A model name is only ever a first guess. Gateways rename models without
 * telling anyone, so when every name in a list is refused as unknown the walk
 * asks the host what it really serves (`discoverModel`) instead of giving up on
 * the system.
 *
 * `rank` is the order a conversation follows: the lowest number answers first
 * and the rest are waiting behind it, in order. It is the answer to "which one
 * is best", written down next to the system it describes rather than in a
 * second list somewhere else. Nothing about it is final — moving a number moves
 * a system, and `AI_LEAD` overrides the lot.
 */
const OPENAI_PROVIDERS: {
  keyEnv: string;
  /** Where it sits in the order. Lower answers first. */
  rank: number;
  /** Other variables that name this same host — an older spelling, or one a
   *  script already sets for another purpose. The first one set wins. */
  alsoKeyEnv?: string[];
  label: string;
  baseUrl: string;
  models: string[];
  builderModels?: string[];
  /** Where its chat route lives, when that is not the usual /chat/completions. */
  chatPath?: string;
  /** The slug an agent names when it wants this one. Derived from keyEnv. */
  slug?: string;
  /** What it costs. Free tier unless it says otherwise. */
  tier?: Tier;
  /** One line for the Control Room: what this system is, and what it costs. */
  note?: string;
}[] = [
  {
    keyEnv: "GROQ_API_KEY",
    label: "Groq",
    rank: 30,
    baseUrl: "https://api.groq.com/openai/v1",
    // Checked against Groq's live /models list. The plain chat model goes
    // first on purpose: reasoning models like gpt-oss can spend the whole
    // token budget thinking and hand back nothing to say. (shallow-probe)
    models: ["qwen/qwen3.8-27b", "openai/gpt-oss-120b", "openai/gpt-oss-20b"],
    // Code wants the bigger reasoner, and it has the budget here.
    builderModels: [
      "openai/gpt-oss-120b",
      "qwen/qwen3.8-27b",
      "openai/gpt-oss-20b",
    ],
    tier: "free-tier",
    note: "Free tier on custom silicon — usually the fastest first token of any system here.",
  },
  {
    keyEnv: "OPENROUTER_API_KEY",
    label: "OpenRouter",
    rank: 42,
    baseUrl: "https://openrouter.ai/api/v1",
    // Checked against OpenRouter's live /models list, and every one of these is
    // a free model that advertises the `reasoning` parameter — so the pane gets
    // the model's own thinking and not only its answer. The two names that used
    // to be here (`deepseek-r1:free`, `deepseek-chat-v3.1:free`) were retired by
    // the gateway, which is the whole reason this is checked rather than
    // remembered. A gateway renames models without telling anyone, so this list
    // is only ever a first guess: when every name in it is refused as unknown,
    // the walk asks the gateway what it really serves and uses that.
    models: [
      "qwen/qwen3.8-27b:free",
      "nvidia/nemotron-3-super-120b-a12b:free",
      "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
    ],
    // Code wants the biggest reasoner that is still free, then the same
    // fallbacks the chat side has.
    builderModels: [
      "nvidia/nemotron-3-super-120b-a12b:free",
      "qwen/qwen3.8-27b:free",
      "thinkingmachines/inkling:free",
    ],
    tier: "free-tier",
    note: "One key, many makers. Only the :free models are ever named here, so this costs nothing.",
  },
  {
    keyEnv: "DEEPSEEK_API_KEY",
    label: "DeepSeek",
    rank: 20,
    baseUrl: "https://api.deepseek.com/v1",
    models: ["deepseek-chat"],
    builderModels: ["deepseek-reasoner", "deepseek-chat"],
    tier: "paid",
    note: "Billed per token. Cheap, and its reasoning model is good at code — but there is no free tier.",
  },
  // Grok, under either of the names its key has had. The Builder asks for a
  // reasoning model first because code wants one; if a name has been retired
  // since, the model walk moves on, and a list that matches nothing at all is
  // discovered from the provider's own /models rather than guessed at.
  {
    keyEnv: "XAI_API_KEY",
    alsoKeyEnv: ["GROK_API_KEY"],
    label: "xAI",
    rank: 18,
    baseUrl: "https://api.x.ai/v1",
    models: ["grok-4-fast-non-reasoning", "grok-3-mini"],
    builderModels: [
      "grok-4-fast-reasoning",
      "grok-4-fast-non-reasoning",
      "grok-3-mini",
    ],
    tier: "paid",
    note: "Grok, billed per token. One system under two key names, so either variable switches it on.",
  },

  /* ------------------------------------------------ the free tiers ----- */
  // Everything from here to the commercial labs answers for nothing once the
  // family adds a key. Every one of them is a real, working connection rather
  // than a promise: if a host has retired a model since, the walk asks it what
  // it serves now, and a system is never lost to a renamed model.
  {
    keyEnv: "CEREBRAS_API_KEY",
    label: "Cerebras",
    rank: 32,
    baseUrl: "https://api.cerebras.ai/v1",
    models: ["gpt-oss-120b", "llama-3.3-70b", "qwen-3-32b"],
    builderModels: ["gpt-oss-120b", "qwen-3-32b", "llama-3.3-70b"],
    tier: "free-tier",
    note: "Free tier on wafer-scale silicon — by a wide margin the fastest words per second here.",
  },
  {
    keyEnv: "MISTRAL_API_KEY",
    label: "Mistral",
    rank: 44,
    baseUrl: "https://api.mistral.ai/v1",
    models: ["mistral-small-latest", "open-mistral-nemo", "ministral-8b-latest"],
    tier: "free-tier",
    note: "Free experimental tier: the small and open-weight Mistral models.",
  },
  {
    keyEnv: "TOGETHER_API_KEY",
    label: "Together AI",
    rank: 34,
    baseUrl: "https://api.together.xyz/v1",
    models: [
      "meta-llama/Llama-3.3-70B-Instruct-Turbo-Free",
      "deepseek-ai/DeepSeek-R1-Distill-Llama-70B-free",
      "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo",
    ],
    tier: "free-tier",
    note: "Free endpoints for open-weight models, marked with a -Free suffix. Paid models on the same key are never named.",
  },
  {
    keyEnv: "SAMBANOVA_API_KEY",
    label: "SambaNova",
    rank: 46,
    baseUrl: "https://api.sambanova.ai/v1",
    models: [
      "Meta-Llama-3.3-70B-Instruct",
      "DeepSeek-R1-Distill-Llama-70B",
      "Meta-Llama-3.1-8B-Instruct",
    ],
    tier: "free-tier",
    note: "Free tier on its own chips, serving Llama and DeepSeek weights.",
  },
  {
    keyEnv: "NVIDIA_API_KEY",
    label: "NVIDIA NIM",
    rank: 36,
    baseUrl: "https://integrate.api.nvidia.com/v1",
    models: [
      "meta/llama-3.3-70b-instruct",
      "nvidia/llama-3.1-nemotron-70b-instruct",
      "deepseek-ai/deepseek-r1",
    ],
    tier: "free-tier",
    note: "Free development credits against NVIDIA's own inference hosts.",
  },
  {
    keyEnv: "HF_TOKEN",
    // The same token, under the name the hub's own setup scripts use.
    alsoKeyEnv: ["HUGGINGFACE_API_KEY", "HUGGING_FACE_HUB_TOKEN"],
    slug: "huggingface",
    label: "Hugging Face",
    rank: 56,
    baseUrl: "https://router.huggingface.co/v1",
    models: [
      "meta-llama/Llama-3.3-70B-Instruct",
      "Qwen/Qwen2.5-72B-Instruct",
      "deepseek-ai/DeepSeek-V3-0324",
    ],
    tier: "free-tier",
    note: "The Inference Providers router — one free monthly credit across the whole open-weight catalogue.",
  },
  {
    keyEnv: "GITHUB_MODELS_TOKEN",
    // A personal access token is the same credential, so one token can be both.
    alsoKeyEnv: ["GITHUB_TOKEN"],
    slug: "github",
    label: "GitHub Models",
    rank: 58,
    baseUrl: "https://models.github.ai/inference",
    models: [
      "openai/gpt-4o-mini",
      "meta/Llama-3.3-70B-Instruct",
      "deepseek/DeepSeek-V3-0324",
    ],
    tier: "free-tier",
    note: "Free with any GitHub account: several makers' models behind one token.",
  },
  {
    keyEnv: "DASHSCOPE_API_KEY",
    alsoKeyEnv: ["QWEN_API_KEY"],
    slug: "qwen",
    label: "Qwen (Alibaba)",
    rank: 48,
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    models: ["qwen-plus", "qwen-turbo", "qwen3-coder-plus"],
    tier: "free-tier",
    note: "Free quota on Alibaba's DashScope, through its OpenAI-compatible route.",
  },
  {
    keyEnv: "ZAI_API_KEY",
    alsoKeyEnv: ["Z_AI_API_KEY", "GLM_API_KEY"],
    slug: "zai",
    label: "Z.ai (GLM)",
    rank: 50,
    baseUrl: "https://api.z.ai/api/paas/v4",
    models: ["glm-4.5-flash", "glm-4.5-air", "glm-4.6"],
    tier: "free-tier",
    note: "GLM's Flash model is free of charge, and the same key reaches the larger ones.",
  },
  {
    keyEnv: "CHUTES_API_KEY",
    label: "Chutes",
    rank: 60,
    baseUrl: "https://llm.chutes.ai/v1",
    models: [
      "deepseek-ai/DeepSeek-V3-0324",
      "Qwen/Qwen3-32B",
      "moonshotai/Kimi-K2-Instruct",
    ],
    tier: "free-tier",
    note: "Free decentralized inference — open-weight models served over Bittensor.",
  },
  {
    keyEnv: "MOONSHOT_API_KEY",
    alsoKeyEnv: ["KIMI_API_KEY"],
    slug: "kimi",
    label: "Moonshot (Kimi)",
    rank: 52,
    baseUrl: "https://api.moonshot.ai/v1",
    models: ["kimi-k2-0905-preview", "moonshot-v1-32k"],
    tier: "free-tier",
    note: "Kimi's own endpoint, with a free allowance before anything is billed.",
  },
  {
    keyEnv: "FIREWORKS_API_KEY",
    label: "Fireworks AI",
    rank: 40,
    baseUrl: "https://api.fireworks.ai/inference/v1",
    models: [
      "accounts/fireworks/models/deepseek-v3",
      "accounts/fireworks/models/llama-v3p3-70b-instruct",
    ],
    tier: "free-tier",
    note: "Free starter credits for open-weight models.",
  },
  {
    keyEnv: "NEBIUS_API_KEY",
    label: "Nebius AI Studio",
    rank: 38,
    baseUrl: "https://api.studio.nebius.com/v1",
    models: ["meta-llama/Llama-3.3-70B-Instruct", "deepseek-ai/DeepSeek-V3"],
    tier: "free-tier",
    note: "Free credits on Nebius's inference studio.",
  },
  {
    keyEnv: "HYPERBOLIC_API_KEY",
    label: "Hyperbolic",
    rank: 54,
    baseUrl: "https://api.hyperbolic.xyz/v1",
    models: ["meta-llama/Llama-3.3-70B-Instruct", "Qwen/Qwen2.5-72B-Instruct"],
    tier: "free-tier",
    note: "Free credits on a decentralized GPU marketplace.",
  },

  /* ------------------------------------------- the commercial labs ------ */
  // Here so that a key which exists is a key that works. Neither has a free
  // tier, which is the only reason they sit below everything else.
  {
    keyEnv: "ANTHROPIC_API_KEY",
    label: "Anthropic",
    rank: 12,
    // Anthropic serves an OpenAI-shaped route at its own /v1, so it needs no
    // dialect of its own here.
    baseUrl: "https://api.anthropic.com/v1",
    models: ["claude-sonnet-4-5", "claude-haiku-4-5"],
    tier: "paid",
    note: "Claude, billed per token — no free tier.",
  },
  {
    keyEnv: "OPENAI_API_KEY",
    label: "OpenAI",
    rank: 10,
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-4o-mini", "gpt-4.1-mini"],
    builderModels: ["gpt-4.1", "gpt-4o", "gpt-4o-mini"],
    tier: "paid",
    note: "The original endpoint, billed per token — no free tier.",
  },
];

type Provider = {
  /** The slug an agent names when it wants this one: "groq", "gemini". */
  id: string;
  flavor: "openai" | "gemini";
  label: string;
  apiKey: string;
  baseUrl: string;
  /** Where its chat route lives, when that is not the usual /chat/completions. */
  chatPath?: string;
  models: string[];
  builderModels: string[];
  /** The order a conversation follows. Lower answers first. */
  rank: number;
  /** It answers with nobody's key: a free public system. */
  free?: boolean;
  /** What it costs, worked out when it was built. */
  tier?: Tier;
  /** The variable that switched it on, when one did. Never its value. */
  keyEnv?: string;
  /** One line for the Control Room, saying what this connection is. */
  note?: string;
};

/**
 * The free public gateways — no key of the family's own, so a deployment that
 * has been given nothing at all still has somewhere to look. They are slower
 * and more limited than a keyed system, which is exactly why a family key
 * takes priority over them.
 *
 * Pollinations' legacy text API is on its way out. It now refuses new
 * generations to anyone without an account — 402, with an empty body, which
 * reads as nothing at all — and answers only prompts it has already seen. It is
 * kept because a cached answer is a real answer and costs nothing, but a hub
 * can no longer be worked from it, which is why the note below says so where
 * the Control Room reads it. What it fails with is named in `classifyFailure`
 * rather than passed on as a status code.
 *
 * The two at the front of the list are models running on the machine the
 * backend runs on, and they are the best kind of free there is: no quota, no
 * rate limit, nothing leaving the house. They are tried first because when one
 * is there it is a real model answering in milliseconds — and when one is not
 * there the connection is refused in a millisecond too, so a hub with no model
 * server running pays almost nothing for the look. Anywhere else at all is
 * reachable with AI_BASE_URL and AI_API_KEY, which is the freedom this list
 * cannot cover and does not pretend to.
 */
const FREE_SYSTEMS: {
  id: string;
  label: string;
  /** Where it sits in the order. Lower answers first. */
  rank: number;
  /** A key is optional here; when one is set, it is used. */
  keyEnv?: string;
  baseUrl: string;
  chatPath?: string;
  /** Empty means "ask the server what it has" — `discoverModel` does it. */
  models: string[];
  note: string;
}[] = [
  {
    id: "ollama",
    label: "Ollama, on this machine",
    rank: 70,
    baseUrl: "http://127.0.0.1:11434/v1",
    // A guess, and only ever a guess: whatever is missing from it is discovered
    // from the server itself on the same question.
    models: ["llama3.2", "qwen2.5-coder:7b", "mistral"],
    note: "Free and private: whatever this machine has pulled. `ollama serve`, then `ollama pull llama3.2`, and the hub finds it on the next question.",
  },
  {
    id: "localllm",
    label: "Local model server, on this machine",
    rank: 72,
    baseUrl: "http://127.0.0.1:1234/v1",
    // Nothing is guessed: the server is asked what it is serving.
    models: [],
    note: "The same idea at LM Studio's usual address — llama.cpp, vLLM, LM Studio and the brain's own serve-local-model script all answer here. Any other address goes in AI_BASE_URL with AI_API_KEY set to any text.",
  },
  {
    id: "pollinations",
    keyEnv: "POLLINATIONS_API_KEY",
    label: "Pollinations",
    rank: 80,
    baseUrl: "https://text.pollinations.ai",
    // Their OpenAI-shaped route is /openai, not the usual /chat/completions.
    chatPath: "/openai",
    models: ["openai-fast"],
    note: "Free public model, no key needed — but its legacy API now answers only prompts it has already seen. Fine as a fallback; not a system to rely on. A key is.",
  },
];

/**
 * Workers AI, the one free host that cannot be described by a single variable:
 * the address carries the account the models belong to. Two variables, and it
 * is one more free system like any other — which is why it is built by hand in
 * `resolveProviders` and still appears in the catalog like the rest of them.
 */
const CLOUDFLARE = {
  slug: "cloudflare",
  label: "Cloudflare Workers AI",
  rank: 62,
  keyEnv: "CLOUDFLARE_API_TOKEN",
  accountEnv: "CLOUDFLARE_ACCOUNT_ID",
  models: [
    "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    "@cf/openai/gpt-oss-120b",
    "@cf/qwen/qwen2.5-coder-32b-instruct",
  ],
  note: "A free daily allowance of neurons on Cloudflare's own GPUs.",
};

/**
 * Where the systems that are not in either list above sit in the order.
 *
 * One number each, read by the resolver and by the catalog both, so a system
 * can never be listed in one position and built in another.
 */
const CUSTOM_RANK = 0;
const GEMINI_RANK = 14;
const VLY_RANK = 16;

/**
 * The gateway this deployment already ships with. Underneath it is
 * OpenAI-compatible, so it is simply one more system to ask — and the only
 * one that reaches other makers' models without a key of the family's own.
 */
const VLY_MODELS = ["gpt-5", "gpt-4o-mini", "claude-3-haiku"];



/* ---------------------------------------------------------------- provider */

function freeTierOn() {
  return (process.env.AI_FREE_TIER ?? "").trim().toLowerCase() !== "off";
}

/** Where the deployment's own gateway lives, and its OpenAI-shaped route. */
function gatewayUrl() {
  const base =
    (process.env.VLY_INTEGRATION_BASE_URL ?? "").trim() ||
    "https://integrations.vly.ai";
  return `${base.replace(/\/+$/, "")}/v1/llm`;
}

function buildProvider(input: {
  id: string;
  flavor: Provider["flavor"];
  label: string;
  apiKey: string;
  baseUrl: string;
  chatPath?: string;
  models: string[];
  builderModels?: string[];
  rank: number;
  free?: boolean;
  tier?: Tier;
  /** The variable this was switched on by, when one was. */
  keyEnv?: string;
  note?: string;
}): Provider {
  const chosenModel = process.env.AI_MODEL?.trim();
  const chat = chosenModel ? [chosenModel, ...input.models] : input.models;
  const builder = chosenModel
    ? [chosenModel, ...(input.builderModels ?? input.models)]
    : (input.builderModels ?? input.models);

  return {
    id: input.id,
    flavor: input.flavor,
    label: input.label,
    apiKey: input.apiKey,
    baseUrl: input.baseUrl.replace(/\/+$/, ""),
    chatPath: input.chatPath,
    models: Array.from(new Set(chat)),
    builderModels: Array.from(new Set(builder)),
    rank: input.rank,
    free: input.free,
    tier: input.tier ?? (input.free ? "free" : "free-tier"),
    keyEnv: input.keyEnv,
    note: input.note,
  };
}

/** The first of these variables that actually holds a value, if any does. */
function firstSet(names: string[]): string | null {
  return names.find((name) => (process.env[name] ?? "").trim() !== "") ?? null;
}

/**
 * Every AI system this deployment can reach, best first.
 *
 * There is no single "the model" any more, and no single order that is right
 * for every family. What there is: the systems that cost nothing at all, then
 * the systems that cost nothing with a key, then the ones that bill per token,
 * then the gateway this app ships with, and finally the free public systems and
 * the models running on this machine. The first one leads the conversation; any
 * of them may be consulted; and a system that stops answering hands the
 * question down the line on its own.
 */
function resolveProviders(): Provider[] {
  const found: Provider[] = [];

  // 1. Anything you point at yourself — a local model, a proxy, a provider we
  //    have never heard of.
  const customBase = process.env.AI_BASE_URL?.trim();
  const customKey = process.env.AI_API_KEY?.trim();
  if (customBase && customKey) {
    found.push(
      buildProvider({
        id: "custom",
        flavor: "openai",
        label: "Your own endpoint",
        apiKey: customKey,
        baseUrl: customBase,
        models: [],
        // Yours, pointed at deliberately. It leads because you put it there.
        rank: CUSTOM_RANK,
        keyEnv: "AI_BASE_URL",
        tier: "own",
        note: "From AI_BASE_URL — whatever you pointed the app at, at whatever it charges.",
      }),
    );
  }

  // 2. Every open host the family has given a key for, free tiers first. The
  //    order inside a tier is the roster's own, and the sort is stable, so
  //    there is exactly one place to add a system and no second list to keep.
  const keyed = OPENAI_PROVIDERS.map((system) => {
    const keyEnv = firstSet([system.keyEnv, ...(system.alsoKeyEnv ?? [])]);
    if (!keyEnv) return null;

    return buildProvider({
      id: system.slug ?? keyEnv.replace(/_API_KEY$/, "").toLowerCase(),
      flavor: "openai",
      label: system.label,
      apiKey: (process.env[keyEnv] ?? "").trim(),
      baseUrl: system.baseUrl,
      chatPath: system.chatPath,
      models: system.models,
      builderModels: system.builderModels,
      rank: system.rank,
      keyEnv,
      tier: system.tier ?? "free-tier",
      note: `${system.note ?? ""} Connected with your ${keyEnv}.`,
    });
  }).filter((system): system is Provider => system !== null);

  found.push(...keyed);

  // 2b. Workers AI, the one free host whose address carries its own account.
  const cloudflareKey = process.env[CLOUDFLARE.keyEnv]?.trim();
  const cloudflareAccount = process.env[CLOUDFLARE.accountEnv]?.trim();
  if (cloudflareKey && cloudflareAccount) {
    found.push(
      buildProvider({
        id: CLOUDFLARE.slug,
        flavor: "openai",
        label: CLOUDFLARE.label,
        apiKey: cloudflareKey,
        baseUrl: `https://api.cloudflare.com/client/v4/accounts/${cloudflareAccount}/ai/v1`,
        models: CLOUDFLARE.models,
        rank: CLOUDFLARE.rank,
        keyEnv: CLOUDFLARE.keyEnv,
        tier: "free-tier",
        note: `${CLOUDFLARE.note} Connected with your ${CLOUDFLARE.keyEnv} and ${CLOUDFLARE.accountEnv}.`,
      }),
    );
  }

  // 3. The gateway this deployment already has.
  const gatewayKey = process.env.VLY_INTEGRATION_KEY?.trim();
  if (gatewayKey) {
    found.push(
      buildProvider({
        id: "vly",
        flavor: "openai",
        label: "Freebuff AI",
        apiKey: gatewayKey,
        baseUrl: gatewayUrl(),
        models: VLY_MODELS,
        rank: VLY_RANK,
        keyEnv: "VLY_INTEGRATION_KEY",
        tier: "free",
        note: "The app's own gateway — several makers' models behind one connection, with nothing to set up.",
      }),
    );
  }

  // 4. Gemini, which speaks its own dialect and has a free tier of its own.
  const geminiKeyEnv = firstSet(["GOOGLE_API_KEY", "GEMINI_API_KEY"]);
  if (geminiKeyEnv) {
    found.push(
      buildProvider({
        id: "gemini",
        flavor: "gemini",
        label: "Google Gemini",
        apiKey: (process.env[geminiKeyEnv] ?? "").trim(),
        baseUrl: GEMINI_BASE,
        models: GEMINI_MODELS,
        rank: GEMINI_RANK,
        keyEnv: geminiKeyEnv,
        tier: "free-tier",
        note: `Free tier, several models behind one Google key. Connected with your ${geminiKeyEnv}.`,
      }),
    );
  }

  // 5. The free public systems and the models on this machine, last and only
  //    as a safety net.
  if (freeTierOn()) {
    for (const system of FREE_SYSTEMS) {
      found.push(
        buildProvider({
          id: system.id,
          flavor: "openai",
          label: system.label,
          apiKey: system.keyEnv
            ? (process.env[system.keyEnv]?.trim() ?? "")
            : "",
          baseUrl: system.baseUrl,
          // Without this the declared route is dropped and every free system
          // is asked at the usual /chat/completions — which is exactly what
          // Pollinations does not serve, so the safety net never worked.
          chatPath: system.chatPath,
          models: system.models,
          rank: system.rank,
          keyEnv: system.keyEnv,
          free: true,
          note: system.note,
        }),
      );
    }
  }

  // The order a conversation follows, decided once and in one place: best
  // first, and the question moves down the list only when a system cannot
  // answer at all. Consulting, reviewing and nudging all read this same list,
  // so what answers a question is what answers a review of it.
  found.sort((a, b) => a.rank - b.rank);

  // Two variables naming the same company are one system, not two.
  const seenId = new Set<string>();
  const seenLabel = new Set<string>();

  const unique = found.filter((provider) => {
    if (seenId.has(provider.id) || seenLabel.has(provider.label)) return false;
    seenId.add(provider.id);
    seenLabel.add(provider.label);
    return true;
  });

  // The family can name the system to lead with, without touching code: set
  // AI_LEAD to a system's name — "groq", "xai", "your own endpoint". A name
  // that is not reachable is simply ignored, so a switch never leaves a box
  // with nothing to talk to.
  return withLead(unique, process.env.AI_LEAD?.trim());
}

/**
 * Put the named system at the front, keeping every other one in the order it
 * was built. The name is matched against the slug ("groq", "xai") or the
 * written label ("Google Gemini"), so either reads the same. A name that is
 * not in the list — no key for it yet — leaves the order untouched, and a lead
 * that stops answering still hands the question down the line on its own.
 */
function withLead(
  providers: Provider[],
  lead: string | null | undefined,
): Provider[] {
  if (!lead) return providers;

  const wanted = lead.trim().toLowerCase();
  const index = providers.findIndex(
    (provider) =>
      provider.id.toLowerCase() === wanted ||
      provider.label.toLowerCase() === wanted,
  );
  if (index <= 0) return providers;

  const ordered = [...providers];
  const [chosen] = ordered.splice(index, 1);
  ordered.unshift(chosen);
  return ordered;
}

/** The system that leads the conversation. */
function resolveProvider(): Provider | null {
  return resolveProviders()[0] ?? null;
}

/**
 * Whether the family has given this hub a key of its own, anywhere.
 *
 * It is the difference between two failures that look identical from the reply
 * alone: a system having a bad afternoon, which fixes itself, and a hub with
 * nothing but a free public model to talk to, which never will. Only the second
 * one is worth asking the person to do something about.
 */
function keyedSystemExists(): boolean {
  return resolveProviders().some((provider) => provider.free !== true);
}

/** Whether an AI box has anything to talk to. */
export const configured = query({
  args: {},
  handler: async () => resolveProviders().length > 0,
});

/**
 * Which systems are reachable right now, for the Control Room. Names and lines
 * only — never a key, and never which key is a real one. The order is the same
 * one a conversation follows, so the system shown as leading really is first.
 */
export const systems = query({
  args: {},
  handler: async () => {
    return resolveProviders().map((provider) => ({
      id: provider.id,
      label: provider.label,
      free: Boolean(provider.free),
      tier: provider.tier ?? (provider.free ? "free" : "free-tier"),
      /** The variable that switched it on — a name, never a value. */
      keyEnv: provider.keyEnv ?? null,
      models: provider.models.slice(0, 4),
      note: provider.note ?? "",
    }));
  },
});

/**
 * Every system this hub knows how to reach — connected or not — with the
 * variable that switches each one on.
 *
 * This is what turns "add a key" from a guess into a list. The Control Room can
 * name the exact variable to paste, say which systems ask for nothing at all,
 * and say which of them a free account already covers. It reports variable
 * *names* and never a value, and it is built from the same roster the resolver
 * reads, so a system can never be listed here and unbuildable there.
 */
export const catalog = query({
  args: {},
  handler: async () => {
    const live = new Map(
      resolveProviders().map((provider) => [provider.id, provider]),
    );

    const row = (input: {
      id: string;
      label: string;
      tier: Tier;
      rank: number;
      /** Every variable that turns it on. Empty: it needs no key at all. */
      envVars: string[];
      note: string;
      models?: string[];
    }) => {
      const connected = live.get(input.id);
      return {
        id: input.id,
        label: input.label,
        tier: input.tier,
        rank: input.rank,
        envVars: input.envVars,
        note: input.note,
        connected: Boolean(connected),
        /** Which variable switched it on, when one did. Never its value. */
        keyEnv: connected?.keyEnv ?? null,
        models: (connected?.models ?? input.models ?? []).slice(0, 4),
      };
    };

    const rows = [
      row({
        id: "custom",
        label: "Your own endpoint",
        tier: "own",
        rank: CUSTOM_RANK,
        envVars: ["AI_BASE_URL", "AI_API_KEY"],
        note: "Point the hub at anything that speaks the OpenAI shape — a model on your own network, a proxy, a host that is not on this list.",
      }),
      ...OPENAI_PROVIDERS.map((system) =>
        row({
          id:
            system.slug ??
            system.keyEnv.replace(/_API_KEY$/, "").toLowerCase(),
          label: system.label,
          tier: system.tier ?? "free-tier",
          rank: system.rank,
          envVars: [system.keyEnv, ...(system.alsoKeyEnv ?? [])],
          note: system.note ?? "",
          models: system.models,
        }),
      ),
      row({
        id: CLOUDFLARE.slug,
        label: CLOUDFLARE.label,
        tier: "free-tier",
        rank: CLOUDFLARE.rank,
        envVars: [CLOUDFLARE.keyEnv, CLOUDFLARE.accountEnv],
        note: CLOUDFLARE.note,
        models: CLOUDFLARE.models,
      }),
      row({
        id: "vly",
        label: "Freebuff AI",
        tier: "free",
        rank: VLY_RANK,
        envVars: ["VLY_INTEGRATION_KEY"],
        note: "The gateway this app already ships with. There is nothing to set up — when the deployment has it, it is here.",
        models: VLY_MODELS,
      }),
      row({
        id: "gemini",
        label: "Google Gemini",
        tier: "free-tier",
        rank: GEMINI_RANK,
        envVars: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
        note: "Google's own free tier, spoken in its own dialect. Either variable name works.",
        models: GEMINI_MODELS,
      }),
      ...FREE_SYSTEMS.map((system) =>
        row({
          id: system.id,
          label: system.label,
          tier: "free",
          rank: system.rank,
          envVars: system.keyEnv ? [system.keyEnv] : [],
          note: system.note,
          models: system.models,
        }),
      ),
    ];

    // What is already connected leads — and inside that, in the order a
    // conversation follows, so the first row really is the one answering. What
    // is left is grouped by what it costs, and inside a group by how good it
    // is, so the best free one is the first free one on the list.
    return rows.sort((a, b) => {
      if (a.connected !== b.connected) return a.connected ? -1 : 1;
      const byTier = TIER_RANK[a.tier] - TIER_RANK[b.tier];
      return byTier !== 0 ? byTier : a.rank - b.rank;
    });
  },
});

type SystemHealth = {
  id: string;
  label: string;
  ok: boolean;
  ms: number;
  /** "Answered", or why it did not. */
  detail: string;
};

/** How long an answer is believed before the systems are asked again. */
const HEALTH_TTL_MS = 30_000;
let healthCache: { at: number; rows: SystemHealth[] } | null = null;

/**
 * A different handful of characters on every probe.
 *
 * It matters more than it looks. A free public system caches identical prompts,
 * so a fixed test question comes back in milliseconds from the cache even when
 * the system behind it has stopped answering anything new at all — a green
 * light, arrived at without asking anybody. The probe has to be text the system
 * has never seen or it is not a test.
 */
function probeId() {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Knock on every system's door and report who actually answered.
 *
 * The presence of a key is not the same as a working connection: a revoked key,
 * a model retired overnight and a provider having a bad afternoon all look
 * identical from here otherwise. This is what the Control Room's refresh button
 * — and its automatic one — ask, so "connected" is something the page can show
 * rather than assume. The listing itself never touches a model.
 */
export const checkSystems = action({
  args: {},
  handler: async (ctx): Promise<SystemHealth[]> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];

    // A locked account is told nothing about which keys the family has.
    if (!(await ctx.runQuery(internal.access.unlocked, {}))) return [];

    if (healthCache && Date.now() - healthCache.at < HEALTH_TTL_MS) {
      return healthCache.rows;
    }

    const rows = await Promise.all(
      resolveProviders().map(async (provider): Promise<SystemHealth> => {
        const started = Date.now();
        let detail = "It did not answer.";

        // A system that declares no models — a local server whose contents
        // only the server itself knows — is asked what it is serving, rather
        // than being reported as dead for having nothing to guess with. It is
        // the difference between "not answering" and "not asked".
        let models = modelsFor(provider, "assistant");
        if (!models.length) {
          const discovered = await discoverModel(provider);
          models = discovered ? [discovered] : [];
        }
        if (!models.length) {
          return {
            id: provider.id,
            label: provider.label,
            ok: false,
            ms: Date.now() - started,
            detail: "It did not answer, and it would not say which models it serves — so there was nothing to ask it.",
          };
        }

        for (const model of models) {
          const asked = await askOnce(
            provider,
            model,
            "You are a connection test. Reply with the single word: ok",
            [{ role: "user", text: `say ok ${probeId()}` }],
            0,
            16,
          );

          if (asked.ok) {
            return {
              id: provider.id,
              label: provider.label,
              ok: true,
              ms: Date.now() - started,
              detail: "Answered",
            };
          }

          detail = asked.error.slice(0, 200);
        }

        return {
          id: provider.id,
          label: provider.label,
          ok: false,
          ms: Date.now() - started,
          detail,
        };
      }),
    );

    healthCache = { at: Date.now(), rows };
    return rows;
  },
});

/* ------------------------------------------------------------ model talking */

type Turn = { role: "user" | "assistant"; text: string };

type CallResult =
  | {
      ok: true;
      text: string;
      /**
       * The model's own reasoning, when it returned one and could not stream it.
       * A model that streams its reasoning has already had it shown, and leaves
       * this unset so the pane does not say the same thing twice.
       */
      reasoning?: string;
      /** Which system and model answered, for the pane to name. */
      by?: string;
    }
  | { ok: false; error: string; missingModel: boolean; tokenLimit: boolean };

/** A piece of the model's own reasoning, or of its answer, as it arrives. */
type OnDelta = (kind: "reasoning" | "answer", text: string) => void;

/** How often a streamed step is written to the pane. */
const STREAM_FLUSH_MS = 400;

/**
 * The pane's writer: everything a turn does, recorded as it happens.
 *
 * This exists because a turn is a long silence. The person watches a box think
 * for a minute and, until now, the only thing that ever reached them was the
 * finished reply. Each call here is a write the panel is subscribed to, so the
 * thinking appears as it is written rather than after the fact.
 *
 * Two properties matter:
 *
 * * **One queue.** Everything goes through a single chain, so a streamed
 *   paragraph and the tool line that follows it cannot land out of order — a
 *   batch of reasoning flushed late would otherwise appear under a step that
 *   came after it.
 * * **The pane never breaks a turn.** A write that fails is dropped: this is a
 *   view of the work, not the work itself, and losing a line of it is not a
 *   reason to fail an answer somebody is waiting for.
 */
function makeTracer(ctx: ActionCtx, traceId: Id<"aiTraces">) {
  let queue: Promise<unknown> = Promise.resolve();

  const write = (kind: TraceStepKind, text: string, merge: boolean) => {
    queue = queue
      .then(() => ctx.runMutation(internal.traces.append, { traceId, kind, text, merge }))
      .catch(() => undefined);
  };

  return {
    /** A finished line: a tool it used, a system that answered, a thought. */
    step(kind: TraceStepKind, text: string) {
      const trimmed = text.trim();
      if (trimmed) write(kind, trimmed, false);
    },

    /**
     * A step that is still being written. `push` is called for every handful of
     * characters the model emits, and the text is batched into one write every
     * few hundred milliseconds — a token is not worth a database write of its
     * own, and a paragraph does not need to arrive character by character.
     */
    stream(kind: TraceStepKind) {
      let buffer = "";
      let timer: ReturnType<typeof setTimeout> | null = null;

      const flush = () => {
        if (!buffer) return;
        const text = buffer;
        buffer = "";
        write(kind, text, true);
      };

      return {
        push(text: string) {
          buffer += text;
          if (timer) return;
          timer = setTimeout(() => {
            timer = null;
            flush();
          }, STREAM_FLUSH_MS);
        },
        async done() {
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
          flush();
          await queue;
        },
      };
    },

    /** Close the turn, after everything written has landed. */
    async finish(status: "done" | "failed", by?: string, error?: string) {
      await queue;
      await ctx
        .runMutation(internal.traces.finish, { traceId, status, by, error })
        .catch(() => undefined);
    },
  };
}

type Tracer = ReturnType<typeof makeTracer>;

/**
 * The model's answer, as it is written — unless what it is writing is plumbing.
 *
 * Most of these models ask for a tool by writing a line of JSON, and the
 * assistant adds its actions to the reply in the same shape. That text is the
 * wire between the agent and this file, not something anybody wants to read, so
 * the first characters decide whether a stream is prose or plumbing: an answer
 * that opens with `{`, or with a ```json fence, is held back and the tool line
 * it turns into is shown instead. Prose and fenced code — what the person
 * actually asked for — stream through as they are written.
 *
 * The decision is made once and never revisited, because half an answer has
 * already been shown by then.
 */
function answerPublisher(stream: { push: (text: string) => void }) {
  let head = "";
  let decided: "show" | "hide" | null = null;

  const decide = (final: boolean) => {
    if (decided !== null) return;

    const lead = head.trimStart();
    if (!lead) {
      if (final) decided = "hide";
      return;
    }

    if (lead.startsWith("{") || /^```json/i.test(lead)) decided = "hide";
    // `` ``` `` alone could still become ```json, so the fence language is
    // waited for before anything is shown.
    else if (lead.startsWith("`") && !lead.includes("\n") && lead.length < 12 && !final)
      return;
    else decided = "show";

    if (decided === "show") stream.push(head);
    head = "";
  };

  return {
    push(text: string) {
      if (decided === "hide") return;
      if (decided === "show") {
        stream.push(text);
        return;
      }
      head += text;
      decide(false);
    },
    done() {
      decide(true);
    },
    /** Was any of it shown? If not, the finished text is worth publishing. */
    shown: () => decided === "show",
  };
}

function authHeaders(provider: Provider): Record<string, string> {
  // A free public system takes no key, and sending an empty bearer token is
  // how you get refused by one.
  if (!provider.apiKey) return { "Content-Type": "application/json" };

  if (provider.flavor === "openai") {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${provider.apiKey}`,
    };
  }
  return {
    "Content-Type": "application/json",
    "x-goog-api-key": provider.apiKey,
  };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = FETCH_TIMEOUT_MS,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask again when the failure is the kind that passes.
 *
 * A busy queue, a gateway flashing a 502 and a request the clock ran out on all
 * mean the same thing from here: nothing is broken, the answer simply is not in
 * yet. Each is waited out and asked again rather than carried back as the
 * reader's problem. A dropped connection gets exactly one more go, because
 * repeating a long wait is worse than moving on to the next model.
 */
async function sendingWithRetries(
  send: () => Promise<Response>,
  retries = TRANSIENT_RETRIES,
): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    let response: Response;
    try {
      response = await send();
    } catch (error) {
      if (attempt >= Math.min(retries, 1)) throw error;
      await pause(TRANSIENT_BACKOFF_MS * (attempt + 1));
      continue;
    }

    if (!TRANSIENT_STATUSES.includes(response.status)) return response;
    if (attempt >= retries) return response;
    await pause(TRANSIENT_BACKOFF_MS * (attempt + 1));
  }
}

/**
 * Say what actually went wrong, in words the person can act on.
 *
 * A raw status and a lump of the provider's body is not an answer: "401" and
 * "429" need entirely different responses from the reader, and only one of them
 * is theirs to fix. Getting that wrong is how a hub ends up looking broken on
 * every visit when only one key is stale.
 */
function classifyFailure(
  status: number,
  detail: string,
  provider: Provider,
): CallResult {
  const busy = status === 429 || status === 503;
  const refused = status === 401 || status === 403;
  // 402 is the provider saying "not without payment" — an account out of
  // credit, or a free public system that has stopped serving new requests to
  // anyone without one. It never passes on its own, so it is not waited out,
  // and it is the one status whose body is usually empty: quoting it back as
  // `Model request failed (402): {}` is how a missing key came to read as a
  // lost connection.
  const unpaid = status === 402;

  return {
    ok: false,
    missingModel: status === 404,
    // Some providers cap completion tokens per model; retry with less.
    tokenLimit:
      status === 400 && /max_?tokens|too large|maximum|context length/i.test(detail),
    error: refused
      ? `${provider.label} refused the key it was given (${status}). No setting on this page can mend that — the key has to be replaced where it is set, or removed so the app stops asking for it.`
      : unpaid && provider.free === true
        ? keyedSystemExists()
          ? `The free public model has stopped taking new requests (${status}) — it answers only what it has already answered, so it adds nothing to a hub that has a key of its own. Nothing to fix here, and nothing changes because of it.`
          : `The free public system has stopped taking new requests (${status}), and it is the only system this hub can reach — no key of your own is set anywhere. It still answers what it has answered before, which is why it can look alive, but every new question ends here. Add a key for one AI system and the boxes will answer again; nothing else has to change.`
        : unpaid
          ? `${provider.label} is out of credit or over its quota (${status}). Nothing else about this hub is wrong — it will keep refusing until that account is topped up, or a different system is connected.`
          : busy && provider.free === true
            ? `The free public system is busy (${status}). It takes one request at a time per address, and something else had the place — a shared free tier, not a fault in this hub. Try again in a moment.`
            : busy
              ? `${provider.label} is busy or rate limiting (${status}). It is only this one system; the question moves on, and it will be tried again later.`
              : `Model request failed (${status}): ${detail.slice(0, 300)}`,
  };
}

/**
 * Read an answer while it is being written, instead of once it has stopped.
 *
 * This is what makes the thinking pane live rather than eventual: the reasoning
 * a reasoning model narrates (`reasoning_content`), and the answer itself, are
 * handed to `onDelta` as the endpoint emits them, so a person watches the model
 * think instead of waiting out a silence.
 *
 * It returns `null` whenever streaming simply is not available — an endpoint
 * that ignores `stream`, one that answers with plain JSON, a connection that
 * never opened — and the caller then asks the ordinary way. So a provider that
 * cannot stream loses nothing but the live view, and one that can stream gains
 * it, with no list of who-supports-what to keep.
 *
 * A failure *after* the first token is reported as a failure rather than
 * retried silently: part of an answer is already on screen, and quietly
 * starting again would show the person the same words twice.
 */
async function streamOpenAi(args: {
  chatUrl: string;
  provider: Provider;
  model: string;
  system: string;
  turns: Turn[];
  temperature: number;
  maxTokens: number;
  /** How long this one attempt gets, which is short for a free system. */
  timeoutMs: number;
  specs: unknown[];
  onDelta: OnDelta;
}): Promise<CallResult | null> {
  const {
    chatUrl,
    provider,
    model,
    system,
    turns,
    temperature,
    maxTokens,
    timeoutMs,
    specs,
    onDelta,
  } = args;

  let response: Response;
  try {
    response = await fetchWithTimeout(
      chatUrl,
      {
        method: "POST",
        headers: { ...authHeaders(provider), Accept: "text/event-stream" },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: system },
            ...turns.map((turn) => ({ role: turn.role, content: turn.text })),
          ],
          temperature,
          max_tokens: maxTokens,
          stream: true,
          ...(specs.length ? { tools: specs, tool_choice: "auto" } : {}),
        }),
      },
      timeoutMs,
    );
  } catch {
    return null;
  }

  // An endpoint that answered with a document rather than a stream has not
  // streamed anything, and is better asked the plain way.
  if (!response.ok || !response.body) return null;
  if ((response.headers.get("content-type") ?? "").includes("application/json")) {
    return null;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  let buffer = "";
  let content = "";
  let arrived = false;
  const calls: { name: string; args: string }[] = [];

  const consume = (payload: string) => {
    if (!payload || payload === "[DONE]") return;

    let parsed: {
      choices?: {
        delta?: {
          content?: unknown;
          reasoning_content?: unknown;
          reasoning?: unknown;
          tool_calls?: {
            index?: unknown;
            function?: { name?: unknown; arguments?: unknown };
          }[];
        };
      }[];
    };
    try {
      parsed = JSON.parse(payload) as typeof parsed;
    } catch {
      return;
    }

    const delta = parsed.choices?.[0]?.delta;
    if (!delta) return;

    // DeepSeek calls it reasoning_content; other systems say reasoning. Either
    // is the model thinking out loud, and it is the best thing in the pane.
    const thought =
      typeof delta.reasoning_content === "string"
        ? delta.reasoning_content
        : typeof delta.reasoning === "string"
          ? delta.reasoning
          : "";
    if (thought) {
      arrived = true;
      onDelta("reasoning", thought);
    }

    if (typeof delta.content === "string" && delta.content) {
      content += delta.content;
      arrived = true;
      onDelta("answer", delta.content);
    }

    for (const call of delta.tool_calls ?? []) {
      const index = typeof call.index === "number" ? call.index : 0;
      calls[index] = calls[index] ?? { name: "", args: "" };
      if (typeof call.function?.name === "string") calls[index]!.name = call.function.name;
      if (typeof call.function?.arguments === "string") {
        calls[index]!.args += call.function.arguments;
      }
      arrived = true;
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        consume(trimmed.slice(5).trim());
      }
    }
  } catch {
    if (!arrived) return null;
    return {
      ok: false,
      missingModel: false,
      tokenLimit: false,
      error: "The answer stopped half way through.",
    };
  }

  const by = `${provider.label} · ${model}`;

  // A tool call, assembled from the fragments it arrived in, and handed back in
  // the one shape the rest of this file already speaks.
  const call = calls.find((one) => one.name);
  if (call) {
    const asJson = toolCallJson(call.name, call.args);
    if (asJson) return { ok: true, text: asJson, by };
  }

  const text = content.trim();

  if (!text) {
    // Nothing at all came down the pipe: the endpoint is not going to stream,
    // so this is not a failure, it is a reason to ask again plainly.
    if (!arrived) return null;
    return {
      ok: false,
      missingModel: false,
      tokenLimit: false,
      error: "The model returned an empty answer.",
    };
  }

  // The reasoning has already been shown as it arrived, so it is deliberately
  // not handed back with the text.
  return { ok: true, text, by };
}

async function callOpenAi(
  provider: Provider,
  model: string,
  system: string,
  turns: Turn[],
  temperature: number,
  maxTokens: number,
  onDelta?: OnDelta,
): Promise<CallResult> {
  // Almost everyone puts chat at /chat/completions; the free public gateway
  // puts it at /openai, which is why the path is per-provider.
  const chatUrl = `${provider.baseUrl}${provider.chatPath ?? "/chat/completions"}`;
  // The tools this prompt is allowed, declared properly. Empty for a review,
  // a consultation or a nudge, which only rewrite text.
  const specs = toolSpecsFor(system);
  // Both attempts below share one budget, so a free system that is not there
  // costs one short wait rather than two long ones.
  const budget = budgetFor(provider, maxTokens);

  // Live first, when somebody is watching. Everything below is the same ask
  // without streaming, which is also the fallback for every way the live
  // attempt can decline.
  if (onDelta) {
    const live = await streamOpenAi({
      chatUrl,
      provider,
      model,
      system,
      turns,
      temperature,
      maxTokens,
      timeoutMs: budget,
      specs,
      onDelta,
    });
    if (live) return live;
  }

  const post = (withTools: boolean) =>
    fetchWithTimeout(
      chatUrl,
      {
        method: "POST",
        headers: authHeaders(provider),
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: system },
            ...turns.map((turn) => ({ role: turn.role, content: turn.text })),
          ],
          temperature,
          max_tokens: maxTokens,
          ...(withTools && specs.length
            ? { tools: specs, tool_choice: "auto" }
            : {}),
        }),
      },
      budget,
    );

  let response: Response;
  let detail = "";
  try {
    response = await sendingWithRetries(() => post(specs.length > 0));
    if (!response.ok) detail = await response.text();

    // An endpoint that refuses the `tools` field outright is asked again the
    // plain way, rather than losing the whole system over a parameter it never
    // wanted. A 400 about the model calling a tool is not that, and is left
    // alone.
    if (
      !response.ok &&
      specs.length > 0 &&
      response.status === 400 &&
      /\btools?\b/i.test(detail) &&
      /unsupported|unrecognized|not supported|unknown|unexpected|invalid/i.test(
        detail,
      ) &&
      !/tool_use_failed/i.test(detail)
    ) {
      response = await sendingWithRetries(() => post(false));
      detail = response.ok ? "" : await response.text();
    }

    // A busy free queue is waited out inside the send above, alongside every
    // other failure that passes on its own — two people asking at once, the
    // assistant and the builder both working, or a review running beside the
    // reply it is checking. Identical prompts come back cached and cost
    // nothing, so the queue only ever applies to new text.
  } catch (error) {
    return {
      ok: false,
      missingModel: false,
      tokenLimit: false,
      error: `Could not reach the model: ${
        error instanceof Error ? error.message : "network error"
      }`,
    };
  }

  if (!response.ok) return classifyFailure(response.status, detail, provider);

  const data = (await response.json()) as {
    choices?: {
      message?: {
        content?: string;
        /** The model thinking out loud, when it offers one. */
        reasoning_content?: string;
        reasoning?: string;
        tool_calls?: { function?: { name?: string; arguments?: string } }[];
      };
    }[];
  };

  const message = data.choices?.[0]?.message;
  const by = `${provider.label} · ${model}`;

  // An endpoint that will not stream still hands its reasoning over in one
  // piece, when the model has any. It is not live, but it is the same thinking.
  const reasoning =
    typeof message?.reasoning_content === "string" && message.reasoning_content.trim()
      ? message.reasoning_content.trim()
      : typeof message?.reasoning === "string" && message.reasoning.trim()
        ? message.reasoning.trim()
        : undefined;

  // Some models answer with a real tool call instead of a line of JSON. It
  // means exactly the same thing, so it is handed back in the one shape the
  // rest of this file already speaks.
  const calls = message?.tool_calls ?? [];
  if (calls.length) {
    const [first, ...rest] = calls;
    const asJson = first?.function?.name
      ? toolCallJson(first.function.name, first.function.arguments ?? "")
      : null;

    if (asJson) {
      // Only one tool is carried out per turn. A model that asked for two in
      // the same breath — a timer *and* a search, say — is told so, in its own
      // words, and does the second one next turn instead of losing it.
      const left = rest
        .map((call) => {
          const name = call.function?.name ?? "";
          const args = call.function?.arguments ?? "";
          return name ? (toolCallJson(name, args) ?? name) : "";
        })
        .filter(Boolean);

      return {
        ok: true,
        by,
        reasoning,
        text: left.length
          ? `${asJson}\n\n(Only one tool runs at a time. You also asked for: ${left.join(
              ", ",
            )}. Do that in your next turn.)`
          : asJson,
      };
    }
  }

  const text = message?.content?.trim() ?? "";

  if (!text) {
    return {
      ok: false,
      missingModel: false,
      tokenLimit: false,
      error: "The model returned an empty answer.",
    };
  }

  return { ok: true, text, reasoning, by };
}

async function callGemini(
  provider: Provider,
  model: string,
  system: string,
  turns: Turn[],
  temperature: number,
  maxTokens: number,
): Promise<CallResult> {
  const send = () =>
    fetchWithTimeout(
      `${provider.baseUrl}/${model}:generateContent`,
      {
        method: "POST",
        headers: authHeaders(provider),
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: turns.map((turn) => ({
            role: turn.role === "assistant" ? "model" : "user",
            parts: [{ text: turn.text }],
          })),
          generationConfig: { temperature, maxOutputTokens: maxTokens },
        }),
      },
      modelTimeout(maxTokens),
    );

  let response: Response;
  try {
    response = await sendingWithRetries(send);
  } catch (error) {
    return {
      ok: false,
      missingModel: false,
      tokenLimit: false,
      error: `Could not reach the model: ${
        error instanceof Error ? error.message : "network error"
      }`,
    };
  }

  if (!response.ok) {
    return classifyFailure(response.status, await response.text(), provider);
  }

  const data = (await response.json()) as {
    candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[];
    promptFeedback?: { blockReason?: string };
  };

  const blocked = data.promptFeedback?.blockReason;
  if (blocked) {
    return {
      ok: false,
      missingModel: false,
      tokenLimit: false,
      error: `The model declined that one (${blocked}).`,
    };
  }

  // Gemini 3 marks the parts it thought with before it spoke. Left in, they
  // read as part of the answer — which is what this used to do, joining every
  // part into the reply. Split out, they are the same live reasoning the pane
  // shows for the systems that stream it.
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const text = parts
    .filter((part) => part.thought !== true)
    .map((part) => part.text ?? "")
    .join("")
    .trim();
  const reasoning = parts
    .filter((part) => part.thought === true)
    .map((part) => part.text ?? "")
    .join("")
    .trim();

  if (!text) {
    return {
      ok: false,
      missingModel: false,
      tokenLimit: false,
      error: "The model returned an empty answer.",
    };
  }

  return { ok: true, text, reasoning: reasoning || undefined, by: `${provider.label} · ${model}` };
}

function askOnce(
  provider: Provider,
  model: string,
  system: string,
  turns: Turn[],
  temperature: number,
  maxTokens: number,
  onDelta?: OnDelta,
) {
  return provider.flavor === "openai"
    ? callOpenAi(provider, model, system, turns, temperature, maxTokens, onDelta)
    : callGemini(provider, model, system, turns, temperature, maxTokens);
}

/**
 * When none of the model names we guessed exist any more, ask the provider
 * what it actually has and pick something that talks.
 */
async function discoverModel(provider: Provider) {
  try {
    const response = await fetchWithTimeout(`${provider.baseUrl}/models`, {
      headers: authHeaders(provider),
    });
    if (!response.ok) return null;

    const data = (await response.json()) as { data?: { id?: unknown }[] };
    const ids = (data.data ?? [])
      .map((entry) => entry.id)
      .filter((id): id is string => typeof id === "string");

    const unusable =
      /embed|whisper|tts|audio|speech|voice|realtime|orpheus|playai|transcribe|moderation|guard|rerank|image|vision|flux|sdxl|diffusion/i;
    const usable = ids.filter((id) => !unusable.test(id));

    const talkative =
      /deepseek|gpt-oss|llama|qwen|mistral|mixtral|gemma|chat|instruct/i;

    return (
      usable.find((id) => /deepseek/i.test(id)) ??
      usable.find((id) => talkative.test(id)) ??
      usable[0] ??
      null
    );
  } catch {
    return null;
  }
}

/**
 * Ask one system, walking its candidate models until one answers. If every
 * guess is rejected as unknown, find out what it really serves.
 */
async function askOneSystem(
  provider: Provider,
  models: string[],
  system: string,
  turns: Turn[],
  temperature: number,
  maxTokens: number,
  budgetMs = MODEL_WALK_DEADLINE_MS,
  onDelta?: OnDelta,
): Promise<
  | { ok: true; text: string; reasoning?: string; by?: string }
  | { ok: false; error: string }
> {
  const tried = new Set<string>();
  let lastError = "The model did not return an answer.";
  let missingEveryModel = true;
  const started = Date.now();

  const attempt = async (model: string, budget: number) => {
    if (tried.has(model)) return null;
    tried.add(model);

    const result = await askOnce(
      provider,
      model,
      system,
      turns,
      temperature,
      budget,
      onDelta,
    );

    if (!result.ok) {
      lastError = result.error;
      if (!result.missingModel) missingEveryModel = false;
    }

    return result;
  };

  for (const model of models) {
    // A system that keeps failing must not hold the question past the action's
    // own limit. The next one is given whatever time is left.
    if (Date.now() - started > budgetMs) break;

    const result = await attempt(model, maxTokens);
    if (result?.ok) {
      return { ok: true, text: result.text, reasoning: result.reasoning, by: result.by };
    }

    if (result && !result.ok && result.tokenLimit && maxTokens > FALLBACK_TOKENS) {
      tried.delete(model);
      const retry = await attempt(model, FALLBACK_TOKENS);
      if (retry?.ok) {
        return { ok: true, text: retry.text, reasoning: retry.reasoning, by: retry.by };
      }
    }
  }

  if (missingEveryModel) {
    const discovered = await discoverModel(provider);
    if (discovered) {
      const result = await attempt(discovered, maxTokens);
      if (result?.ok) {
        return { ok: true, text: result.text, reasoning: result.reasoning, by: result.by };
      }
    }
  }

  return { ok: false, error: lastError };
}

/**
 * Ask the leading system — and if it cannot answer at all, ask the next one
 * this deployment can reach, and then the next.
 *
 * This is what keeps a box from ever going quiet because of one dead key: a
 * rate limit, a model that was retired overnight, a provider having a bad
 * afternoon. The question simply moves along the list until somebody answers.
 * Consulting, reviewing and nudging all come through here, so every one of them
 * inherits the same second and third chance.
 */
async function askModel(
  provider: Provider,
  models: string[],
  system: string,
  turns: Turn[],
  temperature: number,
  maxTokens: number,
  onDelta?: OnDelta,
  /**
   * Told when the question moves on to another system, before that system is
   * asked. Whoever is watching gets to see the list being walked rather than
   * only the one that answered, which is the difference between "it is slow"
   * and "the first three are out".
   */
  onFallback?: (from: string, to: string) => void,
): Promise<
  | { ok: true; text: string; reasoning?: string; by?: string }
  | { ok: false; error: string }
> {
  const chainStarted = Date.now();
  const first = await askOneSystem(
    provider,
    models,
    system,
    turns,
    temperature,
    maxTokens,
    Math.min(MODEL_WALK_DEADLINE_MS, PROVIDER_CHAIN_DEADLINE_MS),
    onDelta,
  );
  if (first.ok) return first;

  // A fallback answers in the same job the question was asked of, so the
  // builder's models are used when it was the builder asking.
  const agent = agentForPrompt(system) ?? "assistant";
  const others = resolveProviders().filter((one) => one.id !== provider.id);

  // Three other keyed systems, and then — whatever happened — the ones that
  // need no key at all. A hub whose only key was just revoked, or whose one
  // provider is simply having an afternoon, still gets an answer if a model is
  // running on this machine or a free public system is listening. Two of them,
  // because this is a last resort rather than a second walk of the whole list,
  // and the chain's own deadline still governs how long any of it may take.
  const fallbacks = [
    ...others.filter((one) => one.free !== true).slice(0, 3),
    ...others.filter((one) => one.free === true).slice(0, 2),
  ];

  let lastError = first.error;
  // Who the question is with right now, so a hand-on is reported as one rather
  // than as an anonymous try.
  let holding = provider.label;

  for (const other of fallbacks) {
    const remaining = PROVIDER_CHAIN_DEADLINE_MS - (Date.now() - chainStarted);
    if (remaining <= 0) break;

    // Said out loud before the wait, not after it: a person watching a still
    // pane should learn that the first system is out while it is happening.
    onFallback?.(holding, other.label);

    const result = await askOneSystem(
      other,
      modelsFor(other, agent),
      system,
      turns,
      temperature,
      maxTokens,
      Math.min(MODEL_WALK_DEADLINE_MS, remaining),
      onDelta,
    );
    if (result.ok) return result;
    lastError = result.error;
    holding = other.label;
  }

  return { ok: false, error: lastError };
}

function modelsFor(provider: Provider, agent: Agent) {
  return agent === "builder" ? provider.builderModels : provider.models;
}

/* ------------------------------------------------------------------- tools */

type ToolCall =
  | { name: "web_search"; query: string }
  | { name: "fetch_url"; url: string }
  | { name: "ask_agent"; agent: Agent; question: string }
  | {
      name: "run_code";
      language: string;
      code: string;
      files: { path: string; code: string }[];
    }
  | { name: "read_family"; limit: number | null }
  | { name: "read_briefing"; section: string | null }
  | { name: "read_rundown"; days: number | null }
  | { name: "list_ai" }
  | { name: "ask_ai"; system: string; model: string | null; question: string }
  | { name: "act"; actions: unknown[] }
  /* the builder's own workbench */
  | { name: "write_file"; path: string; content: string; language: string | null }
  | { name: "read_file"; path: string; from: number | null; to: number | null }
  | { name: "list_files" }
  | { name: "search_files"; query: string }
  | { name: "delete_file"; path: string }
  /* reading and repairing its own source */
  | {
      name: "read_own_code";
      path: string | null;
      search: string | null;
      from: number | null;
      to: number | null;
    }
  | { name: "patch_own_code"; path: string; search: string; replace: string }
  /* reasoning out loud, and the bench edited in place */
  | { name: "think"; thought: string }
  | { name: "edit_file"; path: string; search: string; replace: string }
  | { name: "move_file"; path: string; to: string }
  | { name: "scaffold_project" }
  /* building the replica of this app in the workshop sandbox */
  | { name: "build_app"; quick: boolean };

/** The tools that only make sense for the builder, not the voice. */
const BUILDER_TOOLS = new Set<ToolCall["name"]>([
  "write_file",
  "read_file",
  "list_files",
  "search_files",
  "delete_file",
  "edit_file",
  "move_file",
  "scaffold_project",
  "read_own_code",
  "patch_own_code",
  // Building the replica belongs to the one who writes files, because it is a
  // statement about files. The voice has no bench and is never offered it.
  "build_app",
]);

/* --------------------------------------------- the same tools, declared */

/**
 * Which agent a prompt belongs to, read back off the prompt itself. Both agent
 * prompts are ours and open with a fixed line, which is enough to know which
 * tools to offer. A review, a consultation or a nudge carries neither line and
 * so is offered none — those only ever rewrite text.
 */
function agentForPrompt(system: string): Agent | null {
  if (system.includes("You are the AI Builder")) return "builder";
  if (system.includes("You are the voice of a hands-free assistant")) {
    return "assistant";
  }
  return null;
}

const str = (description: string) => ({ type: "string", description });
const num = (description: string) => ({ type: "number", description });

/**
 * The same tools an agent can already ask for in JSON, declared the way an
 * OpenAI-shaped endpoint understands them.
 *
 * This exists because some models — Groq's gpt-oss pair is the one that bit us
 * — answer with a real tool call whether or not one was declared, and return a
 * 400 refusing to speak at all when it was not. Declaring them turns that
 * refusal into an ordinary reply. `callOpenAi` converts whatever comes back
 * straight into the JSON an agent writes by hand, so nothing downstream of it
 * has to know the difference.
 */
const VOICE_TOOL_SPECS = [
  {
    type: "function" as const,
    function: {
      name: "web_search",
      description:
        "Search the live internet: news, the web, Stack Overflow and Hacker News. Use it before answering anything recent or factual.",
      parameters: {
        type: "object",
        properties: { query: str("What to look up") },
        required: ["query"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "fetch_url",
      description: "Read one web page in full, as plain text.",
      parameters: {
        type: "object",
        properties: { url: str("The http or https address") },
        required: ["url"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_ai",
      description: "List every AI system reachable from this deployment.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "ask_ai",
      description:
        "Ask another AI system, or all of them at once with system 'all', and compare their answers.",
      parameters: {
        type: "object",
        properties: {
          system: str("A system id from list_ai, or 'all'"),
          question: str("The question to put to it"),
          model: str("Optional exact model name, when the system holds many"),
        },
        required: ["system", "question"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "ask_agent",
      description: "Ask the other agent in this app for help with one question.",
      parameters: {
        type: "object",
        properties: {
          agent: { type: "string", enum: ["assistant", "builder"] },
          question: str("Exactly what you need to know"),
        },
        required: ["agent", "question"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "run_code",
      description:
        'Run a program for real and see what it prints. Never claim code works without running it. With language "bash" the code is run as shell commands in the workshop\'s project folder instead, which is how to install packages, typecheck, run tests, and use git.',
      parameters: {
        type: "object",
        properties: {
          language: str(
            'python, javascript, typescript, bash… ("bash" runs the code as shell commands in the project folder)',
          ),
          code: str(
            "The whole program, or the shell commands when language is bash",
          ),
          files: {
            type: "array",
            description: "Extra files, when the program spans more than one",
            items: {
              type: "object",
              properties: { path: str("File name"), code: str("File contents") },
              required: ["path", "code"],
            },
          },
        },
        required: ["language", "code"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "read_family",
      description: "Read the family's shared messages.",
      parameters: {
        type: "object",
        properties: { limit: num("How many messages to read") },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "read_briefing",
      description:
        "Read the [LIVE] board — the hub's own live picture of Colorado gathered on the server: the weather and the mountain snow, the watches and warnings, the air, the drought and the rivers, the wildfires, the disaster declarations, the energy, metals and farm markets, hay and alfalfa prices, the livestock, horse and equipment auctions, the aircraft overhead and the earthquakes, space weather, the headlines, and every link the board names. Ask for one section by id, or omit it for the whole board. Use it whenever they ask about the weather, the roads, the markets, the ranch, prices, an auction, or what is happening right now.",
      parameters: {
        type: "object",
        properties: {
          section: str(
            "One section id — summary, weather, snow, alerts, air, water, drought, fire, disasters, markets, farm, hay, auctions, news, sky, airspace or links — or leave it out for all of them",
          ),
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "read_rundown",
      description:
        "The whole day and everything coming up, in one read: the family calendar for the next several days, and the [LIVE] board's picture of Colorado right now. Use it whenever they ask for a rundown, the day ahead, a briefing, or what is coming up.",
      parameters: {
        type: "object",
        properties: {
          days: num("How many days ahead to read, 1 to 60. Seven by default."),
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "think",
      description:
        "Think out loud before you act: write your reasoning, your plan and how you will check it. Nothing is run and nothing is changed by it — but the person is watching a pane beside the chat, so this is where your thinking is actually read, as you write it.",
      parameters: {
        type: "object",
        properties: {
          thought: str("Your reasoning and plan, as long as it needs to be"),
        },
        required: ["thought"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "act",
      description:
        "Do something for them: open a page, set a timer, remember a fact, flip a setting, tell the family.",
      parameters: {
        type: "object",
        properties: {
          actions: {
            type: "array",
            description: "The actions to carry out",
            items: { type: "object", additionalProperties: true },
          },
        },
        required: ["actions"],
      },
    },
  },
];

/** The bench and the source reader: the builder's alone. */
const BENCH_TOOL_SPECS = [
  {
    type: "function" as const,
    function: {
      name: "write_file",
      description: "Write or overwrite a file on the bench, kept between turns.",
      parameters: {
        type: "object",
        properties: {
          path: str("The file's path"),
          content: str("The whole file"),
          language: str("Its language"),
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "read_file",
      description:
        "Read one file back off the bench, or just a slice of a long one with from/to.",
      parameters: {
        type: "object",
        properties: {
          path: str("The file's path"),
          from: num("First line, to read a slice of a long file"),
          to: num("Last line of the slice"),
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_files",
      description: "List everything on the bench.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "search_files",
      description: "Search every file on the bench for a phrase.",
      parameters: {
        type: "object",
        properties: { query: str("The text to find") },
        required: ["query"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "delete_file",
      description: "Take one file off the bench.",
      parameters: {
        type: "object",
        properties: { path: str("The file's path") },
        required: ["path"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "edit_file",
      description:
        "Change one file on the bench in place by replacing exact text. No need to rewrite the whole file.",
      parameters: {
        type: "object",
        properties: {
          path: str("The file's path"),
          search: str("The exact text to replace, character for character"),
          replace: str("What to put in its place"),
        },
        required: ["path", "search", "replace"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "move_file",
      description: "Rename or move a file on the bench.",
      parameters: {
        type: "object",
        properties: {
          path: str("The file's current path"),
          to: str("Its new path"),
        },
        required: ["path", "to"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "scaffold_project",
      description:
        "Put every file of this entire project onto the bench, so you can rebuild, rework or re-run any part of it.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "read_own_code",
      description: "Read this app's own source: list it, slice a file, or grep it.",
      parameters: {
        type: "object",
        properties: {
          path: str("One file to read"),
          search: str("Text to grep the whole source for"),
          from: num("First line of a slice"),
          to: num("Last line of a slice"),
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "patch_own_code",
      description:
        "Apply one exact-text fix to this app's source and see the diff. A person still has to apply it.",
      parameters: {
        type: "object",
        properties: {
          path: str("The file to patch"),
          search: str("The exact text to replace, character for character"),
          replace: str("What to put in its place"),
        },
        required: ["path", "search", "replace"],
      },
    },
  },
];

function toolSpecsFor(system: string) {
  const agent = agentForPrompt(system);
  if (agent === "builder") return [...VOICE_TOOL_SPECS, ...BENCH_TOOL_SPECS];
  if (agent === "assistant") return VOICE_TOOL_SPECS;
  return [];
}

/**
 * A native tool call, rewritten as the JSON an agent writes by hand — the one
 * shape `parseToolCall` already understands, so every branch behind it stays
 * exactly as it was.
 */
function toolCallJson(name: string, rawArguments: string) {
  let args: Record<string, unknown> = {};

  if (rawArguments.trim()) {
    try {
      const parsed = JSON.parse(rawArguments) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return null;
      }
      args = parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  return JSON.stringify({ tool: name, ...args });
}

/**
 * Pull out balanced JSON objects, ignoring braces and quotes inside strings.
 * Without this, a tool call carrying code would be cut short at the first
 * brace inside the code.
 */
function jsonCandidates(text: string, limit = 4) {
  const found: string[] = [];

  for (let start = 0; start < text.length && found.length < limit; start += 1) {
    if (text[start] !== "{") continue;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = start; index < text.length; index += 1) {
      const character = text[index];

      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        if (inString) escaped = true;
        continue;
      }
      if (character === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;

      if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          found.push(text.slice(start, index + 1));
          start = index;
          break;
        }
      }
    }
  }

  return found;
}

/**
 * An agent asks for a tool with a JSON object. Models sometimes wrap it in a
 * sentence, so look for the object rather than demanding it be the whole
 * reply. A real answer is only mistaken for a tool call if it happens to
 * contain an object with a "tool" key naming one we know.
 */
function parseToolCall(text: string): ToolCall | null {
  const trimmed = text.trim();
  // A patch or a file can be long, so the ceiling is generous — it is only
  // here to stop a runaway reply being scanned forever.
  if (trimmed.length > 200_000) return null;

  for (const candidate of jsonCandidates(trimmed)) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(candidate) as Record<string, unknown>;
    } catch {
      continue;
    }

    const name = parsed.tool ?? parsed.name;

    if (name === "web_search" && typeof parsed.query === "string") {
      return { name, query: parsed.query.slice(0, 300) };
    }
    if (name === "fetch_url" && typeof parsed.url === "string") {
      return { name, url: parsed.url.slice(0, 500) };
    }
    if (
      name === "ask_agent" &&
      typeof parsed.question === "string" &&
      (parsed.agent === "assistant" || parsed.agent === "builder")
    ) {
      return {
        name,
        agent: parsed.agent,
        question: parsed.question.slice(0, 1500),
      };
    }
    if (
      name === "run_code" &&
      typeof parsed.language === "string" &&
      typeof parsed.code === "string"
    ) {
      const extra = Array.isArray(parsed.files)
        ? (parsed.files as { path?: unknown; code?: unknown }[])
            .filter(
              (entry) =>
                typeof entry?.path === "string" && typeof entry?.code === "string",
            )
            .slice(0, 12)
            .map((entry) => ({
              path: String(entry.path).slice(0, 120),
              code: String(entry.code).slice(0, 40_000),
            }))
        : [];

      return {
        name,
        language: parsed.language.slice(0, 40),
        code: parsed.code.slice(0, 20_000),
        files: extra,
      };
    }
    if (name === "read_family") {
      return { name, limit: asNumber(parsed.limit) };
    }
    if (name === "read_briefing") {
      return {
        name,
        section:
          typeof parsed.section === "string" && parsed.section.trim()
            ? parsed.section.slice(0, 40)
            : null,
      };
    }
    if (name === "read_rundown") {
      const days = asNumber(parsed.days);
      return {
        name,
        days: days === null ? null : Math.min(60, Math.max(1, Math.floor(days))),
      };
    }
    if (name === "list_ai") {
      return { name };
    }
    if (name === "ask_ai") {
      // Models name the question differently from one turn to the next, and
      // some leave the system out and mean "whichever".
      const asked =
        parsed.question ?? parsed.prompt ?? parsed.q ?? parsed.query ?? "";
      if (typeof asked !== "string" || !asked.trim()) continue;

      return {
        name,
        system:
          typeof parsed.system === "string" && parsed.system.trim()
            ? parsed.system.slice(0, 80)
            : "any",
        // A gateway like OpenRouter holds hundreds of models under one key, so
        // the agent may name the exact model it wants there.
        model:
          typeof parsed.model === "string" && parsed.model.trim()
            ? parsed.model.slice(0, 120)
            : null,
        question: asked.slice(0, 4000),
      };
    }
    if (name === "act" && Array.isArray(parsed.actions)) {
      return { name, actions: parsed.actions };
    }
    if (
      name === "write_file" &&
      typeof parsed.path === "string" &&
      typeof parsed.content === "string"
    ) {
      return {
        name,
        path: parsed.path.slice(0, 200),
        content: parsed.content.slice(0, 200_000),
        language:
          typeof parsed.language === "string"
            ? parsed.language.slice(0, 40)
            : null,
      };
    }
    if (name === "read_file" && typeof parsed.path === "string") {
      const from = asNumber(parsed.from);
      const to = asNumber(parsed.to);
      return {
        name,
        path: parsed.path.slice(0, 200),
        from: from === null ? null : Math.max(1, Math.floor(from)),
        to: to === null ? null : Math.max(1, Math.floor(to)),
      };
    }
    if (name === "list_files") {
      return { name };
    }
    if (name === "search_files" && typeof parsed.query === "string") {
      return { name, query: parsed.query.slice(0, 200) };
    }
    if (name === "delete_file" && typeof parsed.path === "string") {
      return { name, path: parsed.path.slice(0, 200) };
    }
    if (name === "read_own_code") {
      const from = asNumber(parsed.from);
      const to = asNumber(parsed.to);
      return {
        name,
        path: typeof parsed.path === "string" ? parsed.path.slice(0, 200) : null,
        search:
          typeof parsed.search === "string" ? parsed.search.slice(0, 200) : null,
        from: from === null ? null : Math.max(1, Math.floor(from)),
        to: to === null ? null : Math.max(1, Math.floor(to)),
      };
    }
    if (
      name === "patch_own_code" &&
      typeof parsed.path === "string" &&
      typeof parsed.search === "string" &&
      typeof parsed.replace === "string"
    ) {
      return {
        name,
        path: parsed.path.slice(0, 200),
        search: parsed.search.slice(0, 60_000),
        replace: parsed.replace.slice(0, 60_000),
      };
    }
    if (
      name === "edit_file" &&
      typeof parsed.path === "string" &&
      typeof parsed.search === "string" &&
      typeof parsed.replace === "string"
    ) {
      return {
        name,
        path: parsed.path.slice(0, 200),
        search: parsed.search.slice(0, 60_000),
        replace: parsed.replace.slice(0, 60_000),
      };
    }
    if (
      name === "move_file" &&
      typeof parsed.path === "string" &&
      typeof parsed.to === "string"
    ) {
      return {
        name,
        path: parsed.path.slice(0, 200),
        to: parsed.to.slice(0, 200),
      };
    }
    if (name === "scaffold_project") {
      return { name };
    }
    if (name === "build_app") {
      return { name, quick: parsed.quick === true };
    }
    if (name === "think") {
      // Models name the scratchpad differently from turn to turn.
      const thought = parsed.thought ?? parsed.plan ?? parsed.reasoning;
      if (typeof thought === "string" && thought.trim()) {
        return { name, thought: thought.slice(0, 20_000) };
      }
    }
  }

  return null;
}

function decodeEntities(text: string) {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&hellip;/g, "…")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–");
}

function stripHtml(html: string) {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

function httpUrl(raw: string) {
  const value = raw.trim();
  if (!value) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(value)
    ? value
    : `https://${value}`;
  try {
    const url = new URL(withScheme);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

/** Code questions: Stack Overflow's public API. No key, no bot wall. */
async function searchStackOverflow(query: string) {
  try {
    const response = await fetchWithTimeout(
      `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&site=stackoverflow&pagesize=5&q=${encodeURIComponent(query)}`,
      { headers: { "User-Agent": BROWSER_UA, Accept: "application/json" } },
    );
    if (!response.ok) return null;

    const data = (await response.json()) as {
      items?: {
        title?: string;
        link?: string;
        score?: number;
        is_answered?: boolean;
        tags?: string[];
      }[];
    };
    const items = data.items ?? [];
    if (!items.length) return null;

    const lines = items.map((item) => {
      const title = decodeEntities(item.title ?? "").trim();
      const tags = (item.tags ?? []).slice(0, 4).join(", ");
      const answered = item.is_answered ? " (answered)" : "";
      return `- ${title}${answered} — score ${item.score ?? 0}${tags ? ` [${tags}]` : ""}\n  ${item.link ?? ""}`;
    });

    return `Stack Overflow:\n${lines.join("\n")}`;
  } catch {
    return null;
  }
}

