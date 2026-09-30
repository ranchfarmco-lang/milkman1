import { BoxControlBar } from "@/components/BoxControlBar";
import { TraceFeed, type FeedStep } from "@/components/TraceFeed";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ChatRoom } from "@/hooks/use-chat";
import { useTrace } from "@/hooks/use-trace";
import { splitArtifact, splitFences } from "@/lib/fences";
import { HANDOFF_EVENT, takeHandoff } from "@/lib/internal-share";
import { cn } from "@/lib/utils";
import { ArrowUp, Loader2, type LucideIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { toast } from "sonner";

export type ChatMessage = {
  id: string;
  text: string;
  mine: boolean;
  role: "user" | "assistant" | "member";
  authorName?: string | null;
  /** What the assistant actually did, in plain english. */
  note?: string | null;
  /** The thinking and the steps behind an AI reply, kept with it. */
  feed?: { by?: string | null; ms: number; steps: FeedStep[] } | null;
};

export type PanelAccent = {
  /** Icon chip on the panel header. */
  iconWrap: string;
  /** Send button. */
  send: string;
  /** Your own message bubble. */
  bubble: string;
  /** Live dot in the status pill. */
  dot: string;
};

export type MessagePanelProps = {
  title: string;
  /** Supporting line under the title. Omit it for none. */
  subtitle?: string;
  icon: LucideIcon;
  accent: PanelAccent;
  placeholder: string;
  /** Big line shown while the box is still empty. Omit it for none. */
  emptyTitle?: string;
  /** Smaller supporting line under the empty title. Omit it for none. */
  emptyHint?: string;
  status?: string;
  messages: ChatMessage[];
  onSend: (text: string) => void | Promise<unknown>;
  onClear?: () => void;
  /** Add a new thing here — the Add button in the top-right. Left out where
   *  there is nothing to add. */
  onAdd?: () => void;
  /** The model is working on a reply. */
  thinking?: boolean;
  /** Something the box needs you to know, e.g. a missing key. */
  notice?: string | null;
  /** Sits in the header, left of the status pill. */
  headerAction?: ReactNode;
  /** Sits above the input, under the transcript. */
  footer?: ReactNode;
  /** Sits inside the chat box, to the left of the text field. */
  inputLeading?: ReactNode;
  /** Bump this number to put the cursor straight into the chat box. */
  focusSignal?: number;
  /** Nothing can be sent yet, e.g. you are not in a family. */
  disabled?: boolean;
  /** Which box this is. The control bar in the top-right needs it to know where
   *  uploads land and where a share can go. Omit it and the box carries no bar. */
  room?: ChatRoom;
};

/**
 * The rule itself now lives in `@/lib/fences`, next to the preview pane that
 * needs it too. Still offered from here as well, so either import path works.
 */
export { splitFences };

/**
 * What the AI said, and nothing else. Anything it produced — code, a document,
 * a whole app — is fenced, and that half belongs in the preview pane. So the
 * chat is the conversation: the prose around the fences, with a quiet pointer
 * when a turn produced something instead of saying something.
 */
function DialogueBody({ text }: { text: string }) {
  const { dialogue, product } = useMemo(() => splitArtifact(text), [text]);

  if (!dialogue) {
    return product.length ? (
      <p className="text-[11px] italic text-muted-foreground">
        {product.length === 1 ? "1 block" : `${product.length} blocks`} in the
        Preview.
      </p>
    ) : null;
  }

  return <p className="whitespace-pre-wrap">{dialogue}</p>;
}

/**
 * How much of a half-written reply is prose.
 *
 * The code in a reply belongs to the preview pane, and while the model is still
 * writing there is no way to tell a finished fence from one that is three words
 * in. So the bubble carries the words up to the first fence and stops there: the
 * prose arrives as it is written, and the fence that follows is what the preview
 * is for. A reply that opens with code simply has nothing to stream yet.
 */
function draftingBody(text: string) {
  const fence = text.indexOf("```");
  return (fence === -1 ? text : text.slice(0, fence)).trimEnd();
}

/**
 * One of the app's panels: a header, the live transcript, and an input.
 */
export function MessagePanel({
  title,
  subtitle,
  icon: Icon,
  accent,
  placeholder,
  emptyTitle,
  emptyHint,
  status,
  messages,
  onSend,
  onClear,
  onAdd,
  thinking = false,
  notice = null,
  headerAction,
  footer,
  inputLeading,
  focusSignal,
  disabled = false,
  room,
}: MessagePanelProps) {
  const [value, setValue] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // The reply, as the model is writing it. The turn records what it says a
  // piece at a time, and the newest piece is the live one — an early remark it
  // makes before reaching for a tool is replaced by the answer that follows,
  // rather than piling up in the bubble. It only shows while the turn is
  // running: the stored message takes over the moment the reply lands.
  const trace = useTrace(room ?? "messenger");
  // The turn in this box right now: still arriving, or stopped with a reason.
  // A turn that answered has already become a message, feed and all, so it is
  // deliberately not repeated here.
  const turn =
    trace && (trace.status === "running" || trace.status === "failed")
      ? trace
      : null;
  const running = turn?.status === "running";

  const drafting = useMemo(() => {
    if (!running) return "";
    const spoken = [...(turn?.steps ?? [])]
      .reverse()
      .find((step) => step.kind === "answer");
    return spoken ? draftingBody(spoken.text) : "";
  }, [running, turn]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, thinking, drafting, turn]);

  useEffect(() => {
    if (!focusSignal) return;
    inputRef.current?.focus();
  }, [focusSignal]);

  /** Everything in this box, written out the way a person reads it back. The
   *  copy, share and download buttons in the top-right act on this. */
  const transcript = useMemo(
    () =>
      messages
        .map((message) => {
          const who =
            message.role === "assistant"
              ? "AI"
              : message.mine
                ? "Me"
                : (message.authorName ?? "Family");
          return `${who}: ${message.text}`;
        })
        .join("\n\n"),
    [messages],
  );

  /** Put pasted clipboard text straight into the chat box. */
  const pasteIntoInput = useCallback((clipped: string) => {
    setValue((current) =>
      current.trim() ? `${current.trim()} ${clipped.trim()}` : clipped.trim(),
    );
    inputRef.current?.focus();
  }, []);

  /** A share sent from another box arrives here, waiting in the input. */
  useEffect(() => {
    if (!room) return;

    const take = () => {
      const incoming = takeHandoff(room);
      if (!incoming) return;
      pasteIntoInput(incoming);
      toast.success("Shared into this box — send it when you are ready.");
    };

    take();
    window.addEventListener(HANDOFF_EVENT, take);
    return () => window.removeEventListener(HANDOFF_EVENT, take);
  }, [pasteIntoInput, room]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (disabled) return;
    const text = value.trim();
    if (!text) return;
    setValue("");
    void onSend(text);
  };

  const isEmpty = messages.length === 0 && !thinking;

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-border/70 bg-card/70 backdrop-blur-sm">
      <header className="flex flex-wrap items-center gap-3 border-b border-border/60 px-4 py-2.5">
        <span
          className={cn(
            "grid size-9 shrink-0 place-items-center rounded-xl",
            accent.iconWrap,
          )}
        >
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[12px] font-semibold tracking-tight">
            {title}
          </h2>
          {subtitle ? (
            <p className="truncate text-[10px] text-muted-foreground">
              {subtitle}
            </p>
          ) : null}
        </div>
        {headerAction}
        {status ? (
          <span className="hidden shrink-0 items-center gap-1.5 rounded-full border border-border/60 bg-background/40 px-2 py-0.5 text-[9px] font-medium text-muted-foreground sm:inline-flex">
            <span className={cn("size-1.5 rounded-full", accent.dot)} />
            {status}
          </span>
        ) : null}
        {room ? (
          <BoxControlBar
            label={title}
            room={room}
            text={transcript}
            onClear={onClear}
            onAdd={onAdd}
            onPaste={disabled ? undefined : pasteIntoInput}
            onPasteFallback={
              disabled ? undefined : () => inputRef.current?.focus()
            }
            className="ml-auto"
          />
        ) : null}
      </header>

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
        aria-live="polite"
      >
        {isEmpty ? (
          emptyTitle || emptyHint ? (
            <div className="flex h-full flex-col items-center justify-center px-2 text-center">
              <span
                className={cn(
                  "grid size-11 place-items-center rounded-2xl border border-dashed border-border/80",
                  accent.iconWrap,
                )}
              >
                <Icon className="size-5" />
              </span>
              {emptyTitle ? (
                <p className="mt-3 text-[12px] font-medium">{emptyTitle}</p>
              ) : null}
              {emptyHint ? (
                <p className="mt-1 max-w-[24ch] text-[10px] leading-4 text-muted-foreground">
                  {emptyHint}
                </p>
              ) : null}
            </div>
          ) : null
        ) : (
          <ul className="flex flex-col gap-3">
            {messages.map((message) => (
              <li
                key={message.id}
                className={cn(
                  "flex flex-col",
                  message.mine ? "items-end" : "items-start",
                )}
              >
                {!message.mine ? (
                  <span className="mb-0.5 px-1 text-[9px] font-medium text-muted-foreground">
                    {message.role === "assistant"
                      ? "AI"
                      : (message.authorName ?? "Family")}
                  </span>
                ) : null}
                <div
                  className={cn(
                    "max-w-[90%] rounded-2xl px-3 py-2 text-sm leading-5",
                    message.mine
                      ? cn("rounded-br-md", accent.bubble)
                      : "rounded-bl-md border border-border/60 bg-background/50",
                  )}
                >
                  {message.role === "assistant" ? (
                    <DialogueBody text={message.text} />
                  ) : (
                    <p className="whitespace-pre-wrap">{message.text}</p>
                  )}
                </div>

                {/* Which system actually wrote this. The hub asks several, in
                    order, and the one that answered is a fact about the reply
                    — so it is said here rather than only inside the working,
                    where it would be folded away by default. */}
                {message.role === "assistant" && message.feed?.by ? (
                  <p className="mt-0.5 px-1 text-[9px] text-muted-foreground/80">
                    Answered by {message.feed.by}
                  </p>
                ) : null}

                {/* The working stays under the reply it produced, so the
                    answer and how it was reached are never apart. */}
                {message.feed?.steps.length ? (
                  <div className="mt-1.5 w-full">
                    <TraceFeed
                      steps={message.feed.steps}
                      tookMs={message.feed.ms}
                      by={message.feed.by ?? null}
                    />
                  </div>
                ) : null}
              </li>
            ))}

            {/* The turn as it is happening: its thinking and every step, in a
                text feed, with the reply filling in underneath. A turn that
                failed keeps its feed too, so the reason it stopped is still
                here and not only a flash in the notice bar. */}
            {turn ? (
              <li className="flex flex-col items-start">
                <div className="w-full">
                  <TraceFeed
                    steps={turn.steps}
                    running={running}
                    startedAt={turn.startedAt}
                    tookMs={turn.updatedAt - turn.startedAt}
                    by={turn.by}
                    error={running ? null : turn.error}
                  />
                </div>
              </li>
            ) : null}

            {thinking ? (
              <li className="flex flex-col items-start">
                <span className="mb-0.5 px-1 text-[9px] font-medium text-muted-foreground">
                  AI
                </span>
                {drafting ? (
                  <div className="max-w-[90%] rounded-2xl rounded-bl-md border border-border/60 bg-background/50 px-3 py-2 text-sm leading-5">
                    <p className="whitespace-pre-wrap">{drafting}</p>
                  </div>
                ) : (
                  <span className="inline-flex items-center gap-2 rounded-2xl rounded-bl-md border border-border/60 bg-background/50 px-3 py-2 text-sm text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" />
                    Thinking…
                  </span>
                )}
              </li>
            ) : null}
          </ul>
        )}
      </div>

      {notice ? (
        <p className="border-t border-white/15 bg-white/10 px-4 py-2 text-[10px] leading-4 text-foreground/80">
          {notice}
        </p>
      ) : null}

      {footer}

      {/* A box that cannot be typed in shows no input at all, rather than a
          dead one. */}
      {disabled ? null : (
        <form
          onSubmit={handleSubmit}
          className="flex items-center gap-2 border-t border-border/60 px-3 py-3"
        >
          {inputLeading}
          <Input
            ref={inputRef}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={placeholder}
            aria-label={`${title} input`}
            className="h-10 rounded-xl border-border/60 bg-background/40"
          />
          <Button
            type="submit"
            size="icon"
            disabled={!value.trim()}
            aria-label={`Send to ${title}`}
            className={cn("size-10 shrink-0 rounded-xl", accent.send)}
          >
            <ArrowUp className="size-4" />
          </Button>
        </form>
      )}
    </section>
  );
}
