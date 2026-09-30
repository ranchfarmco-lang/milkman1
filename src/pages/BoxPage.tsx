import { AddContactDialog } from "@/components/AddContactDialog";
import { CallTest } from "@/components/CallTest";
import { useCallStage } from "@/components/CallProvider";
import { ConferenceRoom } from "@/components/ConferenceRoom";
import { ConnectionPanel } from "@/components/ConnectionPanel";
import { MessengerCall } from "@/components/MessengerCall";
import {
  MessagePanel,
  type ChatMessage,
  type PanelAccent,
} from "@/components/MessagePanel";
import { PreviewPanel } from "@/components/PreviewPanel";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/convex/_generated/api";
import { useChat } from "@/hooks/use-chat";
import { useDictation, useSpeechSynthesis } from "@/hooks/use-speech";
import { useReminders, type Reminder } from "@/hooks/use-reminders";
import { useSettings } from "@/hooks/use-settings";
import { useVoice } from "@/hooks/use-voice";
import { buzz, chime, notifyMessage } from "@/lib/alerts";
import {
  runActions,
  sendNotification,
  toActions,
} from "@/lib/assistant-actions";
import { cn } from "@/lib/utils";
import { useMutation, useQuery } from "convex/react";
import {
  ArrowLeftRight,
  Church,
  Hammer,
  MessageCircle,
  Mic,
  MicOff,
  Timer,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router";

export type BoxKey = "assistant" | "builder" | "messenger";

/** Black and white: every box uses the same monochrome treatment. */
const MONO: PanelAccent = {
  iconWrap: "bg-white/10 text-white",
  send: "bg-white text-black hover:bg-white/85",
  bubble: "bg-white/15 text-white",
  dot: "bg-white",
};

const NO_KEY_NOTICE =
  "Nothing for the AI to talk to — the Control Room lists every system this hub can reach and the variable each one asks for, and any of them can be pasted into the Keys tab. The free public systems and a model on this machine need no key at all.";

/** Both AIs change things the same way: the page does it when the reply lands. */
function useAgentActions() {
  const navigate = useNavigate();
  const setDisplayName = useMutation(api.family.setDisplayName);
  const createEvent = useMutation(api.calendar.fromAssistant);
  const planShopping = useMutation(api.calendar.shopFromAssistant);
  const [problem, setProblem] = useState<string | null>(null);

  const run = useCallback(
    async (rawActions: unknown) => {
      const actions = toActions(rawActions);
      if (!actions.length) return;

      await runActions(actions, {
        navigate: (path) => navigate(path),
        setMyName: (name) => setDisplayName({ name }),
        // Both of these go to the server, which is where the audience tiers and
        // who-is-actually-in-this-family are decided — the page is only the
        // hands that carry the action there.
        createEvent: (draft) => createEvent(draft),
        planShopping: (draft) => planShopping(draft),
        onProblem: setProblem,
      });
    },
    [navigate, setDisplayName, createEvent, planShopping],
  );

  return { run, problem, setProblem };
}

/**
 * Alert on messages the rest of the family sends: buzz, chime and a system
 * notification, each governed by the Control Room switches.
 */
function useMessageAlerts(messages: ChatMessage[]) {
  const seen = useRef<Set<string> | null>(null);

  useEffect(() => {
    // The first load is history, not news — remember it and stay quiet.
    if (seen.current === null) {
      seen.current = new Set(messages.map((message) => message.id));
      return;
    }

    const known = seen.current;
    const fresh = messages.filter((message) => !known.has(message.id));
    if (!fresh.length) return;
    for (const message of fresh) known.add(message.id);

    const incoming = fresh.filter(
      (message) => !message.mine && message.role !== "assistant",
    );
    if (!incoming.length) return;

    const last = incoming[incoming.length - 1];
    buzz();
    chime();
    void notifyMessage(last.authorName ?? "Family", last.text);
  }, [messages]);
}

function formatDue(dueAt: number) {
  return new Date(dueAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Two halves, one screen. The input takes one half and the result the other:
 * stacked top and bottom when there is no room for two columns, side by side
 * when there is, and the switch button flips which pane is on which side.
 *
 * What decides that is the width of this box, not the width of the window.
 * A window breakpoint asks the wrong question: the app can be sitting in a
 * narrow frame on a wide screen, and then a window breakpoint calls it a phone
 * and stacks the panes no matter how big the screen is. Asking the box itself
 * gets it right everywhere — a phone, a laptop, or a preview pane.
 */
function SplitScreen({
  swapped,
  input,
  preview,
}: {
  swapped: boolean;
  input: ReactNode;
  preview: ReactNode;
}) {
  return (
    <div className="@container h-full min-h-0">
      <div
        className={cn(
          "flex h-full min-h-0 gap-3",
          swapped
            ? "flex-col-reverse @2xl:flex-row-reverse"
            : "flex-col @2xl:flex-row",
        )}
      >
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{input}</div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{preview}</div>
      </div>
    </div>
  );
}

/** Swaps which half the input sits in, on both the phone and the desktop. */
function SwapSidesButton({
  swapped,
  onSwap,
}: {
  swapped: boolean;
  onSwap: () => void;
}) {
  return (
    <Button
      type="button"
      size="icon-sm"
      variant="ghost"
      onClick={onSwap}
      aria-label="Switch sides"
      aria-pressed={swapped}
      title={swapped ? "Put the input back" : "Switch sides"}
      className="shrink-0 text-muted-foreground hover:text-foreground"
    >
      <ArrowLeftRight className="size-3.5" />
    </Button>
  );
}

/** The big microphone both AI boxes carry. */
function BigMicButton({
  on,
  canListen,
  onToggle,
}: {
  on: boolean;
  canListen: boolean;
  onToggle: () => void;
}) {
  return (
    <Button
      type="button"
      size="icon-lg"
      variant="ghost"
      onClick={onToggle}
      disabled={!canListen}
      aria-pressed={on}
      aria-label={on ? "Turn the microphone off" : "Turn the microphone on"}
      title={
        canListen
          ? on
            ? "Turn the microphone off"
            : "Talk to it out loud"
          : "This browser cannot listen. Chrome or Edge can."
      }
      className={cn(
        "shrink-0 rounded-xl",
        on
          ? "bg-white text-black hover:bg-white/85"
          : "bg-white/10 text-white hover:bg-white/15",
      )}
    >
      {on ? <Mic className="size-5" /> : <MicOff className="size-5" />}
    </Button>
  );
}

/* ------------------------------------------------------------ ai builder */

function BuilderBox() {
  const { messages, thinking, error, sendMessage, clearRoom, aiReady } =
    useChat("builder");
  const { run, problem, setProblem } = useAgentActions();

  const [dictating, setDictating] = useState(false);
  const [working, setWorking] = useState(false);

  const busy = thinking || working;

  const handleSend = useCallback(
    async (text: string) => {
      setProblem(null);
      setWorking(true);
      const result = await sendMessage(text);
      setWorking(false);
      // The builder can act on the app as well as answer in code.
      if (result?.ok) await run(result.actions);
    },
    [run, sendMessage, setProblem],
  );

  const {
    supported: canListen,
    listening,
    interim,
    error: micError,
  } = useDictation({
    active: dictating,
    muted: busy,
    onFinal: (text) => {
      void handleSend(text);
    },
  });

  const aiOffline = aiReady === false;
  const [swapped, setSwapped] = useState(false);

  const inputPanel = (
    <MessagePanel
      title="AI Builder"
      subtitle="Say what you want made — this side is the conversation"
      icon={Hammer}
      accent={MONO}
      placeholder="Describe what you want to build…"
      emptyTitle="Nothing said yet"
      emptyHint="Say what you want made. The back-and-forth stays here; what it builds goes to the Preview."
      status={
        aiOffline
          ? "Not connected"
          : dictating
            ? "Listening"
            : thinking
              ? "Working"
              : "Idle"
      }
      room="builder"
      messages={messages}
      onSend={handleSend}
      onClear={clearRoom}
      thinking={busy}
      notice={error ?? problem ?? micError ?? (aiOffline ? NO_KEY_NOTICE : null)}
      inputLeading={
        <BigMicButton
          on={dictating}
          canListen={canListen}
          onToggle={() => setDictating((on) => !on)}
        />
      }
      footer={
        dictating ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-border/60 px-4 py-2 text-[9px] leading-4 text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  !busy && listening ? "bg-white" : "bg-white/30",
                )}
              />
              {busy ? "Working…" : listening ? "Listening…" : "Paused"}
            </span>
            {interim ? (
              <span className="truncate text-foreground/70 italic">
                {interim}
              </span>
            ) : null}
          </div>
        ) : null
      }
    />
  );

  return (
    <SplitScreen
      swapped={swapped}
      input={inputPanel}
      preview={
        <>
          <PreviewPanel
            title="Preview"
            subtitle="What it is doing, and the code, documents and apps it makes"
            icon={Hammer}
            accent={MONO}
            room="builder"
            onClear={clearRoom}
            messages={messages}
            thinking={busy}
            emptyTitle="Nothing built yet"
            emptyHint="Describe an idea and everything it produces lands here — the chat keeps the conversation."
            headerAction={
              <SwapSidesButton
                swapped={swapped}
                onSwap={() => setSwapped((side) => !side)}
              />
            }
          />

          {/* Its own box, under the preview: the hub's live connection. */}
          <ConnectionPanel />
        </>
      }
    />
  );
}

