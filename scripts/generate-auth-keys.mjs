#!/usr/bin/env bun
/**
 * Generate the signing keys the deployment needs to issue logins.
 *
 * `@convex-dev/auth` signs its own session tokens, so a deployment without
 * `JWT_PRIVATE_KEY` and `JWKS` cannot complete a sign-in at all. The failure is
 * ugly precisely because it is late: the backend answers, the query for the
 * access state succeeds, the app looks healthy — and then the *first* sign-in
 * throws `Missing environment variable JWKS`. Nothing about the running system
 * suggests an unconfigured key, so it reads as a broken app rather than a
 * deployment that was never finished. A fresh deployment always needs this once.
 *
 * `bunx @convex-dev/auth` does the same job, but it is an interactive Node CLI:
 * it asks which providers to configure and prompts before overwriting, so it
 * cannot be scripted, cannot be run by a runner, and cannot be written into a
 * README as a step somebody can simply follow. This is that step.
 *
 * The keys come from WebCrypto rather than a library, for two reasons. There is
 * nothing to install — `globalThis.crypto` is part of both Bun and Node — and
 * jose, which the official CLI uses, resolves to its *browser* build under Bun,
 * where the generated keys are deliberately non-extractable and cannot be
 * exported at all. WebCrypto is the layer jose sits on, so nothing is lost by
 * going straight to it.
 *
 * The two values it writes are the same two the official CLI writes, in the same
 * shape — a PKCS8 PEM for the private half, and the matching public JWK in a
 * `{ keys: [...] }` set — so the server treats them identically.
 *
 *   bun scripts/generate-auth-keys.mjs                        # if the deployment has none
 *   bun scripts/generate-auth-keys.mjs --deployment local      # the local dev backend
 *   bun scripts/generate-auth-keys.mjs --local                # the one `bun run dev` starts
 *   bun scripts/generate-auth-keys.mjs --force                 # replace (signs everyone out)
 *
 * `--deployment` is passed straight to the Convex CLI, so it takes the same
 * values, and `local` is the one worth knowing: the local backend `bun run dev`
 * starts is a deployment of its own, created without these keys, so the first
 * sign-in there fails in exactly the way described above until this is run
 * against it. The existence check and the write always go to the same
 * deployment, so a mistyped name cannot set keys somewhere unintended.
 *
 * Overwriting is refused rather than merely warned about: new keys invalidate
 * every session token already issued, so every device is signed out and has to
 * come back in through the family password. That should be a deliberate act,
 * which is what `--force` is for.
 *
 * `--local` is the same job against the backend this machine is running, and it
 * exists because the CLI cannot do it for that deployment. The backend `bun run
 * dev` starts is created anonymously, on a port, with an admin key written to
 * `.convex/local/default/config.json` — and it is not a deployment the control
 * plane knows about, so `--deployment local` reaches for a login that is not
 * there and comes back with `Access Token could not be decoded`. The admin API
 * behind that key is what the CLI otherwise uses, so the write is the same one;
 * only the road to it is different. `scripts/dev.sh` runs this mode before Vite
 * starts, which is what keeps a brand-new workspace from serving a hub nobody
 * can sign in to.
 */

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const args = process.argv.slice(2);
const force = args.includes("--force");

/**
 * The deployment to configure, when it is not the one this project is pointed
 * at.
 */
const target = (() => {
  const at = args.indexOf("--deployment");
  return at >= 0 && args[at + 1] ? ["--deployment", args[at + 1]] : [];
})();

