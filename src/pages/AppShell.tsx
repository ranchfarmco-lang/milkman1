import { CallProvider } from "@/components/CallProvider";
import { Button } from "@/components/ui/button";
import { api } from "@/convex/_generated/api";
import { useAuth } from "@/hooks/use-auth";
import { useDeviceEffects } from "@/hooks/use-device-effects";
import { useAssistantNudge } from "@/hooks/use-nudge";
import { usePresence } from "@/hooks/use-presence";
import { cn } from "@/lib/utils";
import { useMutation, useQuery } from "convex/react";
import { useEffect, type ReactNode } from "react";
import {
  BrainCircuit,
  CalendarDays,
  Church,
  Globe,
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
 */
const NAV: { to: string; label: string; icon: LucideIcon }[] = [
  { to: "/assistant", label: "AI Assistant", icon: Church },
  { to: "/builder", label: "AI Builder", icon: Hammer },
  { to: "/messenger", label: "Messenger", icon: MessageCircle },
  { to: "/calendar", label: "Calendar", icon: CalendarDays },
  { to: "/control-room", label: "Control Room", icon: SlidersHorizontal },
  { to: "/web-portal", label: "Web Portal", icon: Globe },
  { to: "/offline-brain", label: "Offline Brain", icon: BrainCircuit },
  { to: "/live", label: "[LIVE]", icon: Radio },
];

/** Keeps every signed-in browser marked online for the family box. */
export default function AppShell({ children }: { children?: ReactNode } = {}) {
  const { signOut, user } = useAuth();
  usePresence();
  // The Control Room switches apply across the whole app, not just its page.
  useDeviceEffects();
  // The assistant speaks up on its own, from any page, when you go quiet.
  useAssistantNudge();

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
  const canLock = accessState?.required === true && accessState.unlocked === true;

  // The bottom inset keeps the last row clear of a phone's home indicator once
  // the hub is installed and running without browser bars. It is an inline style
  // rather than a utility so it cannot be dropped for being unrecognised, and it
  // resolves to 0px everywhere the inset does not exist.
  return (
    <div
      className="flex h-dvh flex-col bg-background text-foreground"
      style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
    >
      {/* Every tab stays visible at the top. The strip wraps onto a second line
          when the window is too narrow to hold all eight, rather than scrolling
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
                toast.success("Locked. The family password is asked for again."),
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
    </div>
  );
}
