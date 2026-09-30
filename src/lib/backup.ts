/**
 * Turning the hub into something you can carry.
 *
 * The Control Room's Backup panel offers four things, and every one of them is
 * built here in the browser from what the hub already holds — nothing is
 * uploaded to make a file, and nothing here reads the disk.
 *
 *   - the whole app as one readable text file (`sourceAsText`)
 *   - the hub's data as JSON (`dataAsJson`)
 *   - an installable copy on your own computer: the app plus a Dockerfile and
 *     a compose file that build and serve it (`linuxKit`, `backupZip`)
 *   - everything at once, in one zip (`backupZip`)
 *
 * The source arrives from the backend as a map of path → contents, the same
 * snapshot the AI Builder reads (`src/convex/self_source.ts`). `self_source.ts`
 * itself is left out of that map, so `renderSelfSource` puts it back — a copy
 * of the app that cannot regenerate its own snapshot is a copy that cannot
 * build.
 */
import { PACKAGE_BINARY_FILES, PACKAGE_FILES } from "./offline-brain-files";
import { zipBlob, type ZipEntry } from "./zip";

/** Every file the app is made of: repo-relative path → its text. */
export type SourceMap = Record<string, string>;

/** What `api.backup.data` hands back: table name → rows, plus honest notes. */
export type HubBackup = {
  at: string;
  tables: Record<string, unknown[]>;
  notes: string[];
};

export type BackupInput = {
  at: string;
  files: SourceMap;
  data: HubBackup | null;
  /** The hub's own Convex address, baked into the kit so it runs as it is. */
  convexUrl: string;
  includeSource: boolean;
  includeData: boolean;
  /**
   * The offline-brain package, fetched by the caller (the panel) — when present
   * it is packed under `offline-ai-coding-brain/`, which is what makes this the
   * Everything edition rather than a plain backup.
   */
  brain?: {
    files: SourceMap;
    /** The packaged files that are not text, by path: the source archive. */
    binary?: Record<string, Uint8Array>;
    missing: string[];
  };
  /** Which edition this archive is, named in the README so it says what it is. */
  edition?: "web" | "local" | "everything";
};

const BAR = "=".repeat(78);

