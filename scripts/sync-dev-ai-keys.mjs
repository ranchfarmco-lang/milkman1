#!/usr/bin/env bun
/**
 * Give the local dev backend the same AI keys the deployment has.
 *
 * The app runs against the Convex backend beside the page in development (see
 * `src/lib/backend.ts`), and that backend is a deployment of its own: it is
 * created empty, and only the signing keys are ever put on it (see
 * `scripts/generate-auth-keys.mjs`). Everything else — including every AI key
 * the family has set — lives on the deployment the project is pointed at.
 *
 * That gap is invisible until it matters. A hub with no key of its own still
 * answers by walking down to the free systems and the models running on this
 * machine, so it looks alive; the moment none of those is reachable, every
 * question ends in "Ollama did not answer — asking Local model server", and
 * nothing about the running app suggests the keys are simply somewhere else.
 *
 * This copies the *AI* variables — and only those — from the configured
 * deployment to the local backend, and only where the local backend does not
 * already have them, so a value set deliberately on this machine is never
 * clobbered. `scripts/dev.sh` runs it before Vite starts.
 *
 * Values are secrets. None of them is ever printed: the deployment is read
 * through the CLI, the write goes straight to the local backend's admin API,
 * and only variable *names* reach this script's output.
 *
 *   bun scripts/sync-dev-ai-keys.mjs
 */

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

/**
 * The variables that decide whether an AI box can answer at all.
 *
 * Every name the provider roster in `src/convex/ai.ts` reads, plus the ones the
 * free/dialect systems use. Nothing here is auth, hosting or hub state — a key
 * belongs on this list only when the local app needs it to talk to a model.
 */
const AI_VARS = [
  // the deployment's own gateway
  "VLY_INTEGRATION_KEY",
  "VLY_INTEGRATION_BASE_URL",
  // your own endpoint, and the ordering switches
  "AI_BASE_URL",
  "AI_API_KEY",
  "AI_LEAD",
  "AI_FREE_TIER",
  // the open hosts
  "GROQ_API_KEY",
  "OPENROUTER_API_KEY",
  "DEEPSEEK_API_KEY",
  "XAI_API_KEY",
  "GROK_API_KEY",
  "CEREBRAS_API_KEY",
  "MISTRAL_API_KEY",
  "TOGETHER_API_KEY",
  "SAMBANOVA_API_KEY",
  "NVIDIA_API_KEY",
  "HF_TOKEN",
  "HUGGINGFACE_API_KEY",
  "HUGGING_FACE_HUB_TOKEN",
  "GITHUB_MODELS_TOKEN",
  "GITHUB_TOKEN",
  "DASHSCOPE_API_KEY",
  "QWEN_API_KEY",
  "ZAI_API_KEY",
  "Z_AI_API_KEY",
  "GLM_API_KEY",
  "CHUTES_API_KEY",
  "MOONSHOT_API_KEY",
  "KIMI_API_KEY",
  "FIREWORKS_API_KEY",
  "NEBIUS_API_KEY",
  "HYPERBOLIC_API_KEY",
  // the commercial labs
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  // the ones that are not a plain OpenAI-compatible key
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "POLLINATIONS_API_KEY",
];

/**
 * The local backend, as the CLI leaves it: a port and the admin key that talks
 * to it. Both come from the config the CLI writes when it creates the
 * deployment — the same file, key and API the CLI itself uses.
 */
async function localBackend() {
  let config;
  try {
    config = JSON.parse(
      await readFile(".convex/local/default/config.json", "utf8"),
    );
  } catch {
    return null;
  }
  const port = config?.ports?.cloud;
  const adminKey = config?.adminKey;
  if (!port || !adminKey) return null;
  return { port, adminKey };
}

/** One admin call against the local backend. */
async function localAdmin(backend, path, body) {
  const response = await fetch(`http://127.0.0.1:${backend.port}/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Convex ${backend.adminKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${text.trim().slice(0, 400)}`);
  }
  return text.trim() ? JSON.parse(text) : null;
}

/** The names of the variables already on the local backend — never values. */
async function localNames(backend) {
  const result = await localAdmin(backend, "api/query", {
    path: "_system/cli/queryEnvironmentVariables",
    args: {},
  });
  const entries = result?.value ?? [];
  return new Set(
    entries
      .map((entry) => (typeof entry === "string" ? entry : entry?.name))
      .filter(Boolean),
  );
}

/**
 * The variables on the configured deployment, as a name → value map.
 *
 * Read through `convex env list`, which prints `NAME=value` lines. The map is
 * kept in memory only, and only values for the names on the list above are ever
 * written anywhere.
 */
function deploymentVars() {
  const result = spawnSync("bunx", ["convex", "env", "list"], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  if (result.status !== 0) return null;

  const vars = new Map();
  for (const line of result.stdout.split("\n")) {
    const at = line.indexOf("=");
    if (at < 1) continue;
    vars.set(line.slice(0, at), line.slice(at + 1));
  }
  return vars;
}

const backend = await localBackend();
if (!backend) {
  // No local deployment to configure. Not this script's problem.
  process.exit(0);
}

let current;
try {
  current = await localNames(backend);
} catch (error) {
  console.error(`The local backend is not answering: ${error.message}`);
  process.exit(1);
}

const deployment = deploymentVars();
if (!deployment) {
  console.error(
    "Could not read the deployment's variables — is the Convex CLI signed in?",
  );
  process.exit(1);
}

/**
 * Fill the gaps, and only the gaps. A variable already on the local backend was
 * put there on purpose and is left exactly as it is.
 */
const changes = [];
for (const name of AI_VARS) {
  if (current.has(name)) continue;
  if (!deployment.has(name)) continue;
  changes.push({ name, value: deployment.get(name) });
}

if (changes.length === 0) {
  console.log("The local backend already has every AI key the deployment has.");
  process.exit(0);
}

try {
  await localAdmin(backend, "api/update_environment_variables", { changes });
} catch (error) {
  console.error(`Could not set the AI keys: ${error.message}`);
  process.exit(1);
}

console.log(
  `The local backend can now reach an AI. Set ${changes
    .map((change) => change.name)
    .join(", ")}.`,
);
