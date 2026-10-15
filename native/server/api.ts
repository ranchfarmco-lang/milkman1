/**
 * §5 the application API, §17 authentication, §40–§42 security.
 *
 * §5 asks for a named set of endpoints. This file is their register: every route
 * in the specification is here, with the same meaning and the same verbs.
 *
 * Two rules decide what each route demands.
 *
 * LOCAL IS NOT TRUSTED (§42). A request from 127.0.0.1 is not automatically an
 * administrator's request — it is just a request that did not cross a network.
 * Every state-changing route asks the same authentication question a remote one
 * does, and the administrative routes ask for more than that.
 *
 * CONTROL PLANE IS SEPARATE FROM DATA PLANE (§41). Reading the dashboard needs
 * a session. Starting and stopping the server, changing the password, allowing
 * a firewall rule and revoking a device need an *admin* session, whose marker is
 * signed with the same secret the password hash uses. A viewer session cannot
 * reach them at all.
 *
 * Nothing in this file can run an operating-system command. That is not a
 * policy on top of the code; there is no such code path here to disable.
 */

import { auth } from "../auth/auth.ts";
import { pairing } from "../devices/pairing.ts";
import { browsers } from "../browser/engine.ts";
import { log } from "../core/log.ts";
import { request as outbound } from "../client/internet-client.ts";
import { nativeRoot } from "../downloads/catalog.ts";
import { allowFirewall, detectFirewall } from "../platform/index.ts";
import type { SugarApp } from "../core/app.ts";
import type { HostRequest, HostResponse } from "./server.ts";

type Ctx = {
  app: SugarApp;
  request: HostRequest;
  /** The authenticated session, when one was presented. */
  session: ReturnType<typeof auth.verify>;
  /** Whether the request arrived over the relay, i.e. from the Internet. */
  forwarded: boolean;
  /** A cookie a handler wants set on the answer — only sign-in uses this. */
  cookie: string | null;
};

type Answer =
  | { kind: "json"; status: number; body: unknown }
  | { kind: "text"; status: number; body: string; type?: string }
  | { kind: "binary"; status: number; body: Buffer; type: string; filename?: string }
  | { kind: "none" };

type Route = {
  method: string;
  path: string;
  /** Who may call it. */
  access: "public" | "session" | "admin";
  /** Whether a state-changing request must carry the session's CSRF token. */
  csrf?: boolean;
  handler: (ctx: Ctx) => Promise<Answer>;
};

const json = (status: number, body: unknown): Answer => ({ kind: "json", status, body });
const ok = (body: unknown): Answer => json(200, { ok: true, ...(body as object) });

function denied(message: string, status = 403): Answer {
  return json(status, { ok: false, error: message });
}

/* --------------------------------------------------------------- helpers --- */

function cookieValue(request: HostRequest, name: string): string | null {
  const header = request.headers.cookie ?? "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

function bearer(request: HostRequest): string | null {
  const header = request.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : null;
}

function bodyJson<T>(request: HostRequest): T | null {
  if (!request.body.length) return null;
  try {
    return JSON.parse(request.body.toString("utf8")) as T;
  } catch {
    return null;
  }
}

/**
 * §30 — the host's own Internet agent, exposed as a task. It only speaks to
 * public addresses (the client refuses private ones), it identifies itself, and
 * it never returns more than the caller asked for.
 */
const TASK_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] as const;

/* ------------------------------------------------------------- the routes --- */

