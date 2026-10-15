/**
 * The AI Assistant page — a completely separate AI entity.
 *
 * Calm, informative, high-level: she reads everything, changes light things,
 * and never writes code. When a build is needed she packages a build request
 * into the shared local store and says the handoff sentence — which this
 * page appends itself if the model forgets, so the behaviour is guaranteed
 * rather than merely prompted. Conversation history lives in IndexedDB per
 * page, so it survives reloads and never leaves the browser.
 */
import { MessagePanel, type ChatMessage } from "@/components/MessagePanel";
import { Button } from "@/components/ui/button";
import { useForgeConfig, useForgeMessages, useForgeSessions, usePendingRequests } from "@/hooks/use-forge";
import {
  ASSISTANT_HANDOFF,
  assistantSystem,
  assistantTools,
  statusDigest,
} from "@/lib/forge/assistant";
import { addForgeMessage, clearSessionMessages, ensureSession, newSession } from "@/lib/forge/chat";
import { providerMeta, runToolLoop, type LlmMessage, type ProviderId } from "@/lib/forge/llm";
import { PROVIDERS } from "@/lib/forge/llm";
import { AssistantIcon } from "@/lib/assistant-mark";
import { cn } from "@/lib/utils";
import { Loader2, SquarePen } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";

/** Her on-screen look: quiet, monochrome, distinct from the hub's boxes. */
const ACCENT = {
  iconWrap: "bg-white/10 text-white",
  send: "bg-white text-black hover:bg-white/85",
  bubble: "bg-white/10 text-white",
  dot: "bg-white",
};