/* --------------------------------------------------------- ai assistant */

function AssistantBox() {
  const { messages, thinking, error, sendMessage, clearRoom, aiReady } =
    useChat("assistant");
  const { run, problem, setProblem } = useAgentActions();
  const { values: deviceSettings } = useSettings();
  const { resolved: voice } = useVoice();

  const {
    speak,
    speaking,
    stop: stopSpeaking,
    supported: canTalk,
  } = useSpeechSynthesis({
    enabled: !(deviceSettings.silence ?? false),
    resolved: voice,
  });

  const [handsFree, setHandsFree] = useState(false);
  const [working, setWorking] = useState(false);

  const busy = thinking || working;

  const handleSend = useCallback(
    async (text: string) => {
      setProblem(null);
      setWorking(true);
      const result = await sendMessage(text);
      setWorking(false);

      if (!result?.ok) return;

      if (handsFree && canTalk) speak(result.say);
      await run(result.actions);
    },
    [canTalk, handsFree, run, sendMessage, setProblem, speak],
  );

  const onReminderDue = useCallback(
    (reminder: Reminder) => {
      const title = reminder.kind === "timer" ? "Timer finished" : "Reminder";
      void sendNotification(title, reminder.text);
      if (canTalk) speak(`${title}. ${reminder.text}`);
      setProblem(`${title}: ${reminder.text}`);
    },
    [canTalk, speak, setProblem],
  );

  const reminders = useReminders({ onDue: onReminderDue });

  // Pause the microphone while the model is working or talking, so it never
  // hears itself and never sends the same sentence twice.
  const {
    supported: canListen,
    listening,
    interim,
    error: micError,
  } = useDictation({
    active: handsFree,
    muted: speaking || busy,
    onFinal: (text) => {
      void handleSend(text);
    },
  });

  const toggleHandsFree = () => {
    setHandsFree((on) => {
      if (on) stopSpeaking();
      return !on;
    });
  };

  const nextReminder = reminders[0] ?? null;
  const voiceState = !handsFree
    ? canListen
      ? "Hands-free off"
      : "This browser cannot listen"
    : speaking
      ? "Speaking…"
      : busy
        ? "Working…"
        : listening
          ? "Listening…"
          : "Paused";

  const aiOffline = aiReady === false;
  const [swapped, setSwapped] = useState(false);

  const inputPanel = (
    <MessagePanel
      title="AI Assistant"
      subtitle={
        handsFree
          ? "Hands-free — this side is the conversation"
          : "Ask anything — this side is the conversation"
      }
      icon={Church}
      accent={MONO}
      placeholder={
        handsFree
          ? "Listening — or type it here…"
          : "Ask your assistant anything…"
      }
      emptyTitle="Nothing said yet"
      emptyHint="Tap the microphone and just talk. It can look things up, run code, open things, set timers, and ask the AI Builder for help."
      status={
        aiOffline
          ? "Not connected"
          : handsFree
            ? "Hands-free"
            : busy
              ? "Thinking"
              : "Ready"
      }
      room="assistant"
      messages={messages}
      onSend={handleSend}
      onClear={clearRoom}
      thinking={busy}
      notice={
        problem ?? micError ?? error ?? (aiOffline ? NO_KEY_NOTICE : null)
      }
      inputLeading={
        <BigMicButton
          on={handsFree}
          canListen={canListen}
          onToggle={toggleHandsFree}
        />
      }
      footer={
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-border/60 px-4 py-2 text-[9px] leading-4 text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span
              className={cn(
                "size-1.5 rounded-full",
                handsFree && !speaking && !busy ? "bg-white" : "bg-white/30",
              )}
            />
            {voiceState}
          </span>

          {!canTalk ? <span>No voice output in this browser</span> : null}

          {interim ? (
            <span className="truncate text-foreground/70 italic">
              {interim}
            </span>
          ) : null}

          {nextReminder ? (
            <span className="ml-auto flex items-center gap-1.5 truncate">
              <Timer className="size-3" />
              {nextReminder.kind === "timer" ? "Timer" : "Reminder"}:{" "}
              {nextReminder.text} · {formatDue(nextReminder.dueAt)}
            </span>
          ) : null}
        </div>
      }
    />
  );

  return (
    <SplitScreen
      swapped={swapped}
      input={inputPanel}
      preview={
        <>
          <PreviewPanel
            title="Preview"
            subtitle="Its thinking, and what it produces"
            icon={Church}
            accent={MONO}
            room="assistant"
            onClear={clearRoom}
            messages={messages}
            thinking={busy}
            emptyTitle="Nothing to show yet"
            emptyHint="Ask something and what it looked at, ran and produced lands here."
            headerAction={
              <SwapSidesButton
                swapped={swapped}
                onSwap={() => setSwapped((side) => !side)}
              />
            }
          />

          {/* Its own box, under the preview: the hub's live connection. */}
          <ConnectionPanel />
        </>
      }
    />
  );
}

