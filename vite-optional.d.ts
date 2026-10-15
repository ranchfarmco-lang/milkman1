/**
 * `@vly-ai/integrations` is an **optional** dependency, and this declaration is
 * what keeps it optional at type-check time as well as at run time.
 *
 * It is named in exactly two places, both inside a `try`:
 *
 *   * `vite.config.ts` — the Freebuff build plugin, which only matters while the
 *     project is being edited inside Freebuff;
 *   * `src/lib/vly-integrations.ts` — a lazy helper nothing calls.
 *
 * Nothing the app does at runtime needs the package, and a copy of this project
 * on a machine that has never heard of Freebuff has to build and run all the
 * same. Without this declaration it does not. TypeScript resolves a dynamic
 * `import()` specifier too, so on a machine where the package is not installed
 * (an install with `--omit=optional`, a registry that cannot serve it, a
 * downloaded backup unpacked somewhere without it) `bun tsc` fails with
 *
 *     src/lib/vly-integrations.ts: Cannot find module '@vly-ai/integrations'
 *
 * and because `bun run build` type-checks before it builds, that is the whole
 * app refusing to start — over a package it does not need. Declaring the module
 * tells the type-checker what is true: it may or may not be there, and either
 * way both callers cope.
 *
 * Both TypeScript projects include this file — `tsconfig.node.json` for the Vite
 * config and `tsconfig.app.json` for `src` — so there is one declaration for the
 * one module, and the two projects cannot disagree about whether it exists.
 *
 * If something ever needs the package's real types, delete this file and make
 * that one importer unconditional instead.
 */
declare module "@vly-ai/integrations";