export default function AiAssistantPage() {
  const navigate = useNavigate();
  const config = useForgeConfig();
  const sessions = useForgeSessions("assistant");
  const session = sessions?.[0] ?? null;
  const messages = useForgeMessages(session?.id ?? null);
  const pending = usePendingRequests();

  const [thinking, setThinking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const handoffRef = useRef(false);

  // The first open creates this page's conversation — one write, then the
  // live query carries it.
  useEffect(() => {
    if (sessions && sessions.length === 0) void ensureSession("assistant");
  }, [sessions]);

  const ready = Boolean(config.aiProvider && config.aiModel);
  const providerMeta_ = config.aiProvider ? providerMeta(config.aiProvider) : null;

  const chatMessages = useMemo<ChatMessage[]>(
    () =>
      messages.map((row) => ({
        id: row.id,
        text: row.text,
        note: row.note,
        mine: row.role === "user",
        role: row.role === "user" ? "user" : "assistant",
      })),
    [messages],
  );

  const send = useCallback(
    async (text: string) => {
      if (!session) return;
      if (!config.aiProvider || !config.aiModel) {
        setNotice(
          "No model is chosen. Open the Control Room's BYOK hub, save a key (or detect a local server), and pick the pair to talk to.",
        );
        return;
      }

      handoffRef.current = false;
      setNotice(null);
      setThinking(true);

      // The transcript as it stands, then the new line — written after the
      // answer lands so a failure cannot leave the history half-updated.
      const history: LlmMessage[] = messages.map((row) => ({
        role: row.role === "user" ? "user" : "assistant",
        content: row.text,
      }));

      try {
        const digest = await statusDigest();
        const result = await runToolLoop({
          provider: config.aiProvider as ProviderId,
          model: config.aiModel,
          system: assistantSystem(digest),
          messages: [...history, { role: "user", content: text }],
          tools: assistantTools({ navigate, onHandoff: () => (handoffRef.current = true) }),
          maxRounds: 6,
        });

        let reply = result.text.trim() || "I have nothing to add to that just now.";
        if (handoffRef.current && !reply.includes("AI Builder page to review")) {
          reply = `${reply}\n\n${ASSISTANT_HANDOFF}`;
        }

        await addForgeMessage(session.id, "user", text);
        await addForgeMessage(
          session.id,
          "assistant",
          reply,
          result.used.length ? `tools: ${[...new Set(result.used)].join(", ")}` : null,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await addForgeMessage(session.id, "user", text);
        if (/Stopped\./.test(message)) {
          setNotice("Stopped.");
        } else {
          setNotice(message);
          await addForgeMessage(
            session.id,
            "assistant",
            `I could not finish that: ${message}`,
            "the model call failed",
          );
        }
      } finally {
        setThinking(false);
      }
    },
    [config.aiProvider, config.aiModel, messages, navigate, session],
  );

  const pickProvider = (id: string) => {
    const meta = providerMeta(id);
    void import("@/lib/forge/config").then(({ writeConfig }) =>
      writeConfig({ aiProvider: id, aiModel: meta?.models[0] ?? null }),
    );
  };

  const pickModel = (model: string) => {
    void import("@/lib/forge/config").then(({ writeConfig }) => writeConfig({ aiModel: model }));
  };

  const modelOptions = useMemo(() => {
    const list = providerMeta_?.models ?? [];
    if (config.aiModel && !list.includes(config.aiModel)) return [config.aiModel, ...list];
    return list;
  }, [config.aiModel, providerMeta_]);

  const noModelNotice = !ready
    ? "No model is chosen for the forge yet — save a key (or detect a local server) in the Control Room's BYOK hub, then pick the provider and model below."
    : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <MessagePanel
        title="AI Assistant"
        subtitle="Calm, high-level, reads everything — never writes code. When something needs building, she sends a build request to the AI Builder."
        icon={AssistantIcon}
        accent={ACCENT}
        placeholder={
          ready ? "Ask about the system, the projects, or what should happen next…" : "Choose a model first…"
        }
        emptyTitle="Ask me anything about your system"
        emptyHint="Status, explanations, plans and decisions. When a change needs code, I package a build request for the AI Builder — I never write code myself."
        status={ready ? `${providerMeta_?.label ?? config.aiProvider} · ${config.aiModel}` : "no model"}
        messages={chatMessages}
        onSend={send}
        onClear={() => {
          if (!session) return;
          void clearSessionMessages(session.id).then((count) =>
            toast.success(count ? `Cleared ${count} message(s).` : "Nothing to clear."),
          );
        }}
        thinking={thinking}
        notice={notice ?? noModelNotice}
        disabled={!ready || !session || thinking}
        headerAction={
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-6 cursor-pointer rounded-lg px-2 text-[9px]"
            title="Start a fresh conversation (the old one stays in history)"
            onClick={() => void newSession("assistant")}
          >
            <SquarePen className="size-3" />
            New chat
          </Button>
        }
        footer={
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={config.aiProvider ?? ""}
              onChange={(event) => pickProvider(event.target.value)}
              aria-label="Provider"
              className={cn(
                "h-7 cursor-pointer rounded-lg border border-border/60 bg-background/60 px-1.5 text-[10px] outline-none focus:border-white/40",
              )}
            >
              <option value="">provider…</option>
              {PROVIDERS.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.label}
                  {provider.local ? " (local)" : ""}
                </option>
              ))}
            </select>

            <select
              value={config.aiModel ?? ""}
              onChange={(event) => pickModel(event.target.value)}
              aria-label="Model"
              className="h-7 max-w-64 cursor-pointer rounded-lg border border-border/60 bg-background/60 px-1.5 text-[10px] outline-none focus:border-white/40"
            >
              <option value="">model…</option>
              {modelOptions.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>

            <Link
              to="/control-room#forge-byok"
              className="text-[9px] text-muted-foreground underline decoration-dotted hover:text-foreground"
            >
              BYOK hub
            </Link>

            {pending.length ? (
              <Link
                to="/ai-builder"
                className="ml-auto flex items-center gap-1 rounded-full border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-[9px] text-amber-200 hover:bg-amber-400/20"
              >
                {pending.length} build request{pending.length === 1 ? "" : "s"} waiting in the AI Builder
              </Link>
            ) : null}
          </div>
        }
      />

      {/* A quiet line of truth while a run is in flight: which tools she has
          reached for, without inventing a stream the model does not send. */}
      {thinking ? (
        <p className="mt-1 flex items-center gap-1.5 px-1 text-[9px] text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          reading status, thinking, and running any tools she needs…
        </p>
      ) : null}
    </div>
  );
}
