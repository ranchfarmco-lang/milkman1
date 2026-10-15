import { CallProvider } from "@/components/CallProvider";
import { CompanionBox } from "@/components/CompanionBox";
import { Button } from "@/components/ui/button";
import { api } from "@/convex/_generated/api";
import { useAuth } from "@/hooks/use-auth";
import { useDeviceEffects } from "@/hooks/use-device-effects";
import { useLocalRelay } from "@/hooks/use-local-relay";
import { useAssistantNudge } from "@/hooks/use-nudge";
import { usePresence } from "@/hooks/use-presence";
import { AssistantIcon } from "@/lib/assistant-mark";
import { setHubAiClient } from "@/lib/forge/hub-ai";
import { cn } from "@/lib/utils";
import { useConvex, useMutation, useQuery } from "convex/react";
import { useEffect, type ReactNode } from "react";
import {
  CalendarDays,
  Compass,
  Hammer,
  Lock,
  LogOut,
  MessageCircle,
  Radio,
  SlidersHorizontal,
  type LucideIcon,
} from "lucide-react";
import { NavLink, Outlet } from "react-router";
import { toast } from "sonner";

/**
 * The running order of the tabs, left to right. Calendar sits between the
 * Messenger and the Control Room, as asked.
 *
 * The Web Portal and the Offline Brain used to sit here as two more tabs. They
 * are sections of the Control Room now, so their tabs are gone: one page holds
 * them, and a tab that led to a second copy of the same thing would be exactly
 * the arrangement the merge undid. Their addresses still work — signed in, each
 * one opens the Control Room with its section at the top.
 */
const NAV: { to: string; label: string; icon: LucideIcon }[] = [
  // The browser leads: it is the hub's front door, and everything else is one
  // tap from its home.
  { to: "/browser", label: "Browser", icon: Compass },
  { to: "/assistant", label: "AI Assistant", icon: AssistantIcon },
  // One tab, not two: the apps the builder makes are the builder page's own
  // first box, so an App Sandbox tab beside it would be a second copy of the
  // same page — exactly the arrangement the merge undid. `/app-sandbox` still
  // lands here, so an old link or a bookmark is not broken by the tab going.
  { to: "/builder", label: "AI Builder", icon: Hammer },
  //
  // This App used to sit beside it as a tab of its own. It is a box of the AI
  // Builder page now — the sandbox there holds a copy of this project, so the
  // request that changes the hub, the check in the mirror and the files that
  // carry it in are all on the page whose job that is. Two tabs for one builder
  // with two targets was the thing a person had to guess at; `/this-app` still
  // lands on that page, so nothing that linked to it is broken.
  { to: "/messenger", label: "Messenger", icon: MessageCircle },
  { to: "/calendar", label: "Calendar", icon: CalendarDays },
  { to: "/control-room", label: "Control Room", icon: SlidersHorizontal },
  { to: "/live", label: "[LIVE]", icon: Radio },
];

