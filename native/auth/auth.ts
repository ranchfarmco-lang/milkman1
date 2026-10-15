/**
 * §17 Authentication, §40 security, §41 control plane vs data plane.
 *
 * The rules this file implements, in the order the specification gives them:
 *
 *   · a password is never stored, only a scrypt hash of it, compared in
 *     constant time (§40);
 *   · a session is a random 32-byte token, held in memory and handed to the
 *     browser as an `HttpOnly`, `SameSite=Lax` cookie over the tunnel's TLS;
 *   · sessions expire, and can be listed and ended one by one;
 *   · repeated failures lock the account out for a while, with the delay
 *     growing, so an online guessing attack is not viable (§17);
 *   · administrative actions need a session that was created as an admin
 *     session — a data-plane session can read the dashboard and nothing more
 *     (§41);
 *   · a state-changing request needs a CSRF token that matches the session,
 *     because a cookie alone is not proof of intent (§40).
 *
 * `unlocked` mirrors the hub's own access rule: with no password configured the
 * host is open, and the moment one is set every privileged route requires it.
 */

import { createHmac, scryptSync, timingSafeEqual } from "node:crypto";
import { config } from "../storage/config.ts";
import { fingerprint, getSecret, putSecret, randomToken } from "../storage/secrets.ts";
import { log } from "../core/log.ts";

export type Role = "admin" | "viewer";

export type Session = {
  token: string;
  csrf: string;
  role: Role;
  /** What created it, for the "device/session management" part of §17. */
  label: string;
  createdAt: number;
  lastSeen: number;
  expiresAt: number;
  ip: string | null;
};

/**
 * A session with its two secrets taken out.
 *
 * `list()` is what the device/session screen reads, so it must never carry a
 * token or a CSRF secret out of the process — the copy is made first, then
 * those two keys are dropped from it, rather than naming them in a destructuring
 * pattern that a later field added to `Session` would silently keep.
 */
function publicSession(session: Session): Omit<Session, "token" | "csrf"> {
  const copy = { ...session };
  delete (copy as Partial<Session>).token;
  delete (copy as Partial<Session>).csrf;
  return copy;
}

export type SignInResult =
  | { ok: true; session: Session }
  | { ok: false; reason: "locked" | "bad-credentials" | "no-password"; retryAfterSeconds: number };

const PASSWORD_SECRET = "portal-password";
const SALT = "sugar-portal-v1";

