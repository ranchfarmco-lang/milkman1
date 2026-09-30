# Family Chat Hub

Family Chat Hub (`private-hub`) is one private hub for a family: two AIs, a
shared messenger with real voice and video calls, a contacts roster, and a
Control Room for the device settings that make it behave like an app. Black background, white text, no colour anywhere —
that is the whole theme, on purpose.

Everyone who gets in lands in the same family, and only that family's messages
are visible to them. There is one way in — the family password — and it is the
same one for everybody. No email, no invite code, no guest button.

## What's in it

| Page | Route | What it does |
| --- | --- | --- |
| Signing in | `/auth` | The family password, and nothing else. |
| AI Assistant | `/assistant` | Ask, or just talk. It looks things up, runs code, opens pages, sets reminders and timers, passes messages to the family, reads the whole `[LIVE]` board back to you when you ask, gives you a rundown of the day and everything coming up, and speaks up on its own when you go quiet. |
| AI Builder | `/builder` | Turns an idea into a plan plus code, and can read, run, edit and rebuild this whole project — its own source included. |
| Contacts | `/family` | Who is around right now, with one-tap message, voice and video. |
| Messenger | `/messenger` | The family room, plus voice and video calls in the four boxes. |
| Control Room | `/control-room` | **All the settings, and only the settings.** Sound, alerts, screen, permissions, connections (including the **VPN** switch), privacy and call settings, the eight voices the assistant can speak in, and every AI system the server can reach. Everything the hub truly owns is an on/off switch beside its row, and each row carries a **Where this lives** note picked for the device you are holding — the exact screen behind that setting, and the address to paste where one exists. Information and downloads live on the Web Portal and the Offline Brain instead, so nothing is written twice. |
| Web Portal | `/web-portal` | **All the information.** What this thing actually is — a website, not an app-store app — plus the address to copy onto another device, the install steps for every browser, what is inside each page, and what every button does. `/get-app` still redirects here. |
| Offline Brain | `/offline-brain` | Your Proton VPN link at the very top, the hub's own backup, and the whole offline AI coding system — every model, runtime, reasoning framework, coding agent and tool, each with its own download, a **Download everything** bundle for each category, and a per-platform ready zip that carries the whole package — the Freebuff reference source included — beside an installer written in that platform's own language. |
| Local Brain | `/local-brain` | The control surface for **the system running on your own machine**. Pair it once with the local brain's address and pairing token, and this page becomes a window onto that brain: its memory, its tools, the connectors and keys, the model servers answering on loopback, its self-diagnostics, and a chat that thinks on your own hardware. It needs the hub's database for nothing, so it still opens when Convex does not. |
| [LIVE] | `/live` | Mission control: one wall of same-size boxes, every one fetched by the server itself and drawn by the hub's own code rather than embedded pages — weather and soil, mountain snow over eight ranges, active NWS alerts, air quality, drought and river gauges, Colorado hay and alfalfa prices by region, cattle, horse, tack and equipment auctions across the state, ranch and farm store sales, mapped wildfires, FEMA declarations, the day's earthquakes, energy, metals, farm, market and economic prices, the grid's inputs, aircraft overhead, the ISS and space weather, and Colorado plus world headlines. It refreshes on a timer, and a real 24/7 HFGCS (Emergency Action Message) rebroadcast starts muted. It carries a box for your own calendar's next entries, and the AI Assistant reads the whole board — or the day ahead — back on request: say "what's on the live board", or "brief me". Each morning it also writes its dated sales onto the calendar and leaves the day's watch card there. |

## Getting it

```bash
git clone https://github.com/ranchfarmco-lang/private-hub.git
cd private-hub
```

## Running it

