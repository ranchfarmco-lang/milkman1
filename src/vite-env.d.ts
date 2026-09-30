/// <reference types="vite/client" />

/**
 * The one build-time variable this project adds.
 *
 * Vite forwards `VITE_`-prefixed shell variables into `import.meta.env`, which
 * is how the hub is built as either of its two versions:
 *
 *   VITE_PROFILE=local bun run build:local
 *
 * Declared here so it reads as `string | undefined` rather than `any`, and
 * resolved in `src/lib/profile.ts` — nothing else should read it directly.
 */
interface ImportMetaEnv {
  readonly VITE_PROFILE?: string;
}