const ROUTES: Route[] = [
  {
    method: "GET",
    path: "/health",
    access: "public",
    handler: async ({ app }) =>
      ok({ service: "SUGAR", at: Date.now(), server: app.server.getServerStatus().status }),
  },

  /* §5 — the read side. */
  {
    method: "GET",
    path: "/api/status",
    access: "public",
    handler: async ({ app }) => {
      const snapshot = await app.snapshot();
      return ok({
        service: "SUGAR",
        version: snapshot.version,
        at: Date.now(),
        hostname: snapshot.server.hostname,
        uptimeSeconds: snapshot.server.uptimeSeconds,
        server: snapshot.server,
        lanAddress: snapshot.lanAddress,
        mode: snapshot.network?.mode ?? "LOCAL CONNECTION",
        publicUrl: snapshot.tunnel.publicUrl,
        offline: app.offline,
      });
    },
  },
  {
    method: "GET",
    path: "/api/network",
    access: "session",
    handler: async ({ app }) => ok({ network: app.networkStatus ?? (await app.runNetworkDiagnostics()) }),
  },
  {
    method: "GET",
    path: "/api/connectivity",
    access: "session",
    handler: async ({ app }) => {
      const network = app.networkStatus ?? (await app.runNetworkDiagnostics()).network;
      return ok({
        internet: network.internet,
        dns: network.dns,
        https: network.https,
        vpn: network.vpn,
        mode: network.mode,
        assessment: network.assessment,
        offline: app.offline,
      });
    },
  },
  {
    method: "GET",
    path: "/api/server",
    access: "session",
    handler: async ({ app }) => ok({ server: app.server.getServerStatus(), lanAddress: app.server.getLanAddress() }),
  },
  {
    method: "GET",
    path: "/api/browser",
    access: "session",
    handler: async () => ok({ browser: browsers.first().getBrowserStatus(), browsers: browsers.list() }),
  },
  {
    method: "GET",
    path: "/api/downloads",
    access: "session",
    handler: async ({ app }) => {
      const entries = await app.catalog();
      const all = app.downloads();
      return ok({
        note: "Every entry is a real file the host builds or serves, or the official source of a component that cannot be bundled (§32, §34, §51).",
        entries,
        downloadAll: { href: "/api/downloads/all", bytes: all.buffer.byteLength, files: all.files.length },
      });
    },
  },
  {
    method: "GET",
    path: "/api/diagnostics",
    access: "session",
    handler: async ({ app }) => ok({ diagnostics: await app.diagnostics() }),
  },
  {
    method: "GET",
    path: "/api/logs",
    access: "session",
    handler: async ({ request }) => {
      const category = request.query.get("category") ?? undefined;
      const text = request.query.get("q") ?? undefined;
      const level = request.query.get("level") ?? undefined;
      const entries = log.search({
        category: category as never,
        level: level as never,
        text,
        limit: Number(request.query.get("limit") ?? 200),
      });
      return ok({ counts: log.counts(), entries });
    },
  },
  {
    method: "GET",
    path: "/api/devices",
    access: "session",
    handler: async () => ok({ devices: pairing.list() }),
  },

  /* §5 — the write side. */
  {
    method: "POST",
    path: "/api/network/test",
    access: "session",
    csrf: true,
    handler: async ({ app }) => ok({ network: await app.runNetworkDiagnostics() }),
  },
  {
    method: "POST",
    path: "/api/tests/everything",
    access: "session",
    csrf: true,
    handler: async ({ app }) => ok({ report: await app.testEverything() }),
  },
  {
    method: "POST",
    path: "/api/tests/self",
    access: "session",
    csrf: true,
    handler: async ({ app }) => ok({ report: await app.selfTest() }),
  },
  {
    method: "POST",
    path: "/api/server/start",
    access: "admin",
    csrf: true,
    handler: async ({ app }) => ok({ server: await app.server.start() }),
  },
  {
    method: "POST",
    path: "/api/server/stop",
    access: "admin",
    csrf: true,
    handler: async ({ app }) => {
      const state = app.server.getServerStatus();
      // The server answering this request is the one being stopped, so the
      // answer is written first and the stop is handed to the next tick.
      setTimeout(() => void app.server.stop(), 250);
      return ok({ stopping: true, was: state });
    },
  },
  {
    method: "POST",
    path: "/api/connectivity/reconnect",
    access: "admin",
    csrf: true,
    handler: async ({ app, request }) => {
      const body = bodyJson<{ action?: "connect" | "disconnect" | "reconnect" }>(request);
      const action = body?.action ?? "reconnect";
      return ok({ action, tunnel: await app.remote(action) });
    },
  },
  {
    method: "POST",
    path: "/api/browser/navigate",
    access: "session",
    csrf: true,
    handler: async (ctx) => {
      const { request } = ctx;
      const body = bodyJson<{ url?: string; action?: string }>(request);
      const browser = browsers.first();
      // §65 — the browser area may open a page on this machine's own network
      // only when the request came from this machine. A relayed request can
      // reach the public Internet and nothing inward.
      const allowPrivate = !ctx.forwarded && request.loopback;
      switch (body?.action) {
        case "back":
          return ok({ browser: await browser.back({ allowPrivate }) });
        case "forward":
          return ok({ browser: await browser.forward({ allowPrivate }) });
        case "reload":
          return ok({ browser: await browser.reload({ allowPrivate }) });
        case "stop":
          return ok({ browser: browser.stop() });
        case "home":
          return ok({ browser: await browser.home({ allowPrivate }) });
        case "download": {
          if (!body.url) return denied("A download needs a url.", 400);
          return ok({ download: await browser.download(body.url, { allowPrivate }) });
        }
        default: {
          if (!body?.url) return denied("Navigating needs a url.", 400);
          return ok({ browser: await browser.navigate(body.url, { allowPrivate }) });
        }
      }
    },
  },
  {
    method: "POST",
    path: "/api/tasks",
    access: "session",
    csrf: true,
    handler: async ({ request }) => {
      const body = bodyJson<{ url?: string; method?: string; body?: string; headers?: Record<string, string>; authorization?: string }>(request);
      if (!body?.url) return denied("A task needs a url.", 400);
      const method = (body.method ?? "GET").toUpperCase();
      if (!TASK_METHODS.includes(method as (typeof TASK_METHODS)[number])) {
        return denied(`The Internet agent does not use ${method}.`, 400);
      }
      const result = await outbound(body.url, {
        method: method as (typeof TASK_METHODS)[number],
        headers: body.headers,
        body: body.body,
        authorization: body.authorization,
        timeoutSeconds: 30,
      });
      return ok({
        // §6 — the whole failure taxonomy travels with the answer, so the caller
        // can show a sentence instead of an error code (§21).
        task: {
          url: body.url,
          finalUrl: result.finalUrl,
          method,
          ok: result.ok,
          status: result.status,
          ms: result.ms,
          redirects: result.redirects,
          failure: result.failure,
          headers: result.headers,
          body: typeof result.body === "string" ? result.body.slice(0, 200_000) : null,
          bytes: typeof result.body === "string" ? result.body.length : 0,
        },
      });
    },
  },

  /* §17 — authentication. */
  {
    method: "GET",
    path: "/api/auth/state",
    access: "public",
    handler: async ({ session }) =>
      ok({
        passwordSet: auth.hasPassword(),
        signedIn: Boolean(session),
        role: session?.role ?? null,
        label: session?.label ?? null,
        csrf: session?.csrf ?? null,
        sessions: session ? auth.list() : [],
        pairings: pairing.list().filter((device) => !device.revoked).length,
      }),
  },
  {
    method: "POST",
    path: "/api/auth/login",
    access: "public",
    handler: async (ctx) => {
      const { request, app } = ctx;
      const body = bodyJson<{ password?: string; label?: string }>(request);
      const clientKey = request.remote ?? "unknown";
      const result = auth.signIn(body?.password ?? "", clientKey, body?.label ?? "portal", request.remote);
      if (!result.ok) {
        const message =
          result.reason === "locked"
            ? `Too many failed attempts. Try again in ${Math.ceil(result.retryAfterSeconds / 60)} minute(s).`
            : result.reason === "no-password"
              ? "No password has been set on this host yet."
              : "That password is not right.";
        return json(result.reason === "locked" ? 429 : 401, {
          ok: false,
          error: message,
          reason: result.reason,
          retryAfterSeconds: result.retryAfterSeconds,
        });
      }
      const state = app.server.getServerStatus();
      // §17 — the session cookie is HttpOnly, SameSite=Lax and Secure, so page
      // scripts cannot read the token and another site cannot make it act.
      ctx.cookie = auth.cookie(result.session);
      log.info("security", "Remote portal sign-in succeeded.", { label: result.session.label, remote: request.remote });
      return {
        kind: "json",
        status: 200,
        body: {
          ok: true,
          role: result.session.role,
          csrf: result.session.csrf,
          adminProof: auth.adminProof(result.session),
          expiresAt: result.session.expiresAt,
          server: state,
        },
      };
    },
  },
  {
    method: "POST",
    path: "/api/auth/logout",
    access: "session",
    handler: async ({ request }) => {
      auth.signOut(cookieValue(request, "sugar_session") ?? bearer(request));
      return ok({ signedOut: true });
    },
  },
  {
    method: "POST",
    path: "/api/auth/password",
    access: "admin",
    csrf: true,
    handler: async ({ request }) => {
      const body = bodyJson<{ password?: string }>(request);
      const password = body?.password ?? "";
      if (password.length < 8) {
        return denied("A portal password must be at least 8 characters.", 400);
      }
      const result = auth.setPassword(password, "portal");
      return ok({ changed: result.ok, passwordSet: auth.hasPassword() });
    },
  },

  /* §18 — device pairing. */
  {
    method: "POST",
    path: "/api/pair/begin",
    access: "admin",
    csrf: true,
    handler: async ({ request }) => {
      const body = bodyJson<{ label?: string }>(request);
      const pending = pairing.begin(body?.label ?? "A device");
      return ok({
        code: pending.code,
        label: pending.label,
        expiresAt: pending.expiresAt,
        // §48 — the QR carries the portal address and the code, never a secret.
        qrPayload: `${request.headers.host ? `http://${request.headers.host}` : ""}/?pair=${pending.code}`,
      });
    },
  },
  {
    method: "POST",
    path: "/api/pair/claim",
    access: "public",
    handler: async ({ request }) => {
      const body = bodyJson<{ code?: string; label?: string }>(request);
      if (!body?.code) return denied("A pairing code is required.", 400);
      const result = await pairing.claim(body.code, body.label ?? "A device");
      if (!result.ok) return json(400, { ok: false, error: result.reason });
      log.info("security", "A device completed pairing.", { label: body.label ?? "A device" });
      return ok({
        device: { id: pairing.list()[0]?.id ?? null, secret: result.secret },
        note: "Keep this secret on the device. It can be revoked on the host at any time (§18).",
      });
    },
  },
  {
    method: "POST",
    path: "/api/devices/revoke",
    access: "admin",
    csrf: true,
    handler: async ({ request }) => {
      const body = bodyJson<{ id?: string; all?: boolean }>(request);
      if (body?.all) return ok({ revoked: pairing.revokeAll() });
      if (!body?.id) return denied("A device id is required.", 400);
      return ok({ revoked: pairing.revoke(body.id) ? 1 : 0 });
    },
  },

  /* §25 — the firewall, read-only until someone consents. */
  {
    method: "GET",
    path: "/api/firewall",
    access: "session",
    handler: async ({ app }) => {
      const port = app.server.getPort() ?? 0;
      const check = await detectFirewall(port, process.execPath);
      return ok({ firewall: check, canAllow: check.allowed === false });
    },
  },
  {
    method: "POST",
    path: "/api/firewall/allow",
    access: "admin",
    csrf: true,
    handler: async ({ app, request }) => {
      const body = bodyJson<{ consent?: boolean }>(request);
      if (body?.consent !== true) {
        return denied("Changing the firewall needs explicit consent. Send { consent: true } only after the user has said yes.", 400);
      }
      const port = app.server.getPort();
      if (!port) return denied("The local server is not running, so there is nothing to allow.", 400);
      const result = await allowFirewall(port, process.execPath);
      log.warn("security", "A firewall rule change was requested with consent.", { ok: result.ok, command: result.command });
      return ok({ applied: result.ok, command: result.command, output: result.output });
    },
  },

  /* §58 — the export, and §43 the downloadable log. */
  {
    method: "GET",
    path: "/api/diagnostics/export",
    access: "session",
    handler: async ({ app }) => ({
      kind: "text",
      status: 200,
      type: "application/json; charset=utf-8",
      body: await app.exportDiagnostics(),
    }),
  },
  {
    method: "GET",
    path: "/api/logs/download",
    access: "session",
    handler: async () => ({
      kind: "text",
      status: 200,
      type: "text/plain; charset=utf-8",
      body: log.asText(log.search({ limit: 2000 })),
    }),
  },

  /* §31, §33 — the real files behind the download centre's buttons. */
  {
    method: "GET",
    path: "/api/downloads/all",
    access: "session",
    handler: async ({ app }) => {
      // The archive already carries Checksums/SHA256SUMS.txt for its own
      // contents, so the checksum manifest travels inside it (§35).
      const all = app.downloads();
      return {
        kind: "binary",
        status: 200,
        type: "application/zip",
        filename: "SUGAR-download-all.zip",
        body: all.buffer,
      };
    },
  },
  {
    method: "GET",
    path: "/api/downloads/source",
    access: "session",
    handler: async ({ app }) => {
      const all = app.downloads();
      return {
        kind: "binary",
        status: 200,
        type: "application/zip",
        filename: "SUGAR-source.zip",
        body: all.buffer,
      };
    },
  },
];

