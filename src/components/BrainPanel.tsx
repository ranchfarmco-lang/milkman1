import { cn } from "@/lib/utils";
import { motion } from "framer-motion";
import { Cpu } from "lucide-react";
import type { ReactNode } from "react";

/**
 * The two pieces every panel on the local-brain page is built from.
 *
 * They live here rather than in the page because two files draw with them: the
 * page itself, and the Tasks and Packages panels beside it. Keeping one copy is
 * the difference between a house style and two houses.
 */

const RISE = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
};

export function Panel({
  children,
  className,
  delay = 0,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  return (
    <motion.section
      {...RISE}
      transition={{ duration: 0.25, delay }}
      className={cn(
        "rounded-2xl border border-border/70 bg-card/70 p-4 backdrop-blur-sm",
        className,
      )}
    >
      {children}
    </motion.section>
  );
}

export function Stat({
  label,
  value,
  note,
  icon: Icon,
}: {
  label: string;
  value: string;
  note?: string;
  icon?: typeof Cpu;
}) {
  return (
    <div className="rounded-xl border border-border/70 bg-background/30 px-3 py-2.5">
      <p className="flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {Icon ? <Icon className="size-3" /> : null}
        {label}
      </p>
      <p className="mt-1 truncate text-[13px] font-semibold tracking-tight" title={value}>
        {value}
      </p>
      {note ? <p className="mt-0.5 text-[9px] leading-4 text-muted-foreground">{note}</p> : null}
    </div>
  );
}
