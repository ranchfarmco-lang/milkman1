import { AddContactDialog } from "@/components/AddContactDialog";
import {
  BuilderAppsPanel,
  BuilderSandboxPreview,
} from "@/components/BuilderApps";
import { BuilderBuildLog } from "@/components/BuilderBuildLog";
import { BuilderCrewPanel } from "@/components/BuilderCrewPanel";
import { BuilderWorkbench } from "@/components/BuilderWorkbench";
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
import { useAgentActions } from "@/hooks/use-agent-actions";
import { useAppRunner } from "@/hooks/use-app-runner";
import { useChat } from "@/hooks/use-chat";
import { useDictation, useSpeechSynthesis } from "@/hooks/use-speech";
import { useStudioVoice } from "@/hooks/use-studio-voice";
import { useSettings } from "@/hooks/use-settings";
import { useVoice } from "@/hooks/use-voice";
import { buzz, chime, notifyMessage } from "@/lib/alerts";
import { AssistantIcon } from "@/lib/assistant-mark";
import { cn } from "@/lib/utils";
import { useQuery } from "convex/react";
import {
  ArrowDown,
  ArrowLeftRight,
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

/**
 * The chain between the boxes, said once rather than four times.
 *
 * The AI Builder page is read top to bottom as one job: a request goes in, the
 * build is watched, the app is run and tested, and it is kept until it is
 * finished. These little steps between the boxes are what makes that a chain
 * rather than a stack — each one names the next box and scrolls to it, so the
 * flow is visible and navigable at the same time.
 */
function ChainStep({ to, children }: { to: string; children: ReactNode }) {
  return (
    <div className="flex justify-center">
      <a
        href={`#${to}`}
        className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/40 px-2.5 py-1 text-[9px] text-muted-foreground transition-colors hover:border-white/30 hover:text-foreground"
      >
        <ArrowDown className="size-3 shrink-0" />
        {children}
      </a>
    </div>
  );
}

function BuilderBox() {
  // Which app is in the sandbox frame — one fact, read by the home screen's
  // icons and by the preview box below, so pressing an icon and the frame are
  // the same state rather than two that can disagree.
  const runner = useAppRunner();

  return (
    /*
     * The whole AI Builder page, as five boxes with one job each — and one
     * chain through them, in the order the work happens.
     *
     * There used to be eight boxes, and several of them answered the same
     * question: a chat that asked the AI for things beside a brief that built
     * them, a "what it made" preview beside the sandbox that runs the app, a
     * shelf of cards with a full toolbar each above a bench that listed the
     * same apps again — and the two boxes that had to agree about what was
     * running were the two most likely to disagree. Now:
     *
     *   1. **AI app builder (prompt studio)** — where it starts: the one request
     *      box, the agent behind it, and the conversation. A brief goes in, the
     *      crew works, the reply is written into the box's own thread, and every
     *      request after the first is a *change* to the app on the bench.
     *   2. **Build Code Log** — what is happening while it happens: every line
     *      the crew writes and everything the sandbox printed, with the name of
     *      the app on the bench, a jump to the preview, and Stop for the run.
     *   3. **Preview & Test Sandbox** — run it and test it, and change this app
     *      itself: the box holds two things and says which with a switch.
     *      **Apps it made** is the app itself, running — run, refresh, device
     *      view, a real element inspector, full screen; what the build reported
     *      is said here too, with a link back to the log that said it, and an
     *      element picked in the frame can be handed straight to the prompt box
     *      above as "change this". **This app — its mirror** is the hub itself:
     *      a copy of this whole project on the workshop machine, where a change
     *      to the hub is written, typechecked and built before anybody carries
     *      it in. Two jobs, one sandbox, because both of them happen here.
     *   4. **Saved Projects** — where every build waits: run it, edit it, hand-
     *      edit its files, or Publish to Home Screen.
     *   5. **App icons** — the home screen, at the end because that is where the
     *      chain ends: rounded squares with a logo and a name, the way a phone
     *      holds its apps. Pressing one launches it in the preview above.
     *
     * The order is the flow, and the little steps between the boxes (and the
     * numbered strip at the top) are what say so: each names the next box and
     * scrolls to it. Nothing here is decoration — pressing an icon really does
     * put that app in the frame above, the log really is the run that the
     * prompt box started, and the preview really is the app the run published.
     *
     * The page is long on purpose, and the whole page scrolls. Every box is
     * given a real height of its own rather than sharing the viewport with the
     * others: when six boxes were fitted into one screen each of them got a
     * sliver and a scrollbar of its own, and the box that needs the most room —
     * the sandbox a built app runs in — got the least. Scrolling down is
     * cheaper than a preview too small to see.
     *
     * The sandbox and Saved Projects sit side by side only when the box is
     * genuinely wide enough for two columns; below that they stack, full width.
     * The decision is this container's own rather than the window's: the page
     * can be sitting in a narrow frame on a wide screen, and a window breakpoint
     * would call that a phone.
     */
    <div className="@container flex h-full min-h-0 flex-col gap-4 overflow-y-auto">
      {/* The chain, in one line, before anything else: what the page does, in
          the order it does it. Each chip is a link to its box. */}
      <nav
        aria-label="How the AI Builder page works"
        className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-2xl border border-white/20 bg-card/60 px-3 py-2 text-[9px] text-muted-foreground backdrop-blur-sm"
      >
        {[
          ["1", "builder-studio", "Ask"],
          ["2", "builder-log", "Watch"],
          ["3", "builder-preview", "Run it, test it, or change this app"],
          ["4", "builder-projects", "Keep"],
          ["5", "builder-apps", "Publish"],
        ].map(([step, id, label], index) => (
          <span key={id} className="flex items-center gap-1.5">
            {index > 0 ? (
              <span className="text-muted-foreground/50">→</span>
            ) : null}
            <a
              href={`#${id}`}
              className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background/40 px-2 py-0.5 transition-colors hover:border-white/30 hover:text-foreground"
            >
              <span className="font-medium text-foreground/80">{step}</span>
              {label}
            </a>
          </span>
        ))}
        <span className="ml-auto hidden @3xl:inline">
          one request · the live build · the app running · what is kept · what
          is finished
        </span>
      </nav>

      {/* 1 — The prompt studio: one brief, one press, and the crew goes to
          work. The only place a request is put in on this page, and where the
          answering happens. */}
      <BuilderCrewPanel runner={runner} />

      {/* The hand-off to the box that shows the work. */}
      <ChainStep to="builder-log">
        the crew writes here, and the log below shows every step as it happens
      </ChainStep>

      {/* 2 — The log: what the crew is doing as it does it, and what the
          sandbox said about what they wrote. A terminal wants width, so it
          takes the whole row. */}
      <div className="flex h-[18rem] min-h-0 shrink-0 flex-col @3xl:h-[22rem]">
        <BuilderBuildLog />
      </div>

      {/* The hand-off to the app itself, and to the other half of the page:
          the same sandbox holds this project's own copy, and its switch is how
          a change to the hub is asked for, checked and carried in. */}
      <ChainStep to="builder-preview">
        what it built, running — press Run there, or an icon at the bottom.
        Switch it to “This app — its mirror” to change the hub itself, in a copy
        of it
      </ChainStep>

      {/* 3 and 4 — where it runs, and where it waits until it is ready. The
          sandbox takes the room it needs and grows with the screen; Saved
          Projects is a definite column, because a file tree wants the height. */}
      <div className="flex flex-col gap-4 @6xl:flex-row @6xl:items-stretch">
        <div className="flex h-[34rem] min-h-0 min-w-0 flex-col @6xl:h-[48rem] @6xl:flex-1">
          <BuilderSandboxPreview runner={runner} />
        </div>

        <div className="flex h-[34rem] min-h-0 min-w-0 flex-col @6xl:h-[48rem] @6xl:w-[30rem] @6xl:shrink-0">
          <BuilderWorkbench runner={runner} />
        </div>
      </div>

      {/* The hand-off to where finished apps live. */}
      <ChainStep to="builder-apps">
        finished? Publish to Home Screen, and it lands here as an icon
      </ChainStep>

      {/* 5 — The home screen: what has been made, as icons, and the way to
          launch any of it. As tall as its icons need, up to a point — past
          that it scrolls itself, so the chain above is never pushed off the
          page by a family with twenty apps. */}
      <div className="flex max-h-[32rem] min-h-0 shrink-0 flex-col overflow-y-auto @3xl:max-h-[38rem]">
        <BuilderAppsPanel runner={runner} />
      </div>
    </div>
  );
}

/* --------------------------------------------------------- ai assistant */

function AssistantBox() {
  const { messages, thinking, error, sendMessage, clearRoom, aiReady } =
    useChat("assistant");
  const { run, problem, setProblem } = useAgentActions();
  const { values: deviceSettings } = useSettings();
  const { resolved: voice } = useVoice();
  // The studio voice, if one is connected: the messenger's box speaks with the
  // same model the assistant does rather than a different-sounding engine.
  const studio = useStudioVoice();

  const {
    speak,
    speaking,
    stop: stopSpeaking,
    supported: canTalk,
  } = useSpeechSynthesis({
    enabled: !(deviceSettings.silence ?? false),
    resolved: voice,
    studio,
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

      // The assistant reads its answers out loud, exactly as the Control
      // Room's Silence switch promises to mute. Silence is handled inside
      // `speak`; hands-free only decides whether the microphone is open, so a
      // typed question is still answered in its own voice.
      if (canTalk) speak(result.say);
      await run(result.actions);
    },
    [canTalk, run, sendMessage, setProblem, speak],
  );

  // The alerts themselves are sounded app-wide by the assistant shell; here the
  // list is only read, so the next timer is shown without ringing twice.
  const reminders = useQuery(api.reminders.pending) ?? [];

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
      icon={AssistantIcon}
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
            icon={AssistantIcon}
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
