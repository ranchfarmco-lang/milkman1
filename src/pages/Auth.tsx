import { HubUnreachable } from "@/components/HubUnreachable";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api } from "@/convex/_generated/api";
import { useAuth } from "@/hooks/use-auth";
import { useHubReachable } from "@/hooks/use-hub-reachable";
import { deviceId } from "@/lib/device-identity";
import logo from "@/assets/logo.svg";
import { useMutation, useQuery } from "convex/react";
import { ArrowRight, KeyRound, Loader2, Lock } from "lucide-react";
import { Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router";

interface AuthProps {
  redirectAfterAuth?: string;
}

function resolveRedirectAfterAuth(
  returnTo: string | null,
  fallback = "/assistant",
) {
  if (returnTo?.startsWith("/") && !returnTo.startsWith("//")) {
    return returnTo;
  }
  return fallback;
}

function FullScreenLoader() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
    </div>
  );
}

/** The one card every step of getting in is shown in. */
function GateShell({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  const navigate = useNavigate();

  return (
    <div className="flex min-h-screen flex-col p-4">
      <div className="flex flex-1 items-center justify-center">
        <div className="flex h-full w-full max-w-[350px] flex-col items-center justify-center">
          {/* The card fills whatever room it is given up to 350px, rather than
              being at least 350px wide: on the narrowest phones (320px, and
              the 280px folding covers) a minimum width is wider than the
              screen, so the whole page scrolled sideways. */}
          <Card className="w-full pb-0 border shadow-md">
            <CardHeader className="text-center">
              <div className="flex justify-center">
                <img
                  src={logo}
                  alt="Family Chat Hub"
                  width={64}
                  height={64}
                  className="rounded-lg mb-4 mt-4 cursor-pointer"
                  onClick={() => navigate("/")}
                />
              </div>
              <CardTitle className="text-lg">{title}</CardTitle>
              <CardDescription className="text-[13px]">
                {description}
              </CardDescription>
            </CardHeader>

            {children}

            <div className="py-4 px-6 text-[11px] text-center text-muted-foreground bg-muted border-t rounded-b-lg">
              Runs on your own database. Nothing outside this hub sees your
              sign-in.
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

/**
 * The hub's own sign-in: a name and a password, held by this hub.
 *
 * This is the account that belongs to the deployment rather than to a browser.
 * The device account taken automatically below is made fresh in each browser and
 * cannot follow somebody to a second device; this one is stored in the hub's own
 * database, hashed, and works anywhere the hub is reachable. Nothing outside is
 * called: no email is sent, no service is asked, and it works on a hub with no
 * network at all.
 *
 * The identifier is deliberately loose — a name is enough, and an email address
 * is kept as it was typed — because the hub never sends email and so has no use
 * for one. What a typed name turns into is decided in one place,
 * `accountIdentifier` in `src/convex/auth.ts`, so this page and the server
 * cannot disagree about it.
 */
function AccountCard({
  signIn,
  onDone,
  onCancel,
}: {
  signIn: ReturnType<typeof useAuth>["signIn"];
  onDone: () => void;
  onCancel: () => void;
}) {
  const [identifier, setIdentifier] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * One form, two flows: sign in, or make the account first.
   *
   * The password decides who somebody is; this decides whether the account has
   * to exist yet. Both are the same call to the same provider — `signIn` with
   * the `password` provider is also what creates an account, which is why there
   * is no separate "register" screen.
   */
  const run = async (flow: "signIn" | "signUp") => {
    if (!identifier.trim() || !secret) return;

    setBusy(true);
    setError(null);

    try {
      await signIn("password", { email: identifier, password: secret, flow });
      onDone();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      // The provider's own words are not written for a person to read, so the
      // two cases that actually happen are translated. Anything else is passed
      // through as it came rather than replaced with a guess.
      if (/InvalidAccountId|not found|no account/i.test(message)) {
        setError(
          flow === "signIn"
            ? "No account by that name on this hub yet — use “Create this account” below."
            : "That name is already taken on this hub — sign in instead.",
        );
      } else if (/InvalidSecret|invalid password/i.test(message)) {
        setError("That is not the password for this account.");
      } else {
        setError(message);
      }
      setBusy(false);
    }
  };

  return (
    <GateShell
      title="Sign in to your account"
      description="Your name and password, kept in this hub's own database. Nothing is sent anywhere, and the same account works on every device that can reach the hub."
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run("signIn");
        }}
      >
        <CardContent className="flex flex-col gap-2">
          <Input
            name="identifier"
            value={identifier}
            onChange={(event) => setIdentifier(event.target.value)}
            placeholder="Your name, or your email"
            aria-label="Your name or email"
            autoComplete="username"
            autoFocus
            disabled={busy}
            className="text-center"
          />
          <Input
            name="secret"
            type="password"
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            placeholder="Password"
            aria-label="Password"
            autoComplete="current-password"
            disabled={busy}
            className="text-center"
          />

          {error && <p className="mt-2 text-[13px] text-red-500">{error}</p>}

          <Button
            type="submit"
            className="mt-1 w-full"
            disabled={busy || !identifier.trim() || !secret}
          >
            {busy ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <KeyRound className="mr-2 h-4 w-4" />
            )}
            Sign in
          </Button>

          <Button
            type="button"
            variant="ghost"
            className="w-full text-[12px]"
            disabled={busy || !identifier.trim() || secret.length < 8}
            onClick={() => void run("signUp")}
          >
            Create this account
          </Button>

          <Button
            type="button"
            variant="ghost"
            className="w-full text-[12px] text-muted-foreground"
            onClick={onCancel}
            disabled={busy}
          >
            Use this device instead
          </Button>

          <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
            No email is sent and no code is needed — the hub has no email service
            and does not need one. A password is at least 8 characters, and there
            is no reset, so keep it somewhere you can find it.
          </p>
        </CardContent>
      </form>
    </GateShell>
  );
}

