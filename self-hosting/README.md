# Owning Sugar

Sugar is built to be **private by default**: the backend — the database, the AI
orchestration, memory, tasks, conversations, files and administration — is meant
to run on a machine *you* control, reached only by an authenticated account on a
device you have authorised.

This folder is the way to get there. It exists because of one specific failure,
the one that is worst to be on the receiving end of:

> **"Its Convex database has been disabled for exceeding a usage limit."**

Everything shared — the messenger, the calendar, both AI boxes — is stored in a
Convex backend, so when that backend is switched off the whole hub goes quiet.
The app is not broken, nothing has been lost, and it comes straight back the
moment the limit is raised. But if that deployment is not yours, the switch is
not yours either, and no amount of work on the app changes that.

So the answer is not to make the app better at failing. It is to stop sharing a
backend with somebody else. Convex is open source — the hosted service runs the
same code — and there are two ways to have one of your own, plus a third if you
would rather move to your own account on their hosted service.

| Path | Command | Needs | Who it is for |
| --- | --- | --- | --- |
| **One folder, not even a network** | `bun run bundle` | Bun, once, to build it | A machine with nothing installed — including one that is offline. |
| **This machine, nothing else** | `bun run own` | Bun, curl | A laptop or desktop. No account, no card, no Docker. |
| **A server that stays on** | `bun run self-host` | Docker, Bun | A home server, VPS or NAS the family reaches. |
| **Your own Convex project** | see `DEPLOY.md` | A free Convex account | A public address with no machine of your own to run. |