/** `2026-09-26` from an ISO timestamp, so every file carries the same date. */
export function stampOf(at: string) {
  const date = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** "1.1 MB" — the same units the rest of the hub uses. */
function sizeOf(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* ------------------------------------------- the app, as one readable file */

/**
 * Every file, one after another, each announced by its path. Nothing is
 * compressed or split: this is meant to be opened in any text editor and read.
 */
export function sourceAsText(files: SourceMap, at: string) {
  const paths = Object.keys(files).sort();
  const total = paths.reduce((sum, path) => sum + files[path].length, 0);

  const header = [
    "PRIVATE HUB — THE WHOLE APP AS TEXT",
    "",
    `Snapshot taken: ${at}`,
    `Files: ${paths.length}`,
    `Size: ${sizeOf(total)}`,
    "",
    "Every file this hub is made of, written one after another. Each one is",
    "announced by a path between two lines of equals signs, so this can be read",
    "straight through or split back into real files.",
    "",
  ].join("\n");

  const body = paths
    .map((path) => `${BAR}\nFILE: ${path}\n${BAR}\n${files[path]}`)
    .join("\n\n");

  return `${header}\n${body}\n`;
}

/**
 * Put `self_source.ts` back into a copy of the app.
 *
 * The snapshot deliberately leaves itself out — a file cannot contain its own
 * final contents — so a backup would otherwise be missing the module the
 * Builder reads from. Rebuilding it from the same map restores the copy whole.
 */
export function renderSelfSource(files: SourceMap, at: string) {
  const ordered = Object.fromEntries(
    Object.keys(files)
      .sort()
      .map((path) => [path, files[path]]),
  );

  return `/**
 * GENERATED FILE — do not edit by hand.
 *
 * Rebuilt from the hub's own backup on ${at}. In the live project this file is
 * written by \`bun run snapshot:self\`; running that command again will replace
 * this copy with a fresh one.
 */

export const SELF_SNAPSHOT_AT = ${JSON.stringify(at)};

export const SELF_SOURCE: Record<string, string> = ${JSON.stringify(ordered, null, 2)};
`;
}

/* -------------------------------------------------------- the hub's data */

/** The data export as it is saved: readable, and complete enough to keep. */
export function dataAsJson(data: HubBackup) {
  const counts = Object.fromEntries(
    Object.entries(data.tables).map(([table, rows]) => [table, rows.length]),
  );

  return `${JSON.stringify(
    {
      _whatThisIs:
        "A copy of everything the hub has written down, taken from its own database. Restore it with `bunx convex import` (see INSTALL.md).",
      takenAt: data.at,
      counts,
      notes: data.notes,
      tables: data.tables,
    },
    null,
    2,
  )}\n`;
}

/* ------------------------------------------- a copy that runs on your desk */

/**
 * The files that turn the app copy into something you can run on a Linux
 * laptop. The app talks to Convex for its data, so the image carries the
 * interface and points at the same hub database; `data/hub-data.json` is the
 * durable copy of what was written down.
 */
export function linuxKit(convexUrl: string): Record<string, string> {
  const address = convexUrl.trim() || "https://your-deployment.convex.cloud";

  return {
    Dockerfile: `# The hub, built and served on your own computer.
#
# Stage one builds the web app with Bun; stage two serves the finished files
# with nginx. The data is not in here — the hub keeps it in Convex (see
# INSTALL.md) — but this image carries the whole interface and runs it at
# http://localhost:8080.
FROM oven/bun:1 AS build
WORKDIR /app

# Where the hub's database lives. This is a client address, not a secret, and
# it is baked in at build time because the browser is what connects.
ARG VITE_CONVEX_URL=${address}
ENV VITE_CONVEX_URL=$VITE_CONVEX_URL

COPY . .
RUN bun install
RUN bun run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
`,

    "docker-compose.yml": `# Run the hub on your own computer:
#
#   docker compose up --build
#
# then open http://localhost:8080 in your browser.
services:
  hub:
    build:
      context: .
      args:
        # Change this only if the hub has been moved to its own Convex
        # deployment; otherwise leave it as it is.
        VITE_CONVEX_URL: \${VITE_CONVEX_URL:-${address}}
    ports:
      - "8080:80"
    restart: unless-stopped
`,

    "nginx.conf": `server {
  listen 80;
  server_name _;
  root /usr/share/nginx/html;
  index index.html;

  # The hub is one page: any path it does not recognise is the app itself.
  location / {
    try_files $uri $uri/ /index.html;
  }

  # Built files carry a hash in their name, so they can be cached for a while.
  location /assets/ {
    expires 30d;
    add_header Cache-Control "public, immutable";
  }

  # The service worker must never be cached, or an update would never arrive.
  location = /sw.js {
    add_header Cache-Control "no-cache";
  }
}
`,

    "env.example": `# Where the hub keeps its data. Not a secret — the browser connects with it.
VITE_CONVEX_URL=${address}
`,

    // The one command that puts the whole hub on this computer: the backend,
    // the sign-in keys, the functions, and the app pointed at them. No service
    // anywhere else, so nothing outside this machine can switch it off.
    "self-host/setup.sh": `#!/usr/bin/env bash
# Put the hub on this computer, on its own.
#
# One command:
#
#   HUB_PASSWORD='the-password-you-share' bash self-host/setup.sh
#
# What it does, in order:
#   1. starts the open-source Convex backend (the database and the functions)
#   2. waits for it, and makes an admin key
#   3. points this project at that backend
#   4. makes the hub's sign-in keys and sets them
#   5. pushes this app's functions to the backend
#   6. builds and serves the hub against it
#
# Nothing here talks to Freebuff or to any hosted service: when it finishes the
# hub runs on this machine and nobody else can switch it off. It needs Docker
# and Bun.
set -euo pipefail

here="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
app="$(cd "$here/.." && pwd)"
compose="docker compose -f $here/docker-compose.yml"

say() { printf '\\n\\033[1m%s\\033[0m\\n' "$*"; }

command -v docker >/dev/null || { echo "Docker is needed: https://docs.docker.com/engine/install/"; exit 1; }
command -v bun >/dev/null || { echo "Bun is needed: https://bun.sh"; exit 1; }

say "1/6  Starting the backend (database + functions)..."
$compose up -d

say "2/6  Waiting for it to answer..."
ready=""
for _ in $(seq 1 90); do
  if curl -fsS http://127.0.0.1:3210/version >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[ -n "$ready" ] || { echo "The backend did not come up. Try: docker compose -f $here/docker-compose.yml logs"; exit 1; }

say "3/6  Making an admin key and pointing this project at the backend..."
admin_key="$($compose exec -T backend ./generate_admin_key.sh | tr -d '\\r' | tail -n 1)"
[ -n "$admin_key" ] || { echo "Could not read the admin key."; exit 1; }

cat > "$app/.env.local" <<EOF
CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210
CONVEX_SELF_HOSTED_ADMIN_KEY=$admin_key
EOF

say "4/6  Installing the app's packages..."
cd "$app"
bun install

say "5/6  Making the sign-in keys and pushing the functions..."
node "$here/generate-keys.mjs" > "$here/keys.env"
set -a
# shellcheck disable=SC1091
. "$here/keys.env"
set +a

# -- before each name: a PKCS8 PEM begins with "-----", which the CLI would
# otherwise read as an unknown option and refuse to set at all.
bunx convex env set -- JWT_PRIVATE_KEY "$JWT_PRIVATE_KEY"
bunx convex env set -- JWKS "$JWKS"
if [ -n "\${HUB_PASSWORD:-}" ]; then
  bunx convex env set -- HUB_PASSWORD "$HUB_PASSWORD"
  echo "Family password set from HUB_PASSWORD."
else
  echo "No HUB_PASSWORD set, so the hub opens without a password. To require one:"
  echo "  HUB_PASSWORD='the-password-you-share' bash self-host/setup.sh"
fi

bunx convex dev --once

say "6/6  Building and serving the hub against your own backend..."
VITE_CONVEX_URL=http://127.0.0.1:3210 docker compose -f "$app/docker-compose.yml" up --build -d

say "Done - open http://localhost:8080"
echo "The backend's dashboard is at http://localhost:6791"
`,

    "self-host/generate-keys.mjs": `// Makes the two environment variables Convex Auth needs to sign people in:
// JWT_PRIVATE_KEY and JWKS. Prints them as shell assignments, so
// self-host/setup.sh can read them straight in. Run it after \`bun install\`,
// with: node self-host/generate-keys.mjs
import { exportJWK, exportPKCS8, generateKeyPair } from "jose";

const keys = await generateKeyPair("RS256", { extractable: true });
const privateKey = await exportPKCS8(keys.privateKey);
const publicKey = await exportJWK(keys.publicKey);
const jwks = JSON.stringify({ keys: [{ use: "sig", ...publicKey }] });

process.stdout.write(
  'JWT_PRIVATE_KEY="' + privateKey.trimEnd().replace(/\\n/g, " ") + '"\\n',
);
process.stdout.write("JWKS='" + jwks + "'\\n");
`,

    // The way out of depending on someone else's deployment: the official
    // open-source Convex backend, and how to point the hub at it. See section 6
    // of INSTALL.md.
    "self-host/docker-compose.yml": `services:
  backend:
    image: ghcr.io/get-convex/convex-backend:latest
    stop_grace_period: 10s
    stop_signal: SIGINT
    ports:
      - "3210:3210"
      - "3211:3211"
    volumes:
      - data:/convex/data
    environment:
      - CONVEX_CLOUD_ORIGIN=http://127.0.0.1:3210
      - CONVEX_SITE_ORIGIN=http://127.0.0.1:3211
      - DISABLE_METRICS_ENDPOINT=true
      - DOCUMENT_RETENTION_DELAY=172800
      - RUST_LOG=info
    healthcheck:
      test: curl -f http://localhost:3210/version
      interval: 5s
      start_period: 10s

  dashboard:
    image: ghcr.io/get-convex/convex-dashboard:latest
    stop_grace_period: 10s
    stop_signal: SIGINT
    ports:
      - "6791:6791"
    environment:
      - NEXT_PUBLIC_DEPLOYMENT_URL=http://127.0.0.1:3210
    depends_on:
      backend:
        condition: service_healthy

volumes:
  data:
`,

    "self-host/README.md": `# self-host/

The hub's backend, for running it without depending on anyone else's deployment.
This is the official open-source Convex backend and dashboard — the same code
the hosted service runs — packaged so the hub can point at it.

## The one command

From the app folder — the one above this — run:

    HUB_PASSWORD='the-password-you-share' bash self-host/setup.sh

That starts the backend, makes an admin key and the sign-in keys, pushes this
app's functions to it, and builds and serves the hub against it — all on this
computer, with nothing outside it. When it finishes, open
<http://localhost:8080>. Leave out HUB_PASSWORD to run with no family password.

Start it by hand, if you would rather see each step:

    docker compose up -d
    docker compose exec backend ./generate_admin_key.sh

- the backend (database, queries, mutations, actions, file storage) is on
  http://127.0.0.1:3210
- its HTTP actions are on http://127.0.0.1:3211
- its dashboard is on http://localhost:6791

Its data lives in the \`data\` Docker volume, so \`docker compose down\` keeps it
and \`docker compose down -v\` wipes it. Back it up by copying that volume out.

The full walkthrough, and what each step is doing, is in ../INSTALL.md section
6. The keys setup.sh writes live in self-host/keys.env — that file holds a
private key, so keep it to yourself and do not commit it.
`,

    "INSTALL.md": `# Running the hub on your own computer

This folder is a complete copy of the hub's app — the same code the live hub
runs — plus three small files that build and serve it locally. It needs
**Docker** and nothing else.

## 1. Install Docker (once)

On Linux, install Docker Engine and the Compose plugin from
<https://docs.docker.com/engine/install/>. Most distributions also ship it as
\`docker.io\` and \`docker-compose-plugin\`; afterwards \`docker --version\` and
\`docker compose version\` should both answer.

## 2. Start the hub

    docker compose up --build

The first run downloads packages and builds the app, so it takes a few minutes.
When it settles, open:

    http://localhost:8080

You should see the same sign-in screen as the live hub. \`Ctrl+C\` stops it;
\`docker compose up -d\` leaves it running in the background.

## 3. What runs, and what does not

- This image runs **the interface**: every page, the assistant, the builder,
  the messenger, the calendar, the Control Room.
- The **data** still lives in the hub's Convex database at
  \`${address}\`. That is deliberate: the hub is one private place, and every
  device that opens it sees the same family. This local copy is a second way in,
  not a second hub.
- \`data/hub-data.json\` in this backup is the durable, offline copy of
  everything the hub had written down at the moment the backup was taken. If the
  live database ever disappeared, that file is what you would restore from.

## 4. Keeping it working

- To update the app copy, take a new backup from the Control Room and run
  \`docker compose up --build\` again.
- The Freebuff/Vly build plugin (\`@vly-ai/integrations\`) is optional and is
  loaded only if it is actually installed, so this copy builds and runs on a
  machine that has never heard of Freebuff — nothing to edit. It is needed to
  *edit* the project inside Freebuff, never to run it.
- The AI does not need Freebuff either. The gateway the live hub ships with
  (\`VLY_INTEGRATION_KEY\`) is one system among several; leave it unset and the
  hub stops listing it, or point the hub at a model of your own — see section 6.
- If you move the hub to your **own** Convex deployment, change
  \`VITE_CONVEX_URL\` in \`docker-compose.yml\` (or a \`.env\` beside it) and
  rebuild.

## 5. Restoring the data

With the Convex CLI and the hub's deployment selected:

    bunx convex import --table messages data/hub-data.json

The JSON groups rows by table under \`tables\`, so import one table at a time or
split the file first. It is deliberately plain: a person or a script can read it
without this app.

## 6. Cutting the cord — running your own backend

Out of the box this copy talks to the hub's Convex database (the address in
VITE_CONVEX_URL). While that database is up that is the simplest thing — but it
means the copy you own still needs someone else's deployment to sign you in.
There are two ways to make it yours, and either one removes that.

### Your own Convex project (easiest)

Still a hosted service, but the deployment is yours, not anyone else's:

    cd app
    bunx convex dev          # creates a deployment you own and writes its URL

Set the secrets the hub needs on that deployment — the family password, and the
auth keys the app uses (JWKS, JWT_PRIVATE_KEY, SITE_URL) — then rebuild and
start the hub pointed at it:

    bunx convex env set HUB_PASSWORD the-password-you-share
    VITE_CONVEX_URL=<your-deployment-url> docker compose up --build

### Self-hosted Convex (no service at all) — the whole app on this machine

Convex is open source and runs on this machine, so this is the version no
company can switch off. One command does the lot:

    HUB_PASSWORD='the-password-you-share' bash self-host/setup.sh

It starts the backend (self-host/docker-compose.yml), makes an admin key, points
this project at it, makes the sign-in keys, pushes this app's functions to it,
and builds and serves the hub against it. Then open <http://localhost:8080>; the
backend's dashboard is at <http://localhost:6791>. Leave HUB_PASSWORD out to run
with no family password.

By hand, if you would rather see each step:

    cd app/self-host
    docker compose up -d
    docker compose exec backend ./generate_admin_key.sh   # prints an admin key

    cd ..                                   # back in the app folder
    echo CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210 > .env.local
    echo CONVEX_SELF_HOSTED_ADMIN_KEY=<the-admin-key> >> .env.local
    bun install
    node self-host/generate-keys.mjs        # prints JWT_PRIVATE_KEY and JWKS
    bunx convex env set -- JWT_PRIVATE_KEY "<...>"
    bunx convex env set -- JWKS '<...>'
    bunx convex env set -- HUB_PASSWORD "the-password-you-share"
    bunx convex dev --once                  # push the app's functions
    VITE_CONVEX_URL=http://127.0.0.1:3210 docker compose up --build

Why the sign-in keys: the hub signs each device in as an anonymous account and
records the family password against it, and Convex Auth needs JWT_PRIVATE_KEY
and JWKS to issue those tokens. SITE_URL is only for email and OAuth sign-in,
which this hub does not use, so nothing else has to be set. Convex's CLI does
not yet do self-hosted **Convex Auth** in one step — that is the only sharp edge
(<https://labs.convex.dev/auth/setup/manual>).

The \`--\` in front of each name above is load-bearing. A PKCS8 PEM begins with
\`-----\`, which the Convex CLI would otherwise read as an unknown option and
refuse to set — leaving a deployment that answers every query, looks healthy,
and fails on the first sign-in instead.

### Your own AI gateway (replacing Freebuff's)

The hub has no single model it depends on — with no key at all it still answers
on free public systems that need no account. The one piece that belongs to
Freebuff is the gateway the deployment ships with (\`VLY_INTEGRATION_KEY\`), and
it is optional: leave it unset and the hub simply stops listing it. To keep a
real model of your own, run an OpenAI-compatible gateway you control. **LiteLLM**
is open source, free, and already configured in
\`public/offline-brain/configuration/litellm.example.yaml\`, which routes several
local models behind one endpoint. Then point the hub at it:

    bunx convex env set AI_BASE_URL http://localhost:4000/v1
    bunx convex env set AI_API_KEY local
    bunx convex env set AI_MODEL coder

Nothing about this copy expires, phones home, or needs Freebuff: pointed at a
backend and a model you own, it is yours.
`,
  };
}

/* ------------------------------------------------------------- the archive */

function backupReadme(input: BackupInput, root: string) {
  const paths = Object.keys(input.files);
  const stamp = stampOf(input.at);
  const editionLine =
    input.edition === "web"
      ? "THE WEB EDITION — the whole app, ready to run in a browser or a Docker container on your own computer."
      : input.edition === "everything" || input.brain
        ? "THE EVERYTHING EDITION — the web app AND the local offline brain in one archive."
        : "A backup of the hub: the app" + (input.includeData && input.data ? " and its data" : "") + ".";
  const parts = [
    `# Private Hub — ${input.edition ?? "backup"} · taken ${stamp}`,
    "",
    editionLine,
    "",
    "Built in the browser from the app's own snapshot and its own database;",
    "nothing was uploaded to make it.",
    "",
    "## What is inside",
    "",
  ];

  if (input.includeSource) {
    parts.push(
      `- \`app/\` — the whole app: ${paths.length} files, every page and function.`,
      "  It is a real project: `bun install` then `bun run dev` in that folder",
      "  runs it, and `app/INSTALL.md` shows how to run it with Docker.",
      "- `app/Dockerfile`, `app/docker-compose.yml`, `app/nginx.conf` — build and",
      "  serve it on your own computer with `docker compose up --build`.",
    );
  }
  if (input.includeData && input.data) {
    const counts = Object.entries(input.data.tables)
      .filter(([, rows]) => rows.length > 0)
      .map(([table, rows]) => `${table} ${rows.length}`)
      .join(", ");
    parts.push(
      `- \`data/hub-data.json\` — what the hub had written down: ${counts}.`,
    );
  }

  if (input.brain) {
    const brainPaths = Object.keys(input.brain.files);
    const brainBytes = Object.keys(input.brain.binary ?? {});
    parts.push(
      `- \`offline-ai-coding-brain/\` — the local edition: the Python brain, every installer${brainBytes.length ? ` and the Freebuff reference source archive (${brainPaths.length} files)` : ` (${brainPaths.length} files)`}.`,
      "  `python3 brain/brain.py serve` inside it starts the brain; the hub's Local",
      "  Brain page pairs with it once and becomes a view of it. Nothing in there",
      "  is fetched while it installs: the source is unpacked from the archive.",
    );
    if (input.brain.missing.length) {
      parts.push(
        `  Note: ${input.brain.missing.length} package file(s) could not be read when this archive was built: ${input.brain.missing.slice(0, 5).join(", ")}${input.brain.missing.length > 5 ? "…" : ""}.`,
      );
    }
  }

  parts.push(
    "",
    "## Restoring it",
    "",
    "- **The code:** copy `app/` into a project folder and work with it there, or",
    "  run it as-is with Docker (see `app/INSTALL.md`).",
    input.includeData
      ? "- **The data:** `bunx convex import` reads `data/hub-data.json`; the" +
        " steps are in `app/INSTALL.md`."
      : "- **The data:** this backup has code only.",
    "",
    "## Honest notes",
    "",
    "- The copy is a snapshot: it is the code as it was when the backup was",
    "  taken, not a live link to the project.",
    "- Packages are not bundled (no `node_modules`), so the first build fetches",
    "  them. A lockfile is not included either, so versions resolve fresh.",
    input.includeData && input.data?.notes.length
      ? input.data.notes.map((note) => `- ${note}`).join("\n")
      : "- Ephemeral rows (presence, call handshakes, password answers) are left out.",
    "",
    `Taken ${input.at} at ${root}.`,
  );

  return `${parts.join("\n")}\n`;
}

/**
 * The archive itself. `includeSource` adds the app and the Linux kit,
 * `includeData` adds the JSON export — together they are "everything".
 */
export function backupZip(input: BackupInput) {
  const root = `private-hub-backup-${stampOf(input.at)}`;
  const entries: ZipEntry[] = [];

  entries.push({ path: `${root}/README.md`, data: backupReadme(input, root) });

  if (input.includeSource) {
    for (const path of Object.keys(input.files).sort()) {
      entries.push({ path: `${root}/app/${path}`, data: input.files[path] });
    }
    // The snapshot leaves itself out; put it back so the copy can build.
    entries.push({
      path: `${root}/app/src/convex/self_source.ts`,
      data: renderSelfSource(input.files, input.at),
    });
    for (const [name, text] of Object.entries(linuxKit(input.convexUrl))) {
      entries.push({ path: `${root}/app/${name}`, data: text });
    }
  }

  if (input.includeData && input.data) {
    entries.push({
      path: `${root}/data/hub-data.json`,
      data: dataAsJson(input.data),
    });
  }

  // The Everything edition: the local edition rides along under its own
  // folder, so one archive holds the app, the data AND the brain package.
  if (input.brain) {
    for (const path of Object.keys(input.brain.files).sort()) {
      entries.push({
        path: `${root}/offline-ai-coding-brain/${path}`,
        data: input.brain.files[path],
      });
    }
    for (const path of Object.keys(input.brain.binary ?? {}).sort()) {
      entries.push({
        path: `${root}/offline-ai-coding-brain/${path}`,
        data: input.brain.binary![path],
      });
    }
  }

  return zipBlob(entries, new Date(input.at));
}

/* -------------------------------------------------- the local brain, packed */

/**
 * The local edition as one zip: the whole offline-brain package (the Python
 * brain, every installer, the docs and the model manifest) fetched from what
 * the hub itself serves, plus a short README that says what to run first.
 *
 * Files that could not be fetched are named in the README rather than silently
 * missing — an archive that pretends to be complete is worse than one that
 * admits what it lacks.
 */
export async function offlineBrainZip(
  fetchFile: (path: string) => Promise<string | null>,
  at: string,
  fetchBinary: (path: string) => Promise<Uint8Array | null> = async () => null,
): Promise<{ blob: Blob; fetched: number; missing: string[] }> {
  const root = `offline-ai-coding-brain-${stampOf(at)}`;
  const entries: ZipEntry[] = [];
  const missing: string[] = [];
  let fetched = 0;

  for (const path of PACKAGE_FILES) {
    const text = await fetchFile(path);
    if (text === null) {
      missing.push(path);
      continue;
    }
    entries.push({ path: `${root}/${path}`, data: text });
    fetched += 1;
  }

  for (const path of PACKAGE_BINARY_FILES) {
    const bytes = await fetchBinary(path);
    if (bytes === null) {
      missing.push(path);
      continue;
    }
    entries.push({ path: `${root}/${path}`, data: bytes });
    fetched += 1;
  }

  const lines = [
    `# offline-ai-coding-brain — the local edition, packed ${stampOf(at)}`,
    "",
    "The Python brain, every installer and the Freebuff reference source",
    "archive, exactly as the hub serves them. Nothing here is fetched while it",
    "installs: the installers unpack the source archive that is in this folder.",
    "",
    "## Start here (a terminal, in this folder)",
    "",
    "    chmod +x GET-EVERYTHING.sh scripts/*.sh tests/*.sh",
    "    ./GET-EVERYTHING.sh          # every installer; SKIP_MODELS=1 for software only",
    "    python3 brain/brain.py serve # the brain — prints the pairing token",
    "",
    "Then open the hub's Local Brain page and paste the address and token once.",
    "Models are fetched by GET-EVERYTHING.sh; set MODEL_SET=small first for a",
    "laptop-sized download.",
    "",
  ];
  if (missing.length) {
    lines.push("## Not in this copy", "", "These files could not be read when the archive was made:");
    for (const path of missing) lines.push(`- ${path}`);
    lines.push("", "Fetch them from the hub's Offline Brain page instead.");
  } else {
    lines.push("Complete: every packaged file is in this archive.");
  }
  lines.push("");

  entries.push({ path: `${root}/START-HERE.md`, data: lines.join("\n") });

  return { blob: zipBlob(entries, new Date(at)), fetched, missing };
}
