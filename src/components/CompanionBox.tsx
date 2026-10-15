import { Button } from "@/components/ui/button";
import { useCompanion, type CompanionLine } from "@/hooks/use-companion";
import { useScreenReport } from "@/hooks/use-screen-report";
import { AssistantIcon } from "@/lib/assistant-mark";
import { cn } from "@/lib/utils";
import {
  Bell,
  Lightbulb,
  Loader2,
  Mic,
  MicOff,
  Send,
  Trash2,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

/**
 * The little box that follows the person around.
 *
 * It is mounted once, in the signed-in shell, so it is on every page of the hub
 * at the same time — the browser, the calendar, the messenger, the Control Room
 * — and it stays there while they move. What it shows is one column: what they
 * said, what the model said back, and the things the hub noticed by itself
 * (a timer that has gone off, a reminder that has come due).
 *
 * Its mark is the assistant's own, read from one place
 * (`src/lib/assistant-mark.ts`), so the little box and the AI Assistant page it
 * belongs to are visibly the same thing rather than two that resemble each
 * other.
 *
 * Nothing here reaches the model on its own. The typing, the timers and the
 * voice commands are all handled on the device — and spelling is not even that,
 * it is the browser's own checker in whatever field is being typed in, with
 * nothing about it said here; a model call
 * happens when a question is actually asked, or when the companion has been
 * invited to offer one line about the page in front of them.
 */

/** A line's words, with any web address in it made pressable. */
function Words({ text }: { text: string }) {
  // Split so the addresses are kept, not dropped: the companion is told to give
  // a link plainly when what it found has a page, and a link nobody can press
  // is only half an answer.
  const parts = useMemo(
    () => text.split(/(https?:\/\/[^\s<>()"']+)/g).filter(Boolean),
    [text],
  );

  return (
    <>
      {parts.map((part, index) =>
        /^https?:\/\//.test(part) ? (
          <a
            key={`${index}-${part}`}
            href={part.replace(/[.,;:]+$/, "")}
            target="_blank"
            rel="noopener noreferrer"
            className="break-all underline decoration-dotted underline-offset-2 hover:opacity-80"
          >
            {part}
          </a>
        ) : (
          <span key={`${index}-${part.slice(0, 12)}`}>{part}</span>
        ),
      )}
    </>
  );
}

/** One line, drawn the way it is meant to be read. */
function Line({ line }: { line: CompanionLine }) {
  if (line.mine) {
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] rounded-2xl rounded-br-sm bg-white/15 px-2.5 py-1.5 text-[11px] leading-4 text-foreground">
          <Words text={line.text} />
        </p>
      </div>
    );
  }

  if (line.kind === "alert" || line.kind === "note") {
    return (
      <p className="flex items-start gap-1.5 rounded-xl border border-border/50 bg-white/[0.04] px-2.5 py-2 text-[11px] leading-4 text-muted-foreground">
        <Bell className="mt-0.5 size-3 shrink-0 text-foreground/60" />
        <span>
          <Words text={line.text} />
        </span>
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-0.5">
      <p className="max-w-[95%] rounded-2xl rounded-bl-sm bg-white/[0.07] px-2.5 py-2 text-[11px] leading-4 text-foreground">
        <Words text={line.text} />
      </p>
      {line.note ? (
        <span className="pl-2 text-[9px] text-muted-foreground">
          {line.note}
        </span>
      ) : null}
    </div>
  );
}

/** A small round control in the box's header. */
function Tool({
  label,
  on,
  onClick,
  children,
}: {
  label: string;
  on?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        "grid size-6 cursor-pointer place-items-center rounded-lg border transition-colors",
        on
          ? "border-white/25 bg-white/15 text-foreground"
          : "border-transparent text-muted-foreground hover:bg-white/10 hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

export function CompanionBox() {
  const box = useCompanion();
  const [typing, setTyping] = useState("");

  // The page describes itself from here, because this is the one component that
  // is on every page at once.
  useScreenReport();

  const listRef = useRef<HTMLDivElement>(null);

  // Follow the conversation: the newest line is the one being talked about.
  useEffect(() => {
    const node = listRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [box.lines.length, box.thinking, box.open]);

  const send = (text: string) => {
    const said = text.trim();
    if (!said) return;
    setTyping("");
    void box.ask(said);
  };

  // Hands-free switched on in a browser with no speech recognition is not
  // listening, and saying so would be a lie told by a light. The switch is
  // still honoured — it is remembered, and a device that can hear will hear —
  // but nothing here claims to be hearing this one.
  const listening = box.handsFree && box.micSupported;

  // What the header says under the name: what it is doing when it is doing
  // something, and otherwise where it believes they are.
  const here = box.screen;
  const where = here?.title ?? here?.path ?? null;
  const status = box.speaking
    ? "speaking"
    : box.thinking
      ? "thinking…"
      : listening
        ? "listening"
        : box.handsFree
          ? "hands-free: this browser cannot hear"
          : where;

  /* Closed: just the bubble, with a count of anything not read yet. */
  if (!box.open) {
    return (
      <button
        type="button"
        onClick={box.openBox}
        aria-label="Open the companion"
        title="The companion — ask me anything, or turn on hands-free"
        className="fixed right-3 bottom-3 z-50 grid size-11 cursor-pointer place-items-center rounded-full border border-white/15 bg-popover/95 text-foreground shadow-2xl backdrop-blur transition-transform hover:scale-105"
        style={{ bottom: "calc(0.75rem + env(safe-area-inset-bottom, 0px))" }}
      >
        <AssistantIcon
          className={cn("size-5", box.thinking && "animate-pulse")}
        />

        {listening ? (
          <span className="absolute -top-0.5 -right-0.5 flex size-3 items-center justify-center">
            <span className="absolute size-3 animate-ping rounded-full bg-emerald-400/70" />
            <span className="size-2 rounded-full bg-emerald-400" />
          </span>
        ) : null}

        {box.unread > 0 ? (
          <span className="absolute -top-1 -left-1 grid min-w-4 place-items-center rounded-full bg-white px-1 text-[9px] font-semibold text-black">
            {box.unread > 9 ? "9+" : box.unread}
          </span>
        ) : null}
      </button>
    );
  }

  return (
    <section
      aria-label="Companion"
      // Touching it or typing into it counts as having seen what is in it, so
      // the badge clears on attention rather than on a timer.
      onPointerDown={box.markSeen}
      onFocus={box.markSeen}
      className="fixed right-3 z-50 flex h-[min(30rem,72vh)] w-[min(25rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-2xl border border-border/70 bg-popover/95 shadow-2xl backdrop-blur"
      style={{ bottom: "calc(0.75rem + env(safe-area-inset-bottom, 0px))" }}
    >
      {/* Where they are, and what it is doing — plus the four controls that
          matter: read it out, offer hints, listen, and close. */}
      <header className="flex shrink-0 items-center gap-1.5 border-b border-border/60 px-2.5 py-2">
        <span className="grid size-6 shrink-0 place-items-center rounded-lg bg-white/10">
          <AssistantIcon className="size-3.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[11px] font-medium leading-4">
            Companion
          </span>
          <span className="block truncate text-[9px] leading-3 text-muted-foreground">
            {status ?? "here, on every page"}
          </span>
        </span>

        {box.speak ? (
          <Tool
            label={
              box.speakReplies ? "Stop reading answers out" : "Read answers out"
            }
            on={box.speakReplies}
            onClick={() => box.setSpeakReplies(!box.speakReplies)}
          >
            {box.speakReplies ? (
              <Volume2 className="size-3.5" />
            ) : (
              <VolumeX className="size-3.5" />
            )}
          </Tool>
        ) : null}

        <Tool
          label={
            box.hintsOn
              ? "Stop offering hints as I work"
              : "Offer hints as I work"
          }
          on={box.hintsOn}
          onClick={() => box.setHintsOn(!box.hintsOn)}
        >
          <Lightbulb className="size-3.5" />
        </Tool>

        {box.micSupported ? (
          <Tool
            label={
              box.handsFree
                ? "Hands-free is on — switch the microphone off"
                : "Hands-free: leave the microphone open wherever I go"
            }
            on={box.handsFree}
            onClick={() => box.setHandsFree(!box.handsFree)}
          >
            {box.handsFree ? (
              <Mic className="size-3.5" />
            ) : (
              <MicOff className="size-3.5" />
            )}
          </Tool>
        ) : null}

        <Tool label="Empty the box" onClick={box.clear}>
          <Trash2 className="size-3.5" />
        </Tool>
        <Tool label="Close" onClick={box.closeBox}>
          <X className="size-3.5" />
        </Tool>
      </header>

      {/* The column: everything said, and everything noticed. */}
      <div
        ref={listRef}
        className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2.5 py-2.5"
      >
        {box.lines.length === 0 ? (
          <div className="px-1 py-3 text-[10px] leading-4 text-muted-foreground">
            <p className="text-[11px] text-foreground">
              I am here, on every page.
            </p>
            <p className="mt-1">
              Ask about what you are looking at, get a word looked up, a price
              found, a timer set — or press the microphone and just say it. With
              hands-free on I stay listening wherever you go, and I will speak
              up on my own when something is genuinely worth hearing.
            </p>
            {!box.aiReady ? (
              <p className="mt-2">
                No AI system is set up yet, so only the parts that need no key
                work: timers and the voice commands. The Control Room takes a
                key.
              </p>
            ) : null}
          </div>
        ) : null}

        {box.lines.map((line) => (
          <Line key={line.id} line={line} />
        ))}

        {box.thinking ? (
          <p className="flex items-center gap-1.5 px-1 text-[9px] text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            thinking…
          </p>
        ) : null}
      </div>

      {box.error || box.problem || box.micError ? (
        <p className="shrink-0 border-t border-border/60 px-2.5 py-1.5 text-[9px] leading-3 text-destructive">
          {box.micError ?? box.problem ?? box.error}
        </p>
      ) : null}

      {/* What it is hearing, as it hears it. */}
      {listening ? (
        <p className="flex shrink-0 items-center gap-1.5 border-t border-border/60 px-2.5 py-1.5 text-[9px] text-muted-foreground">
          <span className="relative flex size-1.5 shrink-0">
            <span className="absolute inline-flex size-1.5 animate-ping rounded-full bg-emerald-400/70" />
            <span className="relative inline-flex size-1.5 rounded-full bg-emerald-400" />
          </span>
          <span className="truncate">
            {box.interim
              ? `“${box.interim}”`
              : "Hands-free is on — say “open the calendar”, “stop listening”, or ask me anything."}
          </span>
        </p>
      ) : null}

      <div className="shrink-0 border-t border-border/60 px-2.5 py-2">
        {/* The three things said most often, so they are one press away. */}
        <div className="mb-1.5 flex flex-wrap gap-1">
          {[
            "What is this page for?",
            "What should I do next?",
            "Open the calendar",
          ].map((chip) => (
            <button
              key={chip}
              type="button"
              onClick={() => send(chip)}
              className="cursor-pointer rounded-full border border-border/60 px-2 py-0.5 text-[9px] text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground"
            >
              {chip}
            </button>
          ))}
        </div>

        <div className="flex items-end gap-1.5">
          <textarea
            value={typing}
            onChange={(event) => setTyping(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                send(typing);
              }
            }}
            rows={1}
            placeholder="Ask me anything about what you are doing…"
            aria-label="Ask the companion"
            className="max-h-24 min-h-8 flex-1 resize-none rounded-xl border border-border/60 bg-background/60 px-2.5 py-1.5 text-[11px] leading-4 outline-none placeholder:text-muted-foreground focus:border-white/30"
          />

          {box.micSupported ? (
            <Button
              type="button"
              size="icon-sm"
              variant="outline"
              aria-label={
                box.handsFree ? "Turn hands-free off" : "Turn hands-free on"
              }
              title={
                box.handsFree
                  ? "Hands-free is on — the microphone stays open wherever you go"
                  : "Hands-free — keep listening wherever I go"
              }
              className={cn(
                "size-8 shrink-0 cursor-pointer rounded-xl",
                box.handsFree && "border-emerald-400/50 bg-emerald-400/15",
              )}
              onClick={() => box.setHandsFree(!box.handsFree)}
            >
              {box.handsFree ? (
                <Mic className="size-3.5" />
              ) : (
                <MicOff className="size-3.5" />
              )}
            </Button>
          ) : null}

          <Button
            type="button"
            size="icon-sm"
            aria-label="Send"
            title="Send"
            disabled={!typing.trim() || box.thinking}
            className="size-8 shrink-0 cursor-pointer rounded-xl bg-white text-black hover:bg-white/85"
            onClick={() => send(typing)}
          >
            <Send className="size-3.5" />
          </Button>
        </div>
      </div>
    </section>
  );
}

export default CompanionBox;
