# Family Chat Hub

Family Chat Hub (`private-hub`) is one private hub for a family: two AIs, a
shared messenger with real voice and video calls, a contacts roster, and a
Control Room for the device settings that make it behave like an app. Black background, white text, no colour anywhere —
that is the whole theme, on purpose.

Everyone who gets in lands in the same family, and only that family's messages
are visible to them. Sign-in is guests-only for now: no password, no email
form, no invite code — open the hub and it quietly takes an anonymous account,
then asks the one question a hub actually needs, what to call you. The family
password is switched off rather than gone; see **Getting in**.

There is also an account of the hub's own — **a name and a password**, hashed and
stored in this hub's database, signed in with this deployment's own keys and
nothing else: no email, no code, no service, and it works with the machine
offline. “I already have an account” on the sign-in screen is it. See
**Getting in** and `bun run test:auth`.

## What's in it

| Page          | Route            | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Browser       | `/browser`       | **The front door, and the hub's own way of finding things.** No redirects and no third-party search page: the deployment fetches the page, parses it into a document and hands the app the title, the text and the links, so every link opens here. A question is answered by the hub's own search — a real web index when the family has a key for one, and without a key the open sources (Wikipedia, Hacker News, Stack Overflow, live news feeds, Wikimedia Commons, the Internet Archive, OpenStreetMap, Open Library and the npm registry) — with nine categories, four listings, four windows, narrowing to one site or one phrase or one file kind, ten shelves to point a query at, a toolbox (crawl a site, watch a page, probe a server, read the best pages properly, survey several shelves at once) and find-on-page. See **The browser, and what is in its boxes**. |
| Signing in    | `/auth`          | Guests-only by default: no password, no email form, just a name — or an account the hub keeps itself (name and password, no service involved). The family password is one switch away — see **Getting in**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| AI Assistant  | `/assistant`     | Ask, or just talk. It looks things up, runs code, opens pages, sets reminders and timers, passes messages to the family, reads the whole `[LIVE]` board back to you when you ask, gives you a rundown of the day and everything coming up, and speaks up on its own when you go quiet.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| AI Builder    | `/builder`       | Where an app is asked for, built, watched, run and saved, in five numbered boxes that read top to bottom as one chain: **1** the **AI app builder / prompt studio** (the one request box, and the agent behind it: ask for an app, then keep asking — every later request is a change to the app on the bench, answered in the box's own thread, with templates, file attachments and model settings), **2** the **Build Code Log** (the live terminal of every step, naming the app it is building and linking to it), **3** the **Preview & Test Sandbox** (two jobs in one box, with a switch: **Apps it made** — run it, device view, inspector, full screen — and **This app — its mirror**, a copy of this whole hub on a machine of its own where a change to the hub itself is written, typechecked and built before anybody carries it in), **4** **Saved Projects** (where every build waits first — run it, change it, edit its files — until Publish to Home Screen), and **5** **App icons**, the home screen the chain ends at. This is also the App Sandbox and the place this app is changed: both are this page's own boxes, not pages beside it, and `/app-sandbox` and `/this-app` land here. It can also read, run, edit and rebuild this whole project — its own source included. |
| Contacts      | `/family`        | Who is around right now, with one-tap message, voice and video.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Messenger     | `/messenger`     | The family room, plus voice and video calls in the four boxes — a ring on each person's own box to tell them a call is happening, and a call that comes out of the page with you when you leave it, in a box you can drag anywhere.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Control Room  | `/control-room`  | **All the settings, and only the settings.** Sound, alerts, screen, permissions, connections (including the **VPN** switch), privacy and call settings, the eight voices (eight women, eight accents, none of them British) with the four sliders that change how she says it, and every AI system the server can reach. Everything the hub truly owns is an on/off switch beside its row, and each row carries a **Where this lives** note picked for the device you are holding — the exact screen behind that setting, and the address to paste where one exists. Information and downloads live on the Web Portal and the Offline Brain instead, so nothing is written twice.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Web Portal    | `/web-portal`    | **All the information.** What this thing actually is — a website, not an app-store app — plus the address to copy onto another device, the install steps for every browser, what is inside each page, and what every button does. `/get-app` still redirects here.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Offline Brain | `/offline-brain` | Your Proton VPN link at the very top, the hub's own backup, and the whole offline AI coding system — every model, runtime, reasoning framework, coding agent and tool, each with its own download, a **Download everything** bundle for each category, and a per-platform ready zip that carries the whole package — **this app itself, whole**, and the Freebuff reference source beside it — next to an installer written in that platform's own language.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Local Brain   | `/local-brain`   | The control surface for **the system running on your own machine**. Pair it once with the local brain's address and pairing token, and this page becomes a window onto that brain: its memory, its tools, the connectors and keys, the model servers answering on loopback, its self-diagnostics, and a chat that thinks on your own hardware. It needs the hub's database for nothing, so it still opens when Convex does not.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| The companion | every page       | The little box in the corner. Same brain, memory and tools as the AI Assistant, but living on every page at once: it is told what is on your screen, it answers in a small pop-up you can type back into, and with hands-free on it keeps listening wherever you go — see **The companion in the corner**. Spelling is not its job: that happens in the field you are typing in — see **Spelling, at the word**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| [LIVE]        | `/live`          | Mission control: one wall of same-size boxes, every one fetched by the server itself and drawn by the hub's own code rather than embedded pages — weather and soil, mountain snow over eight ranges, active NWS alerts, air quality, drought and river gauges, Colorado hay and alfalfa prices by region, cattle, horse, tack and equipment auctions across the state, ranch and farm store sales, mapped wildfires, FEMA declarations, the day's earthquakes, energy, metals, farm, market and economic prices, the grid's inputs, aircraft overhead, the ISS and space weather, and Colorado plus world headlines. It refreshes on a timer, and a real 24/7 HFGCS (Emergency Action Message) rebroadcast starts muted. It carries a box for your own calendar's next entries, and the AI Assistant reads the whole board — or the day ahead — back on request: say "what's on the live board", or "brief me". Each morning it also writes its dated sales onto the calendar and leaves the day's watch card there.                                                                                                                                                                                                                                                                                   |

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

A page asked to talk to a backend beside it checks that one is there first, and
falls back to the address this run was configured with when none is. A backend is
a process — killed, crashed, or never started leaves the same silence — and
silence is the one failure with nothing on screen to explain it, so the check is
what keeps a page usable when the local half of the pair is gone.

`bun run dev:web` is Vite on its own, for when the backend is already running
somewhere else.

### Getting in

**Guests-only for now.** There is no password to type, no email form and no
invite code: opening the hub takes an anonymous account behind the scenes and
asks one question, what to call you — a name is what puts you on the roster and
into the messenger.

**Or sign in to an account the hub keeps itself.** A name and a password
(`src/convex/auth.ts`), hashed with scrypt and stored in this hub's own
database, with sessions signed by this deployment's own keys. No email is sent
and no service is called — it is a sign-in that belongs to the deployment it
signs you in to, and it works on a hub with no network. It is offered on
`/auth` as “I already have an account”; `bun run test:auth` walks it end to end
against a backend of its own.

The family password is not gone, only switched off. It is one switch, in one
file: `GUESTS_ONLY` in `src/convex/guard.ts`. `hubPassword()` in the same file
is the single answer to "is there a password?" — the sign-in screens, the
server guards and the device rules all ask it, so the hub cannot end up
half-open, one screen asking and the server not.

Whether a **device** may use the hub is one rule as well, and it is written in
one file — `src/convex/device_rule.ts` — because the server and the screen must
give the same answer. Two copies of that rule would leave a signed-in person at
a door the hub had already stopped asking about. A `pending` device is waiting
for the family password and nothing else, so on a guests-only hub it stands open
and the signed-in account walks straight in; a `revoked` device never opens by
itself on either side — that one is the owner's decision, and only the owner can
undo it.

To bring the password back, set it once on the deployment and then flip the
switch:

```bash
bunx convex env set HUB_PASSWORD the-password-you-share
```

```ts
// src/convex/guard.ts
export const GUESTS_ONLY = false;
```

That is the whole of it — no screen edit and no route change. Everything below
describes the password as it behaves when it is switched back on.

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
- **Getting in** — `HUB_PASSWORD`, read only when the family password is switched back on (above).
- **Auth** — `JWKS`, `JWT_PRIVATE_KEY`, `SITE_URL`, `VLY_CONVEX_AUTH_ISSUER`.
- Optional: `BRAVE_API_KEY`, `TAVILY_API_KEY` or `EXA_API_KEY` for a full web
  index — **the browser's All search asks whichever one is set** (Brave first,
  then Tavily, then Exa), and Exa's is the semantic one that returns the
  passages as well as the addresses. **Without one there is still a live
  internet** — search falls back to a keyless news
  feed (Bing, then Google News), Hacker News, Stack Overflow and Wikipedia —
  plus everything the browser asks on its own: Wikimedia Commons, the Internet
  Archive, OpenStreetMap, Open Library and the npm registry.
  Current, but thinner than a real index. Also `AI_REVIEW=off` to skip the
  self-review pass, and `AI_CODE_RUNNER=off` to stop either agent running code.
