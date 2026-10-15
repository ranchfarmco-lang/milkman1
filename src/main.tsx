// First, and for its side effect: some browsers refuse `localStorage`, and a
// preview inside a sandboxed frame is one of them. Swapping in an in-memory
// stand-in has to happen before any later import — a library's included — can
// touch storage. See the file for why.
import "@/lib/safe-storage";

import { DeviceGate } from "@/components/DeviceGate";
import { HubPage } from "@/components/HubPage";
import { PasswordGate } from "@/components/PasswordGate";
import { PublicShell } from "@/components/PublicShell";
import { RequireAuth } from "@/components/RequireAuth";
import { Toaster } from "@/components/ui/sonner";
import {
  DEV_BACKEND,
  backendBesidePageAnswers,
  isLoopbackUrl,
  rememberBackendUrl,
  resolveBackendUrl,
} from "@/lib/backend";
import { registerServiceWorker } from "@/lib/pwa";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { ConvexReactClient } from "convex/react";
import React, { StrictMode, useEffect, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
} from "react-router";
import "./index.css";

/** Where the one reload a stale page is allowed to ask for is recorded. */
const RELOAD_AT_KEY = "sugar:route-reload-at";
/** How long after such a reload the next one is refused, so it cannot loop. */
const RELOAD_QUIET_MS = 15_000;

/**
 * Whether a reload is allowed now — and it counts as spent when it is.
 *
 * `safe-storage` has already replaced an unusable `sessionStorage` with an
 * in-memory stand-in, so this cannot throw the way the browser's own storage
 * does in a sandboxed frame. If it somehow still does, the answer is no: a page
 * that says what failed is worth more than a tab that never stops trying.
 */
function claimReload() {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_AT_KEY) ?? 0);
    if (Date.now() - last < RELOAD_QUIET_MS) return false;
    sessionStorage.setItem(RELOAD_AT_KEY, String(Date.now()));
    return true;
  } catch {
    return false;
  }
}

/**
 * A route, loaded when it is first asked for — and given a way back when the
 * request for it fails.
 *
 * Every route is a separate file the browser fetches on demand, and that
 * request can fail for reasons that have nothing to do with the page itself:
 * the dev server is restarting, its dependency cache is being rebuilt, or a
 * deployment was replaced underneath a tab that was already open. The tab is
 * then holding a module graph that no longer exists, and it arrives as
 * "Failed to fetch dynamically imported module" — which reads like a fault in
 * the page that simply could not be fetched.
 *
 * So a failure is met with the two things that genuinely recover from one: the
 * fetch is tried once more straight away, because a server that was away for a
 * moment answers the second time; and if it still fails the page reloads once
 * to pick up the module graph that exists now. The reload is claimed through a
 * timestamp, so a file that is truly missing cannot become a reload loop — it
 * falls through to the error screen with the real reason.
 */
function lazyRoute<P>(
  load: () => Promise<{ default: React.ComponentType<P> }>,
) {
  return lazy(async (): Promise<{ default: React.ComponentType<P> }> => {
    try {
      return await load();
    } catch {
      try {
        return await load();
      } catch (again) {
        if (claimReload()) window.location.reload();
        throw again;
      }
    }
  });
}

// Lazy load route components for better code splitting
const AppShell = lazyRoute(() => import("./pages/AppShell.tsx"));
const BoxPage = lazyRoute(() => import("./pages/BoxPage.tsx"));
const BrowserPage = lazyRoute(() => import("./pages/BrowserPage.tsx"));
const CalendarPage = lazyRoute(() => import("./pages/CalendarPage.tsx"));
const ControlRoom = lazyRoute(() => import("./pages/ControlRoom.tsx"));
const WebPortal = lazyRoute(() => import("./pages/WebPortal.tsx"));
const OfflineBrain = lazyRoute(() => import("./pages/OfflineBrain.tsx"));
const LocalBrain = lazyRoute(() => import("./pages/LocalBrain.tsx"));
const LivePage = lazyRoute(() => import("./pages/LivePage.tsx"));
const AuthPage = lazyRoute(() => import("./pages/Auth.tsx"));

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

/**
 * Whether a page could not be fetched at all, rather than failing once it ran.
 *
 * It is worth telling apart because it has a remedy the person can use: the
 * file's address is stale for this tab, so asking the server again — a reload —
 * is what fixes it. Anything else on this screen is genuinely something to
 * report rather than to retry.
 */
