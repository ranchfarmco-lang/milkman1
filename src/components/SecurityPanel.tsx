import { Button } from "@/components/ui/button";
import { api } from "@/convex/_generated/api";
import { useAuth } from "@/hooks/use-auth";
import { useHubReachable } from "@/hooks/use-hub-reachable";
import { backendUrlInUse } from "@/lib/backend";
import { ORANGE_GHOST } from "@/lib/control-room-sections";
import { deviceId } from "@/lib/device-identity";
import { cn } from "@/lib/utils";
import { useMutation, useQuery } from "convex/react";
import {
  Ban,
  Brain,
  Check,
  KeyRound,
  Loader2,
  Lock,
  MonitorSmartphone,
  Network,
  RotateCcw,
  Server,
  ShieldCheck,
  ShieldOff,
  UserCheck,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

/** A time a person can read without doing arithmetic. */
function when(at: number): string {
  const diff = Date.now() - at;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} h ago`;
  return new Date(at).toLocaleDateString();
}

type Tone = "good" | "bad" | "warn" | "muted";

function Row({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone: Tone;
}) {
  const toneClass =
    tone === "good"
      ? "text-emerald-400"
      : tone === "bad"
        ? "text-destructive"
        : tone === "warn"
          ? "text-amber-400"
          : "text-muted-foreground";
  return (
    <div className="flex items-center justify-between gap-2 border-t border-border/50 py-1.5 first:border-t-0">
      <span className="flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground">
        <span className="text-foreground/60">{icon}</span>
        {label}
      </span>
      <span className={cn("shrink-0 text-[10px] font-medium tracking-tight", toneClass)}>
        {value}
      </span>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === "authorized"
      ? "border-emerald-500/40 text-emerald-400"
      : status === "pending"
        ? "border-amber-500/40 text-amber-400"
        : "border-destructive/40 text-destructive";
  return (
    <span
      className={cn(
        "rounded-full border px-2 py-0.5 text-[9px] font-medium capitalize",
        tone,
      )}
    >
      {status}
    </span>
  );
}

/**
 * The private half of the Control Room: the security status of the hub, the
 * devices that may use it, and the log of what has happened.
 *
 * Everything on it is server state. The device list and the log are only
 * returned to the owner by the backend, so a non-owner sees the status of their
 * own device and nothing else — and no button here is what grants access; the
 * mutations behind them check ownership on the server.
 */
export function SecurityPanel() {
  const { isAuthenticated } = useAuth();
  const { unreachable } = useHubReachable();
  const id = useMemo(() => deviceId(), []);

  const summary = useQuery(api.security.summary);
  const access = useQuery(api.access.state);
  const mine = useQuery(api.security.state, { deviceId: id });
  const isOwner = summary?.isOwner === true;

  const devices = useQuery(api.security.devices, isOwner ? {} : "skip");
  const log = useQuery(api.security.log, isOwner ? { limit: 40 } : "skip");
  const aiSystems = useQuery(api.ai.systems);

  const authorize = useMutation(api.security.authorize);
  const revoke = useMutation(api.security.revoke);
  const restore = useMutation(api.security.restore);
  const terminate = useMutation(api.security.terminate);

  const [busy, setBusy] = useState<string | null>(null);

  // The address the client is actually talking to, read from the one place that
  // decided it — not worked out again, so this row cannot disagree with what the
  // app is really using (see `src/lib/backend.ts`).
  const backend = backendUrlInUse(
    import.meta.env.VITE_CONVEX_URL as string | undefined,
    window.location,
    import.meta.env.DEV,
  );
  // "Private network" is reported honestly: it is in use when the address the
  // page talks to is a private/loopback one rather than a public hostname.
  const privateNetwork =
    !/^[a-z]+:\/\/([^/]+)/i.test(backend) ||
    /^[a-z]+:\/\/(127\.|localhost|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(
      backend,
    );

  const run = async (
    deviceIdToAct: string,
    label: string,
    action: () => Promise<unknown>,
  ) => {
    setBusy(deviceIdToAct + label);
    try {
      await action();
      toast.success(`${label} done.`);
    } catch (caught) {
      toast.error(
        caught instanceof Error ? caught.message : "That did not go through.",
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="rounded-2xl border border-border/70 bg-card/70 p-4 backdrop-blur-sm">
      <h3 className="flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        <ShieldCheck className="size-3" />
        Security
      </h3>
      <p className="mt-1.5 text-[10px] leading-4 text-muted-foreground">
        The hub is private by default: no anonymous access, no public
        registration, no public memory or task history. Access is granted by the
        server — an authenticated account on an authorised device, not a hidden
        screen or a secret address.
      </p>

      {/* -------------------------------------------------------- status */}
      <div className="mt-3 rounded-xl border border-border/60 bg-background/30 px-3 py-1">
        <Row
          icon={<Server className="size-3" />}
          label="Server"
          value={unreachable ? "OFFLINE" : "CONNECTED"}
          tone={unreachable ? "bad" : "good"}
        />
        <Row
          icon={<Lock className="size-3" />}
          label="Connection"
          value={window.isSecureContext ? "SECURE" : "NOT ENCRYPTED"}
          tone={window.isSecureContext ? "good" : "bad"}
        />
        <Row
          icon={<UserCheck className="size-3" />}
          label="User"
          value={isAuthenticated ? "AUTHENTICATED" : "NOT AUTHENTICATED"}
          tone={isAuthenticated ? "good" : "bad"}
        />
        <Row
          icon={<MonitorSmartphone className="size-3" />}
          label="Device"
          value={
            mine?.device?.status === "authorized"
              ? "AUTHORIZED"
              : mine?.device?.status
                ? mine.device.status.toUpperCase()
                : "NOT REGISTERED"
          }
          tone={mine?.device?.status === "authorized" ? "good" : "warn"}
        />
        <Row
          icon={<KeyRound className="size-3" />}
          label="Session"
          value={
            !access?.required
              ? "OPEN (no password set)"
              : access.unlocked
                ? "ACTIVE"
                : "EXPIRED"
          }
          tone={access?.unlocked ? "good" : "warn"}
        />
        <Row
          icon={<Network className="size-3" />}
          label="Private network"
          value={privateNetwork ? "IN USE" : "NOT IN USE"}
          tone={privateNetwork ? "good" : "muted"}
        />
        <Row
          icon={<Brain className="size-3" />}
          label="AI backend"
          value={(aiSystems?.length ?? 0) > 0 ? "AVAILABLE" : "UNAVAILABLE"}
          tone={(aiSystems?.length ?? 0) > 0 ? "good" : "warn"}
        />
      </div>

      {/* ------------------------------------------------------- owner bits */}
      {!isOwner ? (
        <p className="mt-3 rounded-xl border border-dashed border-border/60 px-3 py-2 text-[10px] leading-4 text-muted-foreground">
          Only the hub's owner can see the device list and the security log, or
          authorise and revoke devices.{" "}
          {summary?.ownerName ? (
            <>The owner is {summary.ownerName}.</>
          ) : (
            <>No owner has claimed this hub yet.</>
          )}
        </p>
      ) : (
        <>
          <div className="mt-3 flex items-center justify-between">
            <p className="text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Authorised devices
            </p>
            <span className="text-[9px] text-muted-foreground">
              {summary?.devices.authorized ?? 0} authorised ·{" "}
              {summary?.devices.pending ?? 0} waiting ·{" "}
              {summary?.devices.revoked ?? 0} revoked
            </span>
          </div>

          <div className="mt-2 flex flex-col gap-1.5">
            {devices === undefined ? (
              <div className="flex items-center justify-center py-3">
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              </div>
            ) : devices.length === 0 ? (
              <p className="py-2 text-[10px] text-muted-foreground">
                No devices have registered yet.
              </p>
            ) : (
              devices.map((device) => (
                <div
                  key={device.deviceId}
                  className="flex flex-wrap items-center gap-2 rounded-xl border border-border/60 bg-background/30 px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1.5 truncate text-[11px] font-medium">
                      {device.name}
                      {device.isOwner ? (
                        <span className="rounded-full border border-primary/40 px-1.5 py-0.5 text-[8px] uppercase tracking-wide text-primary">
                          owner
                        </span>
                      ) : null}
                    </p>
                    <p className="truncate text-[9px] text-muted-foreground">
                      {device.platform} · {device.kind} · {device.ownerName} ·
                      last seen {when(device.lastSeenAt)}
                    </p>
                  </div>

                  <StatusPill status={device.status} />

                  <div className="flex shrink-0 items-center gap-1">
                    {device.status !== "authorized" ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={busy === device.deviceId + "Authorise"}
                        onClick={() =>
                          run(device.deviceId, "Authorise", () =>
                            authorize({ deviceId: device.deviceId }),
                          )
                        }
                        className="h-7 cursor-pointer rounded-lg text-[9px]"
                      >
                        <Check className="size-3" />
                        Authorise
                      </Button>
                    ) : null}

                    {device.status === "authorized" ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={busy === device.deviceId + "End session"}
                        onClick={() =>
                          run(device.deviceId, "End session", () =>
                            terminate({ deviceId: device.deviceId }),
                          )
                        }
                        className="h-7 cursor-pointer rounded-lg text-[9px]"
                      >
                        <X className="size-3" />
                        Log out
                      </Button>
                    ) : null}

                    {device.status !== "revoked" ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={busy === device.deviceId + "Revoke"}
                        onClick={() =>
                          run(device.deviceId, "Revoke", () =>
                            revoke({ deviceId: device.deviceId }),
                          )
                        }
                        className="h-7 cursor-pointer rounded-lg text-[9px] text-destructive"
                      >
                        <Ban className="size-3" />
                        Revoke
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={busy === device.deviceId + "Restore"}
                        onClick={() =>
                          run(device.deviceId, "Restore", () =>
                            restore({ deviceId: device.deviceId }),
                          )
                        }
                        className={cn(
                          "h-7 cursor-pointer rounded-lg text-[9px]",
                          ORANGE_GHOST,
                        )}
                      >
                        <RotateCcw className="size-3" />
                        Restore
                      </Button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>

          <p className="mt-3 text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Security log
          </p>
          <div className="mt-2 max-h-56 overflow-y-auto rounded-xl border border-border/60 bg-background/30">
            {log === undefined ? (
              <div className="flex items-center justify-center py-3">
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              </div>
            ) : log.length === 0 ? (
              <p className="px-3 py-2 text-[10px] text-muted-foreground">
                Nothing recorded yet.
              </p>
            ) : (
              log.map((entry) => (
                <div
                  key={entry._id}
                  className="flex items-start gap-2 border-t border-border/50 px-3 py-1.5 first:border-t-0"
                >
                  <span
                    className={cn(
                      "mt-0.5 shrink-0",
                      entry.event.startsWith("device.revoked") ||
                        entry.event === "session.failed"
                        ? "text-destructive"
                        : entry.event.startsWith("device.")
                          ? "text-amber-400"
                          : "text-muted-foreground",
                    )}
                  >
                    {entry.event === "device.revoked" ? (
                      <ShieldOff className="size-3" />
                    ) : (
                      <ShieldCheck className="size-3" />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[10px] font-medium">
                      {entry.event}
                      {entry.deviceName ? (
                        <span className="text-muted-foreground">
                          {" "}
                          · {entry.deviceName}
                        </span>
                      ) : null}
                    </p>
                    {entry.detail ? (
                      <p className="truncate text-[9px] text-muted-foreground">
                        {entry.detail}
                      </p>
                    ) : null}
                  </div>
                  <span className="shrink-0 text-[9px] text-muted-foreground">
                    {when(entry.at)}
                  </span>
                </div>
              ))
            )}
          </div>
        </>
      )}
    </section>
  );
}
