import { BoxControlBar } from "@/components/BoxControlBar";
import { LivePreview } from "@/components/LivePreview";
import type { ChatMessage, PanelAccent } from "@/components/MessagePanel";
import { Button } from "@/components/ui/button";
import { api } from "@/convex/_generated/api";
import { useBehindTheScenes, type BehindRow } from "@/hooks/use-behind";
import type { ChatRoom } from "@/hooks/use-chat";
import { splitArtifact } from "@/lib/fences";
import { cn } from "@/lib/utils";
import { useQuery } from "convex/react";
import {
  Check,
  Code2,
  Copy,
  Loader2,
  Play,
  Radio,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

/**
 * The other half of the split: the work, and the result.
 *
 * The chat carries the conversation and only the conversation. Everything else
 * lands here, in the order it happens:
 *
 *  - **Behind the scenes** — what the hub is doing when nobody asked it
 *    anything: deciding whether to speak up on its own, going out to every feed
 *    the [LIVE] board draws on, writing the morning board onto the calendar.
 *    Every line is written by the server while the job actually runs, so it is
 *    what the hub is doing rather than a log of what it did.
 *  - **The result** — what the turn produced, running. A page off the builder's
 *    bench, or a reply that brought its own styling, is handed to a browser and
 *    rendered live beside the code, so a broken layout is something you can see
 *    rather than something you find out after copying it out.
 *
 * A finished turn ends in one of two ways and both belong here. A reply that
 * carries fenced code or a document has produced something, and it is laid out
 * as blocks to read. A reply with no fence in it has produced an answer
 * instead, and the answer is the result, so it is shown as the words it was
 * written in. Never both: when there is code, the prose that introduced it is
 * already in the chat.
 *
 * Nothing here is invented, so before there is a result it says so.
 */

/** Does this look like a page rather than a snippet of one? */
function looksLikeDocument(code: string) {
  const head = code.trim().slice(0, 800).toLowerCase();
  if (head.startsWith("<!doctype") || /<html[\s>]/.test(head)) return true;
  if (/<body[\s>]/.test(head) || /<head[\s>]/.test(head)) return true;
  // A fragment that brings its own styling or behaviour is self-contained
  // enough to be worth running.
  return /<style[\s>]/.test(head) || /<script[\s>]/.test(head);
}

/**
 * Give a fragment the shell a page would have had, in this app's own colours.
 *
 * A reply that is a piece of a page rather than a whole one still expects the
 * frame a browser brings: a default font, a margin, and a background. That
 * shell is the hub's black and white rather than a browser's paper, because
 * this pane sits inside a black app and a white rectangle reads as a hole in
 * it. Anything the fragment sets itself — its own stylesheet, its own colours —
 * is untouched and still wins; this is only what fills the gaps.
 */
function documentFor(code: string) {
  if (/<!doctype html|<html[\s>]/i.test(code)) return code;
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:1rem;font-family:system-ui,-apple-system,sans-serif;color:#fff;background:#000}</style>
</head>
<body>
${code}
</body>
</html>`;
}

/** A small switch for the two ways of looking at the same result. */
function ViewTab({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: LucideIcon;
  label: string;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant={active ? "secondary" : "ghost"}
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "h-6 cursor-pointer rounded-md px-2 text-[10px]",
        active ? "text-foreground" : "text-muted-foreground",
      )}
    >
      <Icon className="size-3" />
      {label}
    </Button>
  );
}

export function PreviewPanel({
  title,
  subtitle,
  icon: Icon,
  accent,
  messages,
  thinking = false,
  emptyTitle,
  emptyHint,
  headerAction,
  room,
  onClear,
  onAdd,
}: {
  title: string;
  subtitle: string;
  icon: LucideIcon;
  accent: PanelAccent;
  messages: ChatMessage[];
  thinking?: boolean;
  emptyTitle: string;
  emptyHint: string;
  /** Sits in the header, left of the status note. */
  headerAction?: ReactNode;
  /** Which box this preview belongs to, for the control bar in the top-right. */
  room?: ChatRoom;
  /** Empty the whole box out, transcript included. */
  onClear?: () => void;
  /** Add a new content box here, from the Add button in the top-right. */
  onAdd?: () => void;
}) {
  // What the hub has been doing on its own — the board going out to its feeds,
  // the assistant deciding to speak up, the morning pass over the calendar.
  //
  // The turn's own working travels with the reply it produced, so it is shown
  // once, in the conversation, rather than a second time here.
  const { rows: behind } = useBehindTheScenes();

  // The builder's bench, already composed into one runnable page on the
  // server. Only the builder has a bench, so the assistant skips the read
  // rather than asking for something that will always be empty.
  const bench = useQuery(
    api.workspace.preview,
    room === "builder" ? {} : "skip",
  );

  /**
   * The newest finished turn, whichever of the two shapes it came in: blocks it
   * produced, or the answer it gave. Kept on screen so the last result does not
   * vanish the moment the AI answers a question a moment later.
   */
  const result = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role !== "assistant") continue;
      const { dialogue, product } = splitArtifact(message.text);
      if (product.length) {
        return {
          blocks: product,
          answer: "",
          // The page is found here rather than in a memo of its own: `blocks`
          // is a fresh array on every render, so a second memo keyed on it
          // would recompute every time and hold nothing.
          page:
            product.find((block) => looksLikeDocument(block.content))
              ?.content ?? null,
        };
      }
      if (dialogue) return { blocks: [], answer: dialogue, page: null };
    }
    return null;
  }, [messages]);

  const blocks = result?.blocks ?? [];
  const answer = result?.answer ?? "";
  const page = result?.page ?? null;
  const codeCount = blocks.length;

  // The bench wins: a whole app off the builder's workbench is a better answer
  // than one fenced block out of its reply. Either way the page keeps its own
  // styling — only a fragment with none of its own gets the hub's shell.
  const liveHtml = bench?.html ?? (page ? documentFor(page) : null);
  const previewLabel = bench?.entry ?? (page ? "from its reply" : "");

  const hasResult = Boolean(liveHtml) || codeCount > 0 || Boolean(answer);
  const hasTrace = behind.length > 0 || thinking;
  const [view, setView] = useState<"preview" | "code">("preview");

  return (
    // `min-h-0 flex-1` rather than `h-full`: the connection box sits below this
    // one, so the two share the column instead of one filling it.
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border/70 bg-card/70 backdrop-blur-sm">
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
          <p className="truncate text-[10px] text-muted-foreground">
            {subtitle}
          </p>
        </div>
        {headerAction}
        {thinking ? (
          <span className="inline-flex shrink-0 items-center gap-1.5 text-[9px] text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            Working
          </span>
        ) : behind.length > 0 ? (
          <span className="shrink-0 rounded-full border border-border/60 bg-background/40 px-2 py-0.5 text-[9px] font-medium text-muted-foreground">
            {behind.length === 1 ? "1 job" : `${behind.length} jobs`}
          </span>
        ) : codeCount > 0 ? (
          <span className="shrink-0 rounded-full border border-border/60 bg-background/40 px-2 py-0.5 text-[9px] font-medium text-muted-foreground">
            {codeCount === 1 ? "1 block" : `${codeCount} blocks`}
          </span>
        ) : answer ? (
          <span className="shrink-0 rounded-full border border-border/60 bg-background/40 px-2 py-0.5 text-[9px] font-medium text-muted-foreground">
            Answer
          </span>
        ) : null}

        {room ? (
          <BoxControlBar
            label={title}
            room={room}
            // Whatever is actually on screen, so Save, Share and Copy carry the
            // result and not an empty string.
            text={
              codeCount
                ? blocks.map((block) => block.content).join("\n\n")
                : answer
            }
            onClear={onClear}
            onAdd={onAdd}
            className="ml-auto"
          />
        ) : null}
      </header>

      {!hasResult && !hasTrace ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-2 text-center">
          <span
            className={cn(
              "grid size-11 place-items-center rounded-2xl border border-dashed border-border/80",
              accent.iconWrap,
            )}
          >
            <Icon className="size-5" />
          </span>
          <p className="mt-3 text-[12px] font-medium">{emptyTitle}</p>
          <p className="mt-1 max-w-[26ch] text-[10px] leading-4 text-muted-foreground">
            {emptyHint}
          </p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* -------------------------------------------------- behind the scenes */}
          {hasTrace ? (
            <BehindFeed
              rows={behind}
              thinking={thinking}
              className={cn(
                "shrink-0 border-b border-border/60",
                hasResult ? "max-h-56" : "flex-1",
              )}
            />
          ) : null}

          {/* ------------------------------------------------------ the result */}
          {liveHtml ? (
            <div className="flex min-h-0 flex-1 flex-col">
              {codeCount > 0 ? (
                <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-2.5 py-1.5">
                  <ViewTab
                    active={view === "preview"}
                    onClick={() => setView("preview")}
                    icon={Play}
                    label="Preview"
                  />
                  <ViewTab
                    active={view === "code"}
                    onClick={() => setView("code")}
                    icon={Code2}
                    label={`Code${codeCount > 1 ? ` (${codeCount})` : ""}`}
                  />
                </div>
              ) : null}

              {view === "code" && codeCount > 0 ? (
                <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
                  <div className="flex flex-col gap-3">
                    {blocks.map((block, index) => (
                      <CodeBlock key={index} code={block.content} />
                    ))}
                  </div>
                </div>
              ) : (
                <div className="flex min-h-0 flex-1 flex-col p-2.5">
                  <LivePreview html={liveHtml} label={previewLabel} />
                </div>
              )}
            </div>
          ) : codeCount > 0 ? (
            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
              <div className="flex flex-col gap-3">
                {blocks.map((block, index) => (
                  <CodeBlock key={index} code={block.content} />
                ))}
              </div>
            </div>
          ) : answer ? (
            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
              <AnswerBlock answer={answer} />
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

/**
 * The work nobody asked for, as it happens.
 *
 * The assistant deciding to speak up, the [LIVE] board going out to every feed
 * on its timer, the morning pass that writes the board onto the calendar — none
 * of it triggered by a person, and none of it otherwise visible. Each line is
 * written by the server while the job runs, so this is what the hub is doing,
 * not a log of what it did.
 */
function BehindFeed({
  rows,
  thinking,
  className,
}: {
  rows: BehindRow[];
  thinking: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border/50 px-3 py-1.5 text-[9px] tracking-[0.14em] text-muted-foreground uppercase">
        {thinking ? (
          <Loader2 className="size-3 animate-spin" />
        ) : (
          <Radio className="size-3" />
        )}
        {thinking ? "Working" : "Behind the scenes"}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-2.5">
        {rows.length === 0 ? (
          <p className="text-[11px] leading-5 text-muted-foreground">
            Nothing has run on its own yet.
          </p>
        ) : null}
        {rows.map((row) => (
          <div
            key={row.id}
            className="flex items-start gap-2 text-[11px] leading-5"
          >
            <span
              className={cn(
                "mt-2 size-1.5 shrink-0 rounded-full",
                row.status === "running"
                  ? "animate-pulse bg-foreground/60"
                  : row.status === "failed"
                    ? "bg-foreground/30"
                    : "bg-foreground/25",
              )}
            />
            <span className="min-w-0">
              <span className="block break-words text-foreground/80">
                {row.label}
              </span>
              {row.detail ? (
                <span className="mt-0.5 block whitespace-pre-wrap break-words text-[10px] leading-4 text-muted-foreground">
                  {row.detail}
                </span>
              ) : null}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * A finished result, labelled, with a copy button — because copying it is what
 * you do with it next. Code and a written answer are the two shapes a result
 * comes in and they differ only in their body, so the frame around them is one
 * thing rather than two that drift apart.
 */
function BlockShell({
  label,
  text,
  children,
}: {
  label: string;
  text: string;
  children: ReactNode;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Copying was refused; it is still there to select by hand.
    }
  };

  return (
    <div className="overflow-hidden rounded-lg border border-border/60 bg-background/60">
      <div className="flex items-center justify-between border-b border-border/50 px-2 py-1">
        <span className="text-[9px] tracking-[0.14em] text-muted-foreground uppercase">
          {label}
        </span>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          onClick={() => void copy()}
          aria-label={`Copy the ${label.toLowerCase()}`}
          className="size-6 cursor-pointer text-muted-foreground hover:text-foreground"
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
        </Button>
      </div>
      {children}
    </div>
  );
}

function CodeBlock({ code }: { code: string }) {
  return (
    <BlockShell label="Code" text={code}>
      <pre className="overflow-x-auto p-2.5 font-mono text-[11px] leading-5">
        <code>{code}</code>
      </pre>
    </BlockShell>
  );
}

/**
 * The answer, when the turn produced words rather than code. It reads exactly
 * as it does in the chat, because it is the same text — only here it is the
 * newest thing the box finished, kept until something else is.
 */
function AnswerBlock({ answer }: { answer: string }) {
  return (
    <BlockShell label="Answer" text={answer}>
      <p className="p-2.5 text-[12px] leading-5 whitespace-pre-wrap">
        {answer}
      </p>
    </BlockShell>
  );
}