/** Keeps every signed-in browser marked online for the family box. */
export default function AppShell({ children }: { children?: ReactNode } = {}) {
  const { signOut, user } = useAuth();
  usePresence();
  // The Control Room switches apply across the whole app, not just its page.
  useDeviceEffects();
  // The assistant speaks up on its own, from any page, only on a real alert.
  useAssistantNudge();
  // A model running on this machine is asked through this page, so the hub's
  // server never dials 127.0.0.1 and finds its own data centre there.
  useLocalRelay();

  // The forge's crew thinks with the hub's own models by default, and those
  // calls go through `ai.complete` — a walk a signed-in tab is allowed to make
  // and a page opened outside the app is not. This is the one place that has
  // the client carrying this browser's session, so it is handed over here and
  // taken back when the shell goes, rather than left behind for a page that
  // outlives the sign-in.
  const convex = useConvex();
  useEffect(() => {
    setHubAiClient(convex);
    return () => setHubAiClient(null);
  }, [convex]);

  // Everyone who can open the app belongs to the same family, so the messenger
  // and the contacts work the moment anyone arrives.
  const ensureFamily = useMutation(api.family.ensure);
  // A name is the other half of being in the family — you are not in the
  // contacts or the messenger without one. Joining happens the moment a name is
  // set, so this re-runs when the name does.
  const myName = user?.name ?? null;
  useEffect(() => {
    void ensureFamily({});
  }, [ensureFamily, myName]);

  // Closing the tab takes you off the roster straight away, so the family does
  // not keep seeing a name nobody can reach. Best effort on the way out; the
  // next heartbeat would put you back if you were only away for a moment.
  const leaveFamily = useMutation(api.family.leave);
  useEffect(() => {
    const bail = () => void leaveFamily({});
    window.addEventListener("pagehide", bail);
    return () => window.removeEventListener("pagehide", bail);
  }, [leaveFamily]);

  // Re-locking is only offered when there is a password to be asked for again.
  const accessState = useQuery(api.access.state);
  const lockDevice = useMutation(api.access.lock);
  const canLock =
    accessState?.required === true && accessState.unlocked === true;

  // The insets keep the app clear of what a phone puts over its own screen: the
  // bottom one for the home indicator once the hub is installed and running
  // without browser bars, and the left and right ones for the camera housing
  // when the phone is held sideways (the viewport is `viewport-fit=cover`, so
  // in landscape the notch sits over the page rather than beside it). Inline
  // styles rather than utilities so they cannot be dropped for being
  // unrecognised, and they resolve to 0px everywhere the insets do not exist.
  return (
    <div
      className="flex h-dvh flex-col bg-background text-foreground"
      style={{
        paddingBottom: "env(safe-area-inset-bottom, 0px)",
        paddingLeft: "env(safe-area-inset-left, 0px)",
        paddingRight: "env(safe-area-inset-right, 0px)",
      }}
    >
      {/* Every tab stays visible at the top. The strip wraps onto a second line
          when the window is too narrow to hold them all, rather than scrolling
          sideways — a tab parked off the right edge is a page nobody finds, and
          the last one in the row is always [LIVE]. */}
      <nav className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border/60 px-2 py-2 sm:px-3">
        {NAV.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              cn(
                "inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px] font-medium transition-colors sm:px-2.5",
                isActive
                  ? "bg-white/10 text-foreground"
                  : "text-muted-foreground hover:bg-white/5 hover:text-foreground",
              )
            }
          >
            <Icon className="size-3.5" />
            {label}
          </NavLink>
        ))}

        {canLock ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Lock this device"
            title="Lock this device — the family password is asked for again"
            className="ml-auto shrink-0 text-muted-foreground hover:text-foreground"
            onClick={() => {
              void lockDevice({}).then(() =>
                toast.success(
                  "Locked. The family password is asked for again.",
                ),
              );
            }}
          >
            <Lock className="size-3.5" />
          </Button>
        ) : null}

        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Sign out"
          className={cn(
            "shrink-0 text-muted-foreground hover:text-foreground",
            canLock ? "" : "ml-auto",
          )}
          onClick={() => void signOut()}
        >
          <LogOut className="size-3.5" />
        </Button>
      </nav>

      <div className="min-h-0 flex-1 p-2">
        {/* Calls belong to the whole app, so they can reach you on any page. */}
        <CallProvider>
          {/* As a route layout there is nothing here and the child route comes
              through the Outlet; handed a page directly — which is how the Web
              Portal and the Offline Brain are opened inside the hub — there is
              no Outlet to read, so it is used as it stands. */}
          {children ?? <Outlet />}
        </CallProvider>
      </div>

      {/* The companion sits outside the page frame rather than inside it, so
          moving between tabs never unmounts it: one conversation, one shared
          microphone, one place the page writes down what is on screen — the
          same box wherever they go. It is here rather than higher up because
          its turn is a signed-in one, and this shell is the outermost part of
          the app that is only ever reached with a session; the public pages —
          the Web Portal, the Offline Brain, the local brain — are opened
          without one and are deliberately left alone. */}
      <CompanionBox />
    </div>
  );
}