Needs [Bun](https://bun.sh) and a Convex deployment.

```bash
bun install
bunx convex dev   # once: creates or attaches a deployment and writes the client vars
bun run dev       # from then on, this is the whole system
```

`bun run dev` starts **both** halves: the Convex backend that holds everything
shared, and Vite that serves the UI. That matters because starting only Vite
looks exactly like a broken app — every screen behind sign-in waits for the
backend and spins for ever on a black page, with nothing to say why. The backend
runs in the background and Vite stays in the foreground, so if the backend cannot
start the pages that need no database (the Local Brain, the Offline Brain
downloads) still come up. Its output goes to `.vly-run/convex-dev.log`.

`bun run dev:web` is Vite on its own, for when the backend is already running
somewhere else.

### Getting in

One password, the same for the whole family. Set it once on the deployment:

```bash
bunx convex env set HUB_PASSWORD the-password-you-share
```

Then there is nothing else to do — no email form, no invite code, and no guest
button. Open the hub, type the password, and you are in.

- **Checked on the server, never in the browser.** The password itself is never
  sent to the page and never returned by anything; the functions behind the gate
  only ever answer yes or no.
- **Once per device.** A correct answer is written against the account, so it is
  asked for the first time on a phone or a computer and not again. **Lock this
  device** in the top bar forgets it, for a phone that gets handed round.
- **Nothing works until it is answered.** The roster, the messenger, the shared
  files, the calls and both AI boxes are all shut, enforced on the server as well
  as on screen — reading a thread or spending an AI key from outside the page
  fails exactly the same way. The messenger is opened by the one thing that
  hands out a family, and that is behind the password too.
- **Five wrong guesses** and it makes you wait thirty seconds.
- **First time in, it asks what to call you**, because otherwise the roster and
  every message you send would read "Guest". Your family sees that name; you can
  change it later in the Control Room.
- **Changing it** means setting `HUB_PASSWORD` again: the new password is asked
  for on any device that has not already been let in. **Removing it entirely**
  makes the hub open as it did before, so nobody can be locked out of their own
  app.

### Keys

All keys live on the Convex deployment, never in the browser. Set them with
`bunx convex env set NAME value`.

- **AI systems** — every key you add becomes another AI the assistant can ask.
  `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`, `XAI_API_KEY` or
  `GROK_API_KEY` (xAI), `GOOGLE_API_KEY` or `GEMINI_API_KEY` (Gemini). For any
  other OpenAI-compatible endpoint, set `AI_BASE_URL`, `AI_API_KEY` and
  `AI_MODEL` instead. `VLY_INTEGRATION_KEY`, which this deployment already has,
  is the gateway the app ships with.
- **Which one leads is a setting, not a code change.** `AI_LEAD` names the
  system to lead every conversation — its slug (`AI_LEAD=groq`, `AI_LEAD=xai`,
  `AI_LEAD=vly`) or its written label (`AI_LEAD=Google Gemini`). A name with no
  key behind it is ignored, so switching to a system you have not added yet
  never leaves a box with nothing to talk to. Leave it unset and the built-in
  order decides, exactly as before.
- **None of them is required.** With no key at all the assistant still works, on
  free public systems that need no account. `AI_FREE_TIER=off` switches those
  off, and `POLLINATIONS_API_KEY` lifts their queue limit.
- **A free system is shared, so it is busy sometimes.** Pollinations takes one
  request at a time per address, and this deployment shares its address with
  everything else on the same host — so a second request arriving while the
  first is still in flight is refused with `429`. That is a queue, not a fault:
  the app waits for the place to clear and asks again, and if it still cannot
  get in it says so in plain words instead of showing the raw error. Identical
  prompts come back cached and cost nothing, which is why a passing health check
  proves less than it looks like it does.
- **Pollinations answers on a deprecated address.** `text.pollinations.ai`
  still serves anonymous callers, which is why the keyless fallback points
  there, but it is being retired for anyone holding a token — those accounts
  are asked to move to `gen.pollinations.ai`. The new platform has no anonymous
  tier at all: asked without a key it answers `401`. So the upgrade path, if you
  want a free fallback that is not queue-limited, is a token from
  enter.pollinations.ai, and then moving the entry in `FREE_SYSTEMS` to
  `https://gen.pollinations.ai/v1`.
- **Getting in** — `HUB_PASSWORD` (above).
- **Auth** — `JWKS`, `JWT_PRIVATE_KEY`, `SITE_URL`, `VLY_CONVEX_AUTH_ISSUER`.
- Optional: `BRAVE_API_KEY` or `TAVILY_API_KEY` for a full web index. **Without
  one there is still a live internet** — search falls back to a keyless news
  feed (Bing, then Google News), Hacker News, Stack Overflow and Wikipedia.
  Current, but thinner than a real index. Also `AI_REVIEW=off` to skip the
  self-review pass, and `AI_CODE_RUNNER=off` to stop either agent running code.
- **The workshop** — `DAYTONA_API_KEY` connects a real machine for the builder
  to code on (see below). Optional: `DAYTONA_SERVER_URL` for a self-hosted or
  non-default Daytona, `DAYTONA_TOOLBOX_URL` when the in-sandbox API is not
  at its usual address, and `DAYTONA_SNAPSHOT` to pick a different image.

### The workshop

The builder writes code in this app, but this app runs on Convex, which has no
filesystem and no shell — so the bench (`workspace.ts`) is a filesystem made out
of documents, and it cannot *run* anything. The workshop closes that gap: a real
Linux sandbox out on [Daytona](https://www.daytona.io), with a real shell, a real
filesystem and the network, which the builder's code actually executes on.

- **Add `DAYTONA_API_KEY`** (a key from app.daytona.io) and it is live. **Remove
  it and nothing changes** — every caller falls back to the public code runner
  and to the snapshot, exactly as before. No tool ever fails because the
  workshop is missing.
- **One sandbox per hub**, made on first use and reused after that, labelled so
  it can be found again — and found *only* by that name or label, so a
  sandbox someone else made is never touched. `daytona-medium` — 2 vCPU,
  4 GiB memory, 8 GiB disk, which fits installing packages and typechecking a
  real project; set `DAYTONA_SNAPSHOT` to trade headroom for speed.
- **Files on the bench are mirrored into it**, so a program can span several
  files and can import what was written on an earlier turn.
- **This app's own source is seeded into it** from the snapshot, so its real
  files can be read, edited and checked there instead of only described. That is
  every file in the snapshot, written once in about ten seconds, and skipped
  afterwards.
- **The whole project can be rebuilt from inside.** `scaffold_project` puts every
  file of the hub on the builder's bench, `edit_file` changes one in place
  without rewriting it, `read_file` pages a long one by line range, and
  `move_file` renames one. Together with the shell this is how the builder
  rebuilds the entire app rather than writing new snippets beside it.
- Python 3.14, Node 25, Bun and shell run directly; every other language still
  goes to the public runner. Bun is already on the image and is installed on
  first use if it is ever missing.
- **Shell is the toolchain, not a toy.** `run_code` with `language: "bash"`
  runs the commands in the project folder itself, up to four minutes each, so
  the builder can install packages, typecheck, run a test suite and use git —
  and finds what it installed still there on the next turn. The project's own
  files are put there first when they are not already, so the very first
  command sees the real tree rather than an empty folder.
- To start over, run the `sandbox:reset` function; the next run builds a fresh
  machine. `sandbox:warm` seeds a new one up front instead of on first write.

### Every AI system it can reach

The assistant and the builder are not tied to one model. Whatever keys are set,
plus the app's own gateway and the free public systems, are gathered into one
list that the Control Room shows — best first, the first one leading the
conversation. The Control Room's "Leads" badge marks that first one.

Which system sits at the top is a setting rather than a guess: give `AI_LEAD`
the slug (`xai`, `groq`) or the label (`Google Gemini`) of any system this
deployment can reach, and it moves to the front for both agents. A name that is
not reachable — no key for it yet — is ignored, so the switch never leaves a box
silent, and a lead that stops answering still hands the question down the line
on its own.

Both agents carry two tools for that list:

```text
{"tool":"list_ai"}                                          what is reachable
{"tool":"ask_ai","system":"gemini","question":"..."}     ask one of them
{"tool":"ask_ai","system":"all","question":"..."}        ask all of them and compare
```

An `ask_ai` call may also carry `"model"` to name one exact model inside that
system — worth knowing on a gateway like OpenRouter, which holds hundreds of
models from other makers behind a single key.

They are told to use it whenever an answer turns on something recent, local,
niche or contested, to say plainly where the systems disagree instead of
quietly picking one, and to check anything load-bearing against a real page
before passing it on. `web_search` and `fetch_url` are still there for that.
A note under a reply reading "Asked Google Gemini" is this happening.

### Keeping them connected

- **A dead system never ends the conversation.** The question goes to the
  leading system first; if every model it offers refuses — a rate limit, a model
  retired overnight, a provider having a bad afternoon — the same question moves
  down the list on its own. Consulting, reviewing and the assistant's own
  unprompted lines all inherit that second and third chance, so neither box is
  ever left silent because of one key.
- **Two dialects, one set of tools.** The tools are declared to OpenAI-shaped
  endpoints the ordinary way *as well as* being accepted as JSON inside a reply.
  Models that answer with a real tool call — Groq's `gpt-oss` pair is the one
  that used to fail — now work instead of returning `tool_use_failed`. One tool
  runs per turn, so a model that asks for two in the same breath is told so and
  does the second next turn.
- **Auto refresh.** The Control Room's AI systems card asks every system whether
  it is *still answering* — a real call, because a key that exists proves
  nothing — and asks again every five minutes while the page is open. The
  **Auto refresh the AI systems** switch in the Assistant section turns that
  off; pressing Refresh always works either way.

### What they remember

Everything they remember is this app's own Convex database, per account, and
nowhere else:

- **Facts** — anything the assistant is told that will still be true next week,
  kept in `memories`. It saves them itself, unprompted, and does not invent one
  to sound attentive. The Control Room's **What it remembers** card lists every
  one, with a delete on each line and **Forget everything** above them.
- **The conversation** — every box keeps its own thread in `messages`, so a
  conversation picks up days later where it stopped. The assistant is handed the
  last 48 turns and the builder the last 64.
- **The builder's bench** — real files in `files`, still there next turn. One
  call, `scaffold_project`, lays every file of this whole project out on it, so
  the builder can edit any of them in place and run the whole thing on the
  workshop machine — that is what lets it rebuild the entire hub, not just new
  snippets beside it.
- **Thinking out loud** — both agents share a `think` tool: a scratchpad with no
  effect on anything, which is where a plan for a long job gets written down
  before it is carried out. It is also what the Preview box reads back to you:
  every thought is a real step of the run, so it is shown there the moment it is
  written — typed out a character at a time, between the steps above and below
  it — rather than summarised after the turn is over.

None of it is kept on the device or in browser storage, and none of it is shown
anywhere but your own account. The one place a memory is ever sent is inside the
prompt given to whichever AI system is answering, which is where it stops.

### Installable app

The hub installs as an app on a phone and on a computer straight from the
browser — no app store, no installer file, and it updates itself.

- **iPhone or iPad** — Safari → Share → Add to Home Screen. Only Safari can do
  this on iOS.
- **Android** — Chrome → ⋮ → Install app, or the Install button on `/web-portal`.
- **Windows, Linux or ChromeOS** — Chrome, Edge or Brave: the install icon at
  the right end of the address bar, or ⋮ → Cast, save and share → Install page
  as app.
- **Mac** — same as above in Chrome, Edge or Brave; Safari → File → Add to Dock.

`/web-portal` inside the app works out which device you are on and shows the
exact steps for it, plus the copyable address to open on another device. It also
says plainly what the thing is: one address in a browser, with installing being
a convenience rather than a different version. Installation needs https (or
localhost while testing).

What makes it installable is `public/manifest.webmanifest` and `public/sw.js`,
which caches the icons and nothing else — never the app shell, so a stale build
can never be served. The PNGs in `public/icons` are generated, not drawn: change
the geometry in `scripts/make-icons.mjs` and run `bun run icons`.

### The Control Room

Every row in the Control Room either does the thing itself or names where the
real switch lives:

- **Where this lives** — an inline note picked for the device in front of you
  (from `src/lib/settings-locations.ts`): the taps to reach the browser's or the
  phone's own setting, and the address to paste where one exists. Routes match
  the platform *and* the browser, so an iPhone is never told to open the Chrome
  menu and a Chromebook is never told to open the Settings app on an iPhone.
  Addresses such as `chrome://settings/content/camera` cannot be opened by a link
  from a page, so they are offered as copyable lines instead of buttons that
  would fail — and only where they really exist: no chrome:// address is offered
  to Safari or Firefox, and none on Android, where the padlock is the way in.
- **Permissions are switches too** — Camera, Microphone, Notifications and the
  Clipboard read as on/off switches like every other setting. On asks the
  browser. Off cannot work, because no page is ever allowed to hand a permission
  back: the switch stays where it is and opens the note that says where you
  really can. Chrome and Safari never report the camera or the microphone, so a
  permission that has just been allowed is written down for that device alone
  (`hub.permission-grants` in local storage) — which is what keeps the switch on
  after a reload, without pretending about a device that was never asked.
- **Refresh** — in the header, on each read-only row, and in the Reset card. It
  asks the browser again for permissions and connection state.
- **Reset** — on any switch that has moved off its default, plus one button that
  puts every switch back at once (`assistant_speak_up` is one of them: switch it
  off and the assistant only answers when asked). Permissions cannot be reset by
  a page — only you can take those back, and the row says so.
- **VPN** — a switch, not a tunnel. A web page can never build one, so the
  switch remembers the choice and opens your Proton VPN link (the same link sits
  at the top of the Offline Brain). Change that one link in
  `src/lib/offline-brain.ts` (`VPN_URL`).

### Backup

The Offline Brain's Backup card hands the whole hub back to you as a download.
Every file is built in the browser from what the hub already holds — nothing is
uploaded to make one, and the hub keeps running exactly as it is afterwards.

| Download | What it is |
| --- | --- |
| **Everything** (`.zip`) | The whole app, a Dockerfile that runs it on your own computer, and `data/hub-data.json` — a copy of everything the hub has written down. |
| **The app, ready to run** (`.zip`) | The same app and Docker files without the data. |
| **The code, readable** (`.txt`) | Every file the app is made of, one after another, in one text file. |
| **The data alone** (`.json`) | Messages, calendar, shopping list, memories, reminders, the Builder's files, and links to attachments. |
| **The Linux steps** (`.txt`) | The install guide with the Dockerfile, compose file and nginx config it mentions. |

The pieces:

- `src/convex/backup.ts` — two queries: `source` hands back the app's own
  snapshot (`self_source.ts`) with anything the **AI Builder** has changed merged
  back in on top, and `data` reads the family's rows table by table.
  Both are gated exactly like the rest of the hub — signed in, past the family
  password — and every table is read with a stated cap, so a backup says what it
  left out instead of pretending to be complete.

  The merge is what lets the hub fix itself: the builder keeps a working copy of
  this project on its bench (`workspace.ts`), so a file it repaired there is the
  copy that travels in a backup, and `patched` names every file it changed.
  Nothing here deploys or restarts the live hub, so a fresh backup is how the
  fixed app actually reaches the person.
- `src/lib/backup.ts` — builds the text file, the JSON, the Linux kit and the
  archive. It also puts `src/convex/self_source.ts` back into a copy of the app,
  since the snapshot deliberately leaves itself out; without that step the copy
  would not build.
- `src/lib/zip.ts` — a ZIP writer with no dependency behind it (stored entries,
  CRC-32), so the backup needs nothing added to the project to make a `.zip`.
- `src/components/BackupPanel.tsx` — the card itself, mounted on the Offline
  Brain page.

A backup is a snapshot, not a live link: it is the code and data as they were
when you pressed the button. Restoring the data is `bunx convex import`, and the
steps are in the `INSTALL.md` inside the archive.

### Cutting the cord

A downloaded copy talks to a Convex database, and that database can be someone
else's. The archive carries the way out of that: `app/self-host/` holds the
official **open-source Convex backend** (the same code the hosted service runs)
and a one-command setup, so the copy you own can run its own database on your
own machine — no hosted service, and nothing outside the machine to switch off.

```bash
HUB_PASSWORD='the-password-you-share' bash self-host/setup.sh
```

It starts the backend, makes an admin key, makes the sign-in keys the hub needs
(`JWT_PRIVATE_KEY` and `JWKS`), pushes the app's functions to it, and builds and
serves the hub against it at `http://localhost:8080`. The full walkthrough,
including doing each step by hand, is in section 6 of the archive's
`INSTALL.md`. The hub signs each device in as an anonymous account and never
uses email, so nothing else has to be configured.

### Out of Freebuff entirely

Two things in this project ever touched Freebuff. Neither is needed now:

- **The build plugin** (`@vly-ai/integrations`, wired in `vite.config.ts`). It is
  loaded only when it is actually installed and sits under
  `optionalDependencies`, so a project without it installs and builds the same.
  It is only ever needed to *edit* the project inside Freebuff, never to run it.
- **The AI gateway** (`VLY_INTEGRATION_KEY`). It is one AI system among several,
  and the hub is complete without it — with no key at all it answers on free
  public systems that need no account. To run a real model of your own, use
  LiteLLM (open source, free): `public/offline-brain/configuration/litellm.example.yaml`
  is ready to point at your own models, then set `AI_BASE_URL`, `AI_API_KEY` and
  `AI_MODEL` on the deployment.

Pointed at a backend and a model you own, the copy on your computer answers to
nobody but you.

### Deploying it to your own site

The hub runs anywhere a Vite site runs. `DEPLOY.md` is the whole runbook, and it
is two free accounts, neither of them Freebuff:

- **Convex** (<https://dashboard.convex.dev>) for the backend — your own project,
  in your own name.
- **Vercel** (<https://vercel.com/new>) for the pages. `vercel.json` is already
  in the project, so the build is one command and the routes work on a static
  host.

Set `VITE_CONVEX_URL` to your new Convex URL on the Vercel project *before* the
first build — Vite bakes environment variables in at build time.

### Calls

Voice and video are our own: our own four-portal video stage, our own Convex
backend carrying the ring and the handshake, and our own WebRTC engine. Media
is encrypted end to end (DTLS-SRTP), and no third-party widget is embedded —
the four boxes are ours. Calls need https or localhost, and two devices to test
properly.

There is one thing that cannot be our code, and it is not a program: a
**relay**. Two devices behind strict routers — a phone on a carrier network, an
office network — often cannot open a path to each other at all, so the packets
have to pass through something with a public address. The app prefers a media
server for this, because it also fixes a four-way call (everyone connects out,
instead of six fragile links between four people):

- **A media server (preferred).** Set `LIVEKIT_URL`, `LIVEKIT_API_KEY` and
  `LIVEKIT_API_SECRET` and every device joins a LiveKit room named after the
  call. The server mints a short-lived token per person, and only for a call
  they are already on. LiveKit is open source, so `LIVEKIT_URL` can point at
  your own server and the whole path becomes yours. Without a card, its Cloud
  build tier is free.
- **Straight between the devices (fallback).** With no media server set, the
  devices negotiate directly, using STUN and any TURN relay you point them at
  with `VITE_TURN_URL` / `VITE_TURN_USERNAME` / `VITE_TURN_CREDENTIAL` (or
  `VITE_TURN_SECRET`). Free and private, but it only works when the two
  networks can find each other.

### The Calendar

One grid for the household's month, with the year a click away. Every entry is
stored as a moment in time, so switching the timezone moves the whole page
without rewriting a row.

- **Five layers.** Personal & feeds, community schedule, meals & shopping,
bulletin & help, and Assistant & LIVE — switch any off from the side panel
without deleting anything. Everything the AI Assistant or the `[LIVE]` board
puts on the calendar lands on the Assistant & LIVE layer, so one tap hides or
shows the lot, and the same switch hides it on the `[LIVE]` board's calendar
box too.
- **From the `[LIVE]` board, every morning.** A timer reads the board and writes
what it found onto the Assistant & LIVE layer: the dated horse and equipment
sales become all-day entries, one "Colorado & national watch" card carries the
day's weather alerts, road reports, drought and hay trade, and each person is
left a single reminder for 7am — moved each day rather than piled up. So what
the board shows is on the calendar before you go looking, and a sale that has
passed is cleared away on its own.
- **Around eighty kinds**, grouped for reading: health (appointment, medical,
dentist, therapy, medication, vet), work and school, kids and family (including
adult time and date night), meals, the house, animals (livestock, horse care,
pet care), travel and errands, pickups and drop-offs, requests for a hand,
faith and community, and money. The kind chooses the layer when you do not, and
the nine request kinds (ride, childcare, hauling, help, moving, babysitting,
delivery, pickup, drop-off) write their own headline and carry answer buttons.
A ride, a shift, a dinner and an appointment are the same row with a different
kind, which is why they share one grid.
- **Options on an entry**, all optional: **priority** (Low → Urgent; only High
and Urgent earn a mark on the card), an **emoji** (tap the palette or type any
one), an **alarm** (no alarm, at the start, 15/30 minutes, 1/2 hours or 1 day
before — it becomes a real reminder ahead of the event and is moved or removed
with it), a **link** for a booking, call or recipe, and the money side —
**cost**, **payment** (unpaid / paid / reimbursement) and **paid by**. The card
shows a dollar figure; the detail view spells the rest out.
- **Dates always read MM/DD/YYYY** (or "September 25, 2026" in a heading). No
ISO string or developer timestamp reaches the screen — the one place an ISO
value is still used is the hidden value of a native date picker, which the
browser re-formats itself.
- **Search** the month from the box above the grid: titles, places, notes,
ingredients, and the people and links on a card. It narrows what is drawn and
leaves every stored row alone.
- **Coming in from another calendar.** Drop an `.ics` file on the page, or
link a live address with the **Address** button — a Google calendar's private
"Secret address in iCal format", an Outlook or iCloud subscription. A feed's
entries land on your own layer and re-sync on demand, so a work roster never
lands on the family's grid.
- **Going out to another calendar.** **Download .ics** in the feeds card writes
the last month and the year ahead as a standard `.ics` file — summaries,
locations, notes, categories, priorities and the alarms as `VALARM` entries
travel with it. In Google Calendar: *Settings → Import & export → Import*, pick
the file, choose which calendar to add it to. The same file opens in Outlook
and Apple Calendar. This is a one-time copy, not a live sync.
- **Meals and shopping.** A meal's ingredients become a shopping list from the
side panel, and the list can be attached to a store trip with a reminder
before it.
- **Requests are answered in place.** A ride, childcare, hauling or help card
carries its own "I can help" answer, and the names land back on the card.

### The two versions

One codebase, two builds. The difference between them is a build-time constant,
not a second app:

```bash
bun run build          # the web version: what a host serves
bun run build:local    # the local version: for your own machine
```

The variable behind it is `VITE_PROFILE`, and it has to be spelled that way.
Vite forwards only `VITE_`-prefixed variables from the shell into the build, so
a bare `PROFILE=local` would be ignored without saying so. It is compiled into
the JavaScript, which means it cannot be changed after the build and must never
hold a secret.

Both builds write to `dist/`, so build the version you are about to serve. The
variable itself is read in one place, `src/lib/profile.ts`; everything else reads
the resolved `PROFILE` / `IS_LOCAL` from there rather than the variable again.

What actually differs between the two is deliberately short:

| | the web version | the local version |
| --- | --- | --- |
| Where a copy opens | `/assistant` | `/local-brain` |
| Backend when none is configured | (none — the host supplies it) | `http://127.0.0.1:3210` |

Everything else is the same app: same eight tabs, same order, same routes, same
pages. Both still ask for the family password and a name, because that screen is
also the step that puts an account on the roster — a local copy that skipped it
would be a hub whose family has no names in it.

## The local brain, and why there are two halves

`public/offline-brain/brain/` is a complete, offline-first AI in **Python 3 and
nothing else** — no packages, no virtual environment, no account, no key. It has
its own SQLite memory, its own tool registry, its own workspace, its own
connector and credential layer, its own information hierarchy, its own
diagnostics, its own **scheduler** (recurring work it runs without being asked)
and its own **package manager** (what is installed, what the package's own
installers would add, and what could be replaced with something local). Start it
on the machine in front of you:

```bash
python3 brain/brain.py serve
```

It prints a pairing token. Paste the address and the token into `/local-brain`
once, and the hub becomes a **view** of it: same memory, same tools, same
schedule, same diagnostics, reached over HTTP. There is no second copy of any of it in the
browser, which is what makes the two halves one system rather than two products:

```
your machine                                    any browser
brain.py  ·  memory · tools · workspace   <──▶  /local-brain
```

Two properties are worth naming. The API binds to `127.0.0.1` and requires the
token, because it can run shell commands — and it answers the browser's
private-network preflight, which is what lets a hub served over `https` reach
loopback at all. Everything the brain owns lives in two directories that move
with `BRAIN_HOME` and `BRAIN_WORKSPACE`, so the whole system can live on an
external drive.

The full documentation — every module, the API, the settings, and the reasoning
behind each dependency that was avoided — is in
`public/offline-brain/brain/README.md`, and it ships with the package.

## Layout

```
src/pages        one file per page
src/components   shared UI, including the chat and preview panels
src/convex       the backend: schema, queries, mutations, actions
src/hooks        client-side behaviour
src/lib          small shared helpers
scripts          snapshot, self-check and icon tooling
public/offline-brain   the local system: installers, docs, and brain/
```

## Scripts

| Command | |
| --- | --- |
| `bun run dev` | the whole hub: the Convex backend and the dev server |
| `bun run dev:web` | the dev server alone, when the backend is already up |
| `bun run build` | typecheck and build the **web** version |
| `bun run build:local` | build the **local** version (`VITE_PROFILE=local`) |
| `bun run lint` | eslint |
| `bun run icons` | regenerates the app icons in `public/icons` |
| `bun run snapshot:self` | repacks this app's own source into `src/convex/self_source.ts` |
| `bun run verify:self` | checks that snapshot is current, and that the self-read and self-patch helpers behave |

The words both agents are given live in `src/convex/ai_prompts.ts`, the list of
languages the code runner can actually run in `src/convex/ai_languages.ts`, the
builder's ability to read and patch a snapshot of its own source in
`src/convex/ai_self.ts`, and everything about reaching models, search, pages and
other AI systems in `src/convex/ai.ts`.

The AI Builder runs inside Convex, which has no filesystem, so the only way it
can read its own code is for that code to ship alongside the functions.
`src/convex/self_source.ts` is that copy. It is generated and it goes stale — run
`bun run snapshot:self` after changing code you want the builder to see.

That same snapshot carries the **offline brain**: every file under
`public/offline-brain/` is packed in too, at its real path, so the builder can
read the whole local stack — the architecture, the capability map, the model and
tool catalogs and every installer — with the same `read_own_code` tool it uses
on its own code, instead of answering about it from memory.

---

# Project conventions

The rest of this file is the set of conventions this app was built against.

## Overview

This project uses the following tech stack:
- Vite
- Typescript
- React Router v7 (all imports from `react-router` instead of `react-router-dom`)
- React 19 (for frontend components)
- Tailwind v4 (for styling)
- Shadcn UI (for UI components library)
- Lucide Icons (for icons)
- Convex (for backend & database)
- Convex Auth (for authentication)
- Framer Motion (for animations)
- Three js (for 3d models)

All relevant files live in the 'src' directory.

Use bun for the package manager.

## Setup

This project is set up already and running on a cloud environment, as well as a convex development in the sandbox.

## Environment Variables

The project is set up with project specific CONVEX_DEPLOYMENT and VITE_CONVEX_URL environment variables on the client side.

The convex server has a separate set of environment variables that are accessible by the convex backend.

Currently, these variables include auth-specific keys: JWKS, JWT_PRIVATE_KEY, and SITE_URL.


# Using Authentication (Important!)

You must follow these conventions when using authentication.

## Auth is already set up.

All convex authentication functions are already set up. The auth currently uses email OTP and anonymous users, but can support more.

The email OTP configuration is defined in `src/convex/auth/emailOtp.ts`. DO NOT MODIFY THIS FILE.

Also, DO NOT MODIFY THESE AUTH FILES: `src/convex/auth.config.ts` and `src/convex/auth.ts`.

## Using Convex Auth on the backend

On the `src/convex/users.ts` file, you can use the `getCurrentUser` function to get the current user's data.

## Using Convex Auth on the frontend

The `/auth` page is already set up to use auth. Navigate to `/auth` for all log in / sign up sequences.

You MUST use this hook to get user data. Never do this yourself without the hook:
```typescript
import { useAuth } from "@/hooks/use-auth";

const { isLoading, isAuthenticated, user, signIn, signOut } = useAuth();
```

## Protected Routes

The starter `/dashboard` route is protected with `RequireAuth`. Extend that page
for the product's authenticated experience, and reuse `RequireAuth` when adding
another protected route — do NOT hand-roll a redirect to `/auth`, since landing
on a bare sign-in form with no explanation of what was blocked is confusing.

`RequireAuth` states the block on the page the visitor asked for and sends them
to `/auth?returnTo=<current route>` when they choose to sign in, so they come
back to it. Pass `title` and `description` to say what the page is:

```tsx
<Route
  path="/dashboard"
  element={
    <RequireAuth
      title="Sign in to view your dashboard"
      description="Your projects and settings live here."
    >
      <Dashboard />
    </RequireAuth>
  }
/>
```

Pass `redirectImmediately` for a route where bouncing straight to `/auth` really
is better.

## Auth Page

The auth page is defined in `src/pages/Auth.tsx`. Send sign-in and sign-up actions
to `/auth`.

## Authorization

You can perform authorization checks on the frontend and backend.

On the frontend, you can use the `useAuth` hook to get the current user's data and authentication state.

You should also be protecting queries, mutations, and actions at the base level, checking for authorization securely.

## Adding a redirect after auth

The `/auth` route in `src/main.tsx` redirects to `/dashboard` by default. If the
product's main authenticated route is different, update `redirectAfterAuth` to
that route. A validated same-origin `returnTo` query parameter takes priority so
users can resume the protected page they originally requested. Never leave an
authenticated product redirecting back to the public landing page.

## Complete authenticated products

When the requested product implies accounts, a workspace, a dashboard, or other
signed-in functionality, the task is not complete with only a landing page and
auth form. Build the main authenticated experience, protect its route, and verify
that signing in reaches it.

# Frontend Conventions

You will be using the Vite frontend with React 19, Tailwind v4, and Shadcn UI.

Generally, pages should be in the `src/pages` folder, and components should be in the `src/components` folder.

Shadcn primitives are located in the `src/components/ui` folder and should be used by default.

## Page routing

Your page component should go under the `src/pages` folder.

When adding a page, update the react router configuration in `src/main.tsx` to include the new route you just added.

## Shad CN conventions

Follow these conventions when using Shad CN components, which you should use by default.
- Remember to use "cursor-pointer" to make the element clickable
- For title text, use the "tracking-tight font-bold" class to make the text more readable
- Always make apps MOBILE RESPONSIVE. This is important
- AVOID NESTED CARDS. Try and not to nest cards, borders, components, etc. Nested cards add clutter and make the app look messy.
- AVOID SHADOWS. Avoid adding any shadows to components. stick with a thin border without the shadow.
- Avoid skeletons; instead, use the loader2 component to show a spinning loading state when loading data.


## Landing Pages

You must always create good-looking designer-level styles to your application. 
- Make it well animated and fit a certain "theme", ie neo brutalist, retro, neumorphism, glass morphism, etc

Use known images and emojis from online.

If the user is logged in already, show the get started button to say "Dashboard" or "Profile" instead to take them there.

## Responsiveness and formatting

Make sure pages are wrapped in a container to prevent the width stretching out on wide screens. Always make sure they are centered aligned and not off-center.

Always make sure that your designs are mobile responsive. Verify the formatting to ensure it has correct max and min widths as well as mobile responsiveness.

- Always create sidebars for protected dashboard pages and navigate between pages
- Always create navbars for landing pages
- On these bars, the created logo should be clickable and redirect to the index page

## Animating with Framer Motion

You must add animations to components using Framer Motion. It is already installed and configured in the project.

To use it, import the `motion` component from `framer-motion` and use it to wrap the component you want to animate.


### Other Items to animate
- Fade in and Fade Out
- Slide in and Slide Out animations
- Rendering animations
- Button clicks and UI elements

Animate for all components, including on landing page and app pages.

## Three JS Graphics

Your app comes with three js by default. You can use it to create 3D graphics for landing pages, games, etc.


## Colors

You can override colors in: `src/index.css`

This uses the oklch color format for tailwind v4.

Always use these color variable names.

Make sure all ui components are set up to be mobile responsive and compatible with both light and dark mode.

Set theme using `dark` or `light` variables at the parent className.

## Styling and Theming

When changing the theme, always change the underlying theme of the shad cn components app-wide under `src/components/ui` and the colors in the index.css file.

Avoid hardcoding in colors unless necessary for a use case, and properly implement themes through the underlying shad cn ui components.

When styling, ensure buttons and clickable items have pointer-click on them (don't by default).

Always follow a set theme style and ensure it is tuned to the user's liking.

## Toasts

You should always use toasts to display results to the user, such as confirmations, results, errors, etc.

Use the shad cn Sonner component as the toaster. For example:

```
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
export function SonnerDemo() {
  return (
    <Button
      variant="outline"
      onClick={() =>
        toast("Event has been created", {
          description: "Sunday, December 03, 2023 at 9:00 AM",
          action: {
            label: "Undo",
            onClick: () => console.log("Undo"),
          },
        })
      }
    >
      Show Toast
    </Button>
  )
}
```

Remember to import { toast } from "sonner". Usage: `toast("Event has been created.")`

## Dialogs

Always ensure your larger dialogs have a scroll in its content to ensure that its content fits the screen size. Make sure that the content is not cut off from the screen.

Ideally, instead of using a new page, use a Dialog instead. 

# Using the Convex backend

You will be implementing the convex backend. Follow your knowledge of convex and the documentation to implement the backend.

## The Convex Schema

You must correctly follow the convex schema implementation.

The schema is defined in `src/convex/schema.ts`.

Do not include the `_id` and `_creationTime` fields in your queries (it is included by default for each table).
Do not index `_creationTime` as it is indexed for you. Never have duplicate indexes.


## Convex Actions: Using CRUD operations

When running anything that involves external connections, you must use a convex action with "use node" at the top of the file.

You cannot have queries or mutations in the same file as a "use node" action file. Thus, you must use pre-built queries and mutations in other files.

You can also use the pre-installed internal crud functions for the database:

```ts
// in convex/users.ts
import { crud } from "convex-helpers/server/crud";
import schema from "./schema.ts";

export const { create, read, update, destroy } = crud(schema, "users");

// in some file, in an action:
const user = await ctx.runQuery(internal.users.read, { id: userId });

await ctx.runMutation(internal.users.update, {
  id: userId,
  patch: {
    status: "inactive",
  },
});
```


## Common Convex Mistakes To Avoid

When using convex, make sure:
- Document IDs are referenced as `_id` field, not `id`.
- Document ID types are referenced as `Id<"TableName">`, not `string`.
- Document object types are referenced as `Doc<"TableName">`.
- Keep schemaValidation to false in the schema file.
- You must correctly type your code so that it passes the type checker.
- You must handle null / undefined cases of your convex queries for both frontend and backend, or else it will throw an error that your data could be null or undefined.
- Always use the `@/folder` path, with `@/convex/folder/file.ts` syntax for importing convex files.
- This includes importing generated files like `@/convex/_generated/server`, `@/convex/_generated/api`
- Remember to import functions like useQuery, useMutation, useAction, etc. from `convex/react`
- NEVER have return type validators.
