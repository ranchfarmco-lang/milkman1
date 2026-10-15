// SUGAR — the AI provider registry (§6).
//
// AI is optional here, and the order is deliberate: a model running on *this
// machine* is tried first, and a remote service is only ever used if the person
// configured one and turned it on. With nothing configured, SUGAR still works —
// it falls back to its own command planner, which needs no model at all.
//
// Nothing in this file sends anything anywhere unless it is called, and every
// failure is reported as a failure so the UI can say "the local model is not
// running" rather than pretending an answer came from somewhere.
"use strict";

/** The well-known local AI servers, and the ports they listen on. */
const LOCAL_ENDPOINTS = [
  { id: "ollama", name: "Ollama", base: "http://127.0.0.1:11434", modelsPath: "/api/tags", chatPath: "/v1/chat/completions" },
  { id: "lmstudio", name: "LM Studio", base: "http://127.0.0.1:1234", modelsPath: "/v1/models", chatPath: "/v1/chat/completions" },
  { id: "llamacpp", name: "llama.cpp", base: "http://127.0.0.1:8080", modelsPath: "/v1/models", chatPath: "/v1/chat/completions" },
  { id: "vllm", name: "vLLM", base: "http://127.0.0.1:8000", modelsPath: "/v1/models", chatPath: "/v1/chat/completions" },
  { id: "jan", name: "Jan", base: "http://127.0.0.1:1337", modelsPath: "/v1/models", chatPath: "/v1/chat/completions" },
];

/** Providers from settings, with the local ones first when asked. */
function providerList(settings = {}) {
  const configured = Array.isArray(settings?.ai?.providers) ? settings.ai.providers : [];
  const preferLocal = settings?.ai?.preferLocal !== false;
  const list = [...configured];
  if (preferLocal) list.sort((a, b) => Number(b.kind === "local") - Number(a.kind === "local"));
  return list;
}

/** Whether a provider is usable at all: a local one needs no key, a remote one does. */
function isUsable(provider) {
  if (!provider || !provider.base) return false;
  if (provider.kind === "local") return true;
  return Boolean(provider.apiKey);
}

/**
 * Ask one local server whether it is there. A model server that is not running
 * is the normal case, so a refusal is reported as `available: false`, not as an
 * error the person has to deal with.
 */
async function probe(provider, fetchImpl = fetch, timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${provider.base}${provider.modelsPath ?? "/v1/models"}`, {
      signal: controller.signal,
      headers: provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {},
    });
    if (!response.ok) return { ...provider, available: false, models: [], note: `answered HTTP ${response.status}` };
    const body = await response.json().catch(() => ({}));
    const models = extractModels(body);
    return { ...provider, available: true, models, note: models.length ? `serving ${models.length} model(s)` : "running" };
  } catch (error) {
    return {
      ...provider,
      available: false,
      models: [],
      note: error instanceof Error ? error.message : "no answer",
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Ollama and the OpenAI-compatible servers name their models differently. */
function extractModels(body) {
  const list = Array.isArray(body?.models) ? body.models : Array.isArray(body?.data) ? body.data : [];
  return list
    .map((entry) => entry?.name ?? entry?.id ?? entry?.model ?? null)
    .filter((name) => typeof name === "string" && name.length > 0);
}

/** Probe the well-known local servers and report what answered. */
async function detectLocal(fetchImpl = fetch, extra = []) {
  const all = [...LOCAL_ENDPOINTS.map((entry) => ({ ...entry, kind: "local" })), ...extra];
  const results = await Promise.all(all.map((entry) => probe(entry, fetchImpl)));
  return results.filter((entry) => entry.available);
}

/**
 * The order one question will actually be asked in: the model servers on *this*
 * machine first (detected ones before configured ones), then everything else,
 * skipping anything unusable and never asking the same address twice. With
 * auto-detection turned off, only the configured providers are considered.
 */
function askOrder(config = {}, detected = []) {
  const found = config?.ai?.autoDetectLocal === false ? [] : detected;
  const seen = new Set();
  const order = [];
  for (const provider of [...found, ...providerList(config)]) {
    if (!isUsable(provider)) continue;
    const key = String(provider.base || "").toLowerCase().replace(/\/+$/, "");
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    order.push(provider);
  }
  return order;
}

/**
 * Ask a provider to turn a sentence into SUGAR's plan. The model is given the
 * plan's schema and told to answer with nothing else, so a stray sentence cannot
 * become a browser action. A failure is returned as a failure — the caller falls
 * back to the local planner rather than guessing.
 */
async function planWithProvider(provider, request, fetchImpl = fetch, timeoutMs = 30000) {
  if (!isUsable(provider)) return { ok: false, error: "That provider is not configured." };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${provider.base}${provider.chatPath ?? "/v1/chat/completions"}`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: request.model ?? provider.model ?? "",
        temperature: 0,
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.user },
        ],
      }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    const text =
      body?.choices?.[0]?.message?.content ??
      body?.message?.content ??
      body?.response ??
      "";
    return { ok: true, text: String(text) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  LOCAL_ENDPOINTS,
  providerList,
  isUsable,
  probe,
  extractModels,
  detectLocal,
  askOrder,
  planWithProvider,
};
