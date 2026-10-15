import { splitCrew } from "@/convex/ai_crew";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  BrainCircuit,
  ChevronDown,
  ChevronRight,
  Loader2,
} from "lucide-react";
import { useEffect, useState } from "react";

/**
 * One line of a turn's working: a thought, a step, what a program printed, or
 * something that broke.
 */
export type FeedStep = {
  kind:
    | "reasoning"
    | "think"
    | "tool"
    | "step"
    | "answer"
    | "error"
    | "console";
  text: string;
  at: number;
};

/**
 * A turn's working, as a text feed.
 *
 * The point of it is that it is text: what the model reasoned, what it planned,
 * what it searched for, what it read and ran, which of the other agents it
 * asked — written as it happens, in the order it happens, in the place somebody
 * is already reading. It is not a summary of the work; it is the work.
 *
 * It reads the same whether it is still arriving or was kept under a reply last
 * week, because it is the same data either way — a turn's steps, plus the two
 * things that make them legible: how long it took and which system wrote it.
 *
 * The reply is deliberately not in here. Those `answer` steps are the words of
 * the message this sits under, and saying them twice helps nobody.
 */
export function TraceFeed({
  steps,
  running = false,
  startedAt = 0,
  tookMs,
  by = null,
  error = null,
  defaultOpen = true,
}: {
  steps: FeedStep[];
  /** Still being written: the header ticks and the last line carries a caret. */
  running?: boolean;
  /** When it began, so a running turn can time itself. */
  startedAt?: number;
  /** How long it took, once it has stopped. */
  tookMs?: number;
  by?: string | null;
  error?: string | null;
  /** Open when it first appears. Anything can be folded away and back. */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const lines = steps.filter((step) => step.kind !== "answer");
  const failed = Boolean(error);

  return (
    <div className="w-full overflow-hidden rounded-xl border border-border/50 bg-background/30">
      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center gap-1.5 px-3 py-1.5 text-left text-[9px] uppercase tracking-[0.14em] text-muted-foreground"
      >
        {running ? (
          <Loader2 className="size-3 animate-spin" />
        ) : failed ? (
          <AlertTriangle className="size-3" />
        ) : (
          <BrainCircuit className="size-3" />
        )}
        {running ? "Thinking" : failed ? "Stopped" : "How it got there"}

        <span className="ml-auto flex min-w-0 items-center gap-2 normal-case tracking-normal">
          {running ? <Elapsed from={startedAt} /> : null}
          {!running && typeof tookMs === "number" ? (
            <span className="text-muted-foreground/80">
              {duration(tookMs)}
            </span>
          ) : null}
          {by && !running ? (
            <span className="max-w-[18ch] truncate text-muted-foreground/80">
              {by}
            </span>
          ) : null}
          {open ? (
            <ChevronDown className="size-3" />
          ) : (
            <ChevronRight className="size-3" />
          )}
        </span>
      </button>

      {open ? (
        <div className="flex flex-col gap-2 border-t border-border/40 px-3 py-2.5">
          {lines.length === 0 ? (
            <p className="text-[11px] leading-5 text-muted-foreground">
              {running ? "Starting…" : "Nothing recorded for that turn."}
            </p>
          ) : null}

          {lines.map((step, index) => (
            <FeedLine
              key={`${step.at}-${index}`}
              step={step}
              // Only the very last line of a running turn carries the caret, so
              // it reads as one thing being written rather than many blinking.
              writing={running && index === lines.length - 1}
            />
          ))}

          {error ? (
            <p className="flex items-start gap-1.5 text-[11px] leading-5 text-foreground/80">
              <AlertTriangle className="mt-1 size-3 shrink-0" />
              <span className="min-w-0">{error}</span>
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** One line of the working, set the way its kind deserves. */
function FeedLine({ step, writing }: { step: FeedStep; writing: boolean }) {
  const caret = writing ? (
    <span className="ml-1 inline-block h-3 w-1.5 translate-y-0.5 animate-pulse rounded-sm bg-foreground/60 align-baseline" />
  ) : null;

  if (step.kind === "reasoning" || step.kind === "think") {
    return (
      <p
        className={cn(
          "whitespace-pre-wrap break-words border-l-2 pl-3 text-[11px] leading-5",
          step.kind === "think"
            ? "border-border text-foreground/85"
            : "border-border/50 text-muted-foreground",
        )}
      >
        {step.text}
        {caret}
      </p>
    );
  }

  if (step.kind === "error") {
    return (
      <p className="flex items-start gap-1.5 text-[11px] leading-5 text-foreground/80">
        <AlertTriangle className="mt-1 size-3 shrink-0" />
        <span className="min-w-0">{step.text}</span>
      </p>
    );
  }

  // What a program printed — a build's own output, or a run's. Verbatim, in a
  // mono block: it is machine output rather than something written for a
  // person, and reflowing it in the proportional font would hide what the error
  // actually said.
  if (step.kind === "console") {
    return (
      <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md border border-border/50 bg-background/50 px-2 py-1.5 font-mono text-[10px] leading-4 text-muted-foreground">
        {step.text}
        {caret}
      </pre>
    );
  }

  // A step it took: short, one line, with a mark to walk down — and, when this
  // box works as a crew, the crew member it belongs to. The handle is on the
  // front of the line because the server put it there; splitting it off here is
  // what turns "@Files Looked over its bench" into a badge and a sentence.
  const { handle, body } = splitCrew(step.text);

  return (
    <p className="flex items-start gap-2 text-[11px] leading-5 text-foreground/80">
      <span
        className={cn(
          "mt-2 size-1.5 shrink-0 rounded-full",
          step.kind === "tool" ? "bg-foreground/45" : "bg-foreground/25",
        )}
      />
      <span className="min-w-0 break-words">
        {handle ? (
          <span className="mr-1.5 inline-block rounded border border-border/70 bg-background/50 px-1 py-px align-[1px] font-mono text-[9px] text-foreground/85">
            {handle}
          </span>
        ) : null}
        {body}
        {caret}
      </span>
    </p>
  );
}

/** "12s" or "2m 4s" — the shape of a wait, not a timestamp. */
function duration(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** How long a turn has been running, ticked on its own so nothing else redraws. */
function Elapsed({ from }: { from: number }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <span className="text-muted-foreground/80">{duration(now - from)}</span>
  );
}
