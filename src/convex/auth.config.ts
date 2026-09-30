import type { AuthConfig } from "convex/server";

// One provider only: this project's own sign-in ("Get Started" email/guest,
// see src/convex/auth.ts). The deployment self-issues JWTs (iss =
// CONVEX_SITE_URL, no `kid` header) validated via OIDC discovery at
// `${domain}/.well-known/openid-configuration`, served by
// auth.addHttpRoutes() in convex/http.ts. Do NOT convert this entry to
// `type: "customJwt"` — that path rejects tokens without a `kid` header, so
// sign-in would silently never confirm and RequireAuth would loop back to
// /auth forever.
//
// A second `customJwt` provider used to sit below this one, trusting identity
// tokens signed by Freebuff (issuer from VLY_CONVEX_AUTH_ISSUER, applicationID
// "vly-convex"). It is gone. It was the only thing in the whole project that
// needed a Freebuff variable in order to deploy, nothing in the app ever
// produced a token for it, and every device signs in anonymously and is
// identified by the family password instead.
export default {
  providers: [
    {
      domain: process.env.CONVEX_SITE_URL!,
      applicationID: "convex",
    },
  ],
} satisfies AuthConfig;
