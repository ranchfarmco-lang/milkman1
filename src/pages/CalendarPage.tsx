import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type {
  CalendarAudience,
  CalendarCostStatus,
  CalendarKind,
  CalendarLayer,
  CalendarPriority,
} from "@/convex/schema";
import { LAYER_META, KIND_LABELS } from "@/lib/calendar";
import * as cal from "@/lib/calendar";
import { cn } from "@/lib/utils";
import type { FunctionReturnType } from "convex/server";
import { useAction, useMutation, useQuery } from "convex/react";
import { motion } from "framer-motion";
import {
  Bell,
  CalendarDays,
  CalendarPlus,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  Clock,
  Download,
  Flag,
  Globe,
  HeartHandshake,
  Layers,
  Link2,
  Loader2,
  Lock,
  MapPin,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShoppingCart,
  Trash2,
  Upload,
  Users,
  UtensilsCrossed,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { toast } from "sonner";

type CalendarState = FunctionReturnType<typeof api.calendar.state>;
type Card = CalendarState["events"][number];
type Feed = CalendarState["feeds"][number];
type ShoppingItem = CalendarState["shopping"][number];

const RISE = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
};

// The full list of kinds lives in the shared helper, so the page, the labels
// and the server's layer rules all read from the same place.
const KINDS: CalendarKind[] = cal.CALENDAR_KINDS;

/** A short palette the family taps; the field also takes any emoji typed. */
const EMOJIS = [
  "⭐",
  "❤️",
  "🔥",
  "⚠️",
  "✅",
  "🎉",
  "🏥",
  "💊",
  "🚗",
  "🏫",
  "🍽️",
  "🛒",
  "🐴",
  "🐶",
  "💵",
  "📌",
];

/** An alarm's lead time, said in words. */
function alarmLabel(minutes: number) {
  if (minutes >= 1440) {
    const days = Math.round(minutes / 1440);
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  if (minutes >= 60) {
    const hours = Math.round(minutes / 60);
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `${minutes} min`;
}

/** How a priority reads on a card, when it said anything at all. */
const PRIORITY_LABELS: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  urgent: "Urgent",
};

/** A money amount for a card, plain and to the cent. */
function formatMoney(value: number) {
  return `$${value.toFixed(value % 1 === 0 ? 0 : 2)}`;
}

/**
 * Everything about an entry a search should be able to find — the words on the
 * card, where it is, what was written about it, a recipe's ingredients, and the
 * two links it might carry.
 */
function searchText(event: Card) {
  return [
    event.title,
    event.location ?? "",
    event.notes ?? "",
    event.recipeUrl ?? "",
    event.link ?? "",
    event.place ?? "",
    event.appointmentType ?? "",
    event.paidBy ?? "",
    event.ownerName,
    ...event.ingredients,
    ...event.attendees,
  ]
    .join(" ")
    .toLowerCase();
}

/** The layers a kind falls into when nobody chooses one by hand. */


/** A tiny round picture of a person, coloured from their id. */
function Who({
  id,
  name,
  size = 16,
}: {
  id: string;
  name: string;
  size?: number;
}) {
  const hue = cal.hueFor(id);
  return (
    <span
      className="grid shrink-0 place-items-center rounded-full border font-semibold"
      style={{
        width: size,
        height: size,
        fontSize: Math.max(7, size * 0.42),
        borderColor: `hsl(${hue} 38% 62% / 0.7)`,
        background: `hsl(${hue} 30% 45% / 0.28)`,
        color: "white",
      }}
      title={name}
    >
      {cal.initialsOf(name)}
    </span>
  );
}

function LayerBadge({ layer }: { layer: string }) {
  const meta = LAYER_META.find((entry) => entry.key === layer);
  return (
    <span className="rounded-full border border-border/60 px-1.5 py-px text-[8px] whitespace-nowrap text-muted-foreground">
      {meta?.label ?? layer}
    </span>
  );
}

/* --------------------------------------------------------------- the clock */

function LiveClock({ timeZone }: { timeZone: string }) {
  // Its own tick, so the seconds move without the whole page re-rendering.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="flex items-center gap-2.5">
      <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-white/10 text-white">
        <Clock className="size-4" />
      </span>
      <div className="min-w-0">
        <div className="flex items-baseline gap-1.5">
          <span className="text-[22px] leading-none font-semibold tabular-nums">
            {cal.clockWithSeconds(now, timeZone)}
          </span>
          <span className="rounded-full border border-border/60 px-1.5 py-px text-[8px] text-muted-foreground">
            {cal.zoneLabel(now, timeZone)}
          </span>
        </div>
        <div className="mt-0.5 truncate text-[10px] text-muted-foreground">
          {cal.longDate(now, timeZone)} · {timeZone}
        </div>
      </div>
    </div>
  );
}

