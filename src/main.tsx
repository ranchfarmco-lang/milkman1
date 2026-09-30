// First, and for its side effect: some browsers refuse `localStorage`, and a
// preview inside a sandboxed frame is one of them. Swapping in an in-memory
// stand-in has to happen before any later import — a library's included — can
// touch storage. See the file for why.
import "@/lib/safe-storage";

import { HubPage } from "@/components/HubPage";
import { PasswordGate } from "@/components/PasswordGate";
import { PublicShell } from "@/components/PublicShell";
import { RequireAuth } from "@/components/RequireAuth";
import { Toaster } from "@/components/ui/sonner";
import { resolveBackendUrl } from "@/lib/backend";
import { IS_LOCAL } from "@/lib/profile";
import { registerServiceWorker } from "@/lib/pwa";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { ConvexReactClient } from "convex/react";
import React, { StrictMode, useEffect, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router";
import "./index.css";

// Lazy load route components for better code splitting
const AppShell = lazy(() => import("./pages/AppShell.tsx"));
const BoxPage = lazy(() => import("./pages/BoxPage.tsx"));
const CalendarPage = lazy(() => import("./pages/CalendarPage.tsx"));
const ControlRoom = lazy(() => import("./pages/ControlRoom.tsx"));
const WebPortal = lazy(() => import("./pages/WebPortal.tsx"));
const OfflineBrain = lazy(() => import("./pages/OfflineBrain.tsx"));
const LocalBrain = lazy(() => import("./pages/LocalBrain.tsx"));
const LivePage = lazy(() => import("./pages/LivePage.tsx"));
const AuthPage = lazy(() => import("./pages/Auth.tsx"));
const NotFound = lazy(() => import("./pages/NotFound.tsx"));

// Simple loading fallback for route transitions
function RouteLoading() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="animate-pulse text-muted-foreground">Loading...</div>
    </div>
  );
}

/**
 * Whether the failure is Convex itself being switched off rather than anything
 * this app did wrong. A deployment that has hit its usage limit answers every
 * call with this, so the preview would otherwise open straight onto a raw
 * server error with a stack trace — which reads like a bug in the app and is
 * not one. Recognising it lets the page say what is actually happening.
 */
function deploymentPaused(message: string) {
  return /usage limit|deployment has been disabled|exceeded a configured/i.test(
    message,
  );
}

/** The calm screen shown when the hub's own database has been paused. */
function HubPaused() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background text-foreground p-6">
      <div className="max-w-md text-center">
        <p className="text-sm font-semibold tracking-tight">
          The hub is paused
        </p>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          Its Convex database has been disabled for exceeding a usage limit, so
          nothing shared — the messenger, the calendar, both AI boxes — can read
          or write right now. This is not a fault in the app, and no data has
          been lost.
        </p>
        <p className="mt-3 text-xs leading-5 text-muted-foreground">
          It resumes the moment the limit is raised or disabled in the Convex
          dashboard (Deployment Settings → Usage limits). Reload this page after
          that and everything comes back as it was.
        </p>

        {/* These two pages need no database, so they are somewhere to go —
            and the way to take a copy of the app with you — even now. Plain
            anchors, not router links: this screen is rendered above the
            router, so there is no router context for a Link to read. */}
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          <a
            href="/offline-brain"
            className="rounded-xl border border-border/70 px-3 py-2 text-[11px] font-medium transition-colors hover:bg-white/5"
          >
            Offline Brain &amp; downloads
          </a>
          {/* The brain on your own machine needs nothing from this database,
              so the page that drives it works even now. */}
          <a
            href="/local-brain"
            className="rounded-xl border border-border/70 px-3 py-2 text-[11px] font-medium transition-colors hover:bg-white/5"
          >
            Local Brain
          </a>
          <a
            href="/web-portal"
            className="rounded-xl border border-border/70 px-3 py-2 text-[11px] font-medium transition-colors hover:bg-white/5"
          >
            Web Portal
          </a>
        </div>
      </div>
    </div>
  );
}

