import { api } from "@/convex/_generated/api";
import type {
  AlertItem,
  Aircraft,
  AuctionEvent,
  AuctionReport,
  Briefing,
  Economy,
  FireItem,
  HayPrice,
  MarketReading,
  MoonSky,
  NewsItem,
  Quake,
  SnowPoint,
  Source,
  SunSky,
} from "@/convex/briefing";
import {
  ELSEWHERE,
  RANCH_STORES,
  aqiWord as aqiLabel,
  compassWord as compass,
  kpWord as kpLabel,
  skyWord as sky,
} from "@/convex/live_data";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAction, useConvexConnectionState, useQuery } from "convex/react";
import { motion } from "framer-motion";
import {
  Activity,
  AlertTriangle,
  Bitcoin,
  CalendarDays,
  CircleDollarSign,
  CloudSun,
  Coins,
  Crosshair,
  Droplets,
  ExternalLink,
  Flame,
  Fuel,
  Gauge,
  Gavel,
  Landmark,
  Loader2,
  MapPin,
  Moon,
  Mountain,
  Newspaper,
  Plane,
  Radio,
  RefreshCw,
  Satellite,
  Snowflake,
  Sprout,
  Store,
  Sun,
  Thermometer,
  Truck,
  Volume2,
  VolumeX,
  Waves,
  Wheat,
  Wind,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

/**
 * [LIVE] — mission control.
 *
 * One wall of boxes, every one the same size. Each box is a single reading the
 * hub fetched itself (`convex/briefing.ts`) and drew with its own code — the
 * weather and the mountain snow, the watches and warnings, the air, the drought
 * and the rivers, the fires, the federal declarations, the energy, metals and
 * farm markets the state sells into, the wider economy, the sun and the moon,
 * the aircraft overhead,
 * the ground shaking, the station and the space weather, and the headlines. No
 * embedded web page, no widget waiting on somebody else's site, no box left
 * blank because a stranger's page would not load.
 *
 * Every box names its source and when it was read; one feed failing takes its
 * own box down and nothing else. The broadcast is the one live video, and it
 * starts muted.
 */

/* --------------------------------------------------------------- formatting */

function fmt(value: number | null, digits = 2): string {
  if (value === null) return "—";
  return value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function fmtWhole(value: number | null): string {
  return fmt(value, 0);
}

function fmtCompact(value: number | null): string {
  if (value === null) return "—";
  const abs = Math.abs(value);
  if (abs >= 1e12) return `${(value / 1e12).toFixed(2)} T`;
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)} B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)} M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(1)} K`;
  return value.toFixed(2);
}

function pct(value: number | null): string {
  if (value === null) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${fmt(value, 2)}%`;
}