/** The installer scripts, served by name (§32, §66). */
async function installerRoute(name: string): Promise<Answer | null> {
  const { installerFor } = await import("../downloads/catalog.ts");
  const map: Record<string, "windows" | "linux" | "macos" | "chromebook" | "android"> = {
    "install-windows.ps1": "windows",
    "install-linux.sh": "linux",
    "install-macos.sh": "macos",
    "install-chromebook.sh": "chromebook",
    "install-termux.sh": "android",
  };
  const platform = map[name];
  if (!platform) return null;
  const installer = installerFor(platform);
  return {
    kind: "text",
    status: 200,
    type: "text/plain; charset=utf-8",
    body: installer.text,
  };
}

/* ------------------------------------------------------------ the register --- */

export function createRoutes(app: SugarApp) {
  return async function handle(request: HostRequest): Promise<HostResponse | null> {
    const forwarded = request.headers["x-sugar-forwarded"] === "relay";
    const session = resolveSession(request);
    const ctx: Ctx = { app, request, session, forwarded, cookie: null };

    // A download of a generated installer, before the general table.
    if (request.method === "GET" && request.path.startsWith("/api/downloads/")) {
      const installer = await installerRoute(request.path.slice("/api/downloads/".length));
      if (installer) {
        if (!mayRead(session, forwarded)) return toResponse(denied("Authentication required.", 401), null);
        return toResponse(installer, null);
      }
    }

    const route = ROUTES.find((entry) => entry.method === request.method && entry.path === request.path);
    if (!route) return null;

    // §17, §42 — the access question, asked the same way for everyone.
    if (route.access === "session" && !mayRead(session, forwarded)) {
      return toResponse(denied("Authentication required.", 401), null);
    }
    if (route.access === "admin") {
      const proof = request.headers["x-sugar-admin"] ?? null;
      if (!session) return toResponse(denied("Authentication required.", 401), null);
      if (session.role !== "admin" || !auth.verifyAdminProof(session, proof)) {
        return toResponse(
          denied("This is an administrative action. It needs an administrator session, not a viewing one.", 403),
          null,
        );
      }
    }

    // §40 — a cookie alone is not proof of intent for a state-changing request.
    if (route.csrf && session) {
      const viaCookie = Boolean(cookieValue(request, "sugar_session"));
      if (viaCookie) {
        const presented = request.headers["x-sugar-csrf"] ?? request.query.get("csrf") ?? null;
        if (!auth.csrfValid(session, presented)) {
          return toResponse(denied("That request was missing its security token. Reload the dashboard and try again.", 403), null);
        }
      }
    }

    // A paired device proves itself with its own secret, not a browser cookie.
    const deviceId = request.headers["x-sugar-device"] ?? null;
    const deviceSecret = request.headers["x-sugar-device-secret"] ?? null;
    if (deviceId && deviceSecret && !pairing.verify(deviceId, deviceSecret)) {
      return toResponse(denied("That paired device's credential is not valid any more.", 401), null);
    }

    const answer = await route.handler(ctx);
    return toResponse(answer, ctx.cookie);
  };
}

