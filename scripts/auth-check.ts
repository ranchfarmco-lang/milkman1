#!/usr/bin/env bun
/**
 * Sign-in, end to end, against a backend of this script's own.
 *
 * The hub is built to be independent, and the last thing in it that could still
 * lean on somebody else was getting *in*: an email code sent by a gateway. The
 * hub now signs people in with a name and a password it stores itself
 * (`src/convex/auth.ts`) — and a claim like that is worth exactly as much as the
 * test behind it, because every failure mode here is silent:
 *
 *   * a provider that is not registered — the form spins, then says the password
 *     is wrong, for everybody;
 *   * password hashing that does not run in the deployment's runtime — sign-up
 *     throws, and it reads like the account already exists;
 *   * normalization that is not applied on *both* sides — "Mum" works on the
 *     device it was made on and nowhere else ever again.
 *
 * So this script does not mock anything. It starts a real Convex backend from
 * the program the CLI already downloaded, pushes the hub's functions into it,
 * asks the deployment to run `src/convex/auth_check.ts` — four flows, four
 * outcomes — and reads what came back. Nothing outside this machine is reached:
 * the backend program is local, the deployment is local, and the account it
 * creates dies with the scratch database.
 *
 * Run with: bun run test:auth
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const PORT = 3410;
const SITE_PORT = 3411;
const INSTANCE = "auth-check";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  const oneLine = detail.split(/\\n|\n/)[0].trim();
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${oneLine ? ` — ${oneLine}` : ""}`);
  if (!ok) failures += 1;
}

/* ------------------------------------------------ a backend program to run */

/**
 * The newest cached backend this machine can actually execute.
 *
 * "Cached" because a program this script has to download is a program that may
 * not be there next time; "can execute" because a build newer than the machine's
 * C library dies on its first line — the same test `self-hosting/bundle.sh` uses,
 * and for the same reason.
 */
function backendProgram(): string | null {
  const cache = join(homedir(), ".cache", "convex", "binaries");
  if (!existsSync(cache)) return null;
  for (const version of readdirSync(cache).sort().reverse()) {
    const binary = join(cache, version, "convex-local-backend");
    if (!existsSync(binary)) continue;
    const probe = spawnSync(binary, ["--help"], { encoding: "utf8" });
    const err = String(probe.stderr ?? "");
    if (/GLIBC_|libc\.musl|error while loading shared libraries/.test(err)) continue;
    return binary;
  }
  return null;
}

const binary = backendProgram();
if (!binary) {
  console.error(
    "No Convex backend program to run. Run `bun convex dev --once` once (it downloads one), then try again.",
  );
  process.exit(1);
}

/* ------------------------------------------------------- the scratch backend */

const workdir = mkdtempSync(join(tmpdir(), "sugar-auth-check-"));
const secret = randomBytes(32).toString("hex");
const backend = spawn(
  binary,
  [
    "--port", String(PORT),
    "--site-proxy-port", String(SITE_PORT),
    "--instance-name", INSTANCE,
    "--instance-secret", secret,
    "--disable-beacon",
    join(workdir, "scratch.sqlite3"),
  ],
  { stdio: "ignore" },
);

const stop = () => {
  backend.kill();
  rmSync(workdir, { recursive: true, force: true });
};
process.on("exit", stop);

const answering = async (): Promise<boolean> => {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/version`, {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
};

let up = false;
for (let i = 0; i < 60 && !up; i += 1) {
  up = await answering();
  if (!up) await new Promise((r) => setTimeout(r, 500));
}
if (!up) {
  console.error("The scratch backend never answered on /version.");
  process.exit(1);
}

const keygen = spawnSync(
  binary,
  ["keygen", "admin-key", "--instance-name", INSTANCE, "--instance-secret", secret],
  { encoding: "utf8" },
);
const adminKey = keygen.stdout.trim().split("\n").pop() ?? "";
if (!adminKey) {
  console.error("Could not make an admin key for the scratch backend.");
  process.exit(1);
}

/* ------------------------------------- push the hub into it, then run the flows */

// Self-hosted mode: the CLI is told where the backend is and writes code into it.
// Nothing about this call asks Convex for anything — no account, no login, and
// the backend program came from the cache above.
//
// The deployment is chosen through a file of this script's own rather than
// through the environment, because this project's `.env.local` is loaded by the
// CLI too, and it names a deployment ("CONVEX_DEPLOYMENT must not be set when
// CONVEX_SELF_HOSTED_URL … are set" is what the CLI says when both arrive).
// `--env-file` replaces that file's contribution instead of adding to it, so
// whatever this machine is normally pointed at is neither read nor written.
/* ------------------------------------------ the signing keys it cannot sign without */
//
// A fresh deployment has none, and Convex Auth answers every query, looks
// healthy, and then throws `Missing environment variable JWT_PRIVATE_KEY` the
// moment somebody signs in — the failure `scripts/generate-auth-keys.mjs` exists
// for. That script is used here rather than reimplemented, but it has to run in
// a directory of its own: this project's `.env.local` names a deployment, and
// the CLI refuses to choose when that file and the self-hosted variables are
// both present. So an empty project is made, with `node_modules` linked to this
// one so `bunx` finds the CLI instead of fetching one.
const keyProject = join(workdir, "keys");
mkdirSync(join(keyProject, "functions"), { recursive: true });
await Bun.write(
  join(keyProject, "convex.json"),
  JSON.stringify({ functions: "functions/" }, null, 2),
);
// The CLI insists on a Convex app: a `package.json` that names it, which is also
// what tells it this directory is a project rather than a stray folder.
await Bun.write(
  join(keyProject, "package.json"),
  JSON.stringify(
    { name: "auth-check-keys", private: true, dependencies: { convex: "*" } },
    null,
    2,
  ),
);
symlinkSync(join(ROOT, "node_modules"), join(keyProject, "node_modules"));

const keyEnv: NodeJS.ProcessEnv = {
  ...process.env,
  CONVEX_SELF_HOSTED_URL: `http://127.0.0.1:${PORT}`,
  CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey,
  DISABLE_BEACON: "1",
};
delete keyEnv.CONVEX_DEPLOY_KEY;
delete keyEnv.CONVEX_DEPLOYMENT;
delete keyEnv.CONVEX_DEPLOYMENT_TOKEN;