All three end in the same place — a hub whose backend nobody else can switch
off — and you can move between them at any time, because the data is a file you
can copy (see **Bringing the family's data across**).

---

## What this costs: nothing

Every path above is free, and there is no paid default anywhere in the app — no
account requirement, no trial, nothing that expires and starts charging. The
table is the whole of it:

| Piece | The free one | Costs |
| --- | --- | --- |
| **The database** | Convex, running on your own machine | Nothing, forever. It is open source and needs no account. |
| **Sign-in** | Built in — anonymous accounts plus the family password | Nothing. No email service is involved. |
| **The AI** | Free public systems with no key at all, or a model on your own machine | Nothing. Both options work with no card. |
| **Calls** | Direct between the two devices; LiveKit is open source if you need a relay | Nothing. Self-hosting the relay is free too. |
| **The builder's sandbox** | A public runner, or code on your own machine | Nothing. |
| **Web search** | Keyless news, Hacker News, Stack Overflow, Wikipedia | Nothing, though thinner than a real index. |
| **A name for the hub** | Tailscale Personal — free for ever, six people | Nothing. |
| **Backups** | Copying a folder | Nothing. |

Every key listed under **Optional** in the template is genuinely optional: none
is needed to sign in, to see the family's data, or to have both AI boxes answer.

**The one honest caveat.** The free public AI systems are shared, so a busy
queue can make a reply wait, and one of them (Pollinations) is retiring the
anonymous address. The free answer that is never queued, never metered and
never taken away is a model on the machine the hub runs on — the hub already
speaks to one, and `public/offline-brain/configuration/litellm.example.yaml` is
configured for it:

```bash
bunx convex env set AI_BASE_URL http://localhost:11434/v1   # Ollama, or any
bunx convex env set AI_API_KEY local                        # OpenAI-shaped server
bunx convex env set AI_MODEL coder
```

---

## 0. One folder that needs nothing — `bun run bundle`

`bun run own` assumes a machine that can already be set up: a package manager
that reaches a registry, Bun installed, and a network on which the Convex CLI
fetches its backend program. `bun run bundle` removes all three assumptions by
putting them *inside* one folder:

```bash
bun run bundle                 # writes dist-independent/family-chat-hub-independent
bun run bundle --archive       # and tars it, for handing to another machine
```

Then the folder is the whole thing — copy it to a stick, an air-gapped laptop, a
server with no outbound network:

```bash
dist-independent/family-chat-hub-independent/run.sh --check      # what is inside, measured
dist-independent/family-chat-hub-independent/run.sh --selftest   # start the bundled backend, probe it, stop it
dist-independent/family-chat-hub-independent/run.sh              # start the hub
```

| Inside | Why it is there |
| --- | --- |
| `app/` | The project, with `node_modules` already installed from `bun.lock` — nothing is resolved or fetched on the far machine. |
| `runtime/bun` | The Bun the bundle was built with, so no runtime has to be installed. |
| `state/home/.cache/convex/binaries/<version>/` | The Convex backend *program*, in the exact place the CLI looks for it, under a `HOME` that is inside the folder. Chosen by running each cached build: a backend built against a newer C library than this machine has dies on its first line, and a bundle carrying one cannot start. |
| `manifest.json` | Versions, sizes and what the bundle claims — measured when it was built. `run.sh --check` prints it. |

**Measured, with every outbound request blackholed** (`HTTP_PROXY` and friends
pointed at a closed port): the bundled backend started on port 3210, the CLI
pushed the whole schema and every function into `http://127.0.0.1:3210`, the
signing keys were set, and Vite served the page from the bundle's own
`node_modules` — no account, no download, no registry.

That last part is worth naming, because the obvious approach does not work.
Asked to "develop against a local deployment", the CLI starts by fetching the
*latest* backend version and fails without a network (`✖ Failed to fetch latest
backend version`), and on a machine carrying ambient credentials it provisions a
*hosted* deployment on somebody's account instead. The bundle therefore starts
the backend itself and tells the CLI where it is, with the same two variables
`setup.sh` uses for its container:

```sh
convex-local-backend --port 3210 --instance-secret <generated> --disable-beacon <db>
CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210 CONVEX_SELF_HOSTED_ADMIN_KEY=<from keygen> \
  bun x convex dev --once
```

The instance secret and the database are made on the first run and kept in the
folder; no key from the machine that built the bundle is carried in it, and
`DISABLE_BEACON=1` keeps the self-hosted backend from reporting itself anywhere.

---

## 1. This machine, nothing else — `bun run own`

```bash
bun run own
```

One command, and it is worth knowing exactly what it does, because none of it
involves signing up for anything:

1. installs the app's packages;
2. runs **Convex's own backend as an ordinary program on this machine** — the
   Convex CLI downloads it, starts it, and keeps its database in
   `.convex/local/default/` — and pushes the hub's schema and every function
   into it;
3. leaves that backend running in the background (its output goes to
   `.vly-run/own-backend.log`);
4. makes the signing keys, without which the first sign-in fails on a backend
   that otherwise looks perfectly healthy;
5. sets the family password, and copies across any AI keys exported in your
   shell;
6. builds the hub against that backend and serves it on
   <http://localhost:8080>.

Run it again to start it again: the backend, the database, the keys and the
password are all left exactly as they are. `Ctrl-C` stops the page; the backend
keeps running, so the next start is instant.

Options, all optional:

```bash
HUB_PASSWORD='the-password-you-share' bun run own   # require the family password
OWN_PORT=9000 bun run own                           # serve somewhere else
OWN_BACKEND_VERSION=precompiled-2026-09-21-0cf49cb bun run own   # needs an account — see below
```

**Backing this up is copying a folder.** `cp -r .convex/local/default
/somewhere/safe` is the whole hub's data — messages, calendar, memories, files,
AI threads and the security log. Nothing else holds a copy.

### The one sharp edge: the backend program and your operating system

The backend is a *program the Convex CLI downloads*, and a very new build can
need a newer C library than an older Linux has. The loader says so on the
binary's first line — `GLIBC_2.38 not found`, `GLIBCXX_3.4.32 not found` — and
the only place you will read it is the log this script prints: the backend dies
before it ever listens, which otherwise looks exactly like a backend that was
never asked for.

**The CLI normally picks a build your machine can run.** Verified here on a
glibc 2.36 machine whose newest *cached* build refuses to execute (`precompiled-
2026-10-06-a3538c6` dies with `GLIBC_2.38 not found`): with that build recorded
as the local deployment's backend, `convex dev --once` still pushed the whole
schema and every function — exit 0, about 11 seconds. So a machine being older
than the newest build on disk is not by itself a problem.

The flag for pinning an older build exists — `--local-backend-version`, which is
what `OWN_BACKEND_VERSION` passes — but **the CLI refuses it in exactly the
account-free setup this kit is for.** Verified on CLI 1.42.1 and 1.46.0, on both
this project and a fresh one:

```
✖ `--local-backend-version` can only be used when developing with a local
  deployment. Use `npx convex deployment select local` ...
```

and `convex deployment select local` itself answers `401 Unauthorized` — it
wants a signed-in account. So pinning is not the account-free remedy, and no
step here depends on it.

**What is, if a backend this machine truly cannot run is what the CLI fetched:**
the Docker kit in this folder (`bun run self-host`). Its backend image,
`ghcr.io/get-convex/convex-backend`, carries its own C library, so the host's age
stops mattering — and it needs no Convex account either. A newer distribution,
or a newer `libc` and `libstdc++`, does the same thing without Docker.

`ls ~/.cache/convex/binaries/` lists the builds already downloaded here; running
one with `--help` tells you in one line whether this machine can execute it.
On a current distribution (2024 or later) none of this comes up.

### Two things worth knowing

- The mode this uses, `CONVEX_AGENT_MODE=anonymous`, is Convex's own "no account"
  dev mode and is labelled beta by the CLI. That is why this script pins the
  deployment name explicitly on every call instead of hoping: which backend it
  talks to is written down in this file, not left to a default.
- It does **not** touch `.env.local`. A project that has been pointed at another
  deployment keeps that address in the file, and this script overrides it for
  its own commands only. To make your normal `bun run dev` use the backend on
  this machine too, leave `bun run own` running and start `bun run dev` — a
  development run prefers the backend beside the page (see `src/lib/backend.ts`).

---

## 2. A server that stays on — `bun run self-host`

For a machine that is always up, with a firewall and a VPN in front of it:

```bash
HUB_PASSWORD='the-password-you-share' bun run self-host
```

It writes `self-hosting/.env` (an instance secret, and the addresses), starts
the open-source backend and its dashboard in containers, makes an admin key,
points this project at it, makes the signing keys, sets the family password,
pushes the app's functions, and builds and serves the app on
<http://localhost:8080>. The backend's data lives in the `convex-data` volume:
`docker compose down` keeps it, `down -v` wipes it.

By hand, if you would rather see each step or change an address first: write
`self-hosting/.env` from the template below (`INSTANCE_SECRET` is the one value
that must be there — `openssl rand -hex 32`), start the two backend containers,
take an admin key from the backend, and then do what `setup.sh` does with it:

```bash
docker compose -f self-hosting/docker-compose.yml up -d backend dashboard
docker compose -f self-hosting/docker-compose.yml exec backend ./generate_admin_key.sh

# `.env.local` in the app folder: the CLI reads these two to know which backend
# to talk to. CONVEX_SELF_HOSTED_URL is the address in CONVEX_CLOUD_ORIGIN above.
printf 'CONVEX_SELF_HOSTED_URL=%s\nCONVEX_SELF_HOSTED_ADMIN_KEY=%s\n' \
  http://127.0.0.1:3210 <the-admin-key> >> .env.local

bun install
bun scripts/generate-auth-keys.mjs            # the keys sign-in needs
bunx convex env set -- HUB_PASSWORD 'the-password-you-share'
bunx convex dev --once                        # push the schema and every function
docker compose -f self-hosting/docker-compose.yml up -d --build hub
```

### The settings the stack reads (`self-hosting/.env`)

```dotenv
# Signs the sessions this backend issues. Generate once with: openssl rand -hex 32
# Changing it later signs every device out.
INSTANCE_SECRET=

# Where the backend answers. Behind a VPN, the VPN address — and it must match
# VITE_CONVEX_URL below.
CONVEX_CLOUD_ORIGIN=http://127.0.0.1:3210
CONVEX_SITE_ORIGIN=http://127.0.0.1:3211

# The address the *browser* connects to — public, not a secret. On a machine
# other devices reach, put the name they use (a Tailscale name, a LAN address),
# never 127.0.0.1: on a phone, 127.0.0.1 means the phone.
VITE_CONVEX_URL=http://127.0.0.1:3210
HUB_PORT=8080

# The family password. Empty means no password — fine only if the machine is
# already private.
HUB_PASSWORD=

# Optional: the call relay, the builder's workshop, and AI provider keys. With
# none of them the hub still works — calls negotiate directly and the assistant
# answers on free public systems.
LIVEKIT_URL=
LIVEKIT_API_KEY=
LIVEKIT_API_SECRET=
DAYTONA_API_KEY=
GROQ_API_KEY=
OPENROUTER_API_KEY=
XAI_API_KEY=
GOOGLE_API_KEY=
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
TAVILY_API_KEY=
BRAVE_API_KEY=
```

**`VITE_CONVEX_URL` is baked in before the first build.** Vite compiles it into
the JavaScript, so changing it afterwards changes nothing — set it, then
`bun run self-host` (or `... up -d --build hub`) again. The backend container
needs the matching `CONVEX_CLOUD_ORIGIN`, for the same reason.

---

## 3. Your own Convex project

Still a hosted service, but the deployment is in your name, which is enough that
nobody else's limit can pause it: `DEPLOY.md` has the whole runbook (a free
Convex project for the backend, Vercel for the pages).