/* ------------------------------------------------------------- messenger */

/**
 * The one page: the family's video room and the family's chat.
 *
 * The four always-open portals sit beside the transcript, so this page holds
 * the roster, the group video room and the conversation at once — and a video
 * call fills the room without taking the chat away.
 */
function MessengerBox() {
  const { messages, thinking, error, sendMessage, clearRoom } =
    useChat("messenger");
  useMessageAlerts(messages);
  const family = useQuery(api.family.mine);
  const call = useCallStage();
  const [focusSignal, setFocusSignal] = useState(0);
  const [inviteOpen, setInviteOpen] = useState(false);
  // The call test opens right here, so the messenger stays the one page.
  const [testOpen, setTestOpen] = useState(false);

  const info = family?.family ?? null;
  const members = family?.members ?? [];
  // Someone else being around is what makes the room live.
  const anyoneElseOnline = members.some(
    (member) => member.online && !member.isMe,
  );
  // While a video call is up, the room's four portals take the bigger half.
  const onVideoCall =
    call?.kind === "video" && call.current?.myState === "joined";

  return (
    <div className="@container flex h-full min-h-0 flex-col gap-3">
      <div className="flex min-h-0 flex-1 flex-col gap-3 @2xl:flex-row">
        {/* The room: everyone in the family, and the video stage once you are
            on a call. A ringing conference is answered right here. */}
        <div
          className={cn(
            "flex min-h-0 min-w-0 flex-col",
            onVideoCall ? "flex-1 @2xl:flex-[1.6]" : "flex-1",
          )}
        >
          <ConferenceRoom />
        </div>

        {/* The transcript — the room the family has always had. */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <MessagePanel
            title="Messenger"
            subtitle={info ? "Only your family can read this" : undefined}
            icon={MessageCircle}
            accent={MONO}
            placeholder={
              info ? "Message your family…" : "Join a family to chat…"
            }
            status={anyoneElseOnline ? "Online" : "Offline"}
            room="messenger"
            messages={messages}
            onSend={sendMessage}
            onClear={clearRoom}
            onAdd={() => setInviteOpen(true)}
            thinking={thinking}
            notice={error ?? null}
            focusSignal={focusSignal}
            headerAction={
              <MessengerCall
                members={members}
                onMessage={() => setFocusSignal((count) => count + 1)}
                onTest={() => setTestOpen(true)}
              />
            }
          />
        </div>
      </div>

      <AddContactDialog open={inviteOpen} onOpenChange={setInviteOpen} />

      {/* The call test lives in the messenger, not on a page of its own. */}
      <Dialog open={testOpen} onOpenChange={setTestOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="text-[13px]">Call test</DialogTitle>
            <DialogDescription className="text-[11px] leading-4">
              Check this device, then the server, then a real second device.
            </DialogDescription>
          </DialogHeader>
          <div className="h-[70vh] overflow-hidden">
            <CallTest />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** One box, filling the page below the nav. */
export default function BoxPage({ box }: { box: BoxKey }) {
  if (box === "assistant") return <AssistantBox />;
  if (box === "messenger") return <MessengerBox />;
  return <BuilderBox />;
}
