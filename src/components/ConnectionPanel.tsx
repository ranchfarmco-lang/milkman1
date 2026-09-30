import { api } from "@/convex/_generated/api";
import { useDeviceLink, usePageRate } from "@/hooks/use-connection";
import { useSettings } from "@/hooks/use-settings";
import { cn } from "@/lib/utils";
import { useAction, useConvexConnectionState } from "convex/react";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

/** One AI system, as the server last found it. */
type SystemHealth = {
  id: string;
  label: string;
  ok: boolean;
  ms: number;
  detail: string;
};

/**
 * How often the systems are knocked on while this box is on screen.
 *
 * Five minutes, matching the Control Room, because asking a system whether it
 * is there is a real request to a real provider — it spends tokens and counts
 * against a rate limit. Something that only needs to be true most of the time
 * must not be polled fast enough to be the thing that gets the hub throttled.
 */
const RECHECK_MS = 5 * 60_000;

/** "312 KB" / "1.4 MB" — the units the rest of the hub uses. */
function size(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** "12 Mbps" — but not "12.0" for a small number. */
function speed(mbps: number) {
  return `${mbps >= 10 ? Math.round(mbps) : mbps.toFixed(1)} Mbps`;
}

/**
 * The hub's connection, live — its own box, under the preview box.
 *
 * Every figure is measured rather than styled. The link speed and round trip
 * come from the browser's own report of the connection; the stream rate comes
 * from the browser's resource timings, so it is the real traffic this page is
 * pulling; the hub state comes from the live socket; and each system's latency
 * comes from the server actually knocking on the door and timing the answer.
 *
 * Where a browser will not say — Firefox and Safari have no network-information
 * API at all — the reading is left out rather than guessed at, because an
 * invented speed is worse than a blank one.
 */
export function ConnectionPanel() {
  const link = useDeviceLink();
  const rate = usePageRate();
  const connection = useConvexConnectionState();
  const checkSystems = useAction(api.ai.checkSystems);
  const { values } = useSettings();
  const [systems, setSystems] = useState<SystemHealth[] | null>(null);
  const [lookedAt, setLookedAt] = useState(0);

  // The family's own switch governs whether the systems are checked by
  // themselves. It is theirs, so it is obeyed here too rather than bypassed by
  // a box that happens to want a number.
  const autoRefresh = values.ai_auto_refresh ?? true;

  useEffect(() => {
    if (!autoRefresh) return;

    let alive = true;

    const look = () => {
      void checkSystems()
        .then((rows) => {
          if (!alive) return;
          setSystems(rows);
          setLookedAt(Date.now());
        })
        .catch(() => {
          // A server that cannot be reached is already visible as a broken
          // socket below; there is nothing useful to add from here.
        });
    };

    look();
    const timer = window.setInterval(() => {
      // A hidden tab is left alone, so nothing is asked of a provider while
      // nobody is looking at the answer.
      if (!document.hidden) look();
    }, RECHECK_MS);

    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [autoRefresh, checkSystems]);

  const socket = connection.isWebSocketConnected;
  const answering = systems?.filter((one) => one.ok).length ?? 0;

  return (
    <div className="shrink-0 rounded-2xl border border-border/70 bg-card/70 px-3.5 py-2.5 backdrop-blur-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] leading-4">
        <span className="text-[9px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
          Connection
        </span>

        <Reading
          label="Device"
          value={link.online ? "Online" : "Offline"}
          tone={link.online ? "good" : "bad"}
        />

        {link.downlinkMbps === null ? null : (
          <Reading
            label="Speed"
            value={speed(link.downlinkMbps)}
            note={link.effectiveType ?? undefined}
          />
        )}

        {link.rttMs === null ? null : (
          <Reading label="Round trip" value={`${link.rttMs} ms`} />
        )}

        <Reading
          label="Stream"
          value={`${size(rate.perSecond)}/s`}
          note={`${size(rate.totalBytes)} this session`}
        />

        <Reading
          label="Hub"
          value={
            socket
              ? "Connected"
              : connection.hasEverConnected
                ? "Reconnecting"
                : "Connecting"
          }
          tone={socket ? "good" : "warn"}
        />

        <Reading
          label="AI"
          value={
            systems === null
              ? autoRefresh
                ? "Checking…"
                : "Not checked"
              : `${answering} of ${systems.length}`
          }
          tone={systems === null ? "warn" : answering ? "good" : "bad"}
          note={
            lookedAt
              ? new Date(lookedAt).toLocaleTimeString("en-US", {
                  hour: "numeric",
                  minute: "2-digit",
                })
              : undefined
          }
        />
      </div>

      {systems && systems.length > 0 ? (
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] leading-4">
          {systems.map((one) => (
            <span key={one.id} className="inline-flex items-center gap-1.5">
              <span
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  one.ok ? "bg-emerald-400/80" : "bg-destructive/70",
                )}
              />
              <span className="truncate text-foreground/80">{one.label}</span>
              <span className="tabular-nums text-muted-foreground">
                {one.ok ? `${one.ms} ms` : "no answer"}
              </span>
            </span>
          ))}
        </div>
      ) : null}

      {systems === null && autoRefresh ? (
        <span className="mt-1 inline-flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          Asking each system whether it is there
        </span>
      ) : null}

      {systems === null && !autoRefresh ? (
        <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
          Nothing is being asked: the Assistant switch for auto-refresh is off.
          Turn it on in the Control Room and the systems appear here.
        </p>
      ) : null}

      {systems && systems.length === 0 ? (
        <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
          Nothing was asked: no model key is configured on this hub, or this
          account has not been unlocked yet. Add a key in the Control Room and
          the systems appear here.
        </p>
      ) : null}
    </div>
  );
}

/** One reading: a small label, its value, and any second line beside it. */
function Reading({
  label,
  value,
  note,
  tone = "plain",
}: {
  label: string;
  value: string;
  note?: string;
  tone?: "plain" | "good" | "warn" | "bad";
}) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="text-muted-foreground/70">{label}</span>
      <span
        className={cn(
          "font-medium tabular-nums",
          tone === "good"
            ? "text-foreground"
            : tone === "bad"
              ? "text-destructive"
              : tone === "warn"
                ? "text-muted-foreground"
                : "text-foreground/85",
        )}
      >
        {value}
      </span>
      {note ? <span className="text-muted-foreground/70">· {note}</span> : null}
    </span>
  );
}
