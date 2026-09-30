import { PublicShell } from "@/components/PublicShell";
import { api } from "@/convex/_generated/api";
import { useAuth } from "@/hooks/use-auth";
import { useQuery } from "convex/react";
import { Component, lazy, type ReactNode } from "react";

// The hub's own frame, loaded the same lazy way `main.tsx` loads it, so opening
// one of these pages inside the hub costs no extra bundle on any other page.
const AppShell = lazy(() => import("@/pages/AppShell.tsx"));

/**
 * The frame for the two pages that belong to the hub *and* have to open without
 * it: the Web Portal and the Offline Brain.
 *
 * They are information and downloads, so they carry no sign-in and no family
 * password — that is what keeps them open on a brand-new device, and what makes
 * them the only two pages with anything to offer while the database cannot be
 * reached. Getting that used to cost the visitor the app, though: the tabs lived
 * in the public frame, so clicking "Web Portal" from inside the hub swapped the
 * entire strip of tabs and read as being thrown out of the hub rather than as
 * opening a page.
 *
 * The address no longer decides which frame you get — the session does. Signed
 * in and unlocked, the page opens inside the hub, exactly like the Messenger or
 * the Calendar. Signed out, locked, or with no database to ask, the same address
 * opens in the public frame. Same page, same address, and nothing that links
 * here has to know which frame it will land in.
 *
 * `unlocked` is true on a hub with no family password and false for a visitor
 * who is signed out; it is `undefined` until the answer arrives, and never
 * arrives when the deployment cannot be reached — which is precisely when the
 * public frame is the one wanted. Asking for it also keeps a locked device from
 * mounting the hub shell without the password, which would quietly put that
 * account back on the family roster.
 *
 * The session question is asked in `HubFrame` rather than in `HubPage` itself so
 * that a database answering with an *error* cannot take the page down with it —
 * see `FrameBoundary` below.
 */

/** Signed in and unlocked is the hub; anything else is the public frame. */
function HubFrame({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth();
  const access = useQuery(api.access.state);
  const inHub = isAuthenticated && access?.unlocked === true;

  return inHub ? (
    <AppShell>{children}</AppShell>
  ) : (
    <PublicShell>{children}</PublicShell>
  );
}

/**
 * Keeps a database that answers with an error from taking the whole page away.
 *
 * "No answer" and "an error" are different failures, and only one of them was
 * survivable. A deployment that cannot be reached leaves `useQuery` pending for
 * ever, so the page falls through to the public frame on its own. A deployment
 * Convex has switched off — its usage limit reached, say — answers every call
 * with an exception instead, and a query that throws while rendering goes
 * straight past this component to the top-level boundary in `main.tsx`, which
 * draws the "hub is paused" screen.
 *
 * That screen is the right answer for the messenger and the calendar, and the
 * wrong one for these two addresses: it replaces the only page in the hub that
 * needs no database at all with a notice about the database, so the Offline
 * Brain's catalogue — and every download on it — disappears exactly when it is
 * the one thing still working. Catching the failure here keeps the promise made
 * above: the same address, the public frame, all of its content.
 *
 * The failed session is not retried on a timer; reloading after the deployment
 * is back asks again, from a fresh mount.
 */
class FrameBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    console.warn(
      "[hub] no session to open this page in — using the public frame:",
      error.message,
    );
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function HubPage({ children }: { children: ReactNode }) {
  return (
    <FrameBoundary fallback={<PublicShell>{children}</PublicShell>}>
      <HubFrame>{children}</HubFrame>
    </FrameBoundary>
  );
}

export default HubPage;