/**
 * The way into the hub.
 *
 * Sign-in is guests-only for now (`guard.GUESTS_ONLY`): the server reports no
 * password required, so there is no email form and no password screen — the
 * browser quietly takes an anonymous account behind the scenes and this page
 * goes straight to the one question it still asks, what to call you.
 *
 * The password card below is not dead code. It is what answers when the switch
 * is flipped back: asked for on the server, written down against the account,
 * and required on each device, exactly as before. While the switch is on, none
 * of it is drawn and nothing on the server asks for it either.
 *
 * The one question that is still asked is the name, and it is not optional — a
 * name is what puts you in the family, so without one you are not in the
 * contacts and cannot use the messenger. That is what keeps a "Guest" spot
 * from ever appearing.
 */
function Auth({ redirectAfterAuth }: AuthProps = {}) {
  const { isLoading: authLoading, isAuthenticated, user, signIn } = useAuth();
  const { unreachable, retries } = useHubReachable();
  const navigate = useNavigate();
  const id = useMemo(() => deviceId(), []);
  const [searchParams] = useSearchParams();
  const redirect = resolveRedirectAfterAuth(
    searchParams.get("returnTo"),
    redirectAfterAuth,
  );

  const accessState = useQuery(api.access.state);
  const unlock = useMutation(api.access.unlock);
  const setDisplayName = useMutation(api.family.setDisplayName);

  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Whether the account form was chosen over the device one. The device account
  // is still taken automatically below — it is what the family password and the
  // device rule answer against — and signing in with an account replaces that
  // session with the account's own.
  const [showAccount, setShowAccount] = useState(false);

  const needsPassword =
    accessState?.required === true && accessState.unlocked === false;

  const needsName =
    !needsPassword && isAuthenticated && !authLoading && !user?.name;

  // Take the account the answer will be recorded against. Nobody is offered a
  // choice here and nobody gets in without the password.
  useEffect(() => {
    if (authLoading || accessState === undefined || isAuthenticated) return;
    void signIn("anonymous").catch(() =>
      setError(
        "This browser would not let the hub sign you in. Reload and try again.",
      ),
    );
  }, [accessState, authLoading, isAuthenticated, signIn]);

  // Answered and named: nothing left to ask, so go in.
  useEffect(() => {
    if (!authLoading && isAuthenticated && !needsPassword && !needsName) {
      navigate(redirect);
    }
  }, [
    authLoading,
    isAuthenticated,
    needsName,
    needsPassword,
    navigate,
    redirect,
  ]);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!password.trim()) return;

    setIsLoading(true);
    setError(null);

    try {
      const result = await unlock({ password, deviceId: id });

      if (result.needsSignIn) {
        void signIn("anonymous");
        setError("One moment — setting up this device. Try again in a second.");
        setIsLoading(false);
        return;
      }

      if (!result.ok) {
        setError(
          result.waiting > 0
            ? `Too many tries. Wait ${Math.ceil(result.waiting / 1000)} seconds, then have another go.`
            : "That is not the family password.",
        );
        setIsLoading(false);
        return;
      }

      setPassword("");
      setIsLoading(false);
    } catch {
      setError("That did not go through. Check the connection and try again.");
      setIsLoading(false);
    }
  };

  const handleNameSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const clean = name.trim();
    if (!clean) return;

    setIsLoading(true);
    setError(null);

    try {
      await setDisplayName({ name: clean });
      navigate(redirect);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not save that name. Try another one.",
      );
      setIsLoading(false);
    }
  };

  // Still working out whether there is a password to ask for. While the
  // database is unreachable this never resolves, so it is reported rather than
  // spun on — the sign-in steps below all need that database anyway.
  if (accessState === undefined) {
    if (unreachable) return <HubUnreachable retries={retries} />;
    return <FullScreenLoader />;
  }

  // Somebody who has an account: the account form answers both questions below
  // at once, so it stands in front of them rather than after them.
  if (showAccount) {
    return (
      <AccountCard
        signIn={signIn}
        onDone={() => setShowAccount(false)}
        onCancel={() => setShowAccount(false)}
      />
    );
  }

  // The second half of first-time setup: say who you are. It is required — a
  // name is what puts you in the family alongside the password.
  if (!needsPassword && needsName) {
    return (
      <GateShell
        title="What should we call you?"
        description="Your family sees this name in the Messenger, on the messages you send and on the video portals. You need one to join the family. You can change it later."
      >
        <form onSubmit={handleNameSubmit}>
          <CardContent>
            <Input
              name="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Your name"
              aria-label="Your name"
              autoComplete="given-name"
              maxLength={40}
              autoFocus
              disabled={isLoading}
              className="text-center"
            />

            {error && <p className="mt-2 text-[13px] text-red-500">{error}</p>}

            <Button
              type="submit"
              className="mt-3 w-full"
              disabled={isLoading || !name.trim()}
            >
              {isLoading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <ArrowRight className="mr-2 h-4 w-4" />
              )}
              That is me
            </Button>

            {/* The other way in, next to the first one: an account made here
                rather than a name written against this browser. */}
            <Button
              type="button"
              variant="ghost"
              className="mt-1 w-full text-[12px] text-muted-foreground"
              onClick={() => {
                setError(null);
                setShowAccount(true);
              }}
            >
              I already have an account
            </Button>
          </CardContent>
        </form>
      </GateShell>
    );
  }

  // Nothing to ask — signed in, unlocked and named, so the effect above is
  // already moving on.
  if (!needsPassword) {
    return <FullScreenLoader />;
  }

  return (
    <GateShell
      title="Enter the family password"
      description="One password for everyone. You only do this once on each device."
    >
      <form onSubmit={handleSubmit}>
        <CardContent>
          <div className="relative flex items-center gap-2">
            <div className="relative flex-1">
              <Lock className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
              <Input
                name="password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Family password"
                className="pl-9"
                autoComplete="current-password"
                autoFocus
                disabled={isLoading}
              />
            </div>
            <Button
              type="submit"
              variant="outline"
              size="icon"
              aria-label="Unlock"
              disabled={isLoading || !password.trim()}
            >
              {isLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ArrowRight className="h-4 w-4" />
              )}
            </Button>
          </div>

          {error && <p className="mt-2 text-[13px] text-red-500">{error}</p>}

          <p className="mt-3 text-[11px] leading-4 text-muted-foreground">
            Locked out? Whoever set the hub up can change the password for
            everyone at any time.
          </p>

          <Button
            type="button"
            variant="ghost"
            className="mt-1 w-full text-[12px] text-muted-foreground"
            onClick={() => {
              setError(null);
              setShowAccount(true);
            }}
          >
            I already have an account
          </Button>
        </CardContent>
      </form>
    </GateShell>
  );
}

export default function AuthPage(props: AuthProps) {
  return (
    <Suspense>
      <Auth {...props} />
    </Suspense>
  );
}