- **The workshop** — `DAYTONA_API_KEY` connects a real machine for the builder
  to code on (see below). Optional: `DAYTONA_SERVER_URL` for a self-hosted or
  non-default Daytona, `DAYTONA_TOOLBOX_URL` when the in-sandbox API is not
  at its usual address, and `DAYTONA_SNAPSHOT` to pick a different image.

### The workshop

The builder writes code in this app, but this app runs on Convex, which has no
filesystem and no shell — so the bench (`workspace.ts`) is a filesystem made out
of documents, and it cannot _run_ anything. The workshop closes that gap: a real
Linux sandbox out on [Daytona](https://www.daytona.io), with a real shell, a real
filesystem and the network, which the builder's code actually executes on.

- **Add `DAYTONA_API_KEY`** (a key from app.daytona.io) and it is live. **Remove
  it and nothing changes** — every caller falls back to the public code runner
  and to the snapshot, exactly as before. No tool ever fails because the
  workshop is missing.
- **One sandbox per hub**, made on first use and reused after that, labelled so
  it can be found again — and found _only_ by that name or label, so a
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
  endpoints the ordinary way _as well as_ being accepted as JSON inside a reply.
  Models that answer with a real tool call — Groq's `gpt-oss` pair is the one
  that used to fail — now work instead of returning `tool_use_failed`. One tool
  runs per turn, so a model that asks for two in the same breath is told so and
  does the second next turn.
- **Auto refresh.** The Control Room's AI systems card asks every system whether
  it is _still answering_ — a real call, because a key that exists proves
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

### The companion in the corner

The little box that follows you around every page of the hub. It is the AI
Assistant's own brain — the same memory, the same tools, the same actions —
living in the corner instead of on a page, and it exists to be there wherever you
already are.

- **It knows what you are looking at.** The page it is standing on writes down a
  short description of itself — the route, the heading, the field you are typing
  in and what is in it, anything you have selected — and that description travels
  with each turn, so "fix this", "how much is that", "make it shorter" mean the
  thing in front of you. It is a digest, not a picture: nothing in this hub
  captures your screen, no field that is not prose is ever read (a password box
  is looked away from entirely), every part of it is capped, and it is only ever
  sent as part of a turn. It lives in `src/lib/companion/screen.ts`.
- **It talks back.** Type in the box, or press the microphone. Answers, links and
  hints all arrive in the same little column, and the box pops itself open when
  there is something new in it.
- **Hands-free, everywhere.** Switch the microphone on — in the box or in the
  Control Room — and it stays listening as you move between pages, so you can
  talk to it anywhere in the hub. It shuts itself while the model is thinking or
  while the answer is being read out, so it never answers its own voice.
- **The lines you say most often are answered on the device**: "stop
  listening" and "open the calendar" need no model, no key and no connection.
- **It never says anything about your spelling.** That used to be a note in this
  box — "two words to fix" — and it was the wrong place for it: a spelling is
  dealt with at the word, in the field, and nothing about it is written into a
  conversation. See **Spelling, at the word** below.
- **It speaks up on its own only for good reasons**: a timer that has finished, a
  reminder that has come due, and — no more than every few minutes — one line
  about the page you have just opened. Do not disturb silences all of it, and
  the model is explicitly allowed to answer with nothing.
- **Three switches in the Control Room**: _Hands-free microphone_, _Offer hints
  as I work_ and _Read the little box out loud_. Silence mutes the last one
  exactly as it mutes the assistant's own voice.

It is mounted once, in the signed-in shell (`src/pages/AppShell.tsx`), so moving
between tabs never unmounts it: one conversation, one shared microphone, one
place the page describes itself. The notes it keeps on the device — alerts and
plain acknowledgements, which need no model at all — live in
`src/lib/companion/notes.ts`.

### Spelling, at the word

Spelling is not a message anywhere — and it is not a feature of this app either.
It is the browser's own checker, in the field being typed in: the words are marked
as they are typed, the correction is a right-click (or a press, on a phone) away,
autocorrect does what it does everywhere else, and a name that is not in the
dictionary is added to it once, for the whole machine. Nothing about spelling is
written into a conversation, and nothing is drawn over the page.

- **Which fields are spelled is the one thing this app decides**, and it is one
  rule in one place (`src/lib/spellcheck.ts`). Prose is the default: a
  `<textarea>`, an `<input>` of no type or `text`/`search`, anything
  contenteditable. A field that holds a value rather than sentences — an address
  bar, an API key, a file path, a git ref, a code editor — says so once, with
  `data-spell="off"`, and the UI primitives turn that into the input's own
  `spellCheck`. So a field added tomorrow is spelled without anybody remembering
  to ask for it.
- **The same marker is read in two more places.** The digest the companion is
  told about (`src/lib/companion/screen.ts`) refuses those fields, so a token or a
  repository name in a box is not handed to a model either — one marker, read by
  both, and no second list of "fields to look away from" to drift out of step.
- **There is no checker of this app's own, and there used to be.** Hunspell in
  `nspell`, half a megabyte of dictionary in `public/spell/`, a `SpellCheckLayer`
  that mirrored a field over itself to mark the words, a count in the corner of the
  box being typed in, and a menu of suggestions under each word: three modules and
  a dependency to underline fewer fields than the browser already underlined,
  announcing itself from the corner of the box somebody was writing in. All of it
  is gone. What remains is the browser, doing in these fields exactly what it does
  in every other text box on the computer.
- **`index.html` is what starts it** before any field is touched: `lang="en"`
  picks the dictionary and `spellcheck="true"` turns checking on for the page.

### The browser, and what is in its boxes

`/browser` is the front door: `/`, and every address the app does not know,
lands here. It is a browser of the hub's own kind — a page rendered inside
another app cannot be a real cross-origin browser, because most of the web
refuses to be framed, so the deployment fetches the page (`src/convex/browser.ts`),
parses it into a document and hands the app the title, the text and the links.
There is no JavaScript engine, which is why it is safe and why some pages read
as their text — the reader says so on the page rather than pretending.

A question typed into the bar is answered by the hub itself: `src/convex/search.ts`
asks a real web index when the family has a key for one (Brave, then Tavily) and
otherwise the open sources — Wikipedia, Hacker News, Stack Overflow, live news
feeds, Wikimedia Commons, the Internet Archive, OpenStreetMap, Open Library and
the npm registry. Nine categories (All search, Images, Shopping, Short videos,
Videos, News, Maps, More, Tools), four listings and four windows decide what is
asked and how the rows come back. A date, a size, a length or a price is shown
only where that source gave one.

**Narrowing, and the shelves.** Under the bar, a search can be narrowed to one
site, one phrase, a set of words to leave out and one kind of file. Every filter
is applied to the rows the hub already fetched, and a filter that matched
nothing is *reported* rather than obeyed — a narrowing never answers by emptying
the page. Where a web index is connected the operators go to it by name
(`site:`, a quoted phrase, `-word`, `filetype:`). **More** opens the shelves: the
same words asked of Wikipedia, Open Library, the Internet Archive's scanned
books, sound, datasets and software, Stack Overflow, Hacker News or npm, one
source at a time — pointing a search at a shelf means nothing else answers with
it.

**The toolbox**, behind **Tools**, is the part of finding things that a result
list does not do:

- **Crawl bot** — walks a site link by link: the page you are on, then what it
  links to. Depth 0–3, up to 16 pages, your host or anywhere, fetched four at a
  time with a nine-second leash on each page and a 45-second budget for the walk
  (`src/convex/crawl.ts`). It looks at pages, not pictures or scripts, and hands
  back every page's status, size, words, time and the link it was found on, the
  hosts it touched, and how many links it left unfollowed. The map can be copied
  or saved.
- **Perch bot** — a watch list of pages, kept on your device. A perch is a real
  read of the page with a fingerprint of what it said: checking again is what
turns "it changed" into a fact, and it says how big the change was (`812 words`
  · _was 940_). Nothing is stored in the hub's database and nothing is watched
  on a schedule.
- **Probe the server** — what the address answers before anybody reads the page:
  status, timing, the headers it sent, what the document declares about itself,
  and whether it keeps a `robots.txt` and a `sitemap.xml` for the bots that come
  by.
- **Read it properly** — asks the hub's own search, opens the five best pages it
  returns, and keeps the lines that carry your words. No model is involved and
  nothing is summarised: the lines are the pages' own sentences, so the brief can
  be checked. It can be copied or saved.
- **Survey bot** — one question asked of several categories in turn, counting
  each shelf's answer as it arrives, so you can see where the material actually
  was (and which shelf came back empty).

**On the page itself**: find-on-page (the words are marked where they fall, with
a count and arrows to walk them), the reader's Live view for sites that allow
being framed, the bookmark and the download (both here on every device), copy
link and copy page text, and a right-click menu with the standard actions. Open
tabs, the questions you have already asked (the last 24, with their
refinements — press one to ask it again) and the perch list live in this
browser's own storage rather than in the hub's database.

**The bots keep the reader's own rules**: a signed-in session, an unlocked hub,
and nothing on the deployment's own network or the private ranges — a crawler
that could be pointed at `169.254.169.254` would be the same hole a reader
would. Nothing in these boxes fetches anything until it is pressed. A real web
index is the one thing the browser cannot supply itself: set `BRAVE_API_KEY` (or
`TAVILY_API_KEY`) on the deployment and **All search** becomes a full index
instead of the open sources; everything else here needs no key. The rules are
walked by `bun scripts/browser-check.ts`.

### The Control Room

Every row in the Control Room either does the thing itself or names where the
real switch lives:

- **Where this lives** — an inline note picked for the device in front of you
  (from `src/lib/settings-locations.ts`): the taps to reach the browser's or the
  phone's own setting, and the address to paste where one exists. Routes match
  the platform _and_ the browser, so an iPhone is never told to open the Chrome
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
- **Voice** — eight women, eight accents and not one of them British: Ava
  (American), Scarlett (Southern), Colette (French), Giulia (Italian), Valentina
  (Spanish), Isabela (Brazilian), Sasha (Australian) and Priya (Indian). _Hear
  it_ says her own line before anything changes, and _Use_ makes her the voice on
  every device you sign in on. Underneath the eight are four sliders — speed,
  warmth, volume and expressiveness — that move the real speaker everywhere she
  talks: the assistant's answers, the little box in the corner, and the alerts
  she says out loud on her own. A reply is not read as one long utterance: it is
  split where a person would breathe and each line gets its own small movement,
  so a question lifts, a joke quickens and nothing about the words changes.
  The roster is `src/lib/voices.ts`, imported by `src/convex/voice.ts` as well,
  so the page and the server cannot disagree about which voices exist. Every
  voice the British Isles gives a device is refused twice over — by language tag
  (`en-GB`, `en-IE`) and by name (Daniel, Kate, Serena, Fiona, Moira, Hazel,
  Sonia, Susan and the rest) — and each row says honestly what this device
  really has: that accent, a slower or lower stand-in, or nothing at all
  (`bun run test:voice` walks all of it). The Southern drawl is always a
  stand-in, because no operating system tags one: she is real, the accent is
  borrowed.
- **Voice** — two engines, and one switch between them. **Studio voice** is a
  real text-to-speech model reached with a key this hub already has: OpenRouter's
  speech route (a model that takes a *delivery instruction*, so the persona is
  described to it in full — mature, warm, smoky, quick rather than sweet) or
  Groq's Orpheus (free on the low tier, 200 characters a request). **Test it**
  says one line out loud through exactly the call a reply goes through, and the
  provider's own words are shown when it fails. With no key, with the switch off,
  or with the connection gone, the eight accents below speak instead — and the
  change happens mid-reply rather than the answer going silent, which is also
  what keeps the assistant working offline. The words being spoken are sent to
  the provider while the studio voice is on, so an answer said aloud over the
  internet leaves the hub while a silent one does not; nothing is stored either
  side, and the key is only ever read on the deployment. `bun run test:voice`
  walks the catalog, the request builder, the clipping to each provider's limit
  and the base64 trip the audio takes, and `bunx convex run speech:probe` asks
  every keyed provider to speak a line and reports what came back.
- **Sign-ins & people** — everyone who has come in, written down as it happens
  (`src/convex/people.ts`, the `signIns` table): who, on what, what happened and
  when, with a **Delete** on each line, a **Clear all sign-ins** that clears a
  list of any length (bounded batches, one call each, looping until nothing is
  left), and a **Clear their sign-ins** on every account for that account's own
  history — drawn even before anything has landed for it. Clearing forgets the
  comings and goings only: no account, device, session or security-log row is
  touched, so everyone can sign in again. The same box saves what a person has
  written here, removes it, or removes the person whole, and it is open to
  everyone who is in, not only the owner.

### Backup

The Offline Brain's Backup card hands the whole hub back to you as a download.
Every file is built in the browser from what the hub already holds — nothing is
uploaded to make one, and the hub keeps running exactly as it is afterwards.

| Download                           | What it is                                                                                                                                                |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Everything** (`.zip`)            | The whole app as it now stands, a Dockerfile that runs it on your own computer, and `data/hub-data.json` — a copy of everything the hub has written down. |
| **The app, ready to run** (`.zip`) | The same current app and Docker files without the data.                                                                                                   |
| **The code, readable** (`.txt`)    | Every file the app is made of, one after another, in one text file.                                                                                       |
| **The data alone** (`.json`)       | Messages, calendar, shopping list, memories, reminders, the Builder's files, and links to attachments.                                                    |
| **The Linux steps** (`.txt`)       | The install guide with the Dockerfile, compose file and nginx config it mentions.                                                                         |

The pieces:

- `src/convex/backup.ts` — the app's own copy and the family's rows, read for
  the browser to pack. `sourcePage` hands the app's source over through a
  funnel, one capped page at a time; `manifest` and `changed` say how much of it
  there is and which files the **AI Builder** has changed since it was taken;
  `data` reads the family's rows table by table. All are gated exactly like the
  rest of the hub — signed in, past the family password — and every table is
  read with a stated cap, so a backup says what it left out instead of
  pretending to be complete.

  The merge is what lets the hub fix itself, and it has one rule
  (`carryBenchFiles`): the builder keeps a working copy of this project on its
  bench (`workspace.ts`), and a working file rides into a download only while it
  is _newer_ than the app's own copy. Work written before that copy is older
  than the app itself, so it never overwrites newer code — `superseded` counts
  it rather than hiding it, and the Control Room's workshop can still export the
  whole bench if it is wanted. `patched` names the files that did ride on top.
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

**In this repository it is one command, and it does not need Docker at all.**
`bun run own` runs Convex's own backend as a program on this machine — the
database, the schema, every function, the signing keys and the family password —
and serves the hub against it at <http://localhost:8080>. No account, no card,
and nothing outside the machine to pause it; `bun run self-host` is the same
thing in containers, for a server that stays on. `self-hosting/README.md` is the
runbook, and it is the answer to a hub that has gone quiet because somebody
else's deployment hit a usage limit.

**And when the machine has nothing on it at all, one folder carries everything.**
`bun run bundle` writes `dist-independent/family-chat-hub-independent`: the
project with `node_modules` already installed, the `bun` it was built with, and
the Convex backend program, all inside one folder whose `run.sh` is the only
command anybody needs. It runs with no package manager, no runtime installed and
no network at all — measured with every outbound request blackholed: the backend
starts from the program in the folder, the whole schema and every function are
pushed into it, and the page is served from the packages inside it. Copy it to a
stick and it is the hub. `self-hosting/README.md` → **One folder that needs
nothing** has the detail.

**It costs nothing to run this way, and nothing here has a paid default.**
Convex is open source and runs on your machine with no account; sign-in is built
in; both AI boxes answer with no key at all; calls run directly between the two
devices; the builder's code runs on a public runner; the hub needs no domain
name of its own. `self-hosting/README.md` has the table. The one thing to know
is that the free public AI systems are shared — a reply can wait in a queue —
and the free answer that is never queued is a model on your own machine, which
the hub already knows how to talk to.

A downloaded copy talks to a Convex database, and that database can be someone
else's. The archive carries the way out of that, twice over, because the copy
contains this whole project:

- **Nothing but Bun** — `cd app && bun run own`, the same one command as above,
  with `app/self-hosting/README.md` as its runbook.
- **Docker** — `app/self-host/` holds the official **open-source Convex backend**
  (the same code the hosted service runs) and a one-command setup, so the copy
  you own can run its own database on your own machine — no hosted service, and
  nothing outside the machine to switch off.

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
  It is only ever needed to _edit_ the project inside Freebuff, never to run it.
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

Set `VITE_CONVEX_URL` to your new Convex URL on the Vercel project _before_ the
first build — Vite bakes environment variables in at build time.

### Calls

Voice and video are our own: our own four-portal video stage, our own Convex
backend carrying the ring and the handshake, and our own WebRTC engine. Media
is encrypted end to end (DTLS-SRTP), and no third-party widget is embedded —
the four boxes are ours. Calls need https or localhost, and two devices to test
properly.

**A call belongs to the shell, not to a page.** On the Messenger a video call
fills the room's own four portals, beside the chat. Walk to any other tab — the
calendar, the assistant, the browser — and the same live call comes out of the
page into a small box that follows you, and that can be dragged anywhere it is
out of the way, folded down to its title bar, or put back among the portals with
one button. Nothing is dropped by leaving a page: **Hang up** is the only thing
that ends a call, and closing the ring panel turns down a *ring* rather than a
call. A call the server still holds for an account whose tab is gone — a closed
tab, a killed browser, or the same account open on a second device — is offered
in the Messenger as one line, *you are still on a call: get back on, or leave
it*, instead of a panel over whatever page is open; and calls only ever start
where they are meant to, from the Messenger.

**Ringing is how somebody is told a call is happening.** Every person's portal in
the room carries a bell: pressing it rings that person directly — their hub
rings, buzzes and raises a system notification, and the call is answered in the
panel wherever they are in the app, so a call is never something they have to
notice by themselves. Once a call is up, the Messenger header's call buttons
become one **Ring**, because a second call would drop the first: the same list
now rings people *into* the call that is already going on (`calls.invite`) —
capped at the four the grid draws, leaving anybody already on it untouched, and
asking anybody who stepped out or turned it down back. Whoever is being rung has
a seat in the grid that says so, so a caller can always see that the ring went
somewhere, and an empty seat is itself a way to ring the rest in. Every ring is
said out loud, by name ("Ringing Ana…"), because a button that appears to do
nothing is the one thing a caller cannot tell from a broken hub.

**Everyone on a call can put their screen on it**, from their own seat in the
grid or from the box's controls. A screen is a third track rather than a third
call: it is captured with `getDisplayMedia`, carried exactly like the camera
(through the relay, or straight between the devices), and labelled over the same
channel as the handshake so it opens in **a portal of its own** — draggable,
closable, and fillable to the whole screen — while every face keeps its seat and
the conversation carries on underneath. `bun run test:calls` walks what a tab may
show, where a call is drawn and where a box may sit.

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
  travel with it. In Google Calendar: _Settings → Import & export → Import_, pick
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

|                                 | the web version               | the local version       |
| ------------------------------- | ----------------------------- | ----------------------- |
| Where a copy opens              | `/assistant`                  | `/local-brain`          |
| Backend when none is configured | (none — the host supplies it) | `http://127.0.0.1:3210` |

Everything else is the same app: same seven tabs, same order, same routes, same
pages. Both still ask for a name, because that screen is also the step that puts
an account on the roster — a local copy that skipped it would be a hub whose
family has no names in it. (With the family password switched back on described
under **Getting in**, both ask for that as well.)

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

## Phones, tablets, desktops

One app on every screen. The rules it is built to, so they are not relearned
one page at a time:

- **Nothing has a minimum width.** The sign-in card used to be at least 350px
  wide, which is wider than a 320px phone, so the whole page scrolled sideways.
  Anything that must be a certain size is `max-w-…`, never `min-w-…`.
- **Side panels stack; they do not squeeze.** A panel that sits beside the page
  on a desktop — the browser's saved pages and downloads — goes under the page
  at full width below 1024px, where the `aside` rules in `src/index.css` cap
  its height and give it a scroll of its own.
- **Rows wrap.** Four controls whose labels cannot break are wider than a small
  phone, so the call controls wrap onto a second line instead of pushing the
  page sideways.
- **Grids keep a floor and scroll.** The video room's portals are at least
  9rem tall with the grid itself scrolling, so on a short pane the "Get on"
  button is reachable rather than cut off.
- **A call outlives the page it started on.** The call's boxes float over every
  page and are dragged rather than laid out, and a ring is the only thing that
  ever takes the screen: the calendar, the assistant and the browser all stay
  usable while you are on a call, and a shared screen sits in a portal of its
  own rather than over somebody's face.
- **What a phone puts over its own screen is respected.** `viewport-fit=cover`
  in `index.html` plus `env(safe-area-inset-*)` padding on the shell keeps the
  nav clear of the home indicator and, held sideways, the camera housing.
- **Where a page can sit in a narrow frame on a wide screen, the layout is
  measured in containers rather than the window** (`@container` with `@4xl:` in
  the chat, builder and messenger boxes, and the same idea in `SplitScreen`).

## Scripts

| Command                  |                                                                                                                                                                                                                                                                                    |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run dev`            | the whole hub: the Convex backend and the dev server                                                                                                                                                                                                                               |
| `bun run dev:web`        | the dev server alone, when the backend is already up                                                                                                                                                                                                                               |
| `bun run own`            | the hub on this machine's **own** backend — no account, no Docker (see `self-hosting/`)                                                                                                                                                                                            |
| `bun run self-host`      | the same, in containers, for a server that stays on                                                                                                                                                                                                                                |
| `bun run bundle`         | one folder that runs the hub with no network, no package manager and no installed runtime (`dist-independent/`)                                                                                                                                                                    |
| `bun run restore`        | put a data snapshot into the backend on this machine (`bun run restore -- backups/…zip`)                                                                                                                                                                                           |
| `bun run build`          | typecheck and build the **web** version                                                                                                                                                                                                                                            |
| `bun run build:local`    | build the **local** version (`VITE_PROFILE=local`)                                                                                                                                                                                                                                 |
| `bun run lint`           | eslint                                                                                                                                                                                                                                                                             |
| `bun run icons`          | regenerates the app icons in `public/icons`                                                                                                                                                                                                                                        |
| `bun run snapshot:self`  | repacks this app's own source into `src/convex/self_source.ts`                                                                                                                                                                                                                     |
| `bun run snapshot:app`   | packs the same whole app into the archive the offline brain ships — `public/offline-brain/source/this-app-source.zip`                                                                                                                                                              |
| `bun run verify:self`    | checks that snapshot is current, and that the self-read and self-patch helpers behave                                                                                                                                                                                              |
| `bun run test:hub`       | walks the bridge the crew's Build press goes through — the hub's own models, reached as `ai.complete` — through every outcome it can produce                                                                                                                                       |
| `bun run test:access`    | walks the device rule status by status, and checks the guard and the gate both ask that one rule rather than keeping a copy of it                                                                                                                                                  |
| `bun run test:this-app`  | walks what changing this app does to the hub's own files: the diff, the patch, which files a change carries — and then reads the wiring out of the source, from the turn's `focus` to the mirror being a box of the AI Builder page rather than a page beside it                   |
| `bun run test:calls`     | walks the call surfaces — what a tab may show (a call it joined, or a ring at it, never a membership a closed tab left behind), who a ring reaches and that ringing again does not end the call you are on, where a call is drawn (the Messenger's portals, the movable box, or the panel), where a box is allowed to sit — and reads the wiring behind them out of the source                                                                                                                                                                                       |
| `bun run test:voice`     | walks the eight voices: the accents found on invented devices, the British ones refused by tag and by name, the delivery clamps, the planner that decides how a sentence is said — and that the page's roster and the server's are the same list                                                                                              |
| `bun run test:browser`   | walks the browser's search and its bots — the narrowing, one-address-per-page, and the wiring behind the Tools and More boxes                                                                                                                                                                                                     |
| `bun run test:companion` | walks the little box in the corner: the notes store for real — deduplication, the caps, links that are refused, reading and dismissing — then the wiring that holds it together, read out of the source, including that spelling is nowhere in it and is done in the field instead |

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

And the offline brain carries this app back the other way. `bun run snapshot:app`
(`scripts/pack-this-app.mjs`) packs every file this snapshot covers — the same
walk, so the two can never disagree about what "the whole app" means — into
`public/offline-brain/source/this-app-source.zip`, with the snapshot's two
generated halves written in so the unpacked copy types and builds as it stands.
`scripts/capture-this-app.sh` puts it at `source/app` on the drive, and every
download the hub offers — the one-file installer, each platform build, each
category archive, the local and everything editions, and the Control Room's
Tools & downloads — carries it, because they are all built from the same list in
`src/lib/offline-brain-files.ts`.

## The AI Builder page

`/builder` is where an app is asked for, built, watched, run and saved, in
**five boxes on one page** — one per thing a person actually wants to do, and
in the order the work happens: **ask, watch, run, keep, publish**. A numbered
strip at the top says so, and the steps between the boxes are links to the next
one, so the chain is visible and navigable rather than only true.

| Box                                        | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **1 · AI app builder (prompt studio)**     | The one request box, and the agent it starts. A brief in, **Generate App**, and what the crew makes waits in Saved Projects as a draft — it does not appear among the icons until somebody publishes it there — and it stays on the bench, so every request after it reads the row at the top of the box (_working on “…”_) and is sent as **Send Change**: the app's files are put back on the bench first, the brief carries what it is and what its last build did, and the work lands on that app where it stands instead of arriving as a second app beside it. Each request and its reply are written into the box's own thread — what the Director made of it, which files changed, whether the build passed — in the same `messages` record the Assistant page uses, so the conversation survives a reload. If the app it just changed is the one in the Preview frame, that frame is reloaded so the change is seen where you were already watching. A row of buttons points it at another app, or at a fresh one, at any time. **Templates** fill the box with briefs known to build; **Attach Files** reads text files here and sends them with the brief as context; **Model Settings** opens the BYOK hub. **Delete conversation** empties the box's thread — the thread alone, so the app on the bench, its files and the Build Code Log stay exactly as they are. Assistant requests land here too. |
| **2 · Build Code Log**                     | The live terminal: every line the crew writes with `logAgent`, tagged by agent, and everything the sandbox printed while building what they wrote — nothing replayed. The header names the app those lines are about (the one on the bench, with its build state) and links straight to it in the preview. **Auto-Scroll**, **Clear Logs** (hides the view, not the record), **Export Logs**, **Pause** to freeze the view, and **Stop** to end the run itself, through the controller the prompt box started it with.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **3 · Preview & Test Sandbox**             | The app running for real in a frame with `allow-scripts` and without `allow-same-origin`, so it behaves as in a browser while the hub's session, storage and database stay out of reach. **Mobile/Desktop** device view (390 px or the whole box), **Refresh**, **Inspect** — a real inspector folded into the document before it runs, since an opaque origin cannot be reached from outside — **Full screen**, and the build's own verdict in the header (_builds_, or how many problems) linking back to the log that reported it. An element picked with **Inspect** can be handed to the prompt box above as **Ask for a change**: the app is chosen, the element is in the box, and the page scrolls there.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **4 · Saved Projects (drafts & workshop)** | Where every build lands first, and where the unfinished apps live. Each draft carries **Run** (it, in the Preview box beside it, without publishing it), **Edit Draft** (its files onto the bench below), **Duplicate**, **Publish to Home Screen** and a two-press **Delete**. `Save Draft` keeps the bench's files as a draft, an app moved off the home screen lands back here, and the bench itself has a file tree, a new-file field, an editor and a **Move** — the one edit the editor cannot make by hand, because the entry page and what the build may run are both decided by names.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **5 · App icons** (last)                   | The home screen, and the end of the chain: every **finished** app as one launcher icon — rounded square, small logo, name underneath, the way a phone holds its apps. Pressing one launches it in the preview above; the strip under the grid carries that app's tools: **Launch**, **Export** (a single `.html`, or every file as `.zip`), **Ask for a change** (chooses it in the prompt box), **Move to drafts**, bench, send back, rebuild, rename, duplicate, delete. The `n in Saved Projects` badge beside the counts links up to the drafts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

The prompt studio's continuation is one publish flag: `buildAnApp`
(`src/lib/forge/apps.ts`) takes an `appId`, and with one it updates that app
where it stands — its name, its brief, its place in the list and its run count
all survive — instead of publishing a new one beside it. The app it is about is
read from the sandbox itself (`sandbox.mounted`), then from the Preview frame,
and never guessed: `pickTarget`, `benchContext` and `STATIC_APP_RULE` in
`src/lib/forge/agent.ts` are the one place those answers live, they are what the
crew is told about the app, and they are the same words an app sent back from an
icon carries.

The chain is a real one in both directions, not a diagram. Downwards: the
prompt box registers its run (`beginRun`), the log prints the crew's own lines
and stops that same run, the build it ran is the document the preview frame
receives, and the app it published is the row Saved Projects and the home screen
both read. Upwards: an element picked with the preview's inspector is sent as a
`preset` event (`postForge`), which chooses the app it belongs to in the prompt
box, fills the request, focuses it and scrolls the page there; an icon's **Ask
for a change** does the same for the app it belongs to. `#builder-studio`,
`#builder-log`, `#builder-preview`, `#builder-projects` and `#builder-apps` are
what the numbered strip and the steps between the boxes link to.

The ordering is enforced rather than described: `publishFromSandbox` publishes a
build as a **draft** (`onHome: false`) unless its caller says otherwise, so
nothing the crew makes reaches the home screen without a person pressing
**Publish to Home Screen**. Asking for a _new_ app empties the bench first, so
the crew plans a new app rather than a change to the last one, and the app the
bench is holding is written down beside the other forge settings
(`benchAppId`, `src/lib/forge/config.ts`) — without it a reload turned somebody's
project into anonymous files and the next request had no app to change.

Two flags make the two lists. `onHome` (`src/lib/forge/db.ts`) is `false` on a
draft and absent on the home screen; `onTheHomeScreen`/`setAppOnHome`
(`src/lib/forge/apps.ts`) are the only predicate and switch between them. Saved
Projects uses the _sandbox's_ files (`useSandbox`, `engine.read/write/remove`) —
the bench the crew builds on — not the hub's own workspace, where "open this
project" used to promise files that never appeared. The page is long on purpose
and scrolls, each box given a height of its own, and it **is** the App Sandbox:
`/app-sandbox` simply lands here.

The crew thinks with **This hub** by default: the hub's own models, on the
deployment, behind the keys it already holds (`VLY_INTEGRATION_KEY`, plus
anything added in the Keys tab), reached through `ai.complete`. So **Generate
App** works on a fresh browser with nothing pasted anywhere — which is the point
of it. Choosing any other provider in the Control Room's BYOK hub, or pointing it
at a model running on this machine, replaces that pair and is never overridden
by the default.

## Changing this app — the mirror in the sandbox

This is the other half of the AI Builder, and the one job no other box can do:
change **this** app. Both halves are one page — `/builder` — and the box that
holds them is box 3, the **Preview & Test Sandbox**, because that is where both
of them actually happen. It has two targets and a switch to say which is in it:
**Apps it made** — the calculator, the score pad — whose output waits in Saved
Projects until somebody publishes it, and **This app — its mirror**: the thing
the person is looking at, its pages, its styling, its behaviour. Two jobs
wearing one name was exactly what somebody had to guess at, so the switch is the
first thing on the sandbox and each side says which it is. (`/this-app`,
`/change-this-app` and `/app` still land on that page, so nothing that linked to
the old tab is broken; there is no separate tab in the bar.)

What makes the second job safe is that it is never done on the app you are
using. The sandbox holds a **copy**: `DAYTONA_API_KEY` gives the hub a real
Linux machine, `src/convex/sandbox.ts` seeds a replica of this whole project
into it — every file, installs and all — mirrors the builder's bench over it,
and **Build the copy** (or **Check it**, the typecheck-only press for while the
builder is still iterating) runs this project's own `bun run build` there. A
change that breaks the project fails in the copy, and the hub somebody is
looking at never notices. The result is every step's real output plus the exact
list of files in the copy that are no longer the app's own — which is the list a
person carries in.

What does the work is the hub's **own** builder — the agent on the deployment,
not the browser-side crew — because that is the one that can read its own source
(`read_own_code`), lay every file of this project on its bench
(`scaffold_project`), change one in place (`edit_file`) and run the project's
real typecheck and build on the workshop machine (`run_code`, `build_app`). The
mirror's request box sends its turn with `focus: "self"`, which is the one thing
that tells the builder which of its two jobs it is doing; the paragraph that
changes is `SELF_APP_RULE` in `src/convex/ai_prompts.ts`, and it says so in as
many words — including that a request for a genuinely separate app belongs with
the crew above it, which is where a new app is made.

Nothing about this reaches the app anyone is using. The builder writes the
changed files onto its bench, which is a filesystem built out of rows
(`convex/workspace.ts`), and a browser tab cannot save its own source — so the
changed files _are_ the deliverable, and the page is built around saying that
rather than around a spinner that finishes and changes nothing:

- **What changed, and how much.** `api.backup.changed` reads the bench back
  against the shipped snapshot and names the paths that are part of this app and
  no longer match how it shipped — the same merge a backup takes, names only, so
  it can stay live while the AI is still writing.
- **The diff itself.** Each path opens into the real change, computed by
  `src/lib/self-changes.ts` against the app's own shipped copy (`/self-source.json`,
  the twin of the snapshot the backend reads). That diff is deliberately not a
  full LCS — the files here run to thousands of lines and a real diff table
  between two of them is millions of cells, computed in a tab every time a row is
  opened. It is the window around the change instead, clamped when a whole file
  moved, and it always rebuilds both versions, which `bun run test:this-app`
  checks directly.
- **Three ways in, each of them real.** _Push_ writes one commit holding exactly
  these files, built on top of the branch as it stands — the hub's own GitHub
  writer uses `base_tree`, so nothing else in the repository moves, and for an app
  deployed from that repository the commit _is_ the change. _Save_ writes a zip
  with the paths as they belong, for a project edited by hand or by another
  agent. _Copy the whole patch_ gives one unified diff per file, refused rather
  than clamped when a change is too large to apply. And a **backup** — Offline
  Brain or Control Room — carries the change already, because it merges the
  files written _since_ the app's own copy over that copy: a download is the
  current app, and an older working file waiting on the bench can never take
  newer code's place in one.

The page never claims the app is updated: the builder is told not to say it
either, and the check script looks for both.

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