function TimeZonePicker({
  value,
  onChange,
  now,
}: {
  value: string;
  onChange: (zone: string) => void;
  now: number;
}) {
  const zones = useMemo(() => {
    const list = cal.timeZones().filter((zone) =>
      cal.FALLBACK_ZONES.includes(zone),
    );
    return list.includes(value) ? list : [value, ...list];
  }, [value]);

  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        className="h-8 w-[178px] shrink-0 cursor-pointer rounded-lg text-[10px]"
        title="Every entry is stored as a moment in time, so changing this moves the whole page with it."
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <Globe className="size-3 shrink-0 text-muted-foreground" />
          <SelectValue />
        </span>
      </SelectTrigger>
      <SelectContent className="max-h-[320px]">
        {zones.map((zone) => (
          <SelectItem key={zone} value={zone} className="text-[10px]">
            {zone} · {cal.zoneLabel(now, zone)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/* ----------------------------------------------------------------- a chip */

function EventChip({
  event,
  timeZone,
  onOpen,
  onReply,
}: {
  event: Card;
  timeZone: string;
  onOpen: () => void;
  onReply: (answer: string) => void;
}) {
  const hue = cal.hueFor(event.ownerId);
  const mine = event.mine;

  return (
    <div
      className={cn(
        "group/chip flex min-w-0 flex-col gap-1 rounded-md border-l-2 bg-white/[0.05] px-1.5 py-1 transition-colors hover:bg-white/10",
        mine && "bg-white/[0.09]",
      )}
      style={{ borderLeftColor: `hsl(${hue} 38% 62% / 0.9)` }}
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 cursor-pointer flex-col gap-0.5 text-left"
      >
        <span className="flex min-w-0 items-center gap-1">
          {event.allDay ? null : (
            <span className="shrink-0 text-[9px] tabular-nums text-muted-foreground">
              {cal.clockText(event.startsAt, timeZone)}
            </span>
          )}
          <span className="min-w-0 truncate text-[10px] leading-tight font-medium">
            {event.emoji ? `${event.emoji} ` : ""}
            {event.title}
          </span>
          {/* Who can see it, at a glance: a padlock is one person's, two
              heads are a few of them. The whole family's needs no mark. */}
          {event.audience === "private" ? (
            <span title="Just you" className="shrink-0">
              <Lock className="size-2.5 text-muted-foreground" />
            </span>
          ) : event.audience === "group" ? (
            <span
              title={`Only ${event.attendees.join(", ") || "the people named"}`}
              className="shrink-0"
            >
              <Users className="size-2.5 text-muted-foreground" />
            </span>
          ) : null}
          {event.readOnly ? (
            <Link2 className="size-2.5 shrink-0 text-muted-foreground" />
          ) : null}
          {/* Only the two that want to be noticed get a mark; the quiet ones
              stay quiet, which is the point of the default. */}
          {event.priority === "urgent" || event.priority === "high" ? (
            <span
              title={`Priority: ${PRIORITY_LABELS[event.priority]}`}
              className={cn(
                "shrink-0 rounded-full border px-1 py-px text-[7px] tracking-wide whitespace-nowrap uppercase",
                event.priority === "urgent"
                  ? "border-white/60 text-foreground"
                  : "border-border/70 text-muted-foreground",
              )}
            >
              {PRIORITY_LABELS[event.priority]}
            </span>
          ) : null}
        </span>

        <span className="flex min-w-0 items-center gap-1">
          <Who id={event.ownerId} name={event.ownerName} size={13} />
          <span className="min-w-0 truncate text-[8px] text-muted-foreground">
            {event.mine ? "You" : event.ownerName}
          </span>
          {event.location ? (
            <span className="flex min-w-0 items-center gap-0.5 truncate text-[8px] text-muted-foreground">
              <MapPin className="size-2 shrink-0" />
              {event.location}
            </span>
          ) : null}
          {event.cost !== null ? (
            <span
              title={`${
                event.costStatus === "paid"
                  ? "Paid"
                  : event.costStatus === "reimbursement"
                    ? "Reimbursement requested"
                    : "Unpaid"
              }${event.paidBy ? ` · ${event.paidBy}` : ""}`}
              className="flex shrink-0 items-center gap-0.5 text-[8px] text-muted-foreground"
            >
              <CircleDollarSign className="size-2 shrink-0" />
              {formatMoney(event.cost)}
            </span>
          ) : null}
        </span>
      </button>

      {/* A request for help is answered right here, on its card. */}
      {event.options.length ? (
        <div className="flex flex-wrap items-center gap-1">
          {event.replies.slice(0, 2).map((reply) => (
            <span
              key={reply.userId}
              className="flex items-center gap-1 rounded-full border border-white/25 px-1.5 py-px text-[8px] whitespace-nowrap"
              title={`${reply.name}: ${reply.answer}`}
            >
              <Who id={reply.userId} name={reply.name} size={10} />
              {reply.answer}
            </span>
          ))}
          <select
            className="cursor-pointer rounded-full border border-border/60 bg-background/60 px-1 py-px text-[8px] text-muted-foreground outline-none"
            value=""
            onClick={(clickEvent) => clickEvent.stopPropagation()}
            onChange={(changeEvent) => {
              if (changeEvent.target.value) {
                onReply(changeEvent.target.value);
              }
            }}
            title="Offer a hand"
          >
            <option value="">
              {event.replies.length ? "Change your answer" : "I can help…"}
            </option>
            {event.options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------- the month */

function MonthGrid({
  year,
  month,
  byDay,
  now,
  timeZone,
  onOpen,
  onReply,
  onAdd,
}: {
  year: number;
  month: number;
  byDay: Map<string, Card[]>;
  now: number;
  timeZone: string;
  onOpen: (event: Card) => void;
  onReply: (event: Card, answer: string) => void;
  onAdd: (date: cal.CalendarDate) => void;
}) {
  const cells = useMemo(() => cal.monthGrid(year, month), [year, month]);
  const todayKey = cal.keyOfInstant(now, timeZone);

  // The month's own search: narrows what is drawn without changing a single
  // stored row. A card stays on the grid the moment the box is cleared.
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const shownByDay = useMemo(() => {
    if (!needle) return byDay;
    const next = new Map<string, Card[]>();
    for (const [key, list] of byDay) {
      const kept = list.filter((event) => searchText(event).includes(needle));
      if (kept.length) next.set(key, kept);
    }
    return next;
  }, [byDay, needle]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-2 py-1">
        <Search className="size-3 shrink-0 text-muted-foreground" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search this month — titles, places, notes, meals, costs…"
          className="h-6 min-w-0 flex-1 bg-transparent text-[11px] outline-none placeholder:text-muted-foreground"
        />
        {needle ? (
          <button
            type="button"
            onClick={() => setQuery("")}
            className="shrink-0 cursor-pointer text-[9px] text-muted-foreground hover:text-foreground"
          >
            Clear
          </button>
        ) : null}
      </div>

      <div className="grid shrink-0 grid-cols-7 border-b border-border/60">
        {cal.WEEKDAY_NAMES.map((name) => (
          <div
            key={name}
            className="px-2 py-1.5 text-[9px] font-semibold tracking-[0.12em] text-muted-foreground uppercase"
          >
            {name}
          </div>
        ))}
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-7 grid-rows-6">
        {cells.map((cell, index) => {
          const key = cal.dateKey(cell);
          const events = shownByDay.get(key) ?? [];
          const isToday = key === todayKey;
          const isFirstOfMonth = cell.day === 1;

          return (
            <div
              key={key}
              className={cn(
                "group flex min-h-0 min-w-0 flex-col gap-1 overflow-hidden border-b border-border/40 p-1.5 transition-colors",
                index % 7 !== 6 && "border-r",
                !cell.inMonth && "opacity-35",
                isToday && "bg-white/[0.06]",
              )}
            >
              <div className="flex shrink-0 items-center gap-1">
                <span
                  className={cn(
                    "grid size-[18px] shrink-0 place-items-center rounded-full text-[10px] tabular-nums",
                    isToday
                      ? "bg-white font-semibold text-black"
                      : "text-muted-foreground",
                  )}
                >
                  {cell.day}
                </span>

                {isFirstOfMonth ? (
                  <span className="truncate text-[8px] tracking-wide text-muted-foreground uppercase">
                    {cal.MONTH_NAMES[cell.month - 1].slice(0, 3)}
                  </span>
                ) : null}

                {isToday ? (
                  <span className="flex items-center gap-1 text-[8px] whitespace-nowrap text-muted-foreground">
                    <span className="size-1 animate-pulse rounded-full bg-white" />
                    {cal.clockText(now, timeZone)}
                  </span>
                ) : null}

                <button
                  type="button"
                  onClick={() => onAdd(cell)}
                  aria-label="Add to this day"
                  // `hover` is behind `@media (hover: hover)`, so on a phone
                  // or a tablet this was invisible and there was no way at all
                  // to add to a particular day. A coarse pointer gets it
                  // always; a mouse still gets it on the way past.
                  className="ml-auto shrink-0 cursor-pointer rounded p-0.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 pointer-coarse:opacity-100 hover:bg-white/10 hover:text-foreground"
                  title="Add to this day"
                >
                  <Plus className="size-3" />
                </button>
              </div>

              <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
                {events.map((event) => (
                  <EventChip
                    key={`${key}-${event._id}`}
                    event={event}
                    timeZone={timeZone}
                    onOpen={() => onOpen(event)}
                    onReply={(answer) => onReply(event, answer)}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- the year */

function MiniMonth({
  year,
  month,
  byDay,
  now,
  timeZone,
  onPick,
}: {
  year: number;
  month: number;
  byDay: Map<string, Card[]>;
  now: number;
  timeZone: string;
  onPick: () => void;
}) {
  const cells = useMemo(() => cal.monthGrid(year, month), [year, month]);
  const todayKey = cal.keyOfInstant(now, timeZone);

  return (
    <button
      type="button"
      onClick={onPick}
      className="flex cursor-pointer flex-col gap-1.5 rounded-xl border border-border/60 bg-card/60 p-2.5 text-left transition-colors hover:border-white/40 hover:bg-white/[0.06]"
      title={`Open ${cal.MONTH_NAMES[month - 1]}`}
    >
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold">
          {cal.MONTH_NAMES[month - 1]}
        </span>
        {cells.some((cell) => cal.dateKey(cell) === todayKey) ? (
          <span className="size-1.5 rounded-full bg-white" />
        ) : null}
      </div>

      <div className="grid grid-cols-7 gap-y-0.5">
        {cal.WEEKDAY_NAMES.map((name) => (
          <span
            key={name}
            className="text-center text-[7px] text-muted-foreground"
          >
            {name[0]}
          </span>
        ))}
        {cells.map((cell) => {
          const key = cal.dateKey(cell);
          const events = byDay.get(key) ?? [];
          const isToday = key === todayKey;
          return (
            <span
              key={key}
              className="flex flex-col items-center gap-px py-px"
              title={`${cell.day} — ${events.length} on`}
            >
              <span
                className={cn(
                  "grid size-3.5 place-items-center rounded-full text-[8px] tabular-nums",
                  isToday && "bg-white font-semibold text-black",
                  !isToday && !cell.inMonth && "text-muted-foreground/40",
                  !isToday && cell.inMonth && "text-muted-foreground",
                )}
              >
                {cell.day}
              </span>
              <span className="flex h-1 items-center gap-px">
                {events.slice(0, 3).map((event) => (
                  <span
                    key={event._id}
                    className="size-1 rounded-full"
                    style={{
                      background: `hsl(${cal.hueFor(event.ownerId)} 38% 62%)`,
                    }}
                  />
                ))}
              </span>
            </span>
          );
        })}
      </div>
    </button>
  );
}

/* ------------------------------------------------------------ the shopping */

function ShoppingCard({
  items,
  onPlan,
}: {
  items: ShoppingItem[];
  onPlan: () => void;
}) {
  const [text, setText] = useState("");
  const add = useMutation(api.calendar.addShoppingItem);
  const toggle = useMutation(api.calendar.toggleShoppingItem);
  const drop = useMutation(api.calendar.removeShoppingItem);
  const clear = useMutation(api.calendar.clearShopping);

  const outstanding = items.filter((item) => !item.done).length;

  return (
    <section className="flex min-w-[190px] shrink-0 flex-col gap-2 overflow-hidden rounded-xl border border-border/70 bg-card/60 p-2.5 lg:min-h-[150px] lg:min-w-0 lg:flex-1">
      <div className="flex items-center gap-1.5">
        <ShoppingCart className="size-3 shrink-0 text-muted-foreground" />
        <span className="text-[10px] font-semibold">Shopping</span>
        <span className="ml-auto text-[9px] text-muted-foreground">
          {outstanding} left
        </span>
      </div>

      <Button
        type="button"
        variant="outline"
        onClick={onPlan}
        className="h-7 cursor-pointer rounded-lg text-[9px]"
      >
        <UtensilsCrossed className="size-3" />
        Plan from meals
      </Button>

      <div className="flex items-center gap-1">
        <Input
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || !text.trim()) return;
            void add({ text });
            setText("");
          }}
          placeholder="Add something…"
          className="h-7 rounded-lg text-[10px]"
        />
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Add to the list"
          disabled={!text.trim()}
          onClick={() => {
            void add({ text });
            setText("");
          }}
          className="shrink-0"
        >
          <Plus className="size-3" />
        </Button>
      </div>

      <ul className="flex max-h-40 min-h-0 flex-col gap-1 overflow-y-auto lg:max-h-none lg:flex-1">
        {items.length ? (
          items.map((item) => (
            <li key={item._id} className="flex items-center gap-1.5">
              <Checkbox
                checked={item.done}
                onCheckedChange={() => void toggle({ id: item._id })}
                className="size-3.5 shrink-0"
              />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-[10px]",
                  item.done && "text-muted-foreground line-through",
                )}
              >
                {item.text}
              </span>
              <button
                type="button"
                aria-label="Remove"
                onClick={() => void drop({ id: item._id })}
                className="shrink-0 cursor-pointer text-muted-foreground hover:text-foreground"
              >
                <X className="size-2.5" />
              </button>
            </li>
          ))
        ) : (
          <li className="text-[9px] leading-4 text-muted-foreground">
            Empty. Plan a meal and its ingredients land here.
          </li>
        )}
      </ul>

      {items.length ? (
        <button
          type="button"
          onClick={() => void clear({ doneOnly: true })}
          className="cursor-pointer text-left text-[9px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          Clear the ones already picked up
        </button>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ feeds */

/**
 * The window a download covers: the last month and the year ahead, so a family
 * can pull their own calendar into Google, Outlook or Apple.
 *
 * Worked out once, when this file loads, rather than inside a render: it is a
 * query argument, so the query must not be handed a fresh object on every pass,
 * and `Date.now()` is not something a render is allowed to call.
 */
const DOWNLOAD_WINDOW = (() => {
  const now = Date.now();
  return {
    from: now - 30 * 24 * 60 * 60 * 1000,
    to: now + 365 * 24 * 60 * 60 * 1000,
  };
})();

function FeedsCard({
  feeds,
  onSync,
  onAdd,
  onImport,
  syncing,
}: {
  feeds: Feed[];
  onSync: (id?: string) => void;
  onAdd: () => void;
  onImport: () => void;
  syncing: boolean;
}) {
  const removeFeed = useMutation(api.calendar.removeFeed);

  // One button per row, each full width: three side by side never fit in a
  // narrow side panel, which is what used to cut them off.
  const rowButton =
    "h-7 w-full cursor-pointer justify-start rounded-lg px-2 text-[9px]";

  const exported = useQuery(api.calendar.exportIcs, DOWNLOAD_WINDOW);

  return (
    <section className="flex min-w-[190px] shrink-0 flex-col gap-2 overflow-hidden rounded-xl border border-border/70 bg-card/60 p-2.5 lg:min-h-[210px] lg:min-w-0 lg:flex-1">
      <div className="flex items-center gap-1.5">
        <Layers className="size-3 shrink-0 text-muted-foreground" />
        <span className="text-[10px] font-semibold">Feeds</span>
        {feeds.length ? (
          <button
            type="button"
            disabled={syncing}
            onClick={() => onSync()}
            className="ml-auto flex cursor-pointer items-center gap-1 text-[9px] text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            {syncing ? (
              <Loader2 className="size-2.5 animate-spin" />
            ) : (
              <RefreshCw className="size-2.5" />
            )}
            Sync
          </button>
        ) : null}
      </div>

      <div className="flex flex-col gap-1">
        <Button
          type="button"
          variant="outline"
          onClick={onAdd}
          className={rowButton}
        >
          <Link2 className="size-3 shrink-0" />
          <span className="truncate">Add an address</span>
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={onImport}
          className={rowButton}
        >
          <Upload className="size-3 shrink-0" />
          <span className="truncate">Upload a .ics file</span>
        </Button>
      </div>

      <Button
        type="button"
        variant="outline"
        disabled={!exported}
        onClick={() => {
          if (!exported) return;
          const blob = new Blob([exported.text], { type: "text/calendar" });
          const url = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = url;
          link.download = exported.filename;
          document.body.appendChild(link);
          link.click();
          link.remove();
          URL.revokeObjectURL(url);
          toast.success("Saved. Import it into Google Calendar.");
        }}
        className={rowButton}
      >
        <Download className="size-3 shrink-0" />
        <span className="truncate">Download .ics</span>
      </Button>

      <ul className="flex max-h-40 min-h-0 flex-col gap-1.5 overflow-y-auto lg:max-h-none lg:flex-1">
        {feeds.length ? (
          feeds.map((feed) => (
            <li key={feed._id} className="flex items-start gap-1.5">
              <span className="grid size-4 shrink-0 place-items-center rounded border border-border/60 text-[7px] uppercase">
                {feed.provider.slice(0, 3)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[10px]">{feed.name}</span>
                <span className="block truncate text-[8px] text-muted-foreground">
                  {feed.lastError
                    ? feed.lastError
                    : feed.lastSyncedAt
                      ? `Synced ${new Date(feed.lastSyncedAt).toLocaleTimeString()}`
                      : "Never synced"}
                </span>
              </span>
              <button
                type="button"
                aria-label={`Remove ${feed.name}`}
                onClick={() => void removeFeed({ id: feed._id })}
                className="shrink-0 cursor-pointer text-muted-foreground hover:text-foreground"
              >
                <Trash2 className="size-2.5" />
              </button>
            </li>
          ))
        ) : (
          <li className="text-[9px] leading-4 text-muted-foreground">
            Nothing imported. A feed's entries stay on your own layer.
          </li>
        )}
      </ul>
    </section>
  );
}

/* ------------------------------------------------------------------ dialog */

type Draft = {
  id: Id<"calendarEvents"> | null;
  title: string;
  kind: CalendarKind;
  layer: CalendarLayer;
  allDay: boolean;
  start: string;
  end: string;
  location: string;
  notes: string;
  place: string;
  appointmentType: string;
  recipeUrl: string;
  ingredients: string;
  // a booking portal, a video call, or the recipe a meal came from
  link: string;
  // a single emoji beside the title, and how long before it the alarm rings
  // (an empty string is no emoji, and an empty alarm string is no alarm)
  emoji: string;
  alarm: string;
  // how much it wants to be noticed (null is the quiet default)
  priority: CalendarPriority | null;
  // the money side, kept as text while it is being typed
  cost: string;
  costStatus: CalendarCostStatus | null;
  paidBy: string;
  // Who it is for, and — when that is a few of them — which of them.
  audience: CalendarAudience;
  attendees: Id<"users">[];
};

/**
 * The value a date field wants, for either shape of entry.
 *
 * An all-day entry is a whole day, so its field is a plain date; everything
 * else is a moment, so its field is a datetime. Both keep the same wall clock
 * in the draft, which is why switching between them has to put the missing
 * half back: a date-only string is not a value a `datetime-local` field will
 * accept, and the browser blanks the field rather than showing it.
 */
function inputValue(value: string, allDay: boolean) {
  const date = value.slice(0, 10);
  return allDay ? date : `${date}T${value.slice(11, 16) || "09:00"}`;
}

function roundHour(instant: number) {
  const date = new Date(instant);
  date.setMinutes(0, 0, 0);
  date.setHours(date.getHours() + 1);
  return date.getTime();
}

function emptyDraft(timeZone: string, date?: cal.CalendarDate): Draft {
  const startInstant = date
    ? cal.instantFromWall(date.year, date.month, date.day, 9, 0, 0, timeZone)
    : roundHour(Date.now());
  return {
    id: null,
    title: "",
    kind: "appointment",
    layer: "personal",
    allDay: false,
    start: cal.toLocalInput(startInstant, timeZone),
    end: cal.toLocalInput(startInstant + 60 * 60 * 1000, timeZone),
    location: "",
    notes: "",
    place: "",
    appointmentType: "",
    recipeUrl: "",
    ingredients: "",
    link: "",
    emoji: "",
    alarm: "",
    priority: null,
    cost: "",
    costStatus: null,
    paidBy: "",
    audience: "family",
    attendees: [],
  };
}

function draftFrom(event: Card, timeZone: string): Draft {
  return {
    id: event._id,
    title: event.title,
    kind: event.kind,
    layer: event.layer,
    allDay: event.allDay,
    start: cal.toLocalInput(event.startsAt, timeZone),
    end: cal.toLocalInput(event.endsAt, timeZone),
    location: event.location ?? "",
    notes: event.notes ?? "",
    place: event.place ?? "",
    appointmentType: event.appointmentType ?? "",
    recipeUrl: event.recipeUrl ?? "",
    ingredients: event.ingredients.join(", "),
    link: event.link ?? "",
    emoji: event.emoji ?? "",
    alarm: event.alarmMinutes === null ? "" : String(event.alarmMinutes),
    priority: event.priority,
    cost: event.cost === null ? "" : String(event.cost),
    costStatus: event.costStatus,
    paidBy: event.paidBy ?? "",
    audience: event.audience,
    attendees: event.attendeeIds,
  };
}

function EventDialog({
  open,
  onOpenChange,
  draft,
  setDraft,
  timeZone,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  draft: Draft | null;
  setDraft: (draft: Draft) => void;
  timeZone: string;
  onSaved: () => void;
}) {
  const create = useMutation(api.calendar.create);
  const update = useMutation(api.calendar.update);
  // Who else is in this family, so a "few of us" entry can name them. The
  // server matches them again, so nothing here is trusted on its own.
  const family = useQuery(api.family.mine, {});
  const members = (family?.members ?? []).filter((member) => !member.isMe);
  const [saving, setSaving] = useState(false);

  if (!draft) return null;

  const isRequest = cal.REQUEST_KINDS.has(draft.kind);
  const isMeal = cal.isMealKind(draft.kind);
  // Read once, outside the markup: the request preview needs the instant the
  // typed-in wall clock stands for, and working that out mid-render is a clock
  // read in the middle of one.
  const startsAtPreview = cal.fromLocalInput(draft.start, timeZone);

  const save = async () => {
    const startsAt = cal.fromLocalInput(draft.start, timeZone);
    const endsAt = cal.fromLocalInput(draft.end, timeZone);
    if (startsAt === null) {
      toast.error("That start time does not look right.");
      return;
    }

    setSaving(true);
    try {
      // A "few of us" with nobody ticked would be visible to its owner alone,
      // which is never what was meant, so it falls back to the family.
      const audience: CalendarAudience =
        draft.audience === "group" && !draft.attendees.length
          ? "family"
          : draft.audience;

      const shared = {
        title: draft.title.trim() || undefined,
        kind: draft.kind,
        layer: draft.layer,
        startsAt,
        endsAt: endsAt ?? startsAt + 60 * 60 * 1000,
        allDay: draft.allDay,
        timeZone,
        location: draft.location.trim() || undefined,
        notes: draft.notes.trim() || undefined,
        place: draft.place.trim() || undefined,
        appointmentType: draft.appointmentType.trim() || undefined,
        recipeUrl: draft.recipeUrl.trim() || undefined,
        ingredients: draft.ingredients
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
        link: draft.link.trim() || undefined,
        emoji: draft.emoji.trim() || undefined,
        alarmMinutes: draft.alarm === "" ? undefined : Number(draft.alarm),
        priority: draft.priority ?? undefined,
        cost: draft.cost.trim() ? Number(draft.cost) : undefined,
        costStatus: draft.costStatus ?? undefined,
        paidBy: draft.paidBy.trim() || undefined,
        audience,
        attendees: audience === "group" ? draft.attendees : [],
      };

      if (draft.id) {
        await update({ id: draft.id, ...shared });
      } else {
        await create(shared);
      }

      toast.success(draft.id ? "Changed." : "On the calendar.");
      onSaved();
      onOpenChange(false);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "That did not save.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] overflow-y-auto border-border/70 bg-card/95 backdrop-blur-sm sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-[13px]">
            {draft.id ? "Change this entry" : "Put something on the calendar"}
          </DialogTitle>
          <DialogDescription className="text-[10px]">
            Times are in {timeZone}. Everything else on the page moves if that
            changes, because each entry is stored as a moment, not a string.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="grid gap-1.5">
            <Label className="text-[10px]">What is it</Label>
            <Select
              value={draft.kind}
              onValueChange={(kind) =>
                setDraft({
                  ...draft,
                  kind: kind as CalendarKind,
                  layer: cal.layerForKind(kind),
                })
              }
            >
              <SelectTrigger className="h-9 cursor-pointer rounded-lg text-[11px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {KINDS.map((kind) => (
                  <SelectItem key={kind} value={kind} className="text-[11px]">
                    {KIND_LABELS[kind] ?? kind}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {isRequest ? (
            <>
              <p className="rounded-lg border border-dashed border-border/70 px-2.5 py-2 text-[9px] leading-4 text-muted-foreground">
                Leave the title empty and the card writes the headline for you,
                in the words your family answers with: what it is, where it
                goes
                {draft.place ? ` (${draft.place})` : ""}
                {draft.appointmentType
                  ? `, what it is for (${draft.appointmentType})`
                  : ""}
                , and that it starts at{" "}
                <span className="text-foreground">
                  {startsAtPreview === null
                    ? "the time you set"
                    : cal.clockText(startsAtPreview, timeZone)}
                </span>
                . It arrives with the buttons your family answers with.
              </p>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label className="text-[10px]">Where to</Label>
                  <Input
                    value={draft.place}
                    onChange={(event) =>
                      setDraft({ ...draft, place: event.target.value })
                    }
                    placeholder="the clinic"
                    className="h-9 rounded-lg text-[11px]"
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label className="text-[10px]">What for</Label>
                  <Input
                    value={draft.appointmentType}
                    onChange={(event) =>
                      setDraft({ ...draft, appointmentType: event.target.value })
                    }
                    placeholder="a scan"
                    className="h-9 rounded-lg text-[11px]"
                  />
                </div>
              </div>
            </>
          ) : (
            <div className="grid gap-1.5">
              <Label className="text-[10px]">Title</Label>
              <Input
                value={draft.title}
                onChange={(event) =>
                  setDraft({ ...draft, title: event.target.value })
                }
                placeholder={
                  isMeal
                    ? "Chicken dinner"
                    : 'Example: "Kids Gone Adult Time"'
                }
                className="h-9 rounded-lg text-[11px]"
              />
            </div>
          )}

          <label className="flex cursor-pointer items-center gap-2">
            <Checkbox
              checked={draft.allDay}
              onCheckedChange={(checked) => {
                const allDay = checked === true;
                setDraft({
                  ...draft,
                  allDay,
                  start: inputValue(draft.start, allDay),
                  end: inputValue(draft.end, allDay),
                });
              }}
              className="size-3.5"
            />
            <span className="text-[10px]">All day</span>
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label className="text-[10px]">Starts</Label>
              <Input
                type={draft.allDay ? "date" : "datetime-local"}
                value={inputValue(draft.start, draft.allDay)}
                onChange={(event) =>
                  setDraft({ ...draft, start: event.target.value })
                }
                className="h-9 rounded-lg text-[11px]"
              />
            </div>
            <div className="grid gap-1.5">
              <Label className="text-[10px]">Ends</Label>
              <Input
                type={draft.allDay ? "date" : "datetime-local"}
                value={inputValue(draft.end, draft.allDay)}
                onChange={(event) =>
                  setDraft({ ...draft, end: event.target.value })
                }
                className="h-9 rounded-lg text-[11px]"
              />
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label className="text-[10px]">Where</Label>
            <Input
              value={draft.location}
              onChange={(event) =>
                setDraft({ ...draft, location: event.target.value })
              }
              placeholder="Optional"
              className="h-9 rounded-lg text-[11px]"
            />
          </div>

          <div className="grid gap-1.5">
            <Label className="text-[10px]">Emoji</Label>
            <div className="flex flex-wrap items-center gap-1">
              <Input
                value={draft.emoji}
                onChange={(event) =>
                  setDraft({ ...draft, emoji: event.target.value })
                }
                placeholder="⭐"
                className="h-9 w-14 rounded-lg text-center text-[14px]"
              />
              {EMOJIS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  onClick={() =>
                    setDraft({
                      ...draft,
                      emoji: draft.emoji === emoji ? "" : emoji,
                    })
                  }
                  className={cn(
                    "grid size-7 cursor-pointer place-items-center rounded-lg border text-[13px] transition-colors",
                    draft.emoji === emoji
                      ? "border-white/60 bg-white/10"
                      : "border-border/60 hover:bg-white/5",
                  )}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label className="text-[10px]">Priority</Label>
              <Select
                value={draft.priority ?? "normal"}
                onValueChange={(value) =>
                  setDraft({
                    ...draft,
                    priority:
                      value === "normal" ? null : (value as CalendarPriority),
                  })
                }
              >
                <SelectTrigger className="h-9 cursor-pointer rounded-lg text-[11px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="normal" className="text-[11px]">
                    Normal
                  </SelectItem>
                  <SelectItem value="low" className="text-[11px]">
                    Low
                  </SelectItem>
                  <SelectItem value="medium" className="text-[11px]">
                    Medium
                  </SelectItem>
                  <SelectItem value="high" className="text-[11px]">
                    High
                  </SelectItem>
                  <SelectItem value="urgent" className="text-[11px]">
                    Urgent
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label className="text-[10px]">Link</Label>
              <Input
                value={draft.link}
                onChange={(event) =>
                  setDraft({ ...draft, link: event.target.value })
                }
                placeholder="Video call, booking, recipe…"
                className="h-9 rounded-lg text-[11px]"
              />
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label className="text-[10px]">Alarm</Label>
            <Select
              value={draft.alarm === "" ? "none" : draft.alarm}
              onValueChange={(value) =>
                setDraft({ ...draft, alarm: value === "none" ? "" : value })
              }
            >
              <SelectTrigger className="h-9 cursor-pointer rounded-lg text-[11px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none" className="text-[11px]">
                  No alarm
                </SelectItem>
                <SelectItem value="0" className="text-[11px]">
                  At the start
                </SelectItem>
                <SelectItem value="15" className="text-[11px]">
                  15 minutes before
                </SelectItem>
                <SelectItem value="30" className="text-[11px]">
                  30 minutes before
                </SelectItem>
                <SelectItem value="60" className="text-[11px]">
                  1 hour before
                </SelectItem>
                <SelectItem value="120" className="text-[11px]">
                  2 hours before
                </SelectItem>
                <SelectItem value="1440" className="text-[11px]">
                  1 day before
                </SelectItem>
              </SelectContent>
            </Select>
            <p className="text-[10px] text-muted-foreground">
              {draft.alarm === ""
                ? "No reminder is set for this one."
                : `A reminder rings ${alarmLabel(
                    Number(draft.alarm),
                  )} ahead and lands in your reminders list.`}
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="grid gap-1.5">
              <Label className="text-[10px]">Cost</Label>
              <Input
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                value={draft.cost}
                onChange={(event) =>
                  setDraft({ ...draft, cost: event.target.value })
                }
                placeholder="0.00"
                className="h-9 rounded-lg text-[11px]"
              />
            </div>
            <div className="grid gap-1.5">
              <Label className="text-[10px]">Payment</Label>
              <Select
                value={draft.costStatus ?? "unpaid"}
                onValueChange={(value) =>
                  setDraft({ ...draft, costStatus: value as CalendarCostStatus })
                }
              >
                <SelectTrigger className="h-9 cursor-pointer rounded-lg text-[11px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="unpaid" className="text-[11px]">
                    Unpaid
                  </SelectItem>
                  <SelectItem value="paid" className="text-[11px]">
                    Paid
                  </SelectItem>
                  <SelectItem value="reimbursement" className="text-[11px]">
                    Reimbursement
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label className="text-[10px]">Paid by</Label>
              <Input
                value={draft.paidBy}
                onChange={(event) =>
                  setDraft({ ...draft, paidBy: event.target.value })
                }
                placeholder="Optional"
                className="h-9 rounded-lg text-[11px]"
              />
            </div>
          </div>

          {isMeal ? (
            <>
              <div className="grid gap-1.5">
                <Label className="text-[10px]">Recipe link</Label>
                <Input
                  value={draft.recipeUrl}
                  onChange={(event) =>
                    setDraft({ ...draft, recipeUrl: event.target.value })
                  }
                  placeholder="https://…"
                  className="h-9 rounded-lg text-[11px]"
                />
              </div>
              <div className="grid gap-1.5">
                <Label className="text-[10px]">
                  Ingredients — comma separated; these fill the shopping list
                </Label>
                <Textarea
                  value={draft.ingredients}
                  onChange={(event) =>
                    setDraft({ ...draft, ingredients: event.target.value })
                  }
                  placeholder="chicken, rice, lemon"
                  className="min-h-16 rounded-lg text-[11px]"
                />
              </div>
            </>
          ) : null}

          <div className="grid gap-1.5">
            <Label className="text-[10px]">Notes</Label>
            <Textarea
              value={draft.notes}
              onChange={(event) =>
                setDraft({ ...draft, notes: event.target.value })
              }
              placeholder="Anything worth remembering"
              className="min-h-16 rounded-lg text-[11px]"
            />
          </div>

          <div className="grid gap-1.5">
            <Label className="text-[10px]">Layer</Label>
            <Select
              value={draft.layer}
              onValueChange={(layer) =>
                setDraft({ ...draft, layer: layer as CalendarLayer })
              }
            >
              <SelectTrigger className="h-9 cursor-pointer rounded-lg text-[11px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LAYER_META.map((meta) => (
                  <SelectItem
                    key={meta.key}
                    value={meta.key}
                    className="text-[11px]"
                  >
                    {meta.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-1.5">
            <Label className="text-[10px]">Who is this for</Label>
            <Select
              value={draft.audience}
              onValueChange={(audience) =>
                setDraft({
                  ...draft,
                  audience: audience as CalendarAudience,
                  attendees: audience === "group" ? draft.attendees : [],
                })
              }
            >
              <SelectTrigger className="h-9 cursor-pointer rounded-lg text-[11px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="private" className="text-[11px]">
                  Just me
                </SelectItem>
                <SelectItem value="group" className="text-[11px]">
                  A few of us
                </SelectItem>
                <SelectItem value="family" className="text-[11px]">
                  Everyone
                </SelectItem>
              </SelectContent>
            </Select>
            <p className="text-[10px] text-muted-foreground">
              {draft.audience === "private"
                ? "Only your page shows this, and only you are reminded of it."
                : draft.audience === "group"
                  ? "Only the people you tick below can see it."
                  : "The whole family sees this one."}
            </p>
          </div>

          {draft.audience === "group" ? (
            members.length ? (
              <div className="grid gap-1.5">
                <Label className="text-[10px]">Which of them</Label>
                <div className="flex flex-wrap gap-1.5">
                  {members.map((member) => (
                    <label
                      key={member._id}
                      className="flex cursor-pointer items-center gap-1.5 rounded-full border border-white/20 px-2 py-1"
                    >
                      <Checkbox
                        checked={draft.attendees.includes(
                          member._id as Id<"users">,
                        )}
                        onCheckedChange={(checked) =>
                          setDraft({
                            ...draft,
                            attendees:
                              checked === true
                                ? [
                                    ...draft.attendees,
                                    member._id as Id<"users">,
                                  ]
                                : draft.attendees.filter(
                                    (id) => id !== (member._id as Id<"users">),
                                  ),
                          })
                        }
                        className="size-3.5"
                      />
                      <span className="text-[10px]">{member.name}</span>
                    </label>
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-[10px] text-muted-foreground">
                Nobody else is in the family yet, so this one goes to all of you
                once they are.
              </p>
            )
          ) : null}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            className="h-9 cursor-pointer rounded-lg text-[11px]"
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={saving}
            onClick={() => void save()}
            className="h-9 cursor-pointer rounded-lg text-[11px]"
          >
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {draft.id ? "Save changes" : "Put it on"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------- a card, opened */

function EventDetail({
  event,
  timeZone,
  onClose,
  onEdit,
  onReply,
  onDelete,
}: {
  event: Card;
  timeZone: string;
  onClose: () => void;
  onEdit: () => void;
  onReply: (answer: string) => void;
  onDelete: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent className="max-h-[88vh] overflow-y-auto border-border/70 bg-card/95 backdrop-blur-sm sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-start gap-2 text-[13px] leading-snug">
            <Who id={event.ownerId} name={event.ownerName} size={20} />
            <span className="min-w-0">
              {event.emoji ? `${event.emoji} ` : ""}
              {event.title}
            </span>
          </DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-1.5 text-[10px]">
            <span>{KIND_LABELS[event.kind] ?? event.kind}</span>
            <LayerBadge layer={event.layer} />
            {event.readOnly ? (
              <span className="rounded-full border border-border/60 px-1.5 py-px text-[8px]">
                Imported
              </span>
            ) : null}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 text-[11px]">
          <div className="flex items-start gap-2 text-muted-foreground">
            <CalendarDays className="mt-0.5 size-3.5 shrink-0" />
            <span>
              {event.allDay
                ? `${cal.shortDate(event.startsAt, timeZone)} — all day`
                : `${cal.shortDate(event.startsAt, timeZone)}, ${cal.clockText(
                    event.startsAt,
                    timeZone,
                  )} to ${cal.clockText(event.endsAt, timeZone)}`}
              <span className="ml-1 text-[9px]">({timeZone})</span>
            </span>
          </div>

          {event.location ? (
            <div className="flex items-start gap-2 text-muted-foreground">
              <MapPin className="mt-0.5 size-3.5 shrink-0" />
              <span>{event.location}</span>
            </div>
          ) : null}

          {event.priority ? (
            <div className="flex items-start gap-2 text-muted-foreground">
              <Flag className="mt-0.5 size-3.5 shrink-0" />
              <span>{PRIORITY_LABELS[event.priority]} priority</span>
            </div>
          ) : null}

          {event.alarmMinutes !== null ? (
            <div className="flex items-start gap-2 text-muted-foreground">
              <Bell className="mt-0.5 size-3.5 shrink-0" />
              <span>
                {event.alarmMinutes === 0
                  ? "Reminder at the start"
                  : `Reminder ${alarmLabel(event.alarmMinutes)} before`}
              </span>
            </div>
          ) : null}

          {event.cost !== null ? (
            <div className="flex items-start gap-2 text-muted-foreground">
              <CircleDollarSign className="mt-0.5 size-3.5 shrink-0" />
              <span>
                {formatMoney(event.cost)} ·{" "}
                {event.costStatus === "paid"
                  ? "paid"
                  : event.costStatus === "reimbursement"
                    ? "reimbursement requested"
                    : "unpaid"}
                {event.paidBy ? ` · ${event.paidBy}` : ""}
              </span>
            </div>
          ) : null}

          {event.link ? (
            <a
              href={event.link}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 text-[11px] underline-offset-2 hover:underline"
            >
              <Link2 className="size-3.5" />
              Open the link
            </a>
          ) : null}

          {event.notes ? (
            <p className="leading-5 text-muted-foreground">{event.notes}</p>
          ) : null}

          {event.recipeUrl ? (
            <a
              href={event.recipeUrl}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 text-[11px] underline-offset-2 hover:underline"
            >
              <UtensilsCrossed className="size-3.5" />
              Open the recipe
            </a>
          ) : null}

          {event.ingredients.length ? (
            <div>
              <p className="text-[9px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
                Ingredients
              </p>
              <ul className="mt-1 flex flex-wrap gap-1">
                {event.ingredients.map((item) => (
                  <li
                    key={item}
                    className="rounded-full border border-border/60 px-2 py-0.5 text-[10px]"
                  >
                    {item}
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 text-[9px] text-muted-foreground">
                &ldquo;Plan from meals&rdquo; in the side panel turns these into
                a shopping list.
              </p>
            </div>
          ) : null}

          {event.options.length ? (
            <div className="rounded-xl border border-border/70 bg-card/60 p-2.5">
              <p className="flex items-center gap-1.5 text-[10px] font-semibold">
                <HeartHandshake className="size-3.5" />
                Who can help
              </p>

              {event.replies.length ? (
                <ul className="mt-1.5 flex flex-col gap-1">
                  {event.replies.map((reply) => (
                    <li
                      key={reply.userId}
                      className="flex items-center gap-1.5 text-[10px]"
                    >
                      <Who id={reply.userId} name={reply.name} size={14} />
                      <span className="text-muted-foreground">
                        {reply.mine ? "You" : reply.name}:
                      </span>
                      <span>{reply.answer}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-[9px] text-muted-foreground">
                  Nobody has answered yet.
                </p>
              )}

              <div className="mt-2 flex flex-wrap gap-1.5">
                {event.options.map((option) => {
                  const mine = event.replies.find((reply) => reply.mine);
                  return (
                    <Button
                      key={option}
                      type="button"
                      variant={mine?.answer === option ? "default" : "outline"}
                      size="sm"
                      onClick={() => onReply(option)}
                      className="h-7 cursor-pointer rounded-lg text-[10px]"
                    >
                      {mine?.answer === option ? (
                        <Check className="size-3" />
                      ) : null}
                      {option}
                    </Button>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <div className="flex gap-2">
            {event.readOnly ? null : (
              <>
                <Button
                  type="button"
                  variant="outline"
                  onClick={onEdit}
                  className="h-9 cursor-pointer rounded-lg text-[11px]"
                >
                  <Pencil className="size-3.5" />
                  Change
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={onDelete}
                  className="h-9 cursor-pointer rounded-lg text-[11px] text-muted-foreground hover:text-foreground"
                >
                  <Trash2 className="size-3.5" />
                  Remove
                </Button>
              </>
            )}
          </div>
          <Button
            type="button"
            variant="ghost"
            onClick={onClose}
            className="h-9 cursor-pointer rounded-lg text-[11px]"
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* --------------------------------------------------------------- the shopping plan */

function PlanDialog({
  open,
  onOpenChange,
  timeZone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  timeZone: string;
}) {
  const plan = useMutation(api.calendar.planShopping);
  const [days, setDays] = useState("7");
  const [going, setGoing] = useState(true);
  const [storeAt, setStoreAt] = useState(() =>
    cal.toLocalInput(roundHour(Date.now()) + 24 * 60 * 60 * 1000, timeZone),
  );
  const [busy, setBusy] = useState(false);

  const run = async () => {
    const from = Date.now();
    const to = from + Math.max(1, Number(days) || 7) * 24 * 60 * 60 * 1000;
    const store = going ? cal.fromLocalInput(storeAt, timeZone) : null;

    setBusy(true);
    try {
      const result = await plan({
        from,
        to,
        storeAt: store ?? undefined,
      });
      toast.success(
        result.added
          ? `${result.added} thing${result.added === 1 ? "" : "s"} added from ${
              result.meals
            } planned meal${result.meals === 1 ? "" : "s"}.`
          : result.meals
            ? "Those meals have no ingredients on them yet."
            : "Nothing planned in that window — pin a meal first.",
      );
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-[13px]">
            One list for the meals ahead
          </DialogTitle>
          <DialogDescription className="text-[10px]">
            Every ingredient on every meal in the window, gathered into one
            checklist. Nothing already on the list is added twice.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="grid gap-1.5">
            <Label className="text-[10px]">Meals planned in the next</Label>
            <Select value={days} onValueChange={setDays}>
              <SelectTrigger className="h-9 cursor-pointer rounded-lg text-[11px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {["1", "3", "7", "14", "30"].map((value) => (
                  <SelectItem key={value} value={value} className="text-[11px]">
                    {value} day{value === "1" ? "" : "s"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <label className="flex cursor-pointer items-center gap-2">
            <Checkbox
              checked={going}
              onCheckedChange={(checked) => setGoing(checked === true)}
              className="size-3.5"
            />
            <span className="text-[10px]">
              I am going to the store — put that on the calendar and remind me
              first
            </span>
          </label>

          {going ? (
            <div className="grid gap-1.5">
              <Label className="text-[10px]">Going at</Label>
              <Input
                type="datetime-local"
                value={storeAt}
                onChange={(event) => setStoreAt(event.target.value)}
                className="h-9 rounded-lg text-[11px]"
              />
              <p className="text-[9px] leading-4 text-muted-foreground">
                The trip goes on the calendar, and a reminder fires half an hour
                before it.
              </p>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            className="h-9 cursor-pointer rounded-lg text-[11px]"
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={busy}
            onClick={() => void run()}
            className="h-9 cursor-pointer rounded-lg text-[11px]"
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
            Build the list
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FeedDialog({
  open,
  onOpenChange,
  timeZone,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  timeZone: string;
  onDone: (id?: string) => void;
}) {
  const addFeed = useMutation(api.calendar.addFeed);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      const id = await addFeed({ name: name || "Imported calendar", url });
      onOpenChange(false);
      setName("");
      setUrl("");
      onDone(id as string);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "That did not save.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-[13px]">
            Stream in another calendar
          </DialogTitle>
          <DialogDescription className="text-[10px] leading-4">
            Google, Outlook, iCloud and anything else that hands out a private
            iCal address. The entries land on your own layer, so nobody else in
            the family sees your work roster.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="grid gap-1.5">
            <Label className="text-[10px]">Call it</Label>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Work roster"
              className="h-9 rounded-lg text-[11px]"
            />
          </div>
          <div className="grid gap-1.5">
            <Label className="text-[10px]">The calendar address</Label>
            <Input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://calendar.google.com/…/basic.ics"
              className="h-9 rounded-lg text-[11px]"
            />
            <p className="text-[9px] leading-4 text-muted-foreground">
              A repeating event imports as its first occurrence — the reader
              does not expand recurrence rules, and says so rather than quietly
              getting it wrong. Times are read in {timeZone}.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            className="h-9 cursor-pointer rounded-lg text-[11px]"
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={busy || !url.trim()}
            onClick={() => void save()}
            className="h-9 cursor-pointer rounded-lg text-[11px]"
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
            Add and sync
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* --------------------------------------------------------------- the page */

export default function CalendarPage() {
  const [now, setNow] = useState(() => Date.now());
  // The grid only ever needs the minute: the one place seconds matter is the
  // clock in the header, and that ticks itself. A tick a second here re-rendered
  // every cell, every card and — in the year view — twelve mini-months, sixty
  // times a minute, on a page that can be holding six hundred entries.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const [year, setYear] = useState(
    () => cal.partsInZone(Date.now(), cal.DEFAULT_TIME_ZONE).year,
  );
  const [month, setMonth] = useState(
    () => cal.partsInZone(Date.now(), cal.DEFAULT_TIME_ZONE).month,
  );
  const [zoom, setZoom] = useState(false);
  const [timeZone, setTimeZone] = useState(cal.DEFAULT_TIME_ZONE);
  const [syncing, setSyncing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // The window asked of the server is exactly the days the grid draws — all six
  // weeks of it. "The month and a bit" was not the same thing: the grid runs on
  // past the end of its own month (a 28-day February spills two weeks into
  // March, and a 31-day month beginning on a Sunday eleven days), so with a
  // fixed eight-day pad the greyed-out tail of the grid was drawn but never
  // fetched, and stayed empty however much was on those days. The year view had
  // the same hole at its January and December edges.
  const range = useMemo(() => {
    const firstOf = zoom ? 1 : month;
    const lastOf = zoom ? 12 : month;
    const first = cal.monthGrid(year, firstOf)[0];
    const after = cal.shiftDate(cal.monthGrid(year, lastOf)[41], 1);
    return {
      from: cal.instantFromWall(
        first.year,
        first.month,
        first.day,
        0,
        0,
        0,
        timeZone,
      ),
      to: cal.instantFromWall(
        after.year,
        after.month,
        after.day,
        0,
        0,
        0,
        timeZone,
      ),
    };
  }, [zoom, year, month, timeZone]);

  const state = useQuery(api.calendar.state, range);

  // The timezone is stored per person, so the first read of it only happens
  // once — after that the picker is in charge and nothing snaps back.
  const adopted = useRef(false);
  useEffect(() => {
    if (adopted.current || !state) return;
    adopted.current = true;
    if (state.prefs.timeZone) setTimeZone(state.prefs.timeZone);
  }, [state]);

  const savePrefs = useMutation(api.calendar.savePrefs);
  const reply = useMutation(api.calendar.reply);
  const removeEvent = useMutation(api.calendar.remove);
  const importIcsFile = useMutation(api.calendar.importIcs);
  const syncFeeds = useAction(api.calendar.syncFeeds);

  const [hidden, setHidden] = useState<string[] | null>(null);
  const effectiveHidden = useMemo(
    () => hidden ?? state?.prefs.hiddenLayers ?? [],
    [hidden, state],
  );

  const [editing, setEditing] = useState<Draft | null>(null);
  const [openEvent, setOpenEvent] = useState<Card | null>(null);
  const [planOpen, setPlanOpen] = useState(false);
  const [feedOpen, setFeedOpen] = useState(false);

  const byDay = useMemo(() => {
    const hiddenSet = new Set(effectiveHidden);
    const map = new Map<string, Card[]>();
    for (const event of state?.events ?? []) {
      if (hiddenSet.has(event.layer)) continue;
      for (const key of cal.daysCovered(event, timeZone)) {
        const list = map.get(key) ?? [];
        list.push(event);
        map.set(key, list);
      }
    }
    for (const list of map.values()) {
      list.sort((a, b) => {
        if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
        return a.startsAt - b.startsAt;
      });
    }
    return map;
  }, [state, timeZone, effectiveHidden]);

  const todayKey = cal.keyOfInstant(now, timeZone);

  const goToday = useCallback(() => {
    const parts = cal.partsInZone(Date.now(), timeZone);
    setYear(parts.year);
    setMonth(parts.month);
    setZoom(false);
  }, [timeZone]);

  const step = useCallback(
    (by: number) => {
      // In the year view the arrows move the year, not the month: on "All of
      // 2026" there is no month on screen to move, and leaving them on the
      // month made the two buttons do nothing at all.
      if (zoom) {
        setYear((current) => current + by);
        return;
      }

      const moved = new Date(Date.UTC(year, month - 1 + by, 1));
      setYear(moved.getUTCFullYear());
      setMonth(moved.getUTCMonth() + 1);
    },
    [zoom, year, month],
  );

  const toggleLayer = (key: string) => {
    const next = effectiveHidden.includes(key)
      ? effectiveHidden.filter((entry) => entry !== key)
      : [...effectiveHidden, key];
    setHidden(next);
    void savePrefs({ hiddenLayers: next });
  };

  const changeZone = (zone: string) => {
    setTimeZone(zone);
    void savePrefs({ timeZone: zone });
  };

  const openNew = (date?: cal.CalendarDate) => {
    setOpenEvent(null);
    setEditing(emptyDraft(timeZone, date));
  };

  // The reader lives on the server, so a pasted file and a live address go
  // through exactly the same parser.
  const onImportPicked = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    try {
      const imported = await importIcsFile({
        name: file.name,
        text: await file.text(),
      });
      toast.success(
        `${imported.imported} entr${imported.imported === 1 ? "y" : "ies"} imported from ${file.name}.`,
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not read that file.",
      );
    }
  };

  const runSync = async (id?: string) => {
    setSyncing(true);
    try {
      const results = await syncFeeds(
        id ? { id: id as Id<"calendarFeeds"> } : {},
      );
      const total = results.reduce((sum, one) => sum + one.imported, 0);
      const failed = results.filter((one) => !one.ok);
      if (failed.length) {
        toast.error(failed[0].error ?? "A feed did not answer.");
      } else {
        toast.success(`${total} entries up to date.`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Sync failed.");
    } finally {
      setSyncing(false);
    }
  };

  const busy = state === undefined;

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      {/* ------------------------------------------------ clock and controls */}
      <motion.header
        {...RISE}
        transition={{ duration: 0.25 }}
        className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border border-border/70 bg-card/70 px-3 py-2 backdrop-blur-sm"
      >
        <LiveClock timeZone={timeZone} />

        <TimeZonePicker value={timeZone} onChange={changeZone} now={now} />

        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <div className="flex items-center gap-1 rounded-lg border border-border/60 p-0.5">
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="Previous"
              onClick={() => step(-1)}
              className="text-muted-foreground hover:text-foreground"
            >
              <ChevronLeft className="size-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={goToday}
              className="h-7 cursor-pointer rounded-md px-2 text-[10px]"
            >
              Today
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="Next"
              onClick={() => step(1)}
              className="text-muted-foreground hover:text-foreground"
            >
              <ChevronRight className="size-3.5" />
            </Button>
          </div>

          <div className="flex items-center gap-1 rounded-lg border border-border/60 p-0.5">
            <Button
              type="button"
              variant={zoom ? "ghost" : "secondary"}
              onClick={() => setZoom(false)}
              className="h-7 cursor-pointer rounded-md px-2 text-[10px]"
            >
              {cal.MONTH_NAMES[month - 1].slice(0, 3)} {year}
            </Button>
            <Button
              type="button"
              variant={zoom ? "secondary" : "ghost"}
              onClick={() => setZoom(true)}
              className="h-7 cursor-pointer rounded-md px-2 text-[10px]"
            >
              All of {year}
            </Button>
          </div>

          <Button
            type="button"
            onClick={() => openNew()}
            className="h-8 cursor-pointer rounded-lg text-[11px]"
          >
            <CalendarPlus className="size-3.5" />
            New
          </Button>
        </div>
      </motion.header>

      <div className="flex min-h-0 flex-1 flex-col gap-2 lg:flex-row">
        {/* ------------------------------------------------------- side panel */}
        <aside className="flex max-h-[45vh] min-h-0 shrink-0 items-start gap-2 overflow-x-auto overflow-y-auto overscroll-contain pb-1 lg:h-full lg:max-h-none lg:w-[224px] lg:flex-col lg:items-stretch lg:overflow-x-hidden lg:overflow-y-auto lg:pb-0">
          <section className="flex min-w-[190px] shrink-0 flex-col gap-1.5 rounded-xl border border-border/70 bg-card/60 p-2.5 lg:min-h-0 lg:min-w-0">
            <div className="flex items-center gap-1.5">
              <Layers className="size-3 shrink-0 text-muted-foreground" />
              <span className="text-[10px] font-semibold">Layers</span>
            </div>

            {LAYER_META.map((meta) => {
              const on = !effectiveHidden.includes(meta.key);
              const count = (state?.events ?? []).filter(
                (event) => event.layer === meta.key,
              ).length;

              return (
                <button
                  key={meta.key}
                  type="button"
                  onClick={() => toggleLayer(meta.key)}
                  title={meta.blurb}
                  className="flex cursor-pointer items-start gap-2 rounded-lg px-1 py-1 text-left transition-colors hover:bg-white/5"
                >
                  <span
                    className={cn(
                      "mt-px grid size-3.5 shrink-0 place-items-center rounded border",
                      on
                        ? "border-white/70 bg-white/20 text-white"
                        : "border-border/70 text-transparent",
                    )}
                  >
                    <Check className="size-2.5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        "block break-words text-[10px] leading-tight",
                        !on && "text-muted-foreground",
                      )}
                    >
                      {meta.label}
                    </span>
                    <span className="block truncate text-[8px] text-muted-foreground">
                      {/* The count answers the row's own switch: a layer that
                          is off is not showing anything. */}
                      {on ? `${count} shown` : `${count} hidden`}
                    </span>
                  </span>
                </button>
              );
            })}
          </section>

          <ShoppingCard items={state?.shopping ?? []} onPlan={() => setPlanOpen(true)} />

          <FeedsCard
            feeds={state?.feeds ?? []}
            syncing={syncing}
            onSync={(id) => void runSync(id)}
            onAdd={() => setFeedOpen(true)}
            onImport={() => fileInputRef.current?.click()}
          />
        </aside>

        {/* --------------------------------------------------------- the grid */}
        <main className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border/70 bg-card/40">
          {busy ? (
            <div className="grid h-full place-items-center">
              <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Reading the calendar…
              </span>
            </div>
          ) : zoom ? (
            <motion.div
              key={`year-${year}`}
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.22 }}
              className="grid h-full min-h-0 grid-cols-1 gap-2 overflow-y-auto p-2 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4"
            >
              {cal.MONTH_NAMES.map((name, index) => (
                <MiniMonth
                  key={name}
                  year={year}
                  month={index + 1}
                  byDay={byDay}
                  now={now}
                  timeZone={timeZone}
                  onPick={() => {
                    setMonth(index + 1);
                    setZoom(false);
                  }}
                />
              ))}
            </motion.div>
          ) : (
            <motion.div
              key={`month-${year}-${month}`}
              initial={{ opacity: 0, scale: 1.04 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.22 }}
              className="h-full min-h-0"
            >
              <MonthGrid
                year={year}
                month={month}
                byDay={byDay}
                now={now}
                timeZone={timeZone}
                onOpen={setOpenEvent}
                onReply={(event, answer) => void reply({ id: event._id, answer })}
                onAdd={openNew}
              />
            </motion.div>
          )}

          {/* which day is which, when the grid is scrolled on a phone */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center pb-1">
            <span className="rounded-full border border-border/60 bg-background/80 px-2 py-0.5 text-[8px] text-muted-foreground">
              {todayKey} · {timeZone}
            </span>
          </div>
        </main>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".ics,text/calendar"
        className="hidden"
        onChange={(event) => void onImportPicked(event)}
      />

      <EventDialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        draft={editing}
        setDraft={setEditing}
        timeZone={timeZone}
        onSaved={() => setOpenEvent(null)}
      />

      {openEvent ? (
        <EventDetail
          event={openEvent}
          timeZone={timeZone}
          onClose={() => setOpenEvent(null)}
          onEdit={() => {
            setEditing(draftFrom(openEvent, timeZone));
            setOpenEvent(null);
          }}
          onReply={(answer) => void reply({ id: openEvent._id, answer })}
          onDelete={() => {
            void removeEvent({ id: openEvent._id })
              .then(() => {
                setOpenEvent(null);
                toast.success("Taken off the calendar.");
              })
              // Anything the server refuses used to vanish into an unhandled
              // rejection: the dialog stayed up and nothing was said.
              .catch((error: unknown) => {
                toast.error(
                  error instanceof Error
                    ? error.message
                    : "That did not come off.",
                );
              });
          }}
        />
      ) : null}

      <PlanDialog
        open={planOpen}
        onOpenChange={setPlanOpen}
        timeZone={timeZone}
      />

      <FeedDialog
        open={feedOpen}
        onOpenChange={setFeedOpen}
        timeZone={timeZone}
        onDone={(id) => void runSync(id)}
      />
    </div>
  );
}