const keys = spawnSync("bun", [join(ROOT, "scripts/generate-auth-keys.mjs")], {
  cwd: keyProject,
  env: keyEnv,
  encoding: "utf8",
  timeout: 120_000,
});
console.log(`${keys.stdout ?? ""}${keys.stderr ?? ""}`.trimEnd());
if (keys.status !== 0) {
  console.error("The scratch backend could not be given signing keys.");
  process.exit(1);
}

const deploymentFile = join(workdir, "deployment.env");
await Bun.write(
  deploymentFile,
  [
    `CONVEX_SELF_HOSTED_URL=http://127.0.0.1:${PORT}`,
    `CONVEX_SELF_HOSTED_ADMIN_KEY=${adminKey}`,
    "",
  ].join("\n"),
);

const env: NodeJS.ProcessEnv = { ...process.env, DISABLE_BEACON: "1" };
delete env.CONVEX_DEPLOY_KEY;
delete env.CONVEX_DEPLOYMENT;
delete env.CONVEX_DEPLOYMENT_TOKEN;

const run = spawnSync(
  "bunx",
  [
    "convex", "dev", "--once", "--typecheck", "disable",
    "--env-file", deploymentFile,
    "--run", "auth_check:run",
  ],
  { cwd: ROOT, env, encoding: "utf8", timeout: 180_000 },
);

const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;

// The marker can arrive more than once — the deployment logs it, and the CLI
// also echoes what the function returned — and only some of those are JSON.
// The first line that actually parses is the answer; the rest are decoration.
let results: Record<string, string> | null = null;
for (const line of output.split("\n")) {
  const at = line.indexOf("AUTHCHECK_RESULT");
  if (at === -1) continue;
  // Between the marker and the answer there can be anything the logger added —
  // in the deployment's own log line the two are separate quoted strings. What
  // is certain is that the JSON is the last braces on the line, so it is taken
  // from the first `{` to the last `}` and nothing else is read.
  const from = line.indexOf("{", at);
  const to = line.lastIndexOf("}");
  if (from === -1 || to <= from) continue;
  try {
    results = JSON.parse(line.slice(from, to + 1)) as Record<string, string>;
    break;
  } catch {
    // Not the JSON copy. Keep looking.
  }
}

if (!results) {
  console.error("The deployment never reported a result. Its output:\n");
  console.error(output.split("\n").slice(-25).join("\n"));
  process.exit(1);
}

/**
 * What the deployment said, in one line: the stack below it is not the answer.
 *
 * The stack travels *inside* the message, as the two characters `\n` rather than
 * a line break, so both have to be split on — otherwise every PASS line would
 * carry the deployment's file names and line numbers.
 */
const firstLine = (answer: string) => answer.split(/\\n|\n/)[0].trim();

console.log("The deployment's own answers:\n");
for (const [name, answer] of Object.entries(results)) {
  console.log(`  ${name}: ${firstLine(answer)}`);
}
console.log();

/* --------------------------------------------------------------- assertions */

check(
  "a name and a password make an account, with no email and no service",
  /signed in \(token issued\)/.test(results.makesAnAccount ?? ""),
  results.makesAnAccount,
);
check(
  "the wrong password is refused",
  /not the password|invalid secret|invalids?ecret/i.test(results.wrongPassword ?? ""),
  results.wrongPassword,
);
check(
  "the same name in different case is the same account",
  /signed in \(token issued\)/.test(results.sameNameDifferentCase ?? ""),
  results.sameNameDifferentCase,
);
check(
  "a password shorter than 8 characters is refused at sign-up",
  /8 characters/.test(results.shortPassword ?? ""),
  results.shortPassword,
);

console.log();
if (failures === 0) {
  console.log("Sign-in works on a backend of its own, with nothing outside it.");
} else {
  console.log(`${failures} check${failures === 1 ? "" : "s"} failed.`);
}
process.exit(failures === 0 ? 0 : 1);
