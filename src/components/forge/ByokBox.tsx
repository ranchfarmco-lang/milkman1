/**
 * Box 1 — LLM Providers (BYOK Hub).
 *
 * Eight providers. The first is **This hub** and is unlike the rest: its models
 * live on the deployment, behind the keys the hub already holds, so there is
 * nothing to paste — the crew and the assistant reach them through
 * `ai.complete`, and the row is there to be chosen and tested like any other.
 * The seven behind it each get a live light from a real model-list probe, a
 * masked key input whose value is sealed in the encrypted vault (the field
 * never shows a saved key — it can only be replaced or cleared), endpoint
 * switches for the two local servers, and per-row Test. The box carries
 * Detect (probe both local servers), Refresh Models (re-test everything that
 * has a key), and Clear Keys (two presses, orange, forgets every secret).
 *
 * The chosen provider+model pair is what the Assistant and Builder talk to.
 */
import { ForgeBox, ForgeLight, MiniButton } from "@/components/forge/ForgeBox";
import { Switch } from "@/components/ui/switch";
import { deleteSecret, putSecret } from "@/lib/forge/crypto";
import { forgeDb, setLight, type Tone } from "@/lib/forge/db";
import { endpointOf, writeConfig } from "@/lib/forge/config";
import {
  PROVIDERS,
  detectLocal,
  providerSecretId,
  testProvider,
  type ProviderId,
} from "@/lib/forge/llm";
import {
  useForgeConfig,
  useForgeLights,
  useForgeTick,
} from "@/hooks/use-forge";
import { KeyRound, Plug, Radio, Save, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { toast } from "sonner";

type Models = Partial<Record<ProviderId, string[]>>;

export function ByokBox() {
  const config = useForgeConfig();
  const lights = useForgeLights();
  const tick = useForgeTick();

  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [endpoints, setEndpoints] = useState<Record<string, string>>({});
  const [models, setModels] = useState<Models>({});
  const [testing, setTesting] = useState<string | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [clearArmed, setClearArmed] = useState(false);
  const [readAt, setReadAt] = useState<number | null>(null);

  const secretKeys = useLiveQuery(
    () => forgeDb.secrets.toCollection().primaryKeys(),
    ["secrets", tick],
  );
  const saved = useMemo(
    () => new Set((secretKeys ?? []) as string[]),
    [secretKeys],
  );

  const lightOf = (id: string) => lights.find((light) => light.id === id);

  const runTest = async (provider: ProviderId) => {
    setTesting(provider);
    try {
      const meta = PROVIDERS.find((entry) => entry.id === provider)!;
      const endpoint = endpointOf(config, provider);
      const result = await testProvider(provider, {
        base: endpoint.baseUrl || meta.baseUrl,
      });
      await setLight(`provider:${provider}`, result.tone, result.detail);
      setModels((previous) => ({ ...previous, [provider]: result.models }));
      setReadAt(Date.now());
      if (result.tone === "good")
        toast.success(`${meta.label}: ${result.detail}`);
      else if (result.tone === "bad")
        toast.error(`${meta.label}: ${result.detail}`);
      else toast(`${meta.label}: ${result.detail}`);
    } finally {
      setTesting(null);
    }
  };

  const testAll = async () => {
    for (const provider of PROVIDERS) {
      const hasKey =
        saved.has(providerSecretId(provider.id)) || !provider.needsKey;
      if (hasKey) await runTest(provider.id);
    }
    setReadAt(Date.now());
  };

  const detect = async () => {
    setDetecting(true);
    try {
      const found = await detectLocal();
      if (!found.length) {
        toast(
          "No local model server answered. Ollama and LM Studio must be running, and Ollama needs OLLAMA_ORIGINS to allow this page.",
        );
        return;
      }
      const next = { ...config.endpoints };
      for (const hit of found) {
        next[hit.provider] = { baseUrl: hit.base, enabled: true };
        await setLight(
          `provider:${hit.provider}`,
          "good",
          `Detected at ${hit.base} — ${hit.models.length} model(s).`,
        );
        setModels((previous) => ({ ...previous, [hit.provider]: hit.models }));
      }
      await writeConfig({ endpoints: next });
      toast.success(
        `Found ${found.map((hit) => hit.provider).join(" and ")} at ${found.map((hit) => hit.base).join(", ")}.`,
      );
    } finally {
      setDetecting(false);
    }
  };

  const saveKey = async (provider: ProviderId) => {
    const value = drafts[provider] ?? "";
    if (!value.trim()) {
      toast("Type a key first.");
      return;
    }
    try {
      await putSecret(providerSecretId(provider), value);
      setDrafts((previous) => ({ ...previous, [provider]: "" }));
      toast.success("Key sealed in the encrypted vault.");
      await runTest(provider);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not save the key.",
      );
    }
  };

  const clearKeys = async () => {
    if (!clearArmed) {
      setClearArmed(true);
      toast("Press Clear Keys again to forget every saved key.");
      window.setTimeout(() => setClearArmed(false), 4000);
      return;
    }
    setClearArmed(false);
    for (const provider of PROVIDERS)
      await deleteSecret(providerSecretId(provider.id));
    await deleteSecret("search:brave");
    toast.success("Every key is forgotten.");
    setReadAt(Date.now());
  };

  const overallTone: Tone = lights.some(
    (light) => light.id.startsWith("provider:") && light.tone === "good",
  )
    ? "good"
    : lights.some(
          (light) => light.id.startsWith("provider:") && light.tone === "bad",
        )
      ? "bad"
      : "warn";

  const connected = lights.filter(
    (light) => light.id.startsWith("provider:") && light.tone === "good",
  ).length;

  return (
    <ForgeBox
      id="forge-byok"
      icon={KeyRound}
      title="LLM Providers (BYOK Hub)"
      light={{
        tone: overallTone,
        value: connected ? `${connected} ANSWERING` : "NONE TESTED",
        note: readAt
          ? `Last test ${new Date(readAt).toLocaleTimeString()}.`
          : "Press Test or Detect.",
      }}
      onRefresh={testAll}
      test={{ label: detecting ? "Detecting…" : "Detect", onTest: detect }}
      testing={detecting}
      hint="Keys are sealed with AES-GCM in this browser's IndexedDB and only leave it on the call to their own provider. The pair you mark as in use is what the AI Assistant and AI Builder talk to."
    >
      <div className="flex flex-col divide-y divide-border/50">
        {PROVIDERS.map((provider) => {
          const light = lightOf(`provider:${provider.id}`);
          const hasKey = saved.has(providerSecretId(provider.id));
          const endpoint = endpointOf(config, provider.id);
          const isActive = config.aiProvider === provider.id;
          const modelList = models[provider.id] ?? provider.models;

          return (
            <div
              key={provider.id}
              className="flex flex-col gap-2 py-2.5 first:pt-0"
            >
              <div className="flex flex-wrap items-center gap-2">
                <ForgeLight
                  tone={light?.tone ?? "muted"}
                  value={
                    light?.detail ? light.detail.slice(0, 64) : "NOT TESTED"
                  }
                  note={light?.detail}
                />
                <span className="text-[11px] font-semibold">
                  {provider.label}
                </span>
                {provider.local ? (
                  <span className="rounded-full border border-border/60 px-1.5 py-px text-[8px] uppercase tracking-wider text-muted-foreground">
                    local
                  </span>
                ) : null}
                {isActive ? (
                  <span className="rounded-full bg-white/15 px-1.5 py-px text-[8px] font-semibold uppercase tracking-wider text-white">
                    in use · {config.aiModel ?? "no model"}
                  </span>
                ) : null}
                <span className="ml-auto flex items-center gap-1.5">
                  <MiniButton
                    onClick={() => runTest(provider.id)}
                    disabled={testing !== null}
                    title="Test connection — fetches the model list"
                  >
                    <Plug className="size-3" />
                    Test
                  </MiniButton>
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {provider.id === "hub" ? (
                  <span className="text-[10px] text-muted-foreground">
                    Runs on the deployment, on the keys this hub already holds —
                    nothing to paste.
                  </span>
                ) : null}

                {provider.local ? (
                  <label className="flex items-center gap-2 text-[10px] text-muted-foreground">
                    <Switch
                      checked={endpoint.enabled}
                      onCheckedChange={(checked) =>
                        void writeConfig({
                          endpoints: {
                            ...config.endpoints,
                            [provider.id]: { ...endpoint, enabled: checked },
                          },
                        })
                      }
                    />
                    endpoint on
                  </label>
                ) : null}

                {provider.local ? (
                  <input
                    value={endpoints[provider.id] ?? endpoint.baseUrl}
                    onChange={(event) =>
                      setEndpoints((previous) => ({
                        ...previous,
                        [provider.id]: event.target.value,
                      }))
                    }
                    onBlur={() => {
                      const value = (endpoints[provider.id] ?? endpoint.baseUrl)
                        .trim()
                        .replace(/\/+$/, "");
                      if (value && value !== endpoint.baseUrl) {
                        void writeConfig({
                          endpoints: {
                            ...config.endpoints,
                            [provider.id]: { ...endpoint, baseUrl: value },
                          },
                        });
                      }
                    }}
                    data-spell="off"
                    spellCheck={false}
                    aria-label={`${provider.label} address`}
                    className="h-7 w-56 rounded-lg border border-border/60 bg-background/60 px-2 text-[10px] outline-none focus:border-white/40"
                  />
                ) : null}

                {provider.needsKey ? (
                  <span className="flex items-center gap-1.5">
                    <input
                      type="password"
                      autoComplete="off"
                      value={drafts[provider.id] ?? ""}
                      onChange={(event) =>
                        setDrafts((previous) => ({
                          ...previous,
                          [provider.id]: event.target.value,
                        }))
                      }
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void saveKey(provider.id);
                      }}
                      placeholder={
                        hasKey
                          ? "•••••••• saved — type to replace"
                          : `paste ${provider.keyHint}`
                      }
                      aria-label={`${provider.label} API key`}
                      className="h-7 w-56 rounded-lg border border-border/60 bg-background/60 px-2 text-[10px] outline-none focus:border-white/40"
                    />
                    <MiniButton
                      onClick={() => saveKey(provider.id)}
                      title="Seal this key in the encrypted vault"
                    >
                      <Save className="size-3" />
                      Save
                    </MiniButton>
                    <MiniButton
                      onClick={async () => {
                        await deleteSecret(providerSecretId(provider.id));
                        toast(`${provider.label}'s key forgotten.`);
                      }}
                      disabled={!hasKey}
                      title="Forget this key"
                    >
                      <Trash2 className="size-3" />
                    </MiniButton>
                    <a
                      href={provider.keyUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[9px] text-muted-foreground underline decoration-dotted hover:text-foreground"
                    >
                      get a key
                    </a>
                  </span>
                ) : null}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[9px] text-muted-foreground">
                  Model in use:
                </span>
                <select
                  value={isActive ? (config.aiModel ?? "") : ""}
                  onChange={(event) =>
                    void writeConfig({
                      aiProvider: provider.id,
                      aiModel: event.target.value,
                    })
                  }
                  aria-label={`Model for ${provider.label}`}
                  className="h-7 max-w-72 cursor-pointer rounded-lg border border-border/60 bg-background/60 px-1.5 text-[10px] outline-none focus:border-white/40"
                >
                  <option value="">— choose —</option>
                  {modelList.map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </select>
                {isActive && config.aiModel ? (
                  <MiniButton
                    onClick={() =>
                      void writeConfig({ aiProvider: null, aiModel: null })
                    }
                  >
                    stop using
                  </MiniButton>
                ) : (
                  <button
                    type="button"
                    onClick={() =>
                      void writeConfig({
                        aiProvider: provider.id,
                        aiModel: modelList[0] ?? "",
                      })
                    }
                    className="cursor-pointer text-[9px] text-muted-foreground underline decoration-dotted hover:text-foreground"
                  >
                    use {provider.label}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/50 pt-3">
        <MiniButton
          onClick={clearKeys}
          title="Forget every saved key (two presses)"
        >
          <Trash2 className="size-3 text-amber-300" />
          {clearArmed ? "press again to clear" : "Clear Keys"}
        </MiniButton>
        <span className="text-[9px] text-muted-foreground">
          <Radio className="mr-1 inline size-3" />
          Detect probes 127.0.0.1 for Ollama and LM Studio; Refresh (the ↻ up
          top) re-tests everything with a key.
        </span>
      </div>
    </ForgeBox>
  );
}
