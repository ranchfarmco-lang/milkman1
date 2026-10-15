/**
 * §18 Device pairing, §48 QR codes.
 *
 * A pairing code is short enough to read aloud and short-lived enough to be
 * safe: it exists for five minutes, it can be used once, and it is stored only
 * as a hash so a copy of the config file cannot be replayed. What a device
 * receives in exchange is a long random secret, also stored only as a hash,
 * which the device sends on every later request until the user revokes it.
 *
 * There is deliberately no "permanent unrestricted code" here, because the
 * specification forbids one. Revoking a device is immediate and total.
 */

import { config, type DevicePairing } from "../storage/config.ts";
import { fingerprint, randomCode, randomToken } from "../storage/secrets.ts";
import { log } from "../core/log.ts";

export type PendingCode = {
  code: string;
  label: string;
  createdAt: number;
  expiresAt: number;
  usedBy: string | null;
};

const CODE_LIFETIME_MS = 5 * 60_000;

export class PairingService {
  /** Codes that have not yet been claimed. Never persisted. */
  private pending = new Map<string, PendingCode>();

  /** §18 — show a new pairing code. The QR carries the portal URL plus this. */
  begin(label: string): PendingCode {
    this.prune();
    const code = randomCode(6);
    const now = Date.now();
    const entry: PendingCode = { code, label, createdAt: now, expiresAt: now + CODE_LIFETIME_MS, usedBy: null };
    this.pending.set(code, entry);
    log.info("security", "A device pairing code was created.", { label, expiresInMinutes: 5 });
    return entry;
  }

  /** The code a device presents, plus the portal URL it was told to use. */
  async claim(code: string, label: string): Promise<{ ok: boolean; secret: string | null; reason: string }> {
    this.prune();
    const entry = this.pending.get(code.trim());
    if (!entry || entry.usedBy) {
      return { ok: false, secret: null, reason: "That pairing code is not valid any more. Ask for a new one on the host." };
    }
    if (entry.expiresAt <= Date.now()) {
      this.pending.delete(entry.code);
      return { ok: false, secret: null, reason: "That pairing code has expired. Codes last five minutes." };
    }

    // Single use, immediately.
    entry.usedBy = label;
    const secret = randomToken(32);
    const device: DevicePairing = {
      id: randomToken(9),
      label: label.slice(0, 40) || entry.label,
      secretHash: fingerprint(secret, "device"),
      pairedAt: Date.now(),
      lastSeen: null,
      revoked: false,
    };
    const devices = [device, ...config.get("devices")].slice(0, 50);
    config.set("devices", devices);
    this.pending.delete(entry.code);
    log.info("security", "A device was paired.", { label: device.label, id: device.id });
    return { ok: true, secret, reason: "Paired." };
  }

  /** Do the credentials this device sent belong to a live paired device? */
  verify(deviceId: string, secret: string): DevicePairing | null {
    const device = config.get("devices").find((entry) => entry.id === deviceId);
    if (!device || device.revoked) return null;
    if (device.secretHash !== fingerprint(secret, "device")) return null;
    // Remember the last time it was seen, but do not rewrite the file on every
    // request — once a minute is enough for "last connection" (§36).
    if (!device.lastSeen || Date.now() - device.lastSeen > 60_000) {
      const devices = config.get("devices").map((entry) =>
        entry.id === deviceId ? { ...entry, lastSeen: Date.now() } : entry,
      );
      config.set("devices", devices);
    }
    return device;
  }

  list(): DevicePairing[] {
    return config.get("devices");
  }

  /** §18 — revocable, immediately. */
  revoke(id: string): boolean {
    const devices = config.get("devices");
    const index = devices.findIndex((entry) => entry.id === id);
    if (index < 0) return false;
    devices[index] = { ...devices[index], revoked: true };
    config.set("devices", devices);
    log.warn("security", "A paired device was revoked.", { id });
    return true;
  }

  revokeAll(): number {
    const devices = config.get("devices").map((entry) => ({ ...entry, revoked: true }));
    config.set("devices", devices);
    log.warn("security", "Every paired device was revoked.", { count: devices.length });
    return devices.length;
  }

  /** Remove revoked and long-unused devices from the file entirely. */
  forgetRevoked(): number {
    const devices = config.get("devices").filter((entry) => !entry.revoked);
    const removed = config.get("devices").length - devices.length;
    if (removed) config.set("devices", devices);
    return removed;
  }

  private prune(): void {
    const now = Date.now();
    for (const [code, entry] of this.pending) {
      if (entry.expiresAt <= now || entry.usedBy) this.pending.delete(code);
    }
  }

  /** The pending codes, for the host's own UI. Codes are never listed. */
  pendingCount(): number {
    this.prune();
    return this.pending.size;
  }
}

export const pairing = new PairingService();
