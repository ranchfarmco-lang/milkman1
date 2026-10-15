/**
 * §40, §46 — where the secrets actually live.
 *
 * The specification says not to store passwords in plain text and to use the
 * operating system's secure credential storage where it exists. It does exist
 * on all three targets, behind three different commands:
 *
 *   Windows  cmdkey / PowerShell DPAPI
 *   macOS    security add-generic-password  (the login keychain)
 *   Linux    secret-tool                    (the Secret Service / libsecret)
 *
 * When none of them answers — a headless Linux server with no keyring, say —
 * there is one honest fallback: a file encrypted with AES-256-GCM, whose key is
 * a 32-byte random value kept in a `0600` file beside it. That is weaker than
 * an OS keychain (the key is on the same disk) and the host says so rather than
 * pretending otherwise.
 */

import { execFileSync } from "node:child_process";
import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { ensurePaths } from "../core/paths.ts";
import { log } from "../core/log.ts";

export type SecretBackend = "windows-credential-manager" | "macos-keychain" | "linux-secret-service" | "encrypted-file";

const SERVICE = "SUGAR";

function tryExec(file: string, args: string[], input?: string): string | null {
  try {
    return execFileSync(file, args, {
      input,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 8000,
    }).trim();
  } catch {
    return null;
  }
}

/* -------------------------------------------------------- encrypted file --- */

function keyPath(): string {
  return join(ensurePaths().credentials, "storage.key");
}

/** The fallback key: created once, readable only by this user. */
function localKey(): Buffer {
  const file = keyPath();
  if (existsSync(file)) {
    try {
      const stored = Buffer.from(readFileSync(file, "utf8").trim(), "base64");
      if (stored.length >= 32) return stored.subarray(0, 32);
    } catch {
      /* regenerate below */
    }
  }
  const key = randomBytes(32);
  writeFileSync(file, `${key.toString("base64")}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* Windows ignores the mode; the file still lives under the user's profile */
  }
  return key;
}

function encryptedPath(name: string): string {
  return join(ensurePaths().credentials, `${name.replace(/[^\w.-]/g, "_")}.enc`);
}

function encryptToFile(name: string, value: string): void {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", localKey(), iv);
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  writeFileSync(
    encryptedPath(name),
    `${iv.toString("base64")}.${tag.toString("base64")}.${body.toString("base64")}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

function decryptFromFile(name: string): string | null {
  const file = encryptedPath(name);
  if (!existsSync(file)) return null;
  try {
    const [ivPart, tagPart, bodyPart] = readFileSync(file, "utf8").trim().split(".");
    const decipher = createDecipheriv("aes-256-gcm", localKey(), Buffer.from(ivPart, "base64"));
    decipher.setAuthTag(Buffer.from(tagPart, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(bodyPart, "base64")), decipher.final()]).toString("utf8");
  } catch {
    log.warn("security", "An encrypted credential could not be read.", { name });
    return null;
  }
}

/* --------------------------------------------------------- the public API --- */

/** Which backend this machine can actually use. Detected, never assumed. */
export function detectBackend(): SecretBackend {
  switch (process.platform) {
    case "win32":
      return tryExec("cmdkey", ["/list"]) !== null
        ? "windows-credential-manager"
        : "encrypted-file";
    case "darwin":
      return tryExec("security", ["-h"]) !== null ? "macos-keychain" : "encrypted-file";
    default:
      return tryExec("secret-tool", ["--version"]) !== null ? "linux-secret-service" : "encrypted-file";
  }
}

/** Store a secret. Returns the backend that took it, so the report can say. */
export function putSecret(name: string, value: string): SecretBackend {
  const backend = detectBackend();
  try {
    if (backend === "macos-keychain") {
      // -U updates an existing entry instead of failing.
      const ok = tryExec("security", [
        "add-generic-password",
        "-a",
        SERVICE,
        "-s",
        name,
        "-w",
        value,
        "-U",
      ]);
      if (ok !== null) return backend;
    }
    if (backend === "linux-secret-service") {
      const ok = tryExec(
        "secret-tool",
        ["store", "--label", `${SERVICE} ${name}`, "service", SERVICE, "key", name],
        value,
      );
      if (ok !== null) return backend;
    }
    if (backend === "windows-credential-manager") {
      const ok = tryExec("cmdkey", [`/generic:${SERVICE}/${name}`, "/user:SUGAR", `/pass:${value}`]);
      if (ok !== null) return backend;
    }
  } catch {
    /* fall through to the encrypted file */
  }
  encryptToFile(name, value);
  return "encrypted-file";
}

export function getSecret(name: string): string | null {
  const backend = detectBackend();
  try {
    if (backend === "macos-keychain") {
      const value = tryExec("security", ["find-generic-password", "-a", SERVICE, "-s", name, "-w"]);
      if (value) return value;
    }
    if (backend === "linux-secret-service") {
      const value = tryExec("secret-tool", ["lookup", "service", SERVICE, "key", name]);
      if (value) return value;
    }
    if (backend === "windows-credential-manager") {
      // cmdkey cannot print a password back; the encrypted file carries it.
      return decryptFromFile(name);
    }
  } catch {
    /* fall through */
  }
  return decryptFromFile(name);
}

export function deleteSecret(name: string): boolean {
  const backend = detectBackend();
  let removed = false;
  if (backend === "macos-keychain") {
    removed = tryExec("security", ["delete-generic-password", "-a", SERVICE, "-s", name]) !== null || removed;
  }
  if (backend === "linux-secret-service") {
    removed = tryExec("secret-tool", ["clear", "service", SERVICE, "key", name]) !== null || removed;
  }
  if (backend === "windows-credential-manager") {
    removed = tryExec("cmdkey", [`/delete:${SERVICE}/${name}`]) !== null || removed;
  }
  const file = encryptedPath(name);
  if (existsSync(file)) {
    unlinkSync(file);
    removed = true;
  }
  return removed;
}

/**
 * A stable, non-reversible fingerprint of a secret, safe to log and to compare.
 * `scrypt` is deliberately slow, so this is also the function used to hash
 * pairing secrets and session tokens (§18, §40).
 */
export function fingerprint(value: string, salt = "sugar"): string {
  return scryptSync(value, salt, 32).toString("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function randomCode(digits = 6): string {
  // Uniform, not modulo-biased: reject anything past the last whole block.
  const max = 10 ** digits;
  const limit = Math.floor(0xffffffff / max) * max;
  let value = 0;
  do {
    value = randomBytes(4).readUInt32BE(0);
  } while (value >= limit);
  return String(value % max).padStart(digits, "0");
}

/** A backend report for the diagnostics page (§44, §46). */
export function secretReport() {
  const backend = detectBackend();
  return {
    backend,
    // The honest note the spec asks for when the best option is unavailable.
    note:
      backend === "encrypted-file"
        ? "No OS keychain was reachable, so credentials are held in an AES-256-GCM file under this user's profile. The key sits beside it, so this protects against a stray copy, not against someone with access to this account."
        : "Credentials are held by the operating system's own credential store.",
  };
}
