# Deploying the hub somewhere else

The hub is two pieces, and **neither of them is Freebuff**:

| Piece | Where it goes | What it costs |
| --- | --- | --- |
| **Backend** — database, sign-in, functions, files, cron | Your own **Convex** project | Convex's free tier, under **your** account |
| **Frontend** — every page you see | **Vercel** | Hobby plan, free |

Both are open, both have a free tier that needs no card, and once you have done
this the URL is yours and nothing on Freebuff can switch it off.

- Convex sign-up / dashboard — <https://dashboard.convex.dev>
- Vercel sign-up / new project — <https://vercel.com/new>

## 1. Your own backend (Convex)

From the project folder:

```bash
bun install
bunx convex dev
```

A browser opens to log you in. It then creates a **new** project under your own
account and writes the values the app reads into `.env.local`:
`CONVEX_DEPLOYMENT` and `VITE_CONVEX_URL`. Leave this running (it also watches
the functions), or stop it once it has written the file.

Now give that deployment what it needs to sign people in and lock the family
door:

```bash
bun scripts/generate-auth-keys.mjs        # creates JWT_PRIVATE_KEY and JWKS
bunx convex env set HUB_PASSWORD 'the-password-you-share'
```

- `scripts/generate-auth-keys.mjs` writes `JWT_PRIVATE_KEY` and `JWKS` straight
  onto the deployment, and does nothing if they are already there (`--force`
  replaces them, which signs every device out). Nothing needs installing first:
  the keys come from WebCrypto. The same script under Node is what
  `self-host/generate-keys.mjs` runs in a downloaded copy of the hub.
- This is the step that is easy to skip and hard to read. A deployment without
  keys answers queries happily and looks healthy, and then the *first* sign-in
  throws `Missing environment variable 'JWKS'` — so it reads as a broken app
  rather than as a deployment that was never finished.
- `bunx @convex-dev/auth` is Convex's own one-command version, but it is an
  interactive CLI and under Bun its `jose` dependency resolves to the browser
  build, where the keys are generated non-extractable and cannot be exported at
  all. Use the script above, or run that CLI under Node. Setting the two
  variables by hand is covered at
  <https://labs.convex.dev/auth/setup/manual>.
- Leave out `HUB_PASSWORD` and the hub is open, as it was before a password was
  ever set.
- Optional, for the assistant and builder: `GROQ_API_KEY`, `OPENROUTER_API_KEY`,
  `GOOGLE_API_KEY`, and so on. None is required — with no key at all the
  assistant still answers on free public systems.

## 2. The frontend (Vercel)

`vercel.json` in this project already tells Vercel how to build it and sends
every route back to `index.html` so the hub's pages work on a static host.

**Before you build, set `VITE_CONVEX_URL`.** Vite bakes environment variables in
at build time, so setting it afterwards changes nothing — it has to be set on the
Vercel project first.

With the CLI:

```bash
bunx vercel login
bunx vercel                                   # first run links/creates the project
bunx vercel env add VITE_CONVEX_URL production   # paste the VITE_CONVEX_URL from .env.local
bunx vercel --prod
```

Vercel prints the live address when it finishes — that is the link to your app.

Or through the dashboard: push this folder to a Git repo you own, then
<https://vercel.com/new> → import it. Vercel reads `vercel.json`, so the only
thing left to do is add `VITE_CONVEX_URL` under **Settings → Environment
Variables** before the first deploy.

## 3. Bring your family's data across

The new backend starts empty. While the **old** deployment is still switched on,
pull everything out of it and push it into the new one:

```bash
bunx convex export --path ./hub-export     # pointed at the old deployment
bunx convex import --path ./hub-export     # pointed at the new one
```

If the old deployment has already been disabled, use the hub's own backup
instead: **Offline Brain → Backup → Everything**, then import `data/hub-data.json`
from inside the archive one table at a time. A snapshot already taken with
`bunx convex export` comes across in one command — `bunx convex import
--replace-all -y <snapshot.zip>`, with the target deployment selected — which is
what `backups/README.md` does.

## 4. Keeping it ours

- The frontend is static files on Vercel and the backend is a Convex project in
  your name. Neither can be switched off by anyone but you.
- To take the hub off the internet entirely, `bun run self-host` (or
  `bun run own`, which needs no Docker at all) runs the same open-source Convex
  backend and the same pages on your own machine at <http://localhost:8080>,
  with no account anywhere. `self-hosting/README.md` is the whole of it, and it
  is the answer to a deployment that has been paused by a usage limit — see the
  top of that file.
- The build does **not** need Freebuff. `@vly-ai/integrations` is optional and is
  loaded only if it happens to be installed, so a copy of this project with no
  Freebuff package builds and runs the same.

## 5. Making it private

A deployed hub is private by default, and it is the server — not the screen —
that decides who gets in:

- The **first device** to sign in claims the hub and becomes its **owner**. If
  `HUB_PASSWORD` is set, claiming also requires answering it.
- Any **later device** is refused by every private function until it is
  authorised: its account answers the family password, or the owner approves it
  in **Control Room → Security → Authorised devices**. A copied app does not
  inherit access; it has no password and no authorisation.
- With **no** `HUB_PASSWORD` set the hub is open, as it always was, so a private
  machine is never locked out by the gate — device authorisation is what you get
  when you set a password.
- **Revoking** a device there takes its session away immediately — its next call
  fails because it no longer has an authorised device, and reopening the app
  does not bring it back.
- The **security log** (same panel) records sign-ins, new devices,
  authorisations, revocations and ended sessions.
- AI provider keys stay in the deployment's environment. The browser never sees
  them; Sugar calls the provider, not the page.

To run the whole backend on hardware you control — including behind a VPN — see
[`self-hosting/`](./self-hosting/README.md). It covers the Docker stack, the
environment template, backups, and keeping the backend off the public internet.

Before handing the app out, check **Control Room → Security** reads `CONNECTED`,
`SECURE`, `AUTHENTICATED`, `AUTHORIZED`, `ACTIVE`.
