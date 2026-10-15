import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { api } from "@/convex/_generated/api";
import { deviceGatePasses } from "@/convex/device_rule";
import { useAuth } from "@/hooks/use-auth";
import { deviceId, deviceInfo, installationId } from "@/lib/device-identity";
import { cn } from "@/lib/utils";
import { useMutation, useQuery } from "convex/react";
import {
  Ban,
  KeyRound,
  Laptop,
  Loader2,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Tablet,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

/** How often to tell the server this device is still here. */
const TOUCH_MS = 60_000;

function DeviceIcon({ kind }: { kind: string }) {
  if (kind === "phone") return <Smartphone className="size-5" />;
  if (kind === "tablet") return <Tablet className="size-5" />;
  return <Laptop className="size-5" />;
}

/**
 * The device half of getting in.
 *
 * Authentication identifies the person; this identifies the installation, and
 * it is the difference between "I have an account" and "I may use this hub from
 * here". The installation registers itself the moment the app opens, and what
 * happens next depends on the hub: a `pending` row is waiting for the family
 * password to be answered, which is why a hub with one in force shows the form
 * below and a guests-only hub simply lets the device in. A revoked device is
 * the one thing that stays shut, and only the owner can reopen it.
 *
 * The decision is not made here — `device_rule.ts` holds it, and the server
 * asks the same rule, so hiding a screen or editing one changes nothing about
 * what the hub will actually answer.
 *
 * It sits outside the password gate on purpose: the order is authenticate,
 * identify the device, authorise it, then answer the password.
 */
export function DeviceGate({ children }: { children: ReactNode }) {
  const id = useMemo(() => deviceId(), []);
  const info = useMemo(() => deviceInfo(), []);
  const { isAuthenticated } = useAuth();

  const state = useQuery(api.security.state, { deviceId: id });
  const access = useQuery(api.access.state);
  const register = useMutation(api.security.register);
  const touch = useMutation(api.security.touch);
  const unlock = useMutation(api.access.unlock);
  const recordSignIn = useMutation(api.people.record);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const registering = useRef(false);

  const unlocked = access?.unlocked ?? false;
  const deviceStatus = state?.device?.status ?? null;
  const ownerExists = state?.ownerExists ?? false;

  /**
   * Register once there is something to register: a device the server has not
   * seen, or a claim to make. While the hub has no owner and this account has
   * just answered the password, registering is also what turns it into the
   * owner — so it is re-run the moment `unlocked` flips true.
   */
  useEffect(() => {
    if (!isAuthenticated || state === undefined) return;
    // Register when the server has not seen this device, when the device is
    // still waiting and the account can now qualify for it (the password has
    // been answered, or none is set), or when a claim can be made.
    const needsRegister =
      state.device === null ||
      (state.device.status === "pending" && (unlocked || !state.passwordRequired)) ||
      (!state.ownerExists && unlocked);
    if (!needsRegister || registering.current) return;

    registering.current = true;
    setBusy(true);
    register({
      deviceId: id,
      installationId: installationId(),
      name: info.name,
      platform: info.platform,
      kind: info.kind,
    })
      .catch((caught) => {
        setError(
          caught instanceof Error
            ? caught.message
            : "This device could not register. Check the connection and try again.",
        );
      })
      .finally(() => {
        registering.current = false;
        setBusy(false);
      });
  }, [info, isAuthenticated, id, register, state, unlocked]);

  /*
   * One line in the sign-in history for this arrival. The server keeps it to
   * one row per account and device inside a short window — so reloading is
   * not another sign-in, but coming back the next morning is.
   */
  useEffect(() => {
    if (!isAuthenticated || deviceStatus === null) return;
    void recordSignIn({ deviceId: id }).catch(() => undefined);
  }, [deviceStatus, id, isAuthenticated, recordSignIn]);

  /* A heartbeat, so the owner's device list says when each one was last here. */
  useEffect(() => {
    if (!isAuthenticated || deviceStatus === null) return;
    void touch({ deviceId: id }).catch(() => undefined);
    const timer = window.setInterval(() => {
      void touch({ deviceId: id }).catch(() => undefined);
    }, TOUCH_MS);
    return () => window.clearInterval(timer);
  }, [deviceStatus, id, isAuthenticated, touch]);

  if (state === undefined || access === undefined) {
    return (
      <main className="flex h-full min-h-screen items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </main>
    );
  }

  // Sign-in is the whole of getting in, and whether this installation may
  // proceed is one rule rather than two: `deviceGatePasses` is the same answer
  // the server's guard gives, so a signed-in person is never held here by a
  // row the hub has already stopped asking about.
  const allowed = deviceGatePasses({
    status: deviceStatus,
    passwordRequired: state.passwordRequired,
    ownerExists,
  });

  if (allowed) return <>{children}</>;

  const revoked = deviceStatus === "revoked";

  const submitPassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (unlocking || !password.trim()) return;
    setUnlocking(true);
    setUnlockError(null);
    try {
      const result = await unlock({ password, deviceId: id });
      if (result.ok) {
        // Answering the family password is what lets the register effect
        // authorise this device; it re-runs the moment `unlocked` flips.
        setPassword("");
      } else {
        setUnlockError(
          result.waiting > 0
            ? `Too many tries. Wait ${Math.ceil(result.waiting / 1000)} seconds, then have another go.`
            : "That is not the family password.",
        );
      }
    } catch {
      setUnlockError(
        "That did not go through. Check the connection and try again.",
      );
    } finally {
      setUnlocking(false);
    }
  };

  const retry = () => {
    setError(null);
    setBusy(true);
    register({
      deviceId: id,
      installationId: installationId(),
      name: info.name,
      platform: info.platform,
      kind: info.kind,
    })
      .catch(() =>
        setError("Still no answer from the server. Check the connection."),
      )
      .finally(() => setBusy(false));
  };

  return (
    <main className="flex h-full min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm rounded-2xl border-border/70 bg-card/70 backdrop-blur-sm">
        <CardHeader className="text-center">
          <div className="flex justify-center">
            <span
              className={cn(
                "grid size-11 place-items-center rounded-2xl",
                revoked
                  ? "bg-destructive/15 text-destructive"
                  : "bg-white/10 text-foreground",
              )}
            >
              {revoked ? (
                <Ban className="size-5" />
              ) : (
                <ShieldAlert className="size-5" />
              )}
            </span>
          </div>
          <CardTitle className="mt-3 text-[13px] font-semibold tracking-tight">
            {revoked ? "Access denied" : "Device authorisation required"}
          </CardTitle>
          <CardDescription className="text-[10px] leading-4 text-muted-foreground">
            {revoked
              ? "The owner has revoked this device. It cannot use the hub until the owner authorises it again."
              : "You are signed in, but this device has not been authorised for the private hub yet."}
          </CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-3">
          <div className="flex items-center gap-2 rounded-xl border border-border/60 bg-background/40 px-3 py-2.5">
            <DeviceIcon kind={info.kind} />
            <div className="min-w-0">
              <p className="truncate text-[11px] font-medium">{info.name}</p>
              <p className="truncate text-[9px] text-muted-foreground">
                {info.platform} · {info.browser}
                {ownerExists ? "" : " · setting up the hub"}
              </p>
            </div>
          </div>

          {revoked ? null : state.passwordRequired ? (
            <form onSubmit={submitPassword} className="flex flex-col gap-2">
              <Input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Family password"
                aria-label="Family password"
                autoComplete="current-password"
                disabled={unlocking}
                className="h-9 rounded-xl border-border/60 bg-background/40 text-center text-[11px]"
              />
              {unlockError ? (
                <p className="rounded-lg border border-dashed border-border/70 px-2.5 py-2 text-[10px] leading-4 text-muted-foreground">
                  {unlockError}
                </p>
              ) : null}
              <Button
                type="submit"
                disabled={unlocking || !password.trim()}
                className="h-9 w-full cursor-pointer rounded-xl text-[11px]"
              >
                {unlocking ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <KeyRound className="size-3.5" />
                )}
                Authorise this device
              </Button>
              <p className="text-center text-[9px] leading-4 text-muted-foreground">
                The family password links this device to the hub. The owner can
                also approve it in{" "}
                <span className="text-foreground/80">
                  Control Room → Security
                </span>
                , and can revoke it there.
              </p>
            </form>
          ) : (
            /* Reached only while the installation is registering itself: on a
               hub with a password the form above is what a pending device sees,
               and on one without, a pending row never lands here at all. */
            <p className="flex items-center gap-1.5 text-[10px] leading-4 text-muted-foreground">
              <Loader2 className="size-3 shrink-0 animate-spin" />
              Registering this device with the hub — this only takes a moment.
            </p>
          )}

          {error ? (
            <p className="rounded-lg border border-dashed border-border/70 px-2.5 py-2 text-[10px] leading-4 text-muted-foreground">
              {error}
            </p>
          ) : null}

          <Button
            type="button"
            onClick={retry}
            disabled={busy}
            className="h-9 w-full cursor-pointer rounded-xl text-[11px]"
          >
            {busy ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            Check again
          </Button>

          <p className="flex items-center justify-center gap-1.5 text-[9px] text-muted-foreground">
            <ShieldCheck className="size-3" />
            Access is granted by the server, not this screen.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