/** Run the Convex CLI against the chosen deployment. */
function convex(argv) {
  // The flag belongs to the subcommand (`convex env list --deployment local`),
  // not to the command as a whole, and `env set` ends its own options with `--`
  // before the name — so it goes after the subcommand and before the rest.
  const [command, subcommand, ...rest] = argv;
  const result = spawnSync(
    "bunx",
    ["convex", command, subcommand, ...target, ...rest],
    {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    },
  );
  return {
    ok: result.status === 0,
    // Only ever used for error text that is not a secret. `env get` prints the
    // value of a variable, and this script never needs to read one: existence is
    // the whole question, and the exit code answers it.
    text: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

/**
 * The names of the variables the deployment has, and never their values.
 *
 * `env get` cannot answer this: it exits 0 whether or not the variable exists,
 * so it cheerfully reports a key that is not there — which is exactly the state
 * this script exists to fix, and it would have skipped the fix. `env list` does
 * know, but it prints values, so every line is cut at the first `=` and only the
 * name is kept. Nothing else from that output is read, stored or shown.
 */
function namesOnDeployment() {
  const result = convex(["env", "list"]);
  if (!result.ok) {
    console.error(`Could not read the deployment's variables:\n${result.text.trim()}`);
    process.exit(1);
  }
  return new Set(
    result.text
      .split("\n")
      .map((line) => line.slice(0, line.indexOf("=")))
      .filter(Boolean),
  );
}

/**
 * The local backend, as the CLI leaves it for us: a port to talk to and the
 * admin key that authenticates against it. Both are read from the config the
 * CLI writes when it creates the deployment — this is the same file, the same
 * key and the same API the CLI itself uses, not a copy of them.
 */
async function localBackend() {
  let config;
  try {
    config = JSON.parse(
      await readFile(".convex/local/default/config.json", "utf8"),
    );
  } catch {
    // No local deployment has ever been created here, which is not a failure of
    // this script: there is simply nothing on this machine to configure.
    return null;
  }
  const port = config?.ports?.cloud;
  const adminKey = config?.adminKey;
  if (!port || !adminKey) return null;
  return { port, adminKey };
}

/** One admin call against the local backend. */
async function localAdmin(backend, path, body) {
  const response = await fetch(`http://127.0.0.1:${backend.port}/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Convex ${backend.adminKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${text.trim().slice(0, 400)}`);
  }
  // A write answers with nothing at all, and reading that as JSON would turn a
  // successful change into `Unexpected EOF`.
  if (!text.trim()) return null;
  return JSON.parse(text);
}

/**
 * The names of the variables on the local backend, and never their values.
 *
 * This is the query the CLI runs to list a deployment's variables, so it sees
 * exactly what `env list` would — without the values going past this line.
 */
function localNames(result) {
  const entries = result?.value ?? [];
  return new Set(
    entries
      .map((entry) => (typeof entry === "string" ? entry : entry?.name))
      .filter(Boolean),
  );
}

function set(name, value) {
  // `--` before the name, because a PKCS8 PEM begins with `-----` and would
  // otherwise be read as a flag. The value is a real argument rather than a
  // shell string, so nothing inside it needs escaping.
  //
  // Note that for a single variable the CLI overwrites without asking — it is
  // `--from-file` that refuses — so the guard against replacing live keys has to
  // be the check in this script, not anything the command does.
  const result = convex(["env", "set", "--", name, value]);
  if (!result.ok) {
    console.error(`Could not set ${name}:\n${result.text.trim()}`);
    process.exit(1);
  }
}

/** PKCS8 PEM, wrapped at 64 columns, then folded onto one line. */
function toPem(der) {
  const body = Buffer.from(der).toString("base64").match(/.{1,64}/g) ?? [];
  const pem = `-----BEGIN PRIVATE KEY-----\n${body.join("\n")}\n-----END PRIVATE KEY-----`;
  // The official CLI stores it with newlines replaced by spaces: the variable is
  // a single line on the deployment, and jose's `importPKCS8` ignores the
  // whitespace between the header and the footer.
  return pem.replace(/\n/g, " ");
}

const keys = await crypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), // 65537
    hash: "SHA-256",
  },
  true, // extractable — the entire point of this script
  ["sign", "verify"],
);

const privateKey = toPem(await crypto.subtle.exportKey("pkcs8", keys.privateKey));
const publicJwk = await crypto.subtle.exportKey("jwk", keys.publicKey);

// Built explicitly rather than spread from the export, so the set holds only
// what is needed to verify a signature: the key, its algorithm, and its purpose.
const jwks = JSON.stringify({
  keys: [
    {
      kty: publicJwk.kty,
      n: publicJwk.n,
      e: publicJwk.e,
      alg: "RS256",
      use: "sig",
    },
  ],
});

// The local backend takes a different road (see the note at the top), so it is
// handled and finished with before the CLI path below is reached at all.
if (args.includes("--local")) {
  const backend = await localBackend();
  if (!backend) {
    console.error(
      "There is no local deployment on this machine to configure.\n" +
        "`bun run dev` creates one; run it, then run this again.",
    );
    process.exit(1);
  }

  const readNames = () =>
    localAdmin(backend, "api/query", {
      path: "_system/cli/queryEnvironmentVariables",
      args: {},
    }).then(localNames);

  let current;
  try {
    current = await readNames();
  } catch (error) {
    console.error(
      `The local backend on port ${backend.port} did not answer:\n${error.message}`,
    );
    process.exit(1);
  }

  if (current.has("JWT_PRIVATE_KEY") && current.has("JWKS") && !force) {
    console.log(
      "The local backend already has signing keys, so nothing was changed.",
    );
    process.exit(0);
  }

  try {
    await localAdmin(backend, "api/update_environment_variables", {
      changes: [
        { name: "JWT_PRIVATE_KEY", value: privateKey },
        { name: "JWKS", value: jwks },
      ],
    });
  } catch (error) {
    console.error(
      `Could not set the local backend's signing keys:\n${error.message}`,
    );
    process.exit(1);
  }

  // Read them back, because a write that was accepted and not kept would leave
  // the same broken sign-in behind a script that reported success.
  const after = await readNames();
  if (!after.has("JWT_PRIVATE_KEY") || !after.has("JWKS")) {
    console.error(
      "The local backend did not keep the signing keys, so sign-in would still fail.",
    );
    process.exit(1);
  }

  console.log("The local backend can now issue logins.");
  process.exit(0);
}

const existing = namesOnDeployment();
const hasPrivate = existing.has("JWT_PRIVATE_KEY");
const hasPublic = existing.has("JWKS");

if (hasPrivate || hasPublic) {
  if (!force) {
    console.log(
      "This deployment already has signing keys, so nothing was changed.\n" +
        "They are working as they are — replacing them would sign every device out.\n" +
        "Pass --force if that is what you want.",
    );
    process.exit(0);
  }
  console.log("Replacing the deployment's signing keys (--force).");
}

set("JWT_PRIVATE_KEY", privateKey);
set("JWKS", jwks);

console.log(
  "Signing keys set. Sign-in will work from now on" +
    (force ? " — every existing session was invalidated by the change." : "."),
);
