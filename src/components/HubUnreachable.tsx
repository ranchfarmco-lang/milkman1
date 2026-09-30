import { resolveBackendUrl } from "@/lib/backend";
import { RefreshCw } from "lucide-react";

/**
 * Shown when the hub's database cannot be reached at all.
 *
 * The distinction this screen draws is the important part: `HubPaused` (in
 * `main.tsx`) handles a deployment Convex has switched off, which answers every
 * call with an error. This one handles the opposite case — a backend that is not
 * there to answer. Nothing throws, nothing resolves, and without this the app
 * would sit on a spinner forever on a black page.
 *
 * So it says three things, in the order a person needs them: what is missing,
 * that the app is fine and nothing was lost, and where to go next. The app's own
 * offline-first design makes the last part unusually good — the two pages that
 * need no database are real destinations, not consolation prizes, and one of
 * them can hand you the whole system to run on your own machine.
 */
export function HubUnreachable({ retries = 0 }: { retries?: number }) {
  // The address the client was actually given, worked out the same way the
  // client works it out (see `src/lib/backend.ts`). That is the whole point: on
  // a preview it is this page's own origin rather than a loopback address that
  // could never have worked from here, and it is the one fact that turns "it is
  // broken" into something a person can check. Nothing secret — the page's own
  // origin, or the public deployment URL the build was configured with.
  const address = resolveBackendUrl(
    import.meta.env.VITE_CONVEX_URL as string | undefined,
    window.location,
    import.meta.env.DEV,
  );

  return (
    <div className="min-h-screen flex items-center justify-center bg-background text-foreground p-6">
      <div className="max-w-md text-center">
        <p className="text-sm font-semibold tracking-tight">
          The hub cannot reach its database
        </p>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          Everything shared — the messenger, the calendar, both AI boxes — is
          stored in Convex, and this page cannot get an answer from it. That is
          why nothing has loaded.
        </p>

        {address ? (
          <p className="mt-3 text-xs leading-5 text-muted-foreground">
            It is trying <code className="break-all">{address}</code>
            {retries > 0
              ? `, and has failed to connect ${retries} time${retries === 1 ? "" : "s"}.`
              : "."}
          </p>
        ) : null}

        <p className="mt-3 text-xs leading-5 text-muted-foreground">
          Nothing is wrong with the app and no data has been lost. This is a
          backend that is not running or not reachable from here yet.
        </p>

        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-border/70 px-3 py-2 text-[11px] font-medium transition-colors hover:bg-white/5"
          >
            <RefreshCw className="size-3" />
            Try again
          </button>
          <a
            href="/local-brain"
            className="rounded-xl border border-border/70 px-3 py-2 text-[11px] font-medium transition-colors hover:bg-white/5"
          >
            Local Brain
          </a>
          <a
            href="/offline-brain"
            className="rounded-xl border border-border/70 px-3 py-2 text-[11px] font-medium transition-colors hover:bg-white/5"
          >
            Offline Brain &amp; downloads
          </a>
        </div>

        {/* Why those two, in one line: they are the parts of this system that
            were built to have no backend at all. */}
        <p className="mt-3 text-[10px] leading-4 text-muted-foreground">
          The Local Brain page drives an AI on your own machine and needs no
          database; the Offline Brain page holds the downloads. Both work right
          now, from this machine.
        </p>
      </div>
    </div>
  );
}
