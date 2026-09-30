/**
 * Which of the two versions of the hub this build is.
 *
 * One codebase ships two ways:
 *
 *   - the **web** version — served from a site you own, talking to a Convex
 *     deployment you own. This is what `bun run build` makes.
 *   - the **local** version — served from your own machine, next to the local
 *     brain, with nothing of yours on anybody else's disk.
 *
 * Almost all of the app is identical in both, and it is meant to stay that way:
 * a profile is a short list of decisions — which backend to expect, which of the
 * family layer is worth showing somebody who is already sitting at the machine —
 * never a second copy of a page.
 *
 *   bun run build             # the web version
 *   bun run build:local       # the local version
 *
 * Two properties of that switch are worth knowing, because getting either wrong
 * produces a build that looks configured and is not:
 *
 *   1. The variable has to be spelled `VITE_PROFILE`. Vite forwards
 *      `VITE_`-prefixed variables from the shell into `import.meta.env` and
 *      nothing else, so `PROFILE=local` on its own would be silently ignored.
 *   2. It is a build-time constant, not a running setting. There is no way to
 *      change it after the build, and it must never hold a secret: it is
 *      compiled into JavaScript that anybody can read. Anything the environment
 *      can answer at run time — which Convex address, which brain address — is
 *      left to the environment rather than baked in here a second time.
 */

export type Profile = "web" | "local";

/**
 * The profile a build asked for.
 *
 * Anything unrecognised — unset, empty, a typo, a value left over in a shell
 * from another project — is the web version, deliberately. A build should never
 * fall into the more open of the two by accident.
 */
export function resolveProfile(raw: string | undefined): Profile {
  return raw?.trim().toLowerCase() === "local" ? "local" : "web";
}

/** The version this bundle is. A literal in the built JavaScript. */
export const PROFILE: Profile = resolveProfile(import.meta.env.VITE_PROFILE);

/** True in the local version: the one that runs on your own machine. */
export const IS_LOCAL = PROFILE === "local";