---

## Bringing the family's data across

A backend you own starts empty; the family's rows do not. There is a snapshot of
the old deployment in `backups/`, and putting it in is one command:

```bash
bun run restore -- backups/convex-snapshot-neat-crane-777-2026-10-11.zip
```

It aims the import at the backend on this machine **by name**, and refuses to run
if that backend is not answering — because the import it performs clears whatever
it is aimed at first (`--replace-all`), and a bare `bunx convex import` would take
its target from `.env.local`, which may still name somebody else's deployment.

Then set the signing keys and the password (`bun run own` does both), sign in, and
the family, the messages, the calendar, the files, the AI threads and the security
log are all back. `backups/README.md` has the details, and `bunx convex export` is
how you take a fresh snapshot of any backend, including one you own.

## Getting in

The same rules on all three paths, and they are enforced by the server, not the
screen (`src/convex/guard.ts`, `src/convex/device_rule.ts`):

- With **no** `HUB_PASSWORD`, the hub is guests-only: a name and you are in (or an
  account, above). That is the default here, and it is only safe while the
  machine is private.
- With a password set, a **new device** must answer it before it can see
  anything, and the owner can approve or revoke devices in **Control Room →
  Security**, where the security log records every sign-in, authorisation and
  revocation.
- To change a password, set `HUB_PASSWORD` again on the deployment
  (`bunx convex env set -- HUB_PASSWORD '…'` with the deployment selected) and
  open a device that has not been through it. To remove it, unset it — nobody
  can be locked out of their own app.

