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
import { cn } from "@/lib/utils";
import { useMutation, useQuery } from "convex/react";
import { ArrowRight, KeyRound, Loader2, Lock } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";

/**
 * The two things that stand between the app and the account: the family
 * password, and a name.
 *
 * Sits inside the signed-in area, so the person is already known — they just
 * have not yet said the things that let them in. The password answer is checked
 * on the server and recorded against the account, so this screen appearing is
 * not what protects the hub; the row the server writes is.
 *
 * The name is here for the same reason it is on the first-run sign-in: a name is
 * what puts somebody in the family. Because signing out now keeps the account
 * and only gives up the name, coming back is exactly this gate asking for a name
 * again — instead of spawning a second account that would linger on the roster.
 */
export function PasswordGate({ children }: { children: ReactNode }) {
  const state = useQuery(api.access.state);
  const user = useQuery(api.users.currentUser);
  const unlock = useMutation(api.access.unlock);
  const setDisplayName = useMutation(api.family.setDisplayName);

  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Still finding out whether there is a password, and who this account is.
  if (state === undefined || user === undefined) {
    return (
      <main className="flex h-full items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </main>
    );
  }

  const needsPassword = state.required && !state.unlocked;
  const needsName = !needsPassword && user !== null && !user.name;

  if (!needsPassword && !needsName) return <>{children}</>;

  const submitPassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !password.trim()) return;

    setBusy(true);
    setError(null);

    try {
      const result = await unlock({ password });
      if (result.ok) {
        setPassword("");
        return;
      }

      setError(
        result.waiting > 0
          ? `Too many tries. Wait ${Math.ceil(result.waiting / 1000)} seconds, then have another go.`
          : "That is not the family password. Check it with whoever set the hub up.",
      );
    } catch {
      setError("That did not go through. Check the connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  const submitName = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const clean = name.trim();
    if (busy || !clean) return;

    setBusy(true);
    setError(null);

    try {
      await setDisplayName({ name: clean });
      setName("");
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not save that name. Try another one.",
      );
    } finally {
      setBusy(false);
    }
  };

  const shell = (title: string, description: string, body: ReactNode) => (
    <main className="flex h-full items-center justify-center p-4">
      <Card className="w-full max-w-sm rounded-2xl border-border/70 bg-card/70 backdrop-blur-sm">
        <CardHeader className="text-center">
          <div className="flex justify-center">
            <span className="grid size-11 place-items-center rounded-2xl bg-white/10 text-foreground">
              {needsPassword ? (
                <Lock className="size-5" />
              ) : (
                <KeyRound className="size-5" />
              )}
            </span>
          </div>
          <CardTitle className="mt-3 flex items-center justify-center gap-2 text-[13px] font-semibold tracking-tight">
            {needsPassword ? (
              <>
                <KeyRound className="size-3.5" />
                This hub is private
              </>
            ) : (
              title
            )}
          </CardTitle>
          <CardDescription className="text-[10px] leading-4 text-muted-foreground">
            {description}
          </CardDescription>
        </CardHeader>

        {body}
      </Card>
    </main>
  );

  if (needsPassword) {
    return shell(
      "This hub is private",
      "Type the family password. It is the same one for everyone, and you only have to do this once on each device.",
      <form onSubmit={submitPassword}>
        <CardContent className="flex flex-col gap-2">
          <Input
            type="password"
            name="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Family password"
            aria-label="Family password"
            autoFocus
            autoComplete="current-password"
            disabled={busy}
            className="h-10 rounded-xl border-border/60 bg-background/40 text-center"
          />

          {error ? (
            <p className="rounded-lg border border-dashed border-border/70 px-2.5 py-2 text-[10px] leading-4 text-muted-foreground">
              {error}
            </p>
          ) : null}

          <Button
            type="submit"
            disabled={busy || !password.trim()}
            className={cn("h-10 w-full cursor-pointer rounded-xl text-[11px]")}
          >
            {busy ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <ArrowRight className="size-3.5" />
            )}
            Unlock
          </Button>
        </CardContent>
      </form>,
    );
  }

  return shell(
    "What should we call you?",
    "Your family sees this name in the Messenger, on the messages you send and on the video portals. You need one to join the family.",
    <form onSubmit={submitName}>
      <CardContent className="flex flex-col gap-2">
        <Input
          name="name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Your name"
          aria-label="Your name"
          autoComplete="given-name"
          maxLength={40}
          autoFocus
          disabled={busy}
          className="h-10 rounded-xl border-border/60 bg-background/40 text-center"
        />

        {error ? (
          <p className="rounded-lg border border-dashed border-border/70 px-2.5 py-2 text-[10px] leading-4 text-muted-foreground">
            {error}
          </p>
        ) : null}

        <Button
          type="submit"
          disabled={busy || !name.trim()}
          className={cn("h-10 w-full cursor-pointer rounded-xl text-[11px]")}
        >
          {busy ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <ArrowRight className="size-3.5" />
          )}
          That is me
        </Button>
      </CardContent>
    </form>,
  );
}