/** Constant-time comparison that never throws on a length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) {
    // Still burn the same time, so length is not a timing oracle.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

export function hashPassword(password: string): string {
  return scryptSync(password, SALT, 64).toString("hex");
}

export class AuthService {
  private sessions = new Map<string, Session>();
  /** Failed attempts per client, for the lockout in §17. */
  private failures = new Map<string, { count: number; until: number }>();

  /** Whether a portal password exists at all. */
  hasPassword(): boolean {
    return Boolean(getSecret(PASSWORD_SECRET));
  }

  /** Set or replace the portal password (§17, §40 — never stored plainly). */
  setPassword(password: string, label = "console"): { ok: boolean; session: Session | null } {
    if (password.trim().length < 8) {
      return { ok: false, session: null };
    }
    const backend = putSecret(PASSWORD_SECRET, hashPassword(password));
    config.patch("security", { requireAuth: true });
    log.info("security", `Portal password set; stored by ${backend}.`);
    this.failures.clear();
    return { ok: true, session: this.createSession("admin", label, null) };
  }

  async clearPassword(): Promise<void> {
    const { deleteSecret } = await import("../storage/secrets.ts");
    deleteSecret(PASSWORD_SECRET);
    this.sessions.clear();
    log.warn("security", "Portal password cleared — the portal is open again.");
  }

  /** §17 — the lockout state for one client, without revealing the password. */
  lockState(key: string): { locked: boolean; retryAfterSeconds: number; attemptsLeft: number } {
    const security = config.get("security");
    const record = this.failures.get(key);
    const now = Date.now();
    if (!record || record.until <= now) {
      return { locked: false, retryAfterSeconds: 0, attemptsLeft: security.maxAttempts };
    }
    return {
      locked: true,
      retryAfterSeconds: Math.ceil((record.until - now) / 1000),
      attemptsLeft: 0,
    };
  }

  private recordFailure(key: string): void {
    const security = config.get("security");
    const now = Date.now();
    const record = this.failures.get(key) ?? { count: 0, until: 0 };
    record.count += 1;
    // Exponential, capped: 5 failures = 1 minute, then 2, 4, 8… to `lockoutMinutes`.
    const minutes = Math.min(security.lockoutMinutes, 2 ** (record.count - security.maxAttempts));
    if (record.count >= security.maxAttempts) {
      record.until = now + Math.max(1, minutes) * 60_000;
      log.warn("security", "Too many failed sign-ins; the client is locked out for a while.", {
        failures: record.count,
        minutes,
      });
    }
    this.failures.set(key, record);
  }

  signIn(password: string, clientKey: string, label: string, ip: string | null, role: Role = "admin"): SignInResult {
    const lock = this.lockState(clientKey);
    if (lock.locked) {
      return { ok: false, reason: "locked", retryAfterSeconds: lock.retryAfterSeconds };
    }
    const stored = getSecret(PASSWORD_SECRET);
    if (!stored) return { ok: false, reason: "no-password", retryAfterSeconds: 0 };

    if (!safeEqual(hashPassword(password), stored)) {
      this.recordFailure(clientKey);
      log.warn("security", "A sign-in attempt failed.", { ip });
      return { ok: false, reason: "bad-credentials", retryAfterSeconds: 0 };
    }

    this.failures.delete(clientKey);
    const session = this.createSession(role, label, ip);
    log.info("security", "Signed in.", { label, role, ip });
    return { ok: true, session };
  }

  createSession(role: Role, label: string, ip: string | null): Session {
    const security = config.get("security");
    const now = Date.now();
    const session: Session = {
      token: randomToken(32),
      csrf: randomToken(18),
      role,
      label,
      createdAt: now,
      lastSeen: now,
      expiresAt: now + security.sessionMinutes * 60_000,
      ip,
    };
    this.sessions.set(session.token, session);
    return session;
  }

  /** A session presented with a request, refreshed on use, or null. */
  verify(token: string | null, touch = true): Session | null {
    if (!token) return null;
    const session = this.sessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      log.info("security", "A session expired.", { label: session.label });
      return null;
    }
    if (touch) session.lastSeen = Date.now();
    return session;
  }

  /** §40 CSRF: the token must belong to the same session as the cookie. */
  csrfValid(session: Session | null, presented: string | null): boolean {
    if (!session) return false;
    if (!presented) return false;
    return safeEqual(session.csrf, presented);
  }

  signOut(token: string | null): boolean {
    if (!token) return false;
    const removed = this.sessions.delete(token);
    if (removed) log.info("security", "Signed out.");
    return removed;
  }

  /** §17 device/session management. */
  list(): Omit<Session, "token" | "csrf">[] {
    const now = Date.now();
    return [...this.sessions.values()]
      .filter((session) => session.expiresAt > now)
      .map(publicSession)
      .sort((a, b) => b.lastSeen - a.lastSeen);
  }

  endAll(): number {
    const count = this.sessions.size;
    this.sessions.clear();
    log.warn("security", `All sessions ended (${count}).`);
    return count;
  }

  /**
   * §41 — an admin session, proven by a signed marker rather than by trusting
   * a header. The signature uses the same secret material as the password hash,
   * so a forged marker needs the password.
   */
  adminProof(session: Session): string {
    const secret = getSecret(PASSWORD_SECRET) ?? "open";
    return createHmac("sha256", secret).update(`${session.token}:${session.role}`).digest("base64url");
  }

  verifyAdminProof(session: Session | null, proof: string | null): boolean {
    if (!session || session.role !== "admin" || !proof) return false;
    return safeEqual(this.adminProof(session), proof);
  }

  /**
   * Whether the host is open. Mirrors the hub's rule: no password configured
   * means unrestricted, a password configured means every privileged route
   * demands it. `requireAuth: false` never applies to the admin routes.
   */
  unlocked(): boolean {
    return !this.hasPassword();
  }

  /** The cookie value for a session, and the header the portal reads. */
  cookie(session: Session): string {
    const security = config.get("security");
    const parts = [
      `sugar_session=${session.token}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${security.sessionMinutes * 60}`,
    ];
    if (security.httpsOnlyRemote) parts.push("Secure");
    return parts.join("; ");
  }

  /** A short fingerprint for the session list, safe to log. */
  static fingerprintOf(token: string): string {
    return fingerprint(token, "session").slice(0, 16);
  }
}

export const auth = new AuthService();