### Your own accounts, with no service behind them

The hub has a sign-in that belongs entirely to it: a **name and a password**,
hashed with scrypt and stored in this hub's own database, with sessions signed by
this deployment's own keys (`src/convex/auth.ts`). It is offered on the sign-in
screen as **“I already have an account”**, and “Create this account” makes one.

Nothing is sent anywhere to make it work — no email, no code, no gateway — which
is the point: it works on a hub with no network at all. Two consequences are
worth knowing up front:

- **A name is enough.** Email addresses are accepted and kept as typed, but the
  hub never sends email, so it has no use for one. `Mum`, `mum` and ` MUM ` are
  the same account.
- **There is no reset.** A reset is a code delivered somewhere else, and the hub
  has nowhere else to deliver it. Passwords are at least 8 characters; keep them
  somewhere you can find them. The device path (below) still works for anyone who
  does not want an account at all.

Verified end to end against a backend of its own, with nothing outside it:

```bash
bun run test:auth
```

It starts a scratch backend from the downloaded backend program, pushes the
hub's functions into it, and runs four flows in the deployment — make an account,
refuse a wrong password, sign in with the same name in different case, refuse a
password under 8 characters. `src/convex/auth_check.ts` is the fixture it drives;
neither touches this project's backend, or any account you have made.

