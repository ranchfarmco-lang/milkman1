import { detectDevice, type DeviceInfo } from "@/lib/pwa";

/**
 * Who this installation is.
 *
 * A device is the unit of access for the private hub, so it needs a name that
 * survives reloads and that the server can recognise. Nothing secret lives
 * here: it is an identifier the owner sees in the Control Room, and the browser
 * keeps it so the app does not register itself as a brand-new device every
 * time it opens.
 *
 * A copied build with no storage (a sandboxed frame) generates a fresh id each
 * load, which is the safe direction to fail — it reads as a new device that
 * needs authorising, never as somebody else's.
 */

const DEVICE_KEY = "hub.device.id";
const INSTALLATION_KEY = "hub.device.installation";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage refused — the id stays for this visit only.
  }
}

/** A round of hex from the platform's random source, or Math.random if absent. */
function randomHex(length = 24): string {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, length);
}

function stableId(key: string, prefix: string): string {
  const existing = read(key);
  if (existing) return existing;
  const created = `${prefix}_${randomHex()}`;
  write(key, created);
  return created;
}

/** This installation's stable id. */
export function deviceId(): string {
  return stableId(DEVICE_KEY, "dev");
}

/** The browser profile's id — stable across clearing the device id alone. */
export function installationId(): string {
  return stableId(INSTALLATION_KEY, "inst");
}

/** What to call the device in the Control Room. */
export function deviceName(): string {
  return detectDevice().name;
}

export function deviceInfo(): DeviceInfo {
  return detectDevice();
}