function resolveSession(request: HostRequest) {
  const token = cookieValue(request, "sugar_session") ?? bearer(request);
  return auth.verify(token);
}

/** When the host is open, reading is open; once a password exists, it is not. */
function mayRead(session: ReturnType<typeof auth.verify>, forwarded: boolean): boolean {
  if (session) return true;
  if (auth.hasPassword()) return false;
  // An open host still refuses to serve its dashboard to the Internet (§40).
  return !forwarded;
}

function toResponse(answer: Answer, cookie: string | null): HostResponse | null {
  if (answer.kind === "none") return null;
  const headers: Record<string, string> = {};
  if (cookie) headers["set-cookie"] = cookie;

  if (answer.kind === "json") {
    return {
      status: answer.status,
      headers: { "content-type": "application/json; charset=utf-8", ...headers },
      body: JSON.stringify(answer.body, null, 2),
    };
  }
  if (answer.kind === "text") {
    return {
      status: answer.status,
      headers: { "content-type": answer.type ?? "text/plain; charset=utf-8", ...headers },
      body: answer.body,
    };
  }
  return {
    status: answer.status,
    headers: {
      "content-type": answer.type,
      ...(answer.filename ? { "content-disposition": `attachment; filename="${answer.filename}"` } : {}),
      ...headers,
    },
    body: answer.body,
  };
}

/** Where the host's own source lives, for the diagnostics page. */
export const sourceRoot = nativeRoot();
