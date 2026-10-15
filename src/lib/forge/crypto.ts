/**
 * The vault: API keys and deploy tokens, encrypted at rest in IndexedDB.
 *
 * A single non-extractable AES-GCM key is generated once and kept in IndexedDB
 * itself (browsers clone `CryptoKey` objects structurally, so it never exists
 * as bytes anyone can read out). Every secret is encrypted with a fresh
 * random IV before it is written. The plain text never touches a file, never
 * leaves this browser except on the explicit call to the provider the key
 * belongs to, and is handed back as a string only for the length of one
 * request.
 *
 * If the browser refuses (no `crypto.subtle` — a non-secure origin), the vault
 * says so rather than silently storing something weaker.
 */
import { forgeDb } from "./db";

let cached: CryptoKey | null = null;

/** The master key, created on first use. */
async function masterKey(): Promise<CryptoKey> {
  if (cached) return cached;
  if (!globalThis.crypto?.subtle) {
    throw new Error(
      "This browser will not offer encrypted storage on this address. A secure context (https or localhost) is needed before keys can be kept.",
    );
  }

  const existing = await forgeDb.vault.get("master");
  if (existing?.key) {
    cached = existing.key;
    return cached;
  }

  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  await forgeDb.vault.put({ id: "master", key });
  cached = key;
  return key;
}

/** Encrypt and store one secret under a stable id (`provider:openai`, `github`, …). */
export async function putSecret(id: string, value: string): Promise<void> {
  const trimmed = value.trim();
  if (!trimmed) {
    await deleteSecret(id);
    return;
  }
  const key = await masterKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(trimmed)),
  );
  await forgeDb.secrets.put({ id, iv, data, updatedAt: Date.now() });
}

/** Read one secret back, or null when there is none. */
export async function getSecret(id: string): Promise<string | null> {
  const row = await forgeDb.secrets.get(id);
  if (!row) return null;
  try {
    const key = await masterKey();
    const iv = new Uint8Array(row.iv);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, new Uint8Array(row.data));
    return new TextDecoder().decode(plain);
  } catch {
    // A key written by an older profile or a damaged row reads as nothing.
    return null;
  }
}

/** Forget one secret — Clear Keys and the factory reset use this. */
export async function deleteSecret(id: string): Promise<void> {
  await forgeDb.secrets.delete(id);
}

/** Which secrets exist right now — ids only, never the values. */
export async function secretIds(): Promise<string[]> {
  return (await forgeDb.secrets.toCollection().primaryKeys()) as string[];
}

/** Forget every secret at once. */
export async function clearSecrets(): Promise<void> {
  await forgeDb.secrets.clear();
}