function delta(value: number | null): string {
  if (value === null) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${fmt(value, 2)}`;
}

function timeAgo(ms: number | null): string {
  if (!ms) return "—";
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function clock(ms: number | null): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

function day(date: string): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "numeric",
    day: "numeric",
  });
}

/** When an entry is, in the words this board uses: Today, Tomorrow, or a date. */
function eventWhen(start: number, allDay: boolean): string {
  const dayStart = (value: number) => {
    const date = new Date(value);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  };
  const offset = Math.round((dayStart(start) - dayStart(Date.now())) / 86_400_000);
  const when =
    offset === 0
      ? "Today"
      : offset === 1
        ? "Tomorrow"
        : new Date(start).toLocaleDateString("en-US", {
            weekday: "short",
            month: "numeric",
            day: "numeric",
          });
  if (allDay) return `${when} · all day`;
  return `${when} · ${new Date(start).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  })}`;
}

/**
 * The next few entries still to come, soonest first. Anything on a layer the
 * person has switched off is left out here too — the same switch that hides an
 * entry on the calendar hides it on this board.
 */
function upcomingEvents<
  T extends { endsAt: number; startsAt: number; layer: string },
>(events: T[], count: number, hidden: Set<string>): T[] {
  const now = Date.now();
  return events
    .filter((event) => event.endsAt >= now && !hidden.has(event.layer))
    .sort((a, b) => a.startsAt - b.startsAt)
    .slice(0, count);
}


function upDown(value: number | null): "up" | "down" | "flat" {
  if (value === null || value === 0) return "flat";
  return value > 0 ? "up" : "down";
}

/* ------------------------------------------------------------------- pieces */

function StatusPill() {
  const connection = useConvexConnectionState();
  const [browserOnline, setBrowserOnline] = useState(
    typeof navigator === "undefined" ? true : navigator.onLine,
  );

  useEffect(() => {
    const up = () => setBrowserOnline(true);
    const down = () => setBrowserOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);

  const live = browserOnline && connection.isWebSocketConnected;

  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider">
      <motion.span
        className={
          live
            ? "size-1.5 rounded-full bg-red-500"
            : "size-1.5 rounded-full bg-neutral-700"
        }
        animate={live ? { opacity: [1, 0.35, 1] } : { opacity: 1 }}
        transition={live ? { duration: 1.6, repeat: Infinity } : {}}
      />
      <span className={live ? "text-red-400" : "text-muted-foreground"}>
        {live ? "Live" : "Offline"}
      </span>
    </span>
  );
}

const TONE: Record<string, string> = {
  default: "text-muted-foreground",
  warn: "text-amber-400",
  danger: "text-red-400",
  good: "text-emerald-400",
  water: "text-sky-400",
  power: "text-yellow-400",
  moon: "text-indigo-300",
};

/**
 * One box. Every box on this page is this box: same height, same header, same
 * footer. A feed that failed says so inside its own box rather than vanishing,
 * and a long answer scrolls inside the box instead of stretching the wall.
 */
function Tile({
  title,
  icon: Icon,
  status,
  tone = "default",
  source,
  sourceHref,
  at,
  note,
  children,
  className,
}: {
  title: string;
  icon: LucideIcon;
  status?: string;
  tone?: keyof typeof TONE | string;
  source: string;
  sourceHref: string;
  at?: number | null;
  note?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "flex h-56 flex-col overflow-hidden rounded-lg border border-border/60 bg-card/40 transition-colors hover:border-border",
        className,
      )}
    >
      <header className="flex shrink-0 items-center gap-1.5 border-b border-border/60 px-2.5 py-1.5">
        <Icon className={cn("size-3.5 shrink-0", TONE[tone] ?? TONE.default)} />
        <h3 className="truncate text-[10px] font-bold uppercase tracking-[0.12em]">
          {title}
        </h3>
        {status ? (
          <span className="ml-auto shrink-0 truncate text-[9px] uppercase tracking-wider text-muted-foreground">
            {status}
          </span>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-2">{children}</div>

      <footer className="flex shrink-0 items-center gap-1.5 border-t border-border/60 px-2.5 py-1 text-[9px] text-muted-foreground">
        <a
          href={sourceHref}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex min-w-0 items-center gap-1 truncate transition-colors hover:text-foreground"
        >
          <span className="truncate">{source}</span>
          <ExternalLink className="size-2.5 shrink-0" />
        </a>
        <span className="ml-auto shrink-0">{at ? timeAgo(at) : note}</span>
      </footer>
    </section>
  );
}

/** A failed source, stated plainly, with the one-line reason. */
function FeedDown({ what, reason }: { what: string; reason: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-dashed border-border/60 px-2.5 py-2 text-[11px] text-muted-foreground">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      <p>
        <span className="text-foreground">{what} is not answering.</span>{" "}
        {reason} It is tried again on the next refresh.
      </p>
    </div>
  );
}

function Quiet({ text }: { text: string }) {
  return (
    <p className="rounded-md border border-border/60 px-2.5 py-2 text-[11px] text-muted-foreground">
      {text}
    </p>
  );
}

/** The one big number a stat box leads with. */
function Stat({
  value,
  sub,
  hint,
}: {
  value: string;
  sub?: string;
  hint?: string;
}) {
  return (
    <div className="flex h-full flex-col justify-center">
      <p className="font-mono text-2xl font-bold leading-none tracking-tight tabular-nums">
        {value}
      </p>
      {sub ? (
        <p className="mt-1.5 text-[11px] font-medium leading-4">{sub}</p>
      ) : null}
      {hint ? (
        <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** A label-left, value-right row, used by most of the boxes. */
function Row({
  label,
  value,
  sub,
  tone,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  tone?: string;
}) {
  return (
    <li className="flex items-center gap-2 border-b border-border/40 py-1.5 last:border-b-0">
      <div className="min-w-0 flex-1">
        <p className="truncate text-[11px] leading-4">{label}</p>
        {sub ? (
          <p className="truncate text-[9px] uppercase tracking-wider text-muted-foreground">
            {sub}
          </p>
        ) : null}
      </div>
      <span
        className={cn(
          "shrink-0 font-mono text-[11px] tabular-nums",
          tone === "up" && "text-emerald-400",
          tone === "down" && "text-red-400",
          tone === "flat" && "text-muted-foreground",
        )}
      >
        {value}
      </span>
    </li>
  );
}

function MarketList({ source }: { source: Source<MarketReading[]> }) {
  if (!source.ok) return <FeedDown what="The market feed" reason={source.error} />;

  return (
    <ul className="flex flex-col">
      {source.data.map((reading) => (
        <Row
          key={reading.symbol}
          label={reading.label}
          sub={reading.symbol}
          value={fmt(reading.price)}
          tone={upDown(reading.changePct)}
        />
      ))}
    </ul>
  );
}

function NewsList({ source, what }: { source: Source<NewsItem[]>; what: string }) {
  if (!source.ok) return <FeedDown what={what} reason={source.error} />;
  if (!source.data.length) return <Quiet text="Nothing new right now." />;

  return (
    <ul className="flex flex-col gap-2">
      {source.data.map((item, index) => (
        <li key={`${item.link}-${index}`}>
          <a
            href={item.link}
            target="_blank"
            rel="noreferrer noopener"
            className="block text-[11px] leading-4 transition-colors hover:text-foreground hover:underline"
          >
            {item.title}
          </a>
          <p className="mt-0.5 text-[9px] uppercase tracking-wider text-muted-foreground">
            {item.source} · {timeAgo(item.at)}
          </p>
        </li>
      ))}
    </ul>
  );
}

function AlertList({ source }: { source: Source<AlertItem[]> }) {
  if (!source.ok) return <FeedDown what="Alerts" reason={source.error} />;
  if (!source.data.length) {
    return <Quiet text="No active watches or warnings for Colorado right now." />;
  }

  return (
    <ul className="flex flex-col gap-1.5">
      {source.data.map((alert, index) => (
        <li
          key={`${alert.event}-${index}`}
          className="rounded-md border border-red-500/40 bg-red-500/5 px-2.5 py-1.5"
        >
          <p className="text-[11px] font-semibold text-red-300">
            {alert.event}
            {alert.severity && alert.severity !== "Unknown"
              ? ` · ${alert.severity}`
              : ""}
          </p>
          {alert.headline ? (
            <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
              {alert.headline}
            </p>
          ) : null}
          <p className="mt-0.5 text-[9px] leading-4 text-muted-foreground">
            {alert.area}
            {alert.ends ? ` · until ${clock(Date.parse(alert.ends))}` : ""}
          </p>
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------- sun & moon */

/**
 * The almanac's times come back as the Observatory writes them — a plain
 * 24-hour `HH:MM` — and are turned into the clock the rest of the board reads.
 */
function prettyClock(value: string | null): string {
  if (!value) return "—";
  const [hourText, minuteText = "00"] = value.split(":");
  const hours = Number(hourText);
  if (!Number.isFinite(hours)) return value;
  const suffix = hours >= 12 ? "PM" : "AM";
  const twelve = hours % 12 === 0 ? 12 : hours % 12;
  return `${twelve}:${minuteText} ${suffix}`;
}

/** A count of minutes as the hours and minutes of daylight a person reads. */
function hoursMinutes(total: number | null): string {
  if (total === null) return "—";
  const hours = Math.floor(total / 60);
  const minutes = Math.round(total % 60);
  return `${hours}h ${String(minutes).padStart(2, "0")}m`;
}

/** An ISO date as a short calendar day — "Oct 3". */
function shortDay(date: string | null): string {
  if (!date) return "—";
  return new Date(`${date}T12:00:00`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

/** The glyph for a named phase, so the box reads at a glance. */
function moonGlyph(phase: string | null): string {
  const name = (phase ?? "").toLowerCase();
  if (name.includes("new")) return "🌑";
  if (name.includes("first quarter")) return "🌓";
  if (name.includes("last quarter")) return "🌗";
  if (name.includes("full")) return "🌕";
  if (name.includes("waxing crescent")) return "🌒";
  if (name.includes("waxing gibbous")) return "🌔";
  if (name.includes("waning gibbous")) return "🌖";
  if (name.includes("waning crescent")) return "🌘";
  return "🌙";
}

/**
 * What the moon's phase is for around a ranch — the old almanac's rule of
 * thumb, said plainly and named as tradition rather than measurement, which is
 * all any moon advice has ever been.
 */
function moonEffect(phase: string | null): string {
  const name = (phase ?? "").toLowerCase();
  if (name.includes("new")) {
    return "The darkest nights of the month — the almanac plants above-ground crops and marks it the stillest tide.";
  }
  if (name.includes("first quarter")) {
    return "Waxing half — the almanac's time for leafy crops and starting things while the light grows.";
  }
  if (name.includes("waxing")) {
    return "Waxing and brightening — sap is said to run up; better light for the evening stock check.";
  }
  if (name.includes("full")) {
    return "The brightest night for working stock, and the almanac's peak for hunting and fishing.";
  }
  if (name.includes("last quarter")) {
    return "Waning half — the almanac cuts, prunes and sets root crops as the pull eases.";
  }
  if (name.includes("waning")) {
    return "Waning and dimming — the almanac's time to cut timber and plant below-ground crops.";
  }
  return "The moon sets the month's rhythm for planting, cutting and the dark of a night.";
}

/** Which way the daylight is going, and what that does to the work. */
function sunEffect(deltaMinutes: number | null): string {
  if (deltaMinutes === null) {
    return "Daylight is what runs the pasture, the hay and the chores.";
  }
  const minutes = Math.abs(Math.round(deltaMinutes));
  if (deltaMinutes <= -1) {
    return `Losing about ${minutes} min of light a day — hay cures slower and the evening chores close in.`;
  }
  if (deltaMinutes >= 1) {
    return `Gaining about ${minutes} min of light a day — grazing stretches and the ground warms.`;
  }
  return "Daylight is holding steady around the equinox.";
}

/** The moon box: how lit it is, when it is up, and what the almanac is for. */
function MoonPanel({ moon }: { moon: MoonSky }) {
  return (
    <>
      <div className="flex items-center gap-2">
        <span className="text-2xl leading-none" aria-hidden="true">
          {moonGlyph(moon.phase)}
        </span>
        <div className="min-w-0">
          <p className="font-mono text-xl font-bold leading-none tabular-nums">
            {moon.illumination !== null ? `${Math.round(moon.illumination)}%` : "—"}
          </p>
          <p className="truncate text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {moon.phase ?? "phase unread"} · lit
          </p>
        </div>
      </div>

      <p className="mt-2 text-[10px] leading-4 text-muted-foreground">
        {moonEffect(moon.phase)}
      </p>

      <ul className="mt-2 flex flex-col">
        <Row label="Moonrise" value={prettyClock(moon.rise)} />
        <Row
          label="Highest overhead"
          sub="the almanac's own hour"
          value={prettyClock(moon.transit)}
        />
        <Row label="Moonset" value={prettyClock(moon.set)} />
        <Row
          label="Nearest named phase"
          sub={moon.closestDay ? shortDay(moon.closestDay) : undefined}
          value={moon.closestPhase ?? "—"}
        />
      </ul>

      {moon.upcoming.length ? (
        <>
          <p className="mt-2 text-[9px] uppercase tracking-wider text-muted-foreground">
            Coming phases
          </p>
          <ul className="flex flex-col">
            {moon.upcoming.map((entry) => (
              <Row
                key={`${entry.phase}-${entry.day ?? ""}`}
                label={`${moonGlyph(entry.phase)} ${entry.phase}`}
                sub={entry.day ? shortDay(entry.day) : undefined}
                value={prettyClock(entry.time)}
              />
            ))}
          </ul>
        </>
      ) : null}
    </>
  );
}

/** The sun box: the day's light, and which way it is moving. */
function SunPanel({ sun }: { sun: SunSky }) {
  return (
    <>
      <Stat
        value={hoursMinutes(sun.dayLengthMinutes)}
        sub="of daylight today"
        hint={sunEffect(sun.dayLengthDeltaMinutes)}
      />
      <ul className="mt-3 flex flex-col">
        <Row label="Sunrise" value={prettyClock(sun.rise)} />
        <Row label="Solar noon" value={prettyClock(sun.noon)} />
        <Row label="Sunset" value={prettyClock(sun.set)} />
        <Row
          label="First light"
          sub="civil dawn"
          value={prettyClock(sun.civilBegin)}
        />
        <Row
          label="Last light"
          sub="civil dusk"
          value={prettyClock(sun.civilEnd)}
        />
      </ul>
    </>
  );
}

function QuakeList({ source }: { source: Source<Quake[]> }) {
  if (!source.ok) return <FeedDown what="Earthquake feed" reason={source.error} />;
  if (!source.data.length) {
    return <Quiet text="Nothing of magnitude 2.5 or more in the region today." />;
  }

  return (
    <ul className="flex flex-col">
      {source.data.map((quake, index) => (
        <Row
          key={`${quake.place}-${index}`}
          label={quake.place}
          sub={quake.time ? timeAgo(quake.time) : undefined}
          value={fmt(quake.mag, 1)}
        />
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------ ranch & farm */

/** Colorado hay and alfalfa, per ton, by the region it traded in. */
function HayList({ rows }: { rows: HayPrice[] }) {
  if (!rows.length) {
    return <Quiet text="No Colorado hay trades were posted this week." />;
  }

  return (
    <ul className="flex flex-col">
      {rows.map((row, index) => (
        <Row
          key={`${row.region}-${row.commodity}-${index}`}
          label={`${row.commodity}${row.quality ? ` · ${row.quality}` : ""}`}
          sub={`${row.region}${row.baleType ? ` · ${row.baleType}` : ""}${
            row.estimated ? " · est." : ""
          }`}
          value={row.avg !== null ? `$${fmtWhole(row.avg)}` : "—"}
        />
      ))}
    </ul>
  );
}

/** An auction calendar: the sale and its date, each one click in. */
function AuctionEvents({
  source,
  what,
  empty,
}: {
  source: Source<AuctionEvent[]>;
  what: string;
  empty: string;
}) {
  if (!source.ok) return <FeedDown what={what} reason={source.error} />;
  if (!source.data.length) return <Quiet text={empty} />;

  return (
    <ul className="flex flex-col gap-2">
      {source.data.map((event, index) => (
        <li key={`${event.href}-${index}`}>
          <a
            href={event.href}
            target="_blank"
            rel="noreferrer noopener"
            className="block text-[11px] font-medium leading-4 transition-colors hover:text-foreground hover:underline"
          >
            {event.title}
          </a>
          <p className="text-[9px] uppercase tracking-wider text-muted-foreground">
            {event.date}
            {event.where ? ` · ${event.where}` : ""}
          </p>
        </li>
      ))}
    </ul>
  );
}

/** The USDA market reports for every Colorado barn, each a click away. */
function ReportLinks({ source }: { source: Source<AuctionReport[]> }) {
  if (!source.ok) return <FeedDown what="The report list" reason={source.error} />;
  if (!source.data.length) {
    return <Quiet text="No Colorado reports are listed right now." />;
  }

  return (
    <ul className="flex flex-col gap-1.5">
      {source.data.map((report) => (
        <li key={report.href}>
          <a
            href={report.href}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-start gap-1 text-[11px] leading-4 transition-colors hover:text-foreground hover:underline"
          >
            <span>{report.label}</span>
            <ExternalLink className="mt-0.5 size-2.5 shrink-0" />
          </a>
        </li>
      ))}
    </ul>
  );
}


function StoreLinks() {
  return (
    <ul className="flex flex-col gap-2">
      {RANCH_STORES.map((store) => (
        <li key={store.href}>
          <a
            href={store.href}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 text-[11px] font-medium transition-colors hover:text-foreground hover:underline"
          >
            {store.name}
            <ExternalLink className="size-2.5 shrink-0" />
          </a>
          <p className="text-[9px] leading-4 text-muted-foreground">
            {store.note}
          </p>
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------- broadcast */

/** NEET INTEL — a real 24/7 listener feed of the HFGCS shortwave network. */
const HFGCS_CHANNEL = "UCWm9e7vXXHEhfwkp_UZFKFw";

function Broadcast() {
  const [muted, setMuted] = useState(true);
  const frameRef = useRef<HTMLIFrameElement>(null);

  const src = `https://www.youtube.com/embed/live_stream?channel=${HFGCS_CHANNEL}&autoplay=0&mute=1&rel=0&modestbranding=1&enablejsapi=1`;

  // Our own button drives the embedded player through YouTube's command
  // channel. It starts muted, and only unmutes when asked.
  useEffect(() => {
    const win = frameRef.current?.contentWindow;
    if (!win) return;
    const command = (func: string) =>
      win.postMessage(
        JSON.stringify({ event: "command", func, args: [] }),
        "*",
      );
    command(muted ? "mute" : "unMute");
    command(muted ? "pauseVideo" : "playVideo");
  }, [muted]);

  const applyOnLoad = () => {
    const win = frameRef.current?.contentWindow;
    if (!win) return;
    win.postMessage(
      JSON.stringify({
        event: "command",
        func: muted ? "mute" : "unMute",
        args: [],
      }),
      "*",
    );
  };

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-md border border-border/60 bg-black">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-2 py-1">
        <span className="font-mono text-[10px] text-red-400">
          HFGCS · 8992 / 11175 kHz USB
        </span>
        <button
          type="button"
          onClick={() => setMuted((previous) => !previous)}
          aria-pressed={!muted}
          className={
            muted
              ? "ml-auto inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-red-500/50 bg-red-500/10 px-2 py-0.5 text-[10px] font-semibold text-red-400 transition-colors hover:bg-red-500/20"
              : "ml-auto inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border/60 px-2 py-0.5 text-[10px] font-semibold transition-colors hover:bg-white/5"
          }
        >
          {muted ? (
            <VolumeX className="size-3" />
          ) : (
            <Volume2 className="size-3" />
          )}
          {muted ? "Muted" : "Live audio"}
        </button>
      </div>

      <div className="relative min-h-0 flex-1">
        <iframe
          ref={frameRef}
          src={src}
          title="HFGCS emergency action message live feed"
          onLoad={applyOnLoad}
          allow="autoplay; encrypted-media"
          allowFullScreen
          referrerPolicy="no-referrer-when-downgrade"
          className="absolute inset-0 size-full border-0"
        />
      </div>
    </div>
  );
}