/** Hard guard so runtime errors never leave the preview as a blank page. */
class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; message: string; stack: string }
> {
  state = { hasError: false, message: "", stack: "" };
  static getDerivedStateFromError(error: Error) {
    return {
      hasError: true,
      message: error.message || "Unknown runtime error",
      stack: error.stack || "",
    };
  }
  componentDidCatch(err: Error) {
    console.error("[Preview] Root crash:", err);
  }
  render() {
    if (this.state.hasError) {
      // A paused database is not an app error, so it gets its own screen rather
      // than a stack trace that sends everyone hunting for a bug.
      if (deploymentPaused(this.state.message)) return <HubPaused />;

      return (
        <div className="min-h-screen flex items-center justify-center bg-background text-foreground p-6">
          <div className="max-w-lg text-center">
            <p className="text-sm font-semibold">Preview runtime error</p>
            <p className="mt-2 text-xs text-muted-foreground break-words">
              {this.state.message}
            </p>
            {this.state.stack && (
              <pre className="mt-3 text-left text-[10px] leading-4 text-muted-foreground/80 max-h-40 overflow-auto rounded border border-border/60 p-2">
                {this.state.stack}
              </pre>
            )}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// Which address the hub talks to: in a development run the backend beside the
// page, in a build the configured deployment — or, for a backend on loopback
// being read from somewhere else, this page's own origin, which the dev server
// forwards. That decision, and why it is the right one, is in
// `src/lib/backend.ts`.
const convex = new ConvexReactClient(
  resolveBackendUrl(
    import.meta.env.VITE_CONVEX_URL as string | undefined,
    window.location,
    import.meta.env.DEV,
  ),
);



function RouteSyncer() {
  const location = useLocation();
  useEffect(() => {
    window.parent.postMessage(
      { type: "iframe-route-change", path: location.pathname },
      "*",
    );
  }, [location.pathname]);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.data?.type === "navigate") {
        if (event.data.direction === "back") window.history.back();
        if (event.data.direction === "forward") window.history.forward();
      }
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  return null;
}


createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RootErrorBoundary>
      <ConvexAuthProvider client={convex}>
        <BrowserRouter>
          <RouteSyncer />
          <Suspense fallback={<RouteLoading />}>
            <Routes>
              <Route
                path="/"
                element={
                  <RequireAuth
                    title="Sign in to open the boxes"
                    description="The messenger and the family roster are shared, so you need to sign in first."
                    redirectImmediately
                  >
                    {/* Signing in is not the same as being let in: the family
                        password is asked for once per account, on the server. */}
                    <PasswordGate>
                      <AppShell />
                    </PasswordGate>
                  </RequireAuth>
                }
              >
                {/* Where a copy opens. The shared hub opens on the assistant;
                    a copy running on your own machine opens on the brain it
                    drives, which is the reason that copy exists. */}
                <Route
                  index
                  element={
                    <Navigate
                      to={IS_LOCAL ? "/local-brain" : "/assistant"}
                      replace
                    />
                  }
                />
                <Route path="assistant" element={<BoxPage box="assistant" />} />
                <Route path="builder" element={<BoxPage box="builder" />} />
                <Route path="family" element={<Navigate to="/messenger" replace />} />
                <Route path="messenger" element={<BoxPage box="messenger" />} />
                <Route path="calendar" element={<CalendarPage />} />
                <Route path="control-room" element={<ControlRoom />} />
                <Route path="live" element={<LivePage />} />
              </Route>
              {/* The Web Portal and the Offline Brain hold information and
                  downloads and no private family data, so they carry no sign-in
                  and no family password: they open on a brand-new device, and
                  there is still somewhere to go when the database is down.
                  What they are not is a separate app — `HubPage` opens them
                  inside the hub whenever there is an unlocked session to put
                  them in, so their tabs behave like every other tab. */}
              <Route
                path="/web-portal"
                element={
                  <HubPage>
                    <WebPortal />
                  </HubPage>
                }
              />
              <Route
                path="/offline-brain"
                element={
                  <HubPage>
                    <OfflineBrain />
                  </HubPage>
                }
              />
              {/* The local brain's control surface is public in both senses: it
                  has to open when the database is unreachable, and the memory
                  it shows is on the machine in front of you rather than in
                  Convex. It therefore always wears the public frame. */}
              <Route
                path="/local-brain"
                element={
                  <PublicShell>
                    <LocalBrain />
                  </PublicShell>
                }
              />
              {/* The page used to be called Get App; the old address still lands on it. */}
              <Route
                path="get-app"
                element={<Navigate to="/web-portal" replace />}
              />
              <Route path="/auth" element={<AuthPage redirectAfterAuth="/assistant" />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </Suspense>
        </BrowserRouter>
        <Toaster />
      </ConvexAuthProvider>
    </RootErrorBoundary>
  </StrictMode>,
);

// Makes the hub installable on a phone and a computer. Optional by design: if
// the browser refuses, the app runs exactly the same without it.
registerServiceWorker();
