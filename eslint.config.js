import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier/flat";

export default tseslint.config(
  {
    ignores: [
      "dist",
      // A vendored copy of the Freebuff (Codebuff) source tree that the offline
      // brain documents, not this app's code — linting it only buries the
      // app's own results under a thousand errors from someone else's project.
      "offline-ai-coding-brain",
      // Convex writes these; they are never edited by hand.
      "src/convex/_generated",
    ],
  },
  {
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommended,
      eslintConfigPrettier,
    ],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      /*
       * Two of the plugin's rules are the React Compiler's own diagnostics, and
       * this app is not built with the compiler — `vite.config.ts` runs
       * `@vitejs/plugin-react` with no compiler plugin — so neither can be
       * satisfied by editing the app.
       *
       * `preserve-manual-memoization` reports "Compilation Skipped: Existing
       * memoization could not be preserved". With no compilation step there is
       * nothing to preserve, the error can never be cleared, and the memo it
       * objects to — the newest-turn search in `PreviewPanel` — is the one doing
       * the work.
       *
       * `set-state-in-effect` fires on the deliberate ones: seeding state once
       * from storage or from the server, resetting call and voice state when a
       * call ends, and starting a fetch on mount. Rewriting those is a behaviour
       * change in the realtime code rather than a lint fix, so the rule stays on
       * as a warning — visible, and not a failed run.
       */
      "react-hooks/preserve-manual-memoization": "off",
      "react-hooks/set-state-in-effect": "warn",
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
    },
  },
);