/* ---------------------------------------------------- things not fetchable */


/* ------------------------------------------------------------ plain summary */

/** One sentence that reads the whole board at a glance. */
function headline(data: Briefing | null): string {
  if (!data) return "Gathering the picture…";
  const bits: string[] = [];

  if (data.weather.ok) {
    const w = data.weather.data;
    bits.push(`${sky(w.code)} at ${fmtWhole(w.temperature)}°`);
    if (w.windGust !== null && w.windGust >= 20) {
      bits.push(`gusting ${fmtWhole(w.windGust)} mph`);
    }
  }

  if (data.alerts.ok && data.alerts.data.length) {
    bits.push(
      `${data.alerts.data.length} weather alert${
        data.alerts.data.length === 1 ? "" : "s"
      } out`,
    );
  }

  if (data.fire.ok && data.fire.data.length) {
    const acres = data.fire.data.reduce((total, item) => total + (item.acres ?? 0), 0);
    bits.push(
      `${data.fire.data.length} wildfire${
        data.fire.data.length === 1 ? "" : "s"
      } mapped (${fmtCompact(acres)} acres)`,
    );
  }

  if (data.drought.ok && data.drought.data.d2 !== null) {
    bits.push(`${fmt(data.drought.data.d2, 0)}% of Colorado in severe drought`);
  }

  const oil = data.energy.ok
    ? data.energy.data.find((row) => row.symbol === "CL=F")
    : undefined;
  if (oil?.price !== null && oil?.price !== undefined) {
    bits.push(`WTI $${fmt(oil.price)} (${pct(oil.changePct)})`);
  }

  const corn = data.farm.ok
    ? data.farm.data.find((row) => row.symbol === "ZC=F")
    : undefined;
  if (corn?.price !== null && corn?.price !== undefined) {
    bits.push(`corn ${fmt(corn.price)}¢`);
  }

  if (data.space.ok && data.space.data.kp !== null) {
    bits.push(`Kp ${data.space.data.kp} (${kpLabel(data.space.data.kp)})`);
  }

  if (data.almanac?.ok && data.almanac.data.moon.phase) {
    const moon = data.almanac.data.moon;
    bits.push(
      `${moon.phase}${
        moon.illumination !== null ? ` (${Math.round(moon.illumination)}% lit)` : ""
      }`,
    );
  }

  return bits.length ? `${bits.join(" · ")}.` : "No readings came back.";
}

/* ---------------------------------------------------------------- sections */

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="px-0.5 text-[10px] font-bold uppercase tracking-[0.22em] text-muted-foreground">
        {label}
      </h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
        {children}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------- page */

