# SUGAR Browser

A real, local-first desktop browser with an AI assistant named **SUGAR** built
into it. It embeds Chromium — the same engine every modern browser uses — so
pages render as their own design, their scripts run, video and audio play, and
WebRTC works. It is not a website, not a PWA and not a wrapper around one, and it
needs no hosting, no account and no server to run.

SUGAR belongs to the device it is on. Put the folder on a USB stick, plug it into
another machine, and it is the same browser with the same settings, bookmarks,
history and downloads — on whatever drive letter that machine hands out.

## Two ideas, and everything else follows

**1. It is local and portable.** Every setting, bookmark, history entry,
download, cache file and log lives in the browser's *own* folder — a folder it
works out at run time from the executable that is running, never a path somebody
hard-coded. Move it and it keeps working.

**2. SUGAR can actually drive the browser.** You tell it what you want in words;
it turns that into a plan and carries the plan out, showing you each step while
it works. The sentence-to-plan layer is local, so the common commands work with
no network and no AI model. A local model (or, if you choose, a remote one) is an
*upgrade* to the understanding — never a requirement for using the browser.

## Running it

```sh
cd sugar-browser
npm install          # downloads Electron and Chromium, once
npm start            # a normal (installed-style) run
npm run start:portable   # force portable mode
```

The same two builds come out of one source: a normal installer that installs
SUGAR Browser on the machine, and a portable build you copy onto a drive and run
from there.

## Portable mode (§3, §10)

SUGAR Browser decides where to keep its things at startup:

- **Portable** when you pass `--portable`, set `SUGAR_PORTABLE=1`, drop a file
  named `SUGARBrowser.portable` next to the executable, or run the electron
  builder *portable* `.exe` (it tells the app where it was launched from).
- **Otherwise** it uses the machine's per-user application-data folder, which is
  what an ordinary installed browser does.

Either way it never assumes a drive letter. `D:\SUGARBrowser\`, `E:\SUGARBrowser\`
and `/media/USB/SUGARBrowser/` are all handled, because the location is derived
from the running executable, not stored.

## What it keeps, and where (§9)

```
SUGARBrowser/
├── SUGARBrowser.exe
├── BrowserEngine/
├── Resources/
├── AI/
├── Characters/
├── Extensions/
├── Profiles/          the Chromium profile (cookies, local storage, session)
├── Data/              settings.json, bookmarks.json, history.json, downloads.json
├── Downloads/         files, and pages saved by SUGAR
├── Cache/
├── Logs/
├── Settings/          settings.json
└── Updates/           drop a newer build here; SUGAR notices it
```

Writes are atomic (a temporary file is renamed over the real one), so a crash or
a yanked USB stick cannot leave a half-written file behind. The files are plain
JSON — you can open them in a text editor and see exactly what the browser knows.

## Talking to SUGAR (§6, §8)

Open SUGAR with the **SUGAR** button or `Ctrl/Cmd+K`, then type or speak. It
shows each step as it happens, and its face reflects what it is doing — idle,
listening, working, speaking. Try:

| You say | SUGAR does |
| --- | --- |
| `open google` | Opens Google in the current tab |
| `open google and youtube and wikipedia` | Opens all three, one tab each |
| `search for Linux Mint` | Searches with your configured engine |
| `go back` / `reload` / `home` | Navigates |
| `open another tab` / `close that tab` | Manages tabs |
| `find the information on this page` | Finds it in the page |
| `bookmark this page` / `save this website` | Writes to local data |
| `download this file` / `open the downloaded file` | Downloads, then opens it |
| `read this page to me` | Reads the page aloud |
| `explain what I'm looking at` | Explains, using a local model if present |
| `compare these pages` | Compares the open tabs |

Commands can be chained: `open github; search for a rust bookmarks library`.

SUGAR asks before it writes a file, saves a page, downloads, or fills a form
(§13). It tells you — rather than silently failing — when a command needs the
internet and the machine is offline.

## AI, on your terms (§6)

