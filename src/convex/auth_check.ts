// The hub's own sign-in, exercised inside a real deployment.
//
// A type-check can prove that `src/convex/auth.ts` compiles and that the page
// calls the right provider name. It cannot prove the things that actually decide
// whether somebody can get in: that the provider is registered in the running
// deployment, that password hashing runs in this runtime, that a wrong password
// is refused, that a short one is refused, and that the same name typed in
// different case and with padding is the *same* account.
//
// So this module is one action that walks those cases and reports each outcome as
// a string. It is a fixture, not a feature: nothing in the app calls it, and it
// holds no secrets — the passwords it uses are made up, and the account it
// creates lives in whatever backend it is pointed at. `scripts/auth-check.ts` is
// what runs it, against a scratch backend of its own:
//
//   bun run test:auth
//
// The one thing to know when reading the output: a `catch` here is a *result*.
// "That is not the password for this account" is the deployment refusing a wrong
// password, which is exactly what should happen.
import { action } from "./_generated/server";
import { api } from "./_generated/api";

/** Where each case's outcome is reported, so the runner can parse one line. */
export const RESULT_MARKER = "AUTHCHECK_RESULT";

export const run = action({
  args: {},
  handler: async (ctx) => {
    const out: Record<string, string> = {};

    const attempt = async (key: string, params: Record<string, unknown>) => {
      try {
        const result = await ctx.runAction(api.auth.signIn as never, {
          provider: "password",
          params,
        } as never);
        const token = (result as { tokens?: { token?: string } } | null)?.tokens
          ?.token;
        out[key] = token ? "signed in (token issued)" : "no token issued";
      } catch (error) {
        // The refusal, in the deployment's own words.
        out[key] = error instanceof Error ? error.message : String(error);
      }
    };

    await attempt("makesAnAccount", {
      email: "Mum Test",
      password: "a-good-password",
      flow: "signUp",
    });
    await attempt("wrongPassword", {
      email: "mum test",
      password: "not-the-password",
      flow: "signIn",
    });
    await attempt("sameNameDifferentCase", {
      email: "  MUM TEST  ",
      password: "a-good-password",
      flow: "signIn",
    });
    await attempt("shortPassword", {
      email: "Dad",
      password: "short",
      flow: "signUp",
    });

    // Also in the log, so a person reading the CLI output sees it without the
    // runner having to be the only thing that can parse it.
    console.log(RESULT_MARKER, JSON.stringify(out));
    return out;
  },
});