export default function LivePage() {
  const snapshot = useQuery(api.briefing.read);
  const refresh = useAction(api.briefing.refresh);
  const [busy, setBusy] = useState(false);
  const kicked = useRef(false);

  const data: Briefing | null = snapshot?.data ?? null;

  // The board is rebuilt twice a day on its timer, so this page does not chase
  // it: what is on the shelf is what there is until the next of the two hours
  // comes round, and Refresh is right there for wanting it sooner. The one
  // exception is a hub with nothing on the shelf at all — a brand new install
  // should not stare at an empty board until the next scheduled hour.
  useEffect(() => {
    if (kicked.current || snapshot === undefined) return;
    if (snapshot) return;
    kicked.current = true;
    void refresh().catch(() => {
      // The cron will get there; nothing for the reader to fix.
    });
  }, [snapshot, refresh]);

  const onRefresh = async () => {
    setBusy(true);
    try {
      await refresh();
      toast.success("Briefing refreshed.");
    } catch {
      toast.error("Could not refresh the briefing just now.");
    } finally {
      setBusy(false);
    }
  };

  const updatedAt = snapshot?.updatedAt ?? null;
  const summary = useMemo(() => headline(data), [data]);

  // The calendar is the one box drawn from the person's own data rather than
  // the shared board, because it is theirs — and the server filters it for the
  // account reading it, so only what they are allowed to see ever arrives.
  const calWindow = useMemo(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return {
      from: start.getTime(),
      to: start.getTime() + 14 * 24 * 60 * 60 * 1000,
    };
  }, []);
  const calendar = useQuery(api.calendar.state, calWindow);
  const upcoming = useMemo(
    () =>
      upcomingEvents(
        calendar?.events ?? [],
        8,
        new Set(calendar?.prefs.hiddenLayers ?? []),
      ),
    [calendar],
  );

  const weather = data?.weather.ok ? data.weather.data : null;
  const air = data?.air.ok ? data.air.data : null;
  const drought = data?.drought.ok ? data.drought.data : null;
  const economy: Economy | null = data?.economy.ok ? data.economy.data : null;
  const snowPoints: SnowPoint[] = data?.snow.ok ? data.snow.data.points : [];
  const fire: FireItem[] = data?.fire.ok ? data.fire.data : [];
  const aircraft: Aircraft[] = data?.airspace.ok
    ? data.airspace.data.notable
    : [];
  const hay = data?.hay.ok ? data.hay.data : null;

  const energy = data?.energy.ok ? data.energy.data : [];
  const farm = data?.farm.ok ? data.farm.data : [];
  const markets = data?.markets.ok ? data.markets.data : [];

  const pick = (rows: MarketReading[], symbol: string) =>
    rows.find((row) => row.symbol === symbol) ?? null;

  const oil = pick(energy, "CL=F");
  const gas = pick(energy, "NG=F");
  const gold = pick(energy, "GC=F");
  const corn = pick(farm, "ZC=F");
  const cattle = pick(farm, "LE=F");
  const feeder = pick(farm, "GF=F");
  const sp500 = pick(markets, "^GSPC");
  const tenYear = pick(markets, "^TNX");
  const dollar = pick(markets, "^DXY") ?? pick(markets, "DX-Y.NYB");
  const bitcoin = pick(markets, "BTC-USD");

  const snowDepth = snowPoints.length
    ? snowPoints.reduce<number>((max, point) => Math.max(max, point.snowDepthIn ?? 0), 0)
    : 0;
  const snowNew = snowPoints.reduce<number>(
    (total, point) => total + (point.newSnow24hIn ?? 0),
    0,
  );

  const fireAcres = fire.reduce((total, item) => total + (item.acres ?? 0), 0);

  return (
    <div className="mx-auto flex h-full w-full max-w-[1500px] flex-col gap-4 overflow-y-auto p-2 sm:p-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight">
            <Activity className="size-5" />
            [LIVE] MISSION CONTROL
          </h1>
          <p className="text-xs text-muted-foreground">
            The whole Colorado board on one wall — weather, snow, alerts, air,
            water, drought, fire, hay and cattle, the ranch auctions, the
            economy, power, markets, the sun and the moon, airspace, orbit and
            the headlines. Every number fetched by the hub itself.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <span className="hidden text-[10px] uppercase tracking-wider text-muted-foreground sm:inline">
            Read {timeAgo(updatedAt)}
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void onRefresh()}
            className="h-8 cursor-pointer rounded-lg text-[11px]"
          >
            {busy ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            Refresh
          </Button>
          <StatusPill />
        </div>
      </header>

      {/* -------------------------------------------------------- briefing */}
      <div className="rounded-lg border border-border/60 bg-card/40 px-4 py-3">
        <p className="text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Briefing
        </p>
        <p className="mt-1 text-sm leading-relaxed">{summary}</p>
        {weather ? (
          <p className="mt-1 text-[10px] text-muted-foreground">
            {data?.center.label} · {fmtWhole(weather.temperature)}
            {weather.units.temperature} ·{" "}
            {weather.timezone.split("/").pop()?.replace("_", " ")}
          </p>
        ) : null}
      </div>

      {/* ================================================ family calendar */}
      <Section label="The family calendar">
        <Tile
          title="Calendar — next up"
          icon={CalendarDays}
          status={calendar ? `${upcoming.length} coming up` : "fetching"}
          source="This hub's calendar"
          sourceHref="/calendar"
          note="your own entries"
        >
          {calendar === undefined ? (
            <p className="text-xs text-muted-foreground">Gathering…</p>
          ) : !calendar.me ? (
            <Quiet text="The calendar is not open on this account." />
          ) : upcoming.length === 0 ? (
            <Quiet text="Nothing is coming up on the calendar." />
          ) : (
            <ul className="flex flex-col">
              {upcoming.map((event) => (
                <li
                  key={event._id}
                  className="border-b border-border/40 py-1.5 last:border-b-0"
                >
                  <p className="truncate text-[11px] leading-4">{event.title}</p>
                  <p className="truncate text-[9px] uppercase tracking-wider text-muted-foreground">
                    {eventWhen(event.startsAt, event.allDay)}
                    {event.ownerName ? ` · ${event.ownerName}` : ""}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Tile>
      </Section>

      {/* ================================================== today, colorado */}
      <Section label="Today over Colorado">
        <Tile
          title="Temperature"
          icon={Thermometer}
          tone="warn"
          status={weather ? sky(weather.code) : "fetching"}
          source="Open-Meteo"
          sourceHref="https://open-meteo.com/"
          at={data?.weather.ok ? data.weather.at : null}
        >
          {data && !data.weather.ok ? (
            <FeedDown what="Weather" reason={data.weather.error} />
          ) : weather ? (
            <Stat
              value={`${fmtWhole(weather.temperature)}°`}
              sub={`Feels like the air: ${fmtWhole(weather.humidity)}% humidity`}
              hint={`Pressure ${fmtWhole(weather.pressure)} mb · rain now ${fmt(
                weather.precipitation,
                2,
              )} in`}
            />
          ) : (
            <p className="text-xs text-muted-foreground">Gathering…</p>
          )}
        </Tile>

        <Tile
          title="Wind"
          icon={Wind}
          status={weather ? compass(weather.windDirection) : "fetching"}
          source="Open-Meteo"
          sourceHref="https://open-meteo.com/"
          at={data?.weather.ok ? data.weather.at : null}
        >
          {weather ? (
            <Stat
              value={`${fmtWhole(weather.windSpeed)} mph`}
              sub={`Gusting ${fmtWhole(weather.windGust)} mph`}
              hint={`From the ${compass(weather.windDirection)} — the direction it blows from, as the trade reads it`}
            />
          ) : (
            <p className="text-xs text-muted-foreground">Gathering…</p>
          )}
        </Tile>

        <Tile
          title="Air quality"
          icon={Gauge}
          tone="good"
          status={air ? aqiLabel(air.aqi) : "fetching"}
          source="Open-Meteo"
          sourceHref="https://open-meteo.com/en/docs/air-quality-api"
          at={data?.air.ok ? data.air.at : null}
        >
          {data && !data.air.ok ? (
            <FeedDown what="The air feed" reason={data.air.error} />
          ) : air ? (
            <Stat
              value={`AQI ${air.aqi ?? "—"}`}
              sub={aqiLabel(air.aqi)}
              hint={`PM2.5 ${fmt(air.pm25, 1)} · PM10 ${fmt(air.pm10, 1)} µg/m³`}
            />
          ) : (
            <p className="text-xs text-muted-foreground">Gathering…</p>
          )}
        </Tile>

        <Tile
          title="Ground & soil"
          icon={Sprout}
          tone="good"
          status="6 cm"
          source="Open-Meteo"
          sourceHref="https://open-meteo.com/"
          at={data?.weather.ok ? data.weather.at : null}
        >
          {weather ? (
            <Stat
              value={`${fmtWhole(weather.soilTemperature)}°F`}
              sub={`Soil moisture ${fmt(weather.soilMoisture, 2)} m³/m³`}
              hint="The ground-truth numbers behind hay curing, planting and pasture"
            />
          ) : (
            <p className="text-xs text-muted-foreground">Gathering…</p>
          )}
        </Tile>

        <Tile
          title="Five-day forecast"
          icon={CloudSun}
          status={weather ? "Denver basin" : "fetching"}
          source="Open-Meteo"
          sourceHref="https://open-meteo.com/"
          at={data?.weather.ok ? data.weather.at : null}
        >
          {weather ? (
            <ul className="flex flex-col">
              {weather.daily.map((entry) => (
                <li
                  key={entry.date}
                  className="flex items-center gap-2 border-b border-border/40 py-1.5 last:border-b-0"
                >
                  <span className="w-14 shrink-0 text-[10px] font-medium tabular-nums">
                    {day(entry.date)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">
                    {sky(entry.code)}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] tabular-nums">
                    {fmtWhole(entry.low)}°/{fmtWhole(entry.high)}°
                  </span>
                  <span className="w-12 shrink-0 text-right font-mono text-[9px] tabular-nums text-muted-foreground">
                    {fmt(entry.precipitation, 2)}″
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">Gathering…</p>
          )}
        </Tile>

        <Tile
          title="Alerts — Colorado"
          icon={AlertTriangle}
          tone="danger"
          status={
            data?.alerts.ok
              ? data.alerts.data.length
                ? `${data.alerts.data.length} active`
                : "none active"
              : "fetching"
          }
          source="National Weather Service"
          sourceHref="https://api.weather.gov/alerts/active?area=CO"
          at={data?.alerts.ok ? data.alerts.at : null}
        >
          {data ? (
            <AlertList source={data.alerts} />
          ) : (
            <p className="text-xs text-muted-foreground">Checking the wires…</p>
          )}
        </Tile>
      </Section>

      {/* ============================================== sun, moon, almanac */}
      <Section label="Sun, moon and the almanac">
        <Tile
          title="Moon — phase & pull"
          icon={Moon}
          tone="moon"
          status={
            data?.almanac?.ok
              ? (data.almanac.data.moon.phase ?? "reading")
              : "fetching"
          }
          source="U.S. Naval Observatory"
          sourceHref="https://aa.usno.navy.mil/astronomy/"
          at={data?.almanac?.ok ? data.almanac.at : null}
          note="the official almanac"
        >
          {!data || !data.almanac ? (
            <p className="text-xs text-muted-foreground">Gathering…</p>
          ) : !data.almanac.ok ? (
            <FeedDown what="The almanac feed" reason={data.almanac.error} />
          ) : (
            <MoonPanel moon={data.almanac.data.moon} />
          )}
        </Tile>

        <Tile
          title="Sun — rise, set & daylight"
          icon={Sun}
          tone="warn"
          status={
            data?.almanac?.ok
              ? hoursMinutes(data.almanac.data.sun.dayLengthMinutes)
              : "fetching"
          }
          source="U.S. Naval Observatory"
          sourceHref="https://aa.usno.navy.mil/astronomy/"
          at={data?.almanac?.ok ? data.almanac.at : null}
        >
          {!data || !data.almanac ? (
            <p className="text-xs text-muted-foreground">Gathering…</p>
          ) : !data.almanac.ok ? (
            <FeedDown what="The almanac feed" reason={data.almanac.error} />
          ) : (
            <SunPanel sun={data.almanac.data.sun} />
          )}
        </Tile>
      </Section>

      {/* ================================================ mountains and roads */}
      <Section label="Mountains, snow and roads">
        <Tile
          title="Mountain snow"
          icon={Snowflake}
          tone="water"
          status={`${fmt(snowDepth, 1)}″ deepest`}
          source="Open-Meteo"
          sourceHref="https://open-meteo.com/"
          at={data?.snow.ok ? data.snow.at : null}
        >
          {data && !data.snow.ok ? (
            <FeedDown what="The snow feed" reason={data.snow.error} />
          ) : (
            <ul className="flex flex-col">
              {snowPoints.map((point) => (
                <Row
                  key={point.name}
                  label={point.name}
                  sub={`${fmtWhole(point.elevationFt)} ft · ${fmtWhole(
                    point.temperatureF,
                  )}°`}
                  value={`${fmt(point.snowDepthIn, 1)}″`}
                  tone="flat"
                />
              ))}
            </ul>
          )}
        </Tile>

        <Tile
          title="New snow — 24h"
          icon={Mountain}
          tone="water"
          status="8 ranges"
          source="Open-Meteo"
          sourceHref="https://open-meteo.com/"
          at={data?.snow.ok ? data.snow.at : null}
        >
          {snowPoints.length ? (
            <>
              <Stat
                value={`${fmt(snowNew, 2)}″`}
                sub="Fallen across the eight ranges in the last day"
                hint="A weather model, not a stake in the snow — the honest limit"
              />
              <ul className="mt-3 flex flex-col">
                {snowPoints
                  .slice()
                  .sort(
                    (a, b) => (b.newSnow24hIn ?? 0) - (a.newSnow24hIn ?? 0),
                  )
                  .slice(0, 4)
                  .map((point) => (
                    <Row
                      key={point.name}
                      label={point.name}
                      value={`${fmt(point.newSnow24hIn, 1)}″`}
                      tone="flat"
                    />
                  ))}
              </ul>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">Gathering…</p>
          )}
        </Tile>

        <Tile
          title="Snowpack — 7 day"
          icon={Snowflake}
          tone="water"
          status="Storm total"
          source="Open-Meteo"
          sourceHref="https://open-meteo.com/"
          at={data?.snow.ok ? data.snow.at : null}
        >
          {snowPoints.length ? (
            <ul className="flex flex-col">
              {snowPoints
                .slice()
                .sort((a, b) => (b.newSnow7dIn ?? 0) - (a.newSnow7dIn ?? 0))
                .map((point) => (
                  <Row
                    key={point.name}
                    label={point.name}
                    sub={sky(point.code)}
                    value={`${fmt(point.newSnow7dIn, 1)}″`}
                    tone="flat"
                  />
                ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">Gathering…</p>
          )}
        </Tile>

        <Tile
          title="Roads — reports"
          icon={MapPin}
          tone="warn"
          status="closure news"
          source="Colorado Sun"
          sourceHref="https://www.cotrip.org/list/roadConditions"
          at={data?.roads.ok ? data.roads.at : null}
        >
          {data ? (
            <NewsList source={data.roads} what="The road feed" />
          ) : (
            <p className="text-xs text-muted-foreground">Checking the passes…</p>
          )}
        </Tile>

        <Tile
          title="Avalanche country"
          icon={Mountain}
          status="CAIC zones"
          source="Colorado Sun"
          sourceHref="https://avalanche.state.co.us/forecasts"
          at={data?.avalanche.ok ? data.avalanche.at : null}
        >
          {data ? (
            <NewsList source={data.avalanche} what="The avalanche feed" />
          ) : (
            <p className="text-xs text-muted-foreground">Reading the snowpack…</p>
          )}
        </Tile>
      </Section>

      {/* =============================================================== land */}
      <Section label="Water, drought and fire">
        <Tile
          title="Drought"
          icon={Sprout}
          tone="warn"
          status={drought?.week ? `week of ${drought.week}` : "weekly"}
          source="U.S. Drought Monitor"
          sourceHref="https://droughtmonitor.unl.edu/CurrentMap/StateDroughtMonitor.aspx?CO"
          at={data?.drought.ok ? data.drought.at : null}
        >
          {data && !data.drought.ok ? (
            <FeedDown what="The drought feed" reason={data.drought.error} />
          ) : drought ? (
            <ul className="flex flex-col">
              <Row
                label="Severe or worse (D2+)"
                value={`${fmt(drought.d2, 0)}%`}
                tone="down"
              />
              <Row label="Extreme (D3+)" value={`${fmt(drought.d3, 0)}%`} />
              <Row label="Exceptional (D4)" value={`${fmt(drought.d4, 0)}%`} />
              <Row label="Moderate or worse (D1+)" value={`${fmt(drought.d1, 0)}%`} />
              <Row label="Abnormally dry (D0+)" value={`${fmt(drought.d0, 0)}%`} />
              <Row label="No drought" value={`${fmt(drought.none, 0)}%`} tone="up" />
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">Gathering…</p>
          )}
        </Tile>

        <Tile
          title="Rivers — Colorado"
          icon={Waves}
          tone="water"
          status={data?.water.ok ? `${data.water.data.length} gauges` : "fetching"}
          source="USGS Water Services"
          sourceHref="https://waterdata.usgs.gov/co/nwis/rt"
          at={data?.water.ok ? data.water.at : null}
        >
          {data && !data.water.ok ? (
            <FeedDown what="The river gauges" reason={data.water.error} />
          ) : (
            <ul className="flex flex-col">
              {(data?.water.ok ? data.water.data : []).map((gauge) => (
                <Row
                  key={gauge.site}
                  label={gauge.name}
                  sub={gauge.site}
                  value={`${fmtWhole(gauge.discharge)} ${gauge.unit}`}
                />
              ))}
            </ul>
          )}
        </Tile>

        <Tile
          title="Wildfires — mapped"
          icon={Flame}
          tone="danger"
          status={fire.length ? `${fmtCompact(fireAcres)} acres` : "none active"}
          source="NIFC perimeters"
          sourceHref="https://www.nifc.gov/fire-information/maps"
          at={data?.fire.ok ? data.fire.at : null}
        >
          {data && !data.fire.ok ? (
            <FeedDown what="The fire map" reason={data.fire.error} />
          ) : fire.length ? (
            <ul className="flex flex-col">
              {fire.map((item) => (
                <Row
                  key={item.name}
                  label={item.name}
                  sub={
                    item.contained !== null
                      ? `${fmt(item.contained, 0)}% contained`
                      : item.type ?? undefined
                  }
                  value={`${fmtCompact(item.acres)} ac`}
                />
              ))}
            </ul>
          ) : (
            <Quiet text="No wildfire perimeter is currently mapped in Colorado." />
          )}
        </Tile>

        <Tile
          title="Wildfire — headlines"
          icon={Flame}
          tone="danger"
          status="this week"
          source="Colorado Sun"
          sourceHref="https://coloradosun.com/tag/wildfire/"
          at={data?.wildfire.ok ? data.wildfire.at : null}
        >
          {data ? (
            <NewsList source={data.wildfire} what="The fire news feed" />
          ) : (
            <p className="text-xs text-muted-foreground">Reading the wires…</p>
          )}
        </Tile>

        <Tile
          title="Emergency — federal"
          icon={AlertTriangle}
          tone="danger"
          status="latest for Colorado"
          source="FEMA OpenFEMA"
          sourceHref="https://www.fema.gov/about/openfema/data-sets"
          at={data?.emergency.ok ? data.emergency.at : null}
        >
          {data && !data.emergency.ok ? (
            <FeedDown what="The FEMA feed" reason={data.emergency.error} />
          ) : (
            <ul className="flex flex-col">
              {(data?.emergency.ok ? data.emergency.data : []).map((item) => (
                <Row
                  key={`${item.number}-${item.date}`}
                  label={item.title}
                  sub={`${item.date} · ${item.type}${item.number ? ` ${item.number}` : ""}`}
                  value={item.incident}
                />
              ))}
            </ul>
          )}
        </Tile>

        <Tile
          title="Seismic"
          icon={Waves}
          status="magnitude 2.5+, today"
          source="USGS"
          sourceHref="https://earthquake.usgs.gov/earthquakes/map/"
          at={data?.seismic.ok ? data.seismic.at : null}
        >
          {data ? (
            <QuakeList source={data.seismic} />
          ) : (
            <p className="text-xs text-muted-foreground">Listening…</p>
          )}
        </Tile>
      </Section>

      {/* ============================================================ markets */}
      {/* ===================================================== ranch & farm */}
      <Section label="Ranch & farm — Colorado">
        <Tile
          title="Hay & alfalfa — Colorado"
          icon={Wheat}
          tone="good"
          status={hay ? `${hay.rows.length} trades` : "fetching"}
          source="HayWire — USDA AMS & Colorado auctions"
          sourceHref="https://haywireag.com/prices.html"
          at={data?.hay.ok ? data.hay.at : null}
        >
          {hay ? (
            <HayList rows={hay.rows} />
          ) : (
            <p className="text-xs text-muted-foreground">Reading the hay trade…</p>
          )}
        </Tile>

        <Tile
          title="Feeder cattle"
          icon={CircleDollarSign}
          tone="good"
          status={data?.farm.ok ? "live futures" : "fetching"}
          source="Yahoo Finance"
          sourceHref="https://finance.yahoo.com/quote/GF=F/"
          at={data?.farm.ok ? data.farm.at : null}
        >
          {feeder ? (
            <Stat
              value={feeder.price !== null ? `${fmt(feeder.price)}¢` : "—"}
              sub={`${delta(feeder.change)} on the day (${pct(feeder.changePct)})`}
              hint="Feeder cattle, US cents per pound"
            />
          ) : (
            <p className="text-xs text-muted-foreground">Fetching…</p>
          )}
        </Tile>

        <Tile
          title="Cattle auctions — Colorado"
          icon={Truck}
          status="USDA reports"
          source="The Fence Post — market reports"
          sourceHref="https://www.thefencepost.com/news/market-reports/"
          at={data?.cattleAuctions.ok ? data.cattleAuctions.at : null}
        >
          {data ? (
            <ReportLinks source={data.cattleAuctions} />
          ) : (
            <p className="text-xs text-muted-foreground">Reading the barns…</p>
          )}
        </Tile>

        <Tile
          title="Horse sales & auctions"
          icon={CalendarDays}
          tone="good"
          status="Colorado"
          source="HometownHorses — Colorado events"
          sourceHref="https://www.hometownhorses.com/events?category%5B%5D=Auction"
          at={data?.horseAuctions.ok ? data.horseAuctions.at : null}
        >
          {data ? (
            <AuctionEvents
              source={data.horseAuctions}
              what="The Colorado horse calendar"
              empty="No horse sales or auctions are listed right now."
            />
          ) : (
            <p className="text-xs text-muted-foreground">Reading the calendar…</p>
          )}
        </Tile>

        <Tile
          title="Equipment & draft auctions"
          icon={Gavel}
          status="Colorado"
          source="Josh White Auctioneers"
          sourceHref="https://www.joshwhiteauctions.com/consignment.php"
          at={data?.equipmentAuctions.ok ? data.equipmentAuctions.at : null}
        >
          {data ? (
            <AuctionEvents
              source={data.equipmentAuctions}
              what="The equipment auction calendar"
              empty="Nothing on the auction calendar right now."
            />
          ) : (
            <p className="text-xs text-muted-foreground">Reading the calendar…</p>
          )}
        </Tile>

        <Tile
          title="Ranch & farm stores"
          icon={Store}
          status="sales & events"
          source="Where to look"
          sourceHref="https://www.murdochs.com/"
          note="browser-only"
        >
          <StoreLinks />
          <p className="mt-2 text-[10px] leading-4 text-muted-foreground">
            These stores publish their sales and clearance in their own shops,
            which only a browser can read, so each one is a click in. Colorado
            locations only.
          </p>
        </Tile>
      </Section>

      <Section label="Energy, metals and the markets">
        <Tile
          title="WTI crude"
          icon={Fuel}
          tone="power"
          status={oil ? pct(oil.changePct) : "fetching"}
          source="Yahoo Finance"
          sourceHref="https://finance.yahoo.com/quote/CL=F/"
          at={oil?.at ?? null}
        >
          {oil ? (
            <Stat
              value={`$${fmt(oil.price)}`}
              sub={`${delta(oil.change)} on the day · ${oil.unit}`}
              hint="Front-month contract"
            />
          ) : (
            <p className="text-xs text-muted-foreground">Fetching…</p>
          )}
        </Tile>

        <Tile
          title="Natural gas"
          icon={Flame}
          tone="power"
          status={gas ? pct(gas.changePct) : "fetching"}
          source="Yahoo Finance"
          sourceHref="https://finance.yahoo.com/quote/NG=F/"
          at={gas?.at ?? null}
        >
          {gas ? (
            <Stat
              value={`$${fmt(gas.price)}`}
              sub={`${delta(gas.change)} · ${gas.unit}`}
              hint="The fuel behind Colorado's electric grid and its furnaces"
            />
          ) : (
            <p className="text-xs text-muted-foreground">Fetching…</p>
          )}
        </Tile>

        <Tile
          title="Gold"
          icon={Coins}
          tone="warn"
          status={gold ? pct(gold.changePct) : "fetching"}
          source="Yahoo Finance"
          sourceHref="https://finance.yahoo.com/quote/GC=F/"
          at={gold?.at ?? null}
        >
          {gold ? (
            <Stat
              value={`$${fmt(gold.price)}`}
              sub={`${delta(gold.change)} · ${gold.unit}`}
              hint="The oldest money, still the yardstick"
            />
          ) : (
            <p className="text-xs text-muted-foreground">Fetching…</p>
          )}
        </Tile>

        <Tile
          title="Corn"
          icon={Wheat}
          tone="good"
          status={corn ? pct(corn.changePct) : "fetching"}
          source="Yahoo Finance"
          sourceHref="https://finance.yahoo.com/quote/ZC=F/"
          at={corn?.at ?? null}
        >
          {corn ? (
            <Stat
              value={`${fmt(corn.price)}¢`}
              sub={`${delta(corn.change)} · ${corn.unit}`}
              hint="Chicago front month"
            />
          ) : (
            <p className="text-xs text-muted-foreground">Fetching…</p>
          )}
        </Tile>

        <Tile
          title="Live cattle"
          icon={Wheat}
          tone="good"
          status={cattle ? pct(cattle.changePct) : "fetching"}
          source="Yahoo Finance"
          sourceHref="https://finance.yahoo.com/quote/LE=F/"
          at={cattle?.at ?? null}
        >
          {cattle ? (
            <Stat
              value={`${fmt(cattle.price)}¢`}
              sub={`${delta(cattle.change)} · ${cattle.unit}`}
              hint="What a finished animal is worth on the board"
            />
          ) : (
            <p className="text-xs text-muted-foreground">Fetching…</p>
          )}
        </Tile>

        <Tile
          title="S&P 500"
          icon={Activity}
          status={sp500 ? pct(sp500.changePct) : "fetching"}
          source="Yahoo Finance"
          sourceHref="https://finance.yahoo.com/quote/%5EGSPC/"
          at={sp500?.at ?? null}
        >
          {sp500 ? (
            <Stat
              value={fmtWhole(sp500.price)}
              sub={`${delta(sp500.change)} on the day`}
              hint="The wide stock market"
            />
          ) : (
            <p className="text-xs text-muted-foreground">Fetching…</p>
          )}
        </Tile>

        <Tile
          title="10-year Treasury"
          icon={Landmark}
          status={tenYear ? pct(tenYear.changePct) : "fetching"}
          source="Yahoo Finance"
          sourceHref="https://finance.yahoo.com/quote/%5ETNX/"
          at={tenYear?.at ?? null}
        >
          {tenYear ? (
            <Stat
              value={`${fmt(tenYear.price)}%`}
              sub={`${delta(tenYear.change)} on the day`}
              hint="What the country pays to borrow — and what a mortgage follows"
            />
          ) : (
            <p className="text-xs text-muted-foreground">Fetching…</p>
          )}
        </Tile>

        <Tile
          title="Dollar index"
          icon={Coins}
          status={dollar ? pct(dollar.changePct) : "fetching"}
          source="Yahoo Finance"
          sourceHref="https://finance.yahoo.com/quote/DX-Y.NYB/"
          at={dollar?.at ?? null}
        >
          {dollar ? (
            <Stat
              value={fmt(dollar.price)}
              sub={`${delta(dollar.change)} on the day`}
              hint="A stronger dollar makes American grain dearer abroad"
            />
          ) : (
            <p className="text-xs text-muted-foreground">Fetching…</p>
          )}
        </Tile>

        <Tile
          title="Bitcoin"
          icon={Bitcoin}
          status={bitcoin ? pct(bitcoin.changePct) : "fetching"}
          source="Yahoo Finance"
          sourceHref="https://finance.yahoo.com/quote/BTC-USD/"
          at={bitcoin?.at ?? null}
        >
          {bitcoin ? (
            <Stat
              value={`$${fmtCompact(bitcoin.price)}`}
              sub={`${delta(bitcoin.change)} on the day`}
              hint="The speculative end of the board"
            />
          ) : (
            <p className="text-xs text-muted-foreground">Fetching…</p>
          )}
        </Tile>

        <Tile
          title="Energy & metals"
          icon={Zap}
          tone="power"
          status={data?.energy.ok ? "live futures" : "fetching"}
          source="Yahoo Finance"
          sourceHref="https://finance.yahoo.com/markets/commodities/"
          at={data?.energy.ok ? data.energy.at : null}
        >
          {data ? (
            <MarketList source={data.energy} />
          ) : (
            <p className="text-xs text-muted-foreground">Fetching…</p>
          )}
        </Tile>

        <Tile
          title="Farm & ranch"
          icon={Wheat}
          tone="good"
          status={data?.farm.ok ? "live futures" : "fetching"}
          source="Yahoo Finance"
          sourceHref="https://finance.yahoo.com/markets/commodities/"
          at={data?.farm.ok ? data.farm.at : null}
        >
          {data ? (
            <MarketList source={data.farm} />
          ) : (
            <p className="text-xs text-muted-foreground">Fetching…</p>
          )}
        </Tile>

        <Tile
          title="Markets"
          icon={Activity}
          status={data?.markets.ok ? "live" : "fetching"}
          source="Yahoo Finance"
          sourceHref="https://finance.yahoo.com/markets/"
          at={data?.markets.ok ? data.markets.at : null}
        >
          {data ? (
            <MarketList source={data.markets} />
          ) : (
            <p className="text-xs text-muted-foreground">Fetching…</p>
          )}
        </Tile>

        <Tile
          title="Power & grid"
          icon={Zap}
          tone="power"
          status="inputs"
          source="EIA — Colorado"
          sourceHref="https://www.eia.gov/electricity/state/colorado/"
          at={data?.drought.ok ? data.drought.at : null}
        >
          <ul className="flex flex-col">
            <Row
              label="Natural gas (fuel)"
              value={gas ? `$${fmt(gas.price)}` : "—"}
              tone={gas ? upDown(gas.changePct) : undefined}
            />
            <Row
              label="RBOB gasoline"
              value={
                pick(energy, "RB=F")
                  ? `$${fmt(pick(energy, "RB=F")?.price ?? null)}`
                  : "—"
              }
            />
            <Row
              label="Drought (D2+) — hydro input"
              value={drought ? `${fmt(drought.d2, 0)}%` : "—"}
            />
            <Row
              label="Rivers running"
              value={data?.water.ok ? `${data.water.data.length}` : "—"}
            />
          </ul>
          <p className="mt-2 text-[10px] leading-4 text-muted-foreground">
            WECC, which runs Colorado's grid, publishes no open keyless feed, so
            this box shows what the grid burns and what feeds its dams. The
            state's own electricity profile is one click away in the source
            link.
          </p>
        </Tile>
      </Section>

      {/* ============================================================ economy */}
      <Section label="The economy">
        <Tile
          title="Colorado unemployment"
          icon={Landmark}
          status={economy?.coUnemploymentPeriod ?? "monthly"}
          source="Bureau of Labor Statistics"
          sourceHref="https://www.bls.gov/eag/eag.co.htm"
          at={data?.economy.ok ? data.economy.at : null}
        >
          {economy ? (
            <Stat
              value={economy.coUnemployment !== null ? `${fmt(economy.coUnemployment, 1)}%` : "—"}
              sub={economy.coUnemploymentPeriod ?? undefined}
              hint="Colorado's own rate, as the state reports it"
            />
          ) : (
            <p className="text-xs text-muted-foreground">Fetching…</p>
          )}
        </Tile>

        <Tile
          title="Inflation"
          icon={Activity}
          tone="warn"
          status={economy?.cpiPeriod ?? "monthly"}
          source="Bureau of Labor Statistics"
          sourceHref="https://www.bls.gov/cpi/"
          at={data?.economy.ok ? data.economy.at : null}
        >
          {economy ? (
            <Stat
              value={`${fmt(economy.cpiYoYPct, 2)}%`}
              sub="Year over year"
              hint={`Headline CPI index ${fmt(economy.cpi, 1)} · ${economy.cpiPeriod ?? ""}`}
            />
          ) : (
            <p className="text-xs text-muted-foreground">Fetching…</p>
          )}
        </Tile>

        <Tile
          title="National debt"
          icon={Landmark}
          status={economy?.debtDate ?? "daily"}
          source="U.S. Treasury"
          sourceHref="https://fiscaldata.treasury.gov/datasets/debt-to-the-penny/"
          at={data?.economy.ok ? data.economy.at : null}
        >
          {economy ? (
            <Stat
              value={`$${fmtCompact(economy.debt)}`}
              sub="Total public debt outstanding"
              hint="Filed to the penny, every business day"
            />
          ) : (
            <p className="text-xs text-muted-foreground">Fetching…</p>
          )}
        </Tile>

        <Tile
          title="Economy — detail"
          icon={Gauge}
          status="Colorado and national"
          source="BLS · Treasury"
          sourceHref="https://www.bls.gov/eag/eag.co.htm"
          at={data?.economy.ok ? data.economy.at : null}
        >
          {economy ? (
            <ul className="flex flex-col">
              <Row
                label="Colorado unemployment"
                sub={economy.coUnemploymentPeriod ?? undefined}
                value={`${fmt(economy.coUnemployment, 1)}%`}
              />
              <Row
                label="CPI, year over year"
                sub={economy.cpiPeriod ?? undefined}
                value={`${fmt(economy.cpiYoYPct, 2)}%`}
              />
              <Row label="CPI index level" value={fmt(economy.cpi, 1)} />
              <Row
                label="Public debt"
                sub={economy.debtDate ?? undefined}
                value={`$${fmtCompact(economy.debt)}`}
              />
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">Fetching…</p>
          )}
        </Tile>
      </Section>

      {/* =================================================== sky and airspace */}
      <Section label="Sky, space and airspace">
        <Tile
          title="Space weather"
          icon={Activity}
          tone="warn"
          status={data?.space.ok ? kpLabel(data.space.data.kp) : "fetching"}
          source="NOAA SWPC"
          sourceHref="https://www.swpc.noaa.gov/products/planetary-k-index"
          at={data?.space.ok ? data.space.at : null}
        >
          {data?.space.ok ? (
            <Stat
              value={`Kp ${data.space.data.kp ?? "—"}`}
              sub={kpLabel(data.space.data.kp)}
              hint={
                data.space.data.aurora !== null
                  ? `Aurora overhead at Colorado's latitude: ${data.space.data.aurora}%`
                  : "The aurora grid did not answer this time"
              }
            />
          ) : (
            <p className="text-xs text-muted-foreground">Fetching…</p>
          )}
        </Tile>

        <Tile
          title="Aurora over Colorado"
          icon={Snowflake}
          tone="water"
          status="ovation model"
          source="NOAA SWPC"
          sourceHref="https://www.swpc.noaa.gov/products/aurora-30-minute-forecast"
          at={data?.space.ok ? data.space.at : null}
        >
          <Stat
            value={
              data?.space.ok && data.space.data.aurora !== null
                ? `${data.space.data.aurora}%`
                : "—"
            }
            sub="Chance of aurora directly overhead"
            hint="The K-index has to climb before the northern lights reach this far south"
          />
        </Tile>

        <Tile
          title="International Space Station"
          icon={Satellite}
          status={
            data?.orbit.ok ? `${fmt(data.orbit.data.lat, 1)}°, ${fmt(data.orbit.data.lon, 1)}°` : "fetching"
          }
          source="Where the ISS at?"
          sourceHref="https://wheretheiss.at/"
          at={data?.orbit.ok ? data.orbit.at : null}
        >
          {data && !data.orbit.ok ? (
            <FeedDown what="The orbit feed" reason={data.orbit.error} />
          ) : data?.orbit.ok ? (
            <ul className="flex flex-col">
              <Row label="Latitude" value={`${fmt(data.orbit.data.lat, 2)}°`} />
              <Row label="Longitude" value={`${fmt(data.orbit.data.lon, 2)}°`} />
              <Row
                label="Altitude"
                value={`${fmtWhole(data.orbit.data.altitudeKm)} km`}
              />
              <Row
                label="Speed"
                value={`${fmtWhole(data.orbit.data.velocityKmh)} km/h`}
              />
              <Row
                label="Visible span"
                value={`${fmtWhole(data.orbit.data.footprintKm)} km`}
              />
              <Row label="In" value={data.orbit.data.visibility ?? "—"} />
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">Locating the station…</p>
          )}
        </Tile>

        <Tile
          title="Airspace"
          icon={Plane}
          status={
            data?.airspace.ok
              ? `${data.airspace.data.count} tracked`
              : "fetching"
          }
          source="adsb.lol"
          sourceHref="https://globe.adsbexchange.com/?lat=39&lon=-105.5&zoom=7"
          at={data?.airspace.ok ? data.airspace.at : null}
        >
          {data && !data.airspace.ok ? (
            <FeedDown what="The airspace feed" reason={data.airspace.error} />
          ) : (
            <>
              <ul className="flex flex-col">
                <Row
                  label="Aircraft overhead"
                  sub="within 120 nm"
                  value={`${data?.airspace.ok ? data.airspace.data.count : "—"}`}
                />
                <Row
                  label="Above 30,000 ft"
                  value={`${data?.airspace.ok ? data.airspace.data.high : "—"}`}
                />
                <Row
                  label="Squawking emergency"
                  value={`${data?.airspace.ok ? data.airspace.data.emergency : "—"}`}
                  tone={
                    data?.airspace.ok && data.airspace.data.emergency > 0
                      ? "down"
                      : "flat"
                  }
                />
              </ul>
              <p className="mt-2 text-[9px] uppercase tracking-wider text-muted-foreground">
                Highest up
              </p>
              <ul className="flex flex-col">
                {aircraft.map((craft) => (
                  <Row
                    key={craft.callsign}
                    label={craft.callsign}
                    sub={craft.type ?? undefined}
                    value={`${fmtCompact(craft.altitudeFt)} ft`}
                  />
                ))}
              </ul>
            </>
          )}
        </Tile>

        <Tile
          title="Broadcast"
          icon={Radio}
          tone="danger"
          status="HFGCS rebroadcast"
          source="NEET INTEL"
          sourceHref="https://www.youtube.com/@neetintel"
          className="sm:col-span-2"
        >
          <Broadcast />
        </Tile>
      </Section>

      {/* ========================================================= headlines */}
      <Section label="The headlines">
        <Tile
          title="Colorado — news"
          icon={Newspaper}
          status="today"
          source="Colorado Sun"
          sourceHref="https://coloradosun.com/"
          at={data?.news.ok ? data.news.at : null}
        >
          {data ? (
            <NewsList source={data.news} what="The news feed" />
          ) : (
            <p className="text-xs text-muted-foreground">Reading the wires…</p>
          )}
        </Tile>

        <Tile
          title="World — conflict & crisis"
          icon={Activity}
          tone="danger"
          status="today"
          source="BBC World"
          sourceHref="https://www.bbc.com/news/world"
          at={data?.world.ok ? data.world.at : null}
        >
          {data ? (
            <NewsList source={data.world} what="The world feed" />
          ) : (
            <p className="text-xs text-muted-foreground">Reading the wires…</p>
          )}
        </Tile>
      </Section>

      {/* ===================================================== the fine print */}
      <Section label="Reading the board">
        <Tile
          title="One click away"
          icon={ExternalLink}
          status="browser-only sources"
          source="Where they live"
          sourceHref="https://www.cotrip.org/"
          note="not fetched"
        >
          <ul className="flex flex-col gap-2">
            {ELSEWHERE.map((link) => (
              <li key={link.href}>
                <a
                  href={link.href}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-1 text-[11px] font-medium transition-colors hover:text-foreground hover:underline"
                >
                  {link.label}
                  <ExternalLink className="size-2.5 shrink-0" />
                </a>
                <p className="text-[9px] leading-4 text-muted-foreground">
                  {link.why}
                </p>
              </li>
            ))}
          </ul>
        </Tile>

        <Tile
          title="What each box is"
          icon={Crosshair}
          status="sources & limits"
          source="Method"
          sourceHref="https://open-meteo.com/"
          note="the honest limits"
        >
          <ul className="flex flex-col gap-2 text-[10px] leading-4 text-muted-foreground">
            <li className="flex items-start gap-1.5">
              <Thermometer className="mt-0.5 size-3 shrink-0" />
              <span>
                Weather, soil, snow and air are read at Colorado's centre (39.0,
                −105.5) and over eight named ranges, from Open-Meteo, with
                watches and warnings straight from the National Weather Service.
              </span>
            </li>
            <li className="flex items-start gap-1.5">
              <Gauge className="mt-0.5 size-3 shrink-0" />
              <span>
                The mountain snow is a weather <em>model</em>, not a stake in the
                snow — the one number here that is an estimate rather than a
                measurement.
              </span>
            </li>
            <li className="flex items-start gap-1.5">
              <Coins className="mt-0.5 size-3 shrink-0" />
              <span>
                Prices are front-month futures as the trade quotes them — cents
                per bushel or pound where that is the convention.
              </span>
            </li>
            <li className="flex items-start gap-1.5">
              <Wheat className="mt-0.5 size-3 shrink-0" />
              <span>
                Hay and alfalfa are the week's real Colorado trades from HayWire, and
                the horse, cattle and equipment auctions come from the state's own
                calendars and the USDA barn reports. Chicken and lamb still have none.
              </span>
            </li>
            <li className="flex items-start gap-1.5">
              <Droplets className="mt-0.5 size-3 shrink-0" />
              <span>
                Drought is published weekly, on Thursdays, so that box moves by
                the week even though everything else moves by the minute.
              </span>
            </li>
            <li className="flex items-start gap-1.5">
              <MapPin className="mt-0.5 size-3 shrink-0" />
              <span>
                The whole board is gathered on the server every fifteen minutes
                and opens onto real numbers, and Refresh asks for it now.
              </span>
            </li>
          </ul>
        </Tile>
      </Section>
    </div>
  );
}