function pageCouldNotBeFetched(message: string) {
  return /dynamically imported module|importing a module script failed|error loading dynamically imported/i.test(
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

        {/* Where this ends for good. A limit can only be put over a backend
            somebody else runs, so the honest remedy is not another retry — it
            is a backend of your own, which the hub can run on a single machine
            in one command (`bun run own`, see self-hosting/README.md). Both
            halves of that are reachable from here: the Offline Brain packs the
            whole app and its data into one download, including the self-host
            kit and the command that uses it. */}
        <p className="mt-3 text-xs leading-5 text-muted-foreground">
          This deployment is not yours to raise. The hub runs just as well on a
          backend you own — on your own machine, in one command, with nothing
          outside it able to pause it — and everything here can be carried over
          to one. The Offline Brain has the download that carries the app, its
          data and the way to run it; `self-hosting/README.md` in the code is
          the whole of it.
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

            {/* A page that could not be fetched is the one failure here with
                something to press: the address this tab holds is stale, so
                asking the server again is the remedy. */}
            {pageCouldNotBeFetched(this.state.message) ? (
              <div className="mt-4">
                <p className="text-xs leading-5 text-muted-foreground">
                  This page could not be fetched from the server — usually
                  because it was being rebuilt, or the tab is holding an address
                  that has since changed. Loading it again is the fix.
                </p>
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="mt-3 cursor-pointer rounded-xl border border-border/70 px-3 py-2 text-[11px] font-medium transition-colors hover:bg-white/5"
                >
                  Load the page again
                </button>
              </div>
            ) : null}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * Which address the hub talks to, worked out before anything at all is drawn.
 *
 * Three cases, all of them explained in `src/lib/backend.ts`:
 *
 *   * in a build, the deployment it was configured with;
 *   * in a development run on a machine where the backend beside the page is
 *     answering, that backend — including when the page is being read from
 *     somewhere else, where the dev server carries the calls through;
 *   * in a development run where that backend is **not** answering, the
 *     deployment this run was configured with.
 *
 * The last one is the reason this is asked rather than assumed. A development
 * backend is a separate process, and a process can be gone — killed, crashed, out
 * of memory, or never started. When it is, the page has nothing to talk to and
 * says nothing about it: the client retries for ever, no screen arrives, and a
 * black page is the whole of what you see. Falling back to the configured
 * deployment is what keeps the app usable in exactly that case.
 *
 * It cannot throw — a module that fails to load draws nothing at all, which is
 * worse than the failure it is guarding against.
 */
async function backendUrlForThisRun(): Promise<string> {
  const configured = import.meta.env.VITE_CONVEX_URL as string | undefined;

  // Only a backend on this machine is something a check can speak for; every
  // other address is decided by `resolveBackendUrl` alone, exactly as before.
  if (import.meta.env.DEV && isLoopbackUrl(DEV_BACKEND)) {
    if (await backendBesidePageAnswers(window.location)) {
      // It answered — but *where* it is depends on where this page is being
      // read, and that is the question `resolveBackendUrl` answers. Read on
      // this machine the address is the loopback one; read from somewhere
      // else it is this page's own origin, which the dev server forwards to
      // the same backend. Returning `DEV_BACKEND` here would hand a hosted
      // preview `http://127.0.0.1:3210` — the reader's own computer — and the
      // hub would fail against a backend that is running perfectly well.
      return resolveBackendUrl(DEV_BACKEND, window.location, true);
    }
    // Nothing beside the page: use the address this run was configured with,
    // which is the same rule a build uses — and which lands on this page's own
    // origin rather than nowhere when nothing is configured either.
    return resolveBackendUrl(configured, window.location, false);
  }

  return resolveBackendUrl(configured, window.location, import.meta.env.DEV);
}

const backendUrl = await backendUrlForThisRun();
// Kept, so the screens that *report* the address report the one in use.
rememberBackendUrl(backendUrl);

const convex = new ConvexReactClient(backendUrl);

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
                    {/* Signing in is not the same as being let in. First the
                        device must be authorised into the private hub — a
                        fresh installation waits here until the owner approves
                        it — and then the family password is asked for, once per
                        account. Both are enforced on the server. */}
                    <DeviceGate>
                      <PasswordGate>
                        <AppShell />
                      </PasswordGate>
                    </DeviceGate>
                  </RequireAuth>
                }
              >
                {/* The hub now opens on its own browser: it is the front door
                    to everything else, and every other surface is a tap away
                    from its home. */}
                <Route index element={<Navigate to="/browser" replace />} />
                <Route path="browser" element={<BrowserPage />} />
                <Route path="assistant" element={<BoxPage box="assistant" />} />
                <Route path="builder" element={<BoxPage box="builder" />} />
                {/* Changing this app used to be a tab of its own. It is a box
                    of the AI Builder page now — this project's own copy stands
                    in the sandbox on that page, so the request, the check in
                    the mirror and the carrying-in all sit with the builder
                    that does them. The old addresses still arrive there, so a
                    link somebody typed from memory is not broken by the tab
                    going. */}
                <Route
                  path="this-app"
                  element={<Navigate to="/builder" replace />}
                />
                <Route
                  path="app"
                  element={<Navigate to="/builder" replace />}
                />
                <Route
                  path="change-this-app"
                  element={<Navigate to="/builder" replace />}
                />
                <Route
                  path="family"
                  element={<Navigate to="/messenger" replace />}
                />
                <Route path="messenger" element={<BoxPage box="messenger" />} />
                <Route path="calendar" element={<CalendarPage />} />
                <Route path="control-room" element={<ControlRoom />} />
                {/* The App Sandbox used to be a page of its own. It is not a
                    place any more — the apps the builder makes, the tools on
                    each one and the runner they launch in all live on the AI
                    Builder page, in the same boxes as the prompt studio that
                    made them, so the two were the same thing on two pages. The
                    old address still lands on that page, so nothing that
                    linked here is broken. */}
                <Route
                  path="app-sandbox"
                  element={<Navigate to="/builder" replace />}
                />
                <Route path="live" element={<LivePage />} />
              </Route>
              {/* The Web Portal used to be a page of its own. It is a section
                  of the Control Room now, and this address lands on it: signed
                  in, `/web-portal` opens the Control Room with the Web Portal
                  at the top of the viewport (`into` below). It is still a real
                  page underneath, and that half matters — it holds no private
                  family data, so with no session or with the database down
                  (`HubPage`) it opens on its own, which is what keeps it
                  reachable on a brand-new device and while the hub is paused. */}
              <Route
                path="/web-portal"
                element={
                  <HubPage into="web-portal">
                    <WebPortal />
                  </HubPage>
                }
              />
              {/* The Web Portal used to live at /portal; the old address still
                  lands on it, so nothing that linked there is broken. */}
              <Route
                path="/portal"
                element={<Navigate to="/web-portal" replace />}
              />
              {/* The same for the Offline Brain: a section of the Control Room
                  now, still its own page when there is no session to open the
                  hub in — a brand-new device, or a database that is down, which
                  is exactly when this page is the only thing still working. */}
              <Route
                path="/offline-brain"
                element={
                  <HubPage into="offline-brain">
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
              {/* The Control Room's guide, the forge's own boxes and the builder's
                  documentation all link to the AI Builder and the AI Assistant by
                  these names, which were never routes: the pages live at /builder
                  and /assistant. Rather than change every link, both names lead
                  where they always meant to. */}
              <Route
                path="ai-builder"
                element={<Navigate to="/builder" replace />}
              />
              <Route
                path="ai-assistant"
                element={<Navigate to="/assistant" replace />}
              />
              <Route
                path="/auth"
                element={<AuthPage redirectAfterAuth="/browser" />}
              />
              {/* Nowhere else exists. Rather than a dead-end "404" page — which
                  is what a mistyped address, a stale link or an app served under
                  a path prefix used to land on — an unknown address opens the
                  hub's browser, the front door to everything else. */}
              <Route path="*" element={<Navigate to="/browser" replace />} />
            </Routes>
          </Suspense>
        </BrowserRouter>
        {/* Nothing about spelling is mounted here, and that is the arrangement:
            every field that holds prose carries the browser's own checker, set
            by the UI primitives from the one rule in `src/lib/spellcheck.ts`,
            so the words are marked as they are typed and the corrections are a
            right-click away — as in any other text box on the machine. */}
        <Toaster />
      </ConvexAuthProvider>
    </RootErrorBoundary>
  </StrictMode>,
);

// Makes the hub installable on a phone and a computer. Optional by design: if
// the browser refuses, the app runs exactly the same without it.
registerServiceWorker();
