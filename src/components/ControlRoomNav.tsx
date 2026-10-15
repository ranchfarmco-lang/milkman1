import { cn } from "@/lib/utils";
import { Compass, SlidersHorizontal } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { RefObject } from "react";

/**
 * Quick Reference — every category on the Control Room page, in one bar at the
 * top of it.
 *
 * The page itself holds everything, top to bottom, so the bar is not a set of
 * views: it is a set of places on one page. Pressing a button brings that whole
 * category to the top of the page — its heading, its live readings, its status
 * lights, its buttons and its links together — and nothing is ever taken off
 * the page to make that happen.
 *
 * Every button is on display at once, wrapping onto as many lines as it needs.
 * A button that had to be scrolled sideways to be found would not be on display
 * at all, and a category nobody can see is a category nobody presses.
 *
 * The reading beside each one comes from the same query the category itself
 * reads, so the two can never disagree. A green dot is something connected or
 * answering, red is something that is not, amber is something waiting or
 * changed, and a pale dot is nothing to report yet.
 */

export type SectionTone = "good" | "warn" | "bad" | "muted";

export type ControlRoomSection = {
  /** The id of the section itself, without the `section-` prefix. */
  id: string;
  label: string;
  icon: LucideIcon;
  /** What the category holds, in one line — the button's title. */
  hint: string;
  /** A live reading for this category, or null when it has none. */
  reading?: string | null;
  tone?: SectionTone;
};

const TONE_DOT: Record<SectionTone, string> = {
  good: "bg-emerald-500",
  warn: "bg-amber-400",
  bad: "bg-red-500",
  muted: "bg-white/25",
};

export function ControlRoomNav({
  sections,
  onJump,
  barRef,
}: {
  sections: ControlRoomSection[];
  /** Bring one whole category to the top of the page. */
  onJump: (id: string) => void;
  /**
   * The bar itself. The page measures it so a category it jumps to lands clear
   * of the bar rather than behind it.
   */
  barRef?: RefObject<HTMLElement | null>;
}) {
  return (
    <nav
      ref={barRef}
      aria-label="Quick Reference"
      className="sticky top-0 z-20 -mx-1 border-b border-border/60 bg-background/95 px-1 pb-2 pt-1 backdrop-blur"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-1">
        <span className="flex items-center gap-1.5 text-[12px] font-semibold tracking-tight">
          <SlidersHorizontal className="size-3.5 shrink-0" />
          Control Room
        </span>
        <p className="flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          <Compass className="size-3 shrink-0" />
          Quick Reference · everything on this page, one tap away
        </p>
      </div>

      {/* All of it, all visible: wrapped onto as many lines as it takes, never
          scrolled sideways and never cut off. */}
      <div className="mt-1.5 flex flex-wrap gap-1">
        {sections.map(({ id, label, icon: Icon, hint, reading, tone = "muted" }) => (
          <button
            key={id}
            type="button"
            title={hint}
            onClick={() => onJump(id)}
            className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-border/60 px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:border-white/30 hover:bg-white/5 hover:text-foreground"
          >
            <Icon className="size-3 shrink-0" />
            <span className="whitespace-nowrap font-medium">{label}</span>

            {reading ? (
              <span className="flex items-center gap-1 whitespace-nowrap text-[9px]">
                <span className={cn("size-1.5 rounded-full", TONE_DOT[tone])} />
                {reading}
              </span>
            ) : null}
          </button>
        ))}
      </div>
    </nav>
  );
}

export default ControlRoomNav;
