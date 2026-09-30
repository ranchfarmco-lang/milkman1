/**
 * Which address this page should use to reach its Convex deployment.
 *
 * Getting this wrong is what produced "The hub cannot reach its database" on a
 * page that was perfectly healthy, so the rule is written out in full here. It
 * is the only place the address is decided.
 *
 * **A development run talks to the backend beside it.** `bun run dev` starts the
 * Convex CLI's own backend on this machine and serves the page next to it (see
 * `scripts/dev.sh`). That pairing is the whole point of development here: the
 * backend is the one the code is being written against, and it is running by
 * definition. So a development run uses `DEV_BACKEND` whatever else is
 * configured — the configured `VITE_CONVEX_URL` is the value that goes stale,
 * and a deployment that has since been deleted, switched off, or left behind
 * takes the whole hub down with it. (In this project it is a hosted deployment
 * that has hit its usage limit and refuses every function call, which is exactly
 * that failure.)
 *
 * **A build talks to the address it was built with.** Production is the case
 * where the page and the database are deliberately somewhere else — the
 * family's own deployment, or a laptop running the self-host kit. There,
 * `VITE_CONVEX_URL` is the truth and is used exactly as given, so a hosted
 * `https://<name>.convex.cloud` address is returned untouched.
 *
 * **A loopback address read from somewhere else is reached through this page.**
 * That is the one case a development run cannot handle on its own. A hosted
 * preview hands the page to a browser somewhere else, over a public hostname,
 * while the backend still runs inside the workspace. In that browser
 * `127.0.0.1` is the *reader's own computer*, where nothing is listening, and an
 * `https` page cannot open the insecure `ws://` socket the client needs either.
 * The hub would then never connect once, however healthy the backend is.
 *
 * So in that one case the address becomes this page's own origin, and the dev
 * server forwards `/api` and `/version` from there to the backend (see
 * `vite.config.ts`). The calls then travel the same route as the page itself —
 * one host, no loopback, no mixed content, no CORS — and a preview read from
 * anywhere is talking to the same database as the machine it is running on.
 *
 * Nothing here is hardcoded to one workspace: the hostname comes from the page.
 */

/**
 * The address `scripts/dev.sh` starts and probes: the Convex CLI's own backend,
 * beside the page. Exported so `vite.config.ts` forwards to the same address
 * this file falls back to.
 */
export const DEV_BACKEND = "http://127.0.0.1:3210";

/** Hosts that name the machine the browser is already on. */
export function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    hostname === "0.0.0.0" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
  );
}

/**
 * Whether an address points back at the machine reading it.
 *
 * Exported because `vite.config.ts` asks the same question of the same value:
 * forwarding is only correct for a loopback backend. One definition, used by
 * both, so the two cannot disagree about which case this is.
 */
export function isLoopbackUrl(value: string | undefined | null): boolean {
  const raw = String(value ?? "").trim();
  if (!raw) return false;
  try {
    return isLoopbackHost(new URL(raw).hostname);
  } catch {
    // Not a URL we can reason about. Let Convex be the one to complain.
    return false;
  }
}

/** The page an address is being read from — a `Location`, or anything like one. */
export type PageLocation = { origin: string; hostname: string };

/**
 * The address to use, given what the build was configured with, where the page
 * is being read, and whether this is a development run.
 *
 * Pure: the same three inputs always give the same answer, so the client that
 * connects and the screen that reports where it tried cannot disagree.
 */
export function resolveBackendUrl(
  configured: string | undefined | null,
  here?: PageLocation | null,
  development = false,
): string {
  // A development run uses the backend beside the page; a build uses the address
  // it was built with. See the note at the top of this file.
  const raw = (development ? DEV_BACKEND : String(configured ?? "").trim()).trim();

  // Nothing is configured. A backend on this page's own origin is the only thing
  // that could still answer, so ask there rather than nowhere.
  if (!raw) return here?.origin ?? "";

  // Reachable from anywhere — Convex Cloud, a self-hosted deployment, a LAN
  // address. These already work, so they are returned exactly as written.
  if (!isLoopbackUrl(raw)) return raw;

  // Loopback, with no page to borrow an origin from.
  if (!here) return raw;

  // Loopback, read on the machine it names: the developer's own computer, where
  // this address is the right one.
  if (isLoopbackHost(here.hostname)) return raw;

  // Loopback, read from somewhere else: go through this page.
  return here.origin;
}
