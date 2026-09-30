import { BrainCircuit, CircuitBoard, Globe, Home } from "lucide-react";
import type { ReactNode } from "react";
import { NavLink, Outlet } from "react-router";
import { cn } from "@/lib/utils";

/**
 * The frame for a page that must open even when the hub's database does not.
 *
 * The Local Brain always uses it. The Web Portal and the Offline Brain fall back
 * to it whenever there is no signed-in, unlocked session to open them inside the
 * hub itself — `HubPage` in `main.tsx` decides which of the two frames they get.
 * None of the three holds anything private, so they sit outside the sign-in and
 * the family password on purpose. That is what makes them reachable on a
 * brand-new device, and what makes them the way in when the Convex deployment is
 * down — the rest of the hub still needs the database, and still asks for the
 * password.
 *
 * Handed a page directly it renders it; used as a route layout it leaves
 * `children` out and the child route comes through the Outlet instead, exactly
 * as AppShell does.
 */
const NAV = [
  { to: "/web-portal", label: "Web Portal", icon: Globe },
  { to: "/offline-brain", label: "Offline Brain", icon: BrainCircuit },
  { to: "/local-brain", label: "Local Brain", icon: CircuitBoard },
];

export function PublicShell({ children }: { children?: ReactNode } = {}) {
  return (
    // The bottom inset keeps the last row clear of a phone's home indicator
    // once the hub is installed and running without browser bars.
    <div
      className="flex h-dvh flex-col bg-background text-foreground"
      style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
    >
      <nav className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border/60 px-2 py-2 sm:px-3">
        {NAV.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              cn(
                "inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-medium transition-colors",
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

        <NavLink
          to="/"
          className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
          title="Open the hub — sign in and the family password are asked for there"
        >
          <Home className="size-3.5" />
          Open the hub
        </NavLink>
      </nav>

      <div className="min-h-0 flex-1 p-2">{children ?? <Outlet />}</div>
    </div>
  );
}

export default PublicShell;
