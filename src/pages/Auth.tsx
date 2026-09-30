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
import logo from "@/assets/logo.svg";
import { useMutation, useQuery } from "convex/react";
import { ArrowRight, Loader2, Lock } from "lucide-react";
import { Suspense, useEffect, useState, type ReactNode } from "react";
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
    <div className="min-h-screen flex flex-col">
      <div className="flex-1 flex items-center justify-center">
        <div className="flex items-center justify-center h-full flex-col">
          <Card className="min-w-[350px] pb-0 border shadow-md">
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
 * The only way into the hub: the family password.
 *
 * There is no email form and no guest button. The password is checked on the
 * server and written down against an account, so the browser quietly takes one
 * behind the scenes — that account is bookkeeping, not an option, and nothing is
 * readable until the password has been answered.
 *
 * Then one question, once: what to call you. It is not optional — the password
 * and a name together are what put you in the family, so without a name you are
 * not in the contacts and cannot use the messenger. That is what keeps a
 * "Guest" spot from ever appearing.
 *
 * A hub with no password configured skips straight in, so removing
 * `HUB_PASSWORD` can never lock everyone out of their own app.
 */
function Auth({ redirectAfterAuth }: AuthProps = {}) {
  const { isLoading: authLoading, isAuthenticated, user, signIn } = useAuth();
  const { unreachable, retries } = useHubReachable();
  const navigate = useNavigate();
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
      const result = await unlock({ password });

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