## Keeping it private on the network

You do not have to publish anything. The supported shape is:

```
PHONE  →  PRIVATE VPN / LAN  →  THE MACHINE RUNNING THE HUB  →  SUGAR AI
```

Point `VITE_CONVEX_URL` (and `CONVEX_CLOUD_ORIGIN`) at the VPN address, never a
public hostname, and keep ports 3210, 3211 and 6791 on the private side — 6791
administers the whole hub.

### A link that opens — free, no fees

The only name you truly need is the one your devices already have. **Tailscale's
Personal plan is free forever** (six people, unlimited devices) and gives the
machine a stable name in your own private network:

```bash
tailscale serve --bg 8080        # https://<machine>.<your-tailnet>.ts.net/
```

That comes with a real HTTPS certificate, opens nothing to the internet, and
answers only devices signed into your tailnet. Install it on the hub machine and
on each phone or computer, give the hub machine a short name such as `ranch`, and
put that address in **Control Room → The hub's address** so the Web Portal, the
invite link and the Offline Brain all show and copy it.

Installation as an app (Add to Home Screen) needs HTTPS or localhost, so if you
want the hub on a phone's home screen, this is also the step that makes that
possible. On one machine alone, `http://localhost:8080` is the exception that
works without any of it.

## Backups, and what is not in one

- **`bun run own`** — copy `.convex/local/default/`. It is the whole database.
- **`bun run self-host`** — copy the `convex-data` volume, or
  `bunx convex export --path ./hub-export` pointed at it.
- **Any backend** — `bunx convex export` writes a snapshot zip that
  `bunx convex import` puts back, and **Offline Brain → Backup** in the app
  packs the code and the rows together, built in the browser from what the hub
  already holds.

A backup holds **no API keys**: those live in the deploy environment, not the
database, so a backup file can be stored somewhere less protected than the
machine itself. The one thing to keep as carefully as the data is the instance
secret (`.env`) and the signing keys — anyone holding them can mint a session.

## What is still not yours, and does not need to be

- **AI providers.** Every model is optional, and with no key at all the
  assistant answers on free public systems. To run a real model yourself, point
  the hub at a gateway you control — LiteLLM is open source and
  `public/offline-brain/configuration/litellm.example.yaml` is already
  configured for it:

  ```bash
  bunx convex env set AI_BASE_URL http://localhost:4000/v1
  bunx convex env set AI_API_KEY local
  bunx convex env set AI_MODEL coder
  ```

- **A call relay.** Two devices behind strict routers cannot always reach each
  other directly. LiveKit is open source, so `LIVEKIT_URL` can point at your own
  server; without one, calls negotiate directly and work whenever the two
  networks can find each other.
- **The builder's sandbox.** `DAYTONA_API_KEY` connects a real Linux machine for
  the builder to run code on. Optional: without it, code runs on the public
  runner and this app's own source is still readable and patchable.

Pointed at a backend and a model you own, the hub answers to nobody but you — and
the parts that were never yours are the parts it works perfectly well without.