SUGAR's own command layer needs no model and no network. When you want the
richer understanding (`explain`, `summarise`, `compare`, form filling), SUGAR
looks for a model **on this machine first** — Ollama, LM Studio, llama.cpp,
vLLM or Jan on their usual ports — and only uses a remote service if you
configured one and turned it on. The SUGAR settings panel shows which of them
answered, and the "Detect local AI models automatically" switch decides whether
SUGAR probes for them at all. With nothing configured, it falls back to the
local planner and says so instead of pretending.

## Offline (§12)

With the cable out, SUGAR Browser still launches. You can browse your bookmarks
and history, manage downloads, change settings, use SUGAR's local commands, and
use a local model if one is installed. Only websites and remote AI need the
network, and nothing about the browser requires the network to start.

## Updates (§14)

The primary update path is local: drop a newer build into `Updates/` beside the
executable and SUGAR notices it and tells you. A feed can be configured too, but
it is only ever *read* to tell you a newer version exists — never downloaded,
never installed on its own.

## Security (§13)

No hidden persistence, no silent installs, no copying itself anywhere. The
browser asks for the narrowest permission set it can work with (camera,
microphone, screen capture, clipboard, notifications, fullscreen, geolocation,
MIDI, background sync) and refuses the rest — USB, serial and HID are absent on
purpose. Any path SUGAR touches is checked to be inside the browser's own folder
before it is used, with a dialog whenever a person's choice is involved.

## Packaging (§14)

```sh
cd sugar-browser
npm run dist:win             # NSIS installer + portable .exe
npm run dist:win:installer   # just the installer
npm run dist:win:portable    # just the portable .exe
npm run dist:linux           # AppImage + tar.gz
npm run dist:mac             # .dmg
npm run dist:dir             # unpacked, for inspection
```

`electron-builder` builds each on its own platform (or in CI). The Windows
targets produce `SUGARBrowser-Setup-<version>.exe` (installs locally) and
`SUGARBrowser-Portable-<version>.exe` (run from anywhere, including a USB stick).

## What is in here

| File | What it is |
| --- | --- |
| `main.js` | The main process: portable roots, windows, Chromium views, tabs, permissions, downloads, SUGAR's browser-side actions, the menu. |
| `src/portable.js` | Where SUGAR Browser lives, decided at run time — the core of portable mode. |
| `src/store.js` | The local JSON data layer — settings, bookmarks, history, downloads, commands. |
| `src/security.js` | The permission allow-list and the path guards. |
| `src/updates.js` | The offline-first update check. |
| `src/ai/sugar.js` | SUGAR's own command parser: a sentence in, a plan out. No network. |
| `src/ai/providers.js` | The local-first AI provider registry. |
| `src/sugar-controller.js` | Carries a plan out against the browser, reporting progress. |
| `preload.js` | The narrow bridge between the chrome UI and the main process. |
| `ui/` | The browser's own chrome: tabs, omnibox, find, downloads, and the SUGAR panel. |

## Tests

```sh
npm test        # or: bun sugar-browser/tests/run.js
```

56 real assertions over the parts that can be verified without a display:
portable root resolution (flag, env var, marker file, installed fallback, and
drive-letter independence), the JSON stores (round-trip, atomic write, cap,
search, corruption), the security path guards and permission allow-list, the
offline update check (newer / not newer / failed), SUGAR's command parser for
every documented phrasing, the provider registry, and the controller (progress,
offline refusal, permission refusal, chained commands).

## What could not be verified here

This source is edited in a container with **no display, no Windows toolchain and
no Electron**, so the browser could not be launched, and a Windows `.exe` could
not be compiled. What *was* checked, and passes: every file parses
(`node --check`), the manifest is valid JSON, every element the UI reaches for
exists in the markup, every `api.*` call the UI makes is exposed by the preload
bridge, and every IPC channel the preload invokes has a handler in the main
process (none unused). Running it needs a desktop with a display; then
`npm install && npm start`. Building the Windows builds needs Windows (or CI):
`npm run dist:win`.
