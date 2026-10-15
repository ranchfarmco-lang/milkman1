/**
 * The shell every ControlForge box wears: its own header, its own status
 * light, its own refresh button, its own test/detect button — the spec's
 * requirement, made structural rather than repeated by hand ten times.
 *
 * House rules apply: green and red are readings (connection stats only),
 * orange is for reset/refresh controls, and everything else is neutral.
 */
import { Button } from "@/components/ui/button";
import { ORANGE_GHOST } from "@/lib/control-room-sections";
import { cn } from "@/lib/utils";
import type { Tone } from "@/lib/forge/db";
import { Loader2, RefreshCw, type LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

const DOT: Record<Tone, string> = {
  good: "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.7)]",
  warn: "bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.6)]",
  bad: "bg-rose-500 shadow-[0_0_6px_rgba(244,63,94,0.6)]",
  muted: "bg-white/30",
};

const VALUE: Record<Tone, string> = {
  good: "text-emerald-300",
  warn: "text-amber-300",
  bad: "text-rose-300",
  muted: "text-muted-foreground",
};

/** A live light: the dot, the reading, and the sentence behind it. */
export function ForgeLight({
  tone,
  value,
  note,
}: {
  tone: Tone;
  value: string;
  note?: string;
}) {
  return (
    <span className="flex min-w-0 items-center gap-1.5" title={note}>
      <span className={cn("size-2 shrink-0 rounded-full", DOT[tone])} />
      <span className={cn("truncate text-[9px] font-semibold tracking-wide", VALUE[tone])}>
        {value}
      </span>
    </span>
  );
}

export type ForgeBoxProps = {
  /** Section id the Control Room's jump list uses (`forge-byok`, …). */
  id: string;
  icon: LucideIcon;
  title: string;
  /** The box's own light. Omit while the box has nothing to read yet. */
  light?: { tone: Tone; value: string; note?: string };
  /** Re-read what this box shows. Always present, always orange. */
  onRefresh: () => void | Promise<void>;
  /** The detect/test button. Omit only where the rows each carry their own. */
  test?: { label: string; onTest: () => void | Promise<void> };
  /** Shows a spinner over the test button while its work runs. */
  testing?: boolean;
  /** One quiet line under the header. */
  hint?: string;
  children: ReactNode;
};

export function ForgeBox({
  id,
  icon: Icon,
  title,
  light,
  onRefresh,
  test,
  testing = false,
  hint,
  children,
}: ForgeBoxProps) {
  const [refreshing, setRefreshing] = useState(false);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <section
      id={`section-${id}`}
      className="scroll-mt-28 rounded-2xl border border-white/25 bg-card/70 p-4 backdrop-blur-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          <Icon className="size-3" />
          {title}
        </h3>

        <div className="flex shrink-0 items-center gap-1.5">
          {light ? <ForgeLight {...light} /> : null}
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={`Refresh ${title}`}
            title={`Refresh ${title}`}
            disabled={refreshing}
            onClick={() => void refresh()}
            className={cn("size-6 cursor-pointer", ORANGE_GHOST, refreshing && "animate-pulse")}
          >
            <RefreshCw className={cn("size-3", refreshing && "animate-spin")} />
          </Button>
          {test ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={testing}
              onClick={() => void test.onTest()}
              className="h-6 cursor-pointer rounded-lg px-2 text-[9px]"
            >
              {testing ? <Loader2 className="size-3 animate-spin" /> : null}
              {test.label}
            </Button>
          ) : null}
        </div>
      </div>

      {hint ? (
        <p className="mt-1.5 text-[10px] leading-4 text-muted-foreground">{hint}</p>
      ) : null}

      <div className="mt-3">{children}</div>
    </section>
  );
}

/** A label/value line inside a box. */
export function ForgeRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-1.5">
      <span className="w-40 shrink-0 text-[10px] font-medium text-foreground/90">{label}</span>
      <span className="min-w-0 flex-1 text-[10px] leading-4 text-muted-foreground">{children}</span>
    </div>
  );
}

/** The neutral small button rows of boxes share. */
export function MiniButton({
  onClick,
  children,
  disabled,
  title,
}: {
  onClick: () => void | Promise<void>;
  children: ReactNode;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={disabled}
      title={title}
      onClick={() => void onClick()}
      className="h-7 cursor-pointer rounded-lg px-2.5 text-[9px]"
    >
      {children}
    </Button>
  );
}
