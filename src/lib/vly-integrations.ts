// Freebuff's `@vly-ai/integrations` package, loaded **only if it is there**.
//
// This file used to be a module-level `import` of that package plus a
// `createVlyIntegrations(...)` call, which made an optional dependency into a
// hard one: the import runs when the module is first read, so on a machine
// without the package (a downloaded copy of this project, an install with
// `--omit=optional`) any screen that ever pulled this file in would fail to
// load, and `bun tsc` would refuse to type-check it.
//
// Nothing in the project imports this file today, and nothing needs Freebuff in
// order to run — the hub's own sign-in, storage and AI boxes are all reachable
// without it. So the package is loaded lazily, inside `try`, and the answer when
// it is missing is plainly `null` rather than an exception: an optional thing
// that is absent is a normal state, not an error.
//
// `src/vite-optional.d.ts` declares the module so the type-checker agrees the
// package may be absent. Delete both only if something starts genuinely
// depending on it.

/** What `createVlyIntegrations` hands back, as much of it as this project names. */
export type VlyIntegrations = {
  deploymentToken: string;
  debug: boolean;
};

/**
 * The Freebuff integrations handle, or `null` when the package is not installed
 * or the token has not been provided.
 *
 * Deliberately lazy and never called by the app: it exists so the capability is
 * available to whoever wants it, without the package being a requirement for
 * everyone else.
 */
export async function loadVlyIntegrations(): Promise<VlyIntegrations | null> {
  const token = (import.meta.env.VITE_VLY_INTEGRATION_KEY as string | undefined)?.trim();
  if (!token) return null;

  try {
    const mod = await import("@vly-ai/integrations");
    return mod.createVlyIntegrations({
      deploymentToken: token,
      debug: import.meta.env.DEV,
    }) as VlyIntegrations;
  } catch {
    // Not installed, or not servable from this machine's registry. Nothing in
    // this app depends on it, so there is nothing to report and nothing to fix.
    return null;
  }
}
