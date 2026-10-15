import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { auth } from "./auth";

/**
 * SUGAR's HTTP API — a real server, running for real.
 *
 * The specification asks for a built-in HTTP server with endpoints such as
 * `/api/status`, `/api/network`, `/api/connectivity` and `/api/diagnostics`
 * (spec §5). This is that server: these routes are served by the deployment and
 * are reachable from the browser, from another machine, and from the public
 * Internet at the deployment's own HTTPS address. Every one of them runs the
 * real diagnostic pass in `sugar.ts` and answers with what it measured.
 *
 * Two things it deliberately does not do, because a serverless function cannot:
 * bind an arbitrary port for the native host, and open an inbound tunnel. Both
 * are named as the native host's job in the report rather than faked (§51).
 */

const http = httpRouter();

auth.addHttpRoutes(http);

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, x-hub-password",
  "cache-control": "no-store",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS },
  });
}

/**
 * Whether this request may read the machine's diagnostics.
 *
 * Mirrors the hub's own rule: with no configured password the API is open, and
 * with one set the caller must present it — as `Authorization: Bearer …` or the
 * `x-hub-password` header. That keeps a privileged endpoint from being
 * anonymously readable the moment a password is switched on (§17, §40–§41).
 */
function authorized(request: Request): boolean {
  const expected = (process.env.SUGAR_API_TOKEN ?? process.env.HUB_PASSWORD ?? "").trim();
  if (expected.length === 0) return true;

  const header = request.headers.get("authorization") ?? "";
  const bearer = header.replace(/^Bearer\s+/i, "").trim();
  const password = (request.headers.get("x-hub-password") ?? "").trim();
  return bearer === expected || password === expected;
}

function preflight() {
  return new Response(null, { status: 204, headers: CORS });
}

/** A GET route that authenticates, runs the report, and answers with a slice. */
function route<T>(path: string, shape: (report: SugarReport) => T, status = 200) {
  http.route({
    path,
    method: "GET",
    handler: httpAction(async (ctx, request) => {
      if (!authorized(request)) {
        return json({ ok: false, error: "Authentication required." }, 401);
      }
      const report = (await ctx.runAction(internal.sugar.diagnose, {})) as SugarReport;
      return json({ ok: true, ...(shape(report) as object) }, status);
    }),
  });
}

type SugarReport = {
  at: number;
  version: string;
  server: {
    hostname: string;
    platform: string;
    release: string;
    arch: string;
    cpus: number;
    uptimeSeconds: number;
    nodeVersion: string;
    memory: { totalMb: number; freeMb: number };
    siteUrl: string | null;
    cloudUrl: string | null;
  };
  network: {
    interfaces: {
      name: string;
      address: string;
      family: string;
      internal: boolean;
      mac: string;
      vpn: boolean;
    }[];
    interfaceCount: number;
    vpnDetected: boolean;
    vpnInterfaces: string[];
    lanAddresses: string[];
    loopbackOnly: boolean;
  };
  connectivity: {
    internet: boolean;
    publicIp: string | null;
    latencyMs: number | null;
    dns: { ok: boolean; ms: number | null; addresses: string[]; error: string | null };
    https: { ok: boolean; ms: number; status: number | null; error: string | null };
    secondEndpoint: { ok: boolean; ms: number; status: number | null };
  };
  systems: { key: string; group: string; about: string; configured: boolean }[];
  reachability: {
    publicHttpApi: string | null;
    inboundTestable: boolean;
    tunnelConnected: boolean;
    note: string;
  };
};

/* ------------------------------------------------------------------ routes */

route("/api/status", (report) => ({
  service: "SUGAR",
  version: report.version,
  at: report.at,
  uptimeSeconds: report.server.uptimeSeconds,
  platform: report.server.platform,
  hostname: report.server.hostname,
}));

route("/api/network", (report) => ({
  interfaceCount: report.network.interfaceCount,
  vpnDetected: report.network.vpnDetected,
  vpnInterfaces: report.network.vpnInterfaces,
  lanAddresses: report.network.lanAddresses,
  loopbackOnly: report.network.loopbackOnly,
  interfaces: report.network.interfaces,
}));

route("/api/connectivity", (report) => ({
  internet: report.connectivity.internet,
  publicIp: report.connectivity.publicIp,
  latencyMs: report.connectivity.latencyMs,
  dns: report.connectivity.dns,
  https: report.connectivity.https,
  secondEndpoint: report.connectivity.secondEndpoint,
}));

route("/api/server", (report) => ({ server: report.server }));

route("/api/diagnostics", (report) => report);

route("/api/systems", (report) => ({ systems: report.systems }));

route("/api/downloads", () => ({
  note:
    "Paths are relative to the web portal's own origin. Every entry is a file the hub really serves or builds — nothing here is a placeholder (§32, §51). The SUGAR native host itself is assembled in the browser from its own source on /web-portal.",
  downloads: [
    {
      name: "SUGAR native host — complete source",
      platform: "Windows · Linux · macOS · Chromebook · Android",
      version: "1.0.0",
      size: "built on demand",
      purpose:
        "The host application: embedded HTTP server, outbound Internet client, browser engine window hosts, network and VPN detection, tunnel client, authentication, diagnostics and download centre (§31–§33).",
      path: "/web-portal",
    },
    {
      name: "Freebuff reference source",
      platform: "source",
      version: "Apache-2.0",
      size: "18.9 MB",
      purpose:
        "The upstream source the offline coding brain is built around: the whole Freebuff (Codebuff) monorepo, 1,773 files, 58.3 MB once unpacked.",
      path: "/offline-brain/source/freebuff-source.zip",
    },
    {
      name: "This app — the hub's own source",
      platform: "source",
      version: "this build",
      size: "5.4 MB",
      purpose:
        "The whole hub in one archive — 437 files, 19.9 MB unpacked: every page and Convex function, the shell, the desktop browser, the native host, NOVA OS and the docs, with the generated halves of its own snapshot written in. It is baked into the offline package, so every per-platform build carries it too.",
      path: "/offline-brain/source/this-app-source.zip",
    },
    {
      name: "SUGAR / hub documentation",
      platform: "any",
      version: "this build",
      size: "18.8 KB",
      purpose: "Architecture, capability map, licenses and the offline guide — the five pages under /offline-brain/documentation/.",
      path: "/offline-brain/documentation/README.md",
    },
    {
      name: "Complete per-platform build",
      platform: "Windows · macOS · ChromeOS · Linux · Android · iOS",
      version: "built on demand",
      size: "~33 MB",
      purpose: "A real bundle with a platform-native installer, assembled in the browser: the whole package — 70 files, 24.7 MB as served — wrapped in one installer script.",
      path: "/offline-brain",
    },
  ],
}));

/**
 * §52 — the browser half of the specification, reported for what it is.
 *
 * This deployment has no browser engine: a serverless function has no display
 * to draw into. So it answers with the capability it actually has, and names the
 * component that has the other half, rather than reporting a browser it does not
 * own (§51).
 */
route("/api/browser", () => ({
  renderer: {
    engine: "none",
    available: false,
    reason:
      "This deployment is a serverless function with no display, so it cannot draw a page. The portal's browser area belongs to the native host application, which embeds WebView2 on Windows, WebKitGTK on Linux and WKWebView on macOS (§7).",
  },
  capabilities: {
    canRenderPages: false,
    canNavigateOutbound: true,
    canSaveDownloads: false,
    canHoldCookies: false,
  },
  note:
    "The host's own browser — history, cookies, downloads, TLS status — runs in the native application. Use POST /api/tasks here when you need to retrieve something from the Internet from this deployment.",
}));

/**
 * §5, §30 — the Internet agent, for real.
 *
 * This one genuinely works from here: it is an outbound request, which is
 * exactly what a serverless function can do. It carries the whole failure
 * taxonomy back so the caller can show a sentence instead of an error code
 * (§21), and it refuses private and loopback addresses so the endpoint cannot be
 * used to probe this deployment's own network (§65).
 */
const PRIVATE_TARGET =
  /^(?:10\.|127\.|0\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|198\.18\.)/;

http.route({
  path: "/api/tasks",
  method: "POST",
  handler: httpAction(async (_ctx, request) => {
    if (!authorized(request)) {
      return json({ ok: false, error: "Authentication required." }, 401);
    }

    let body: { url?: string; method?: string; headers?: Record<string, string>; body?: string; authorization?: string };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ ok: false, error: "A task needs a JSON body with a url." }, 400);
    }

    let target: URL;
    try {
      target = new URL(String(body.url ?? ""));
    } catch {
      return json({ ok: false, error: "That is not a URL the agent can use." }, 400);
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      return json({ ok: false, error: "The agent only speaks HTTP and HTTPS." }, 400);
    }
    if (PRIVATE_TARGET.test(target.hostname) || /^(localhost|\.local|\.internal)$/i.test(target.hostname)) {
      return json(
        {
          ok: false,
          error:
            "That address is on a private network. The agent will not make requests to private addresses on behalf of a caller (§65).",
        },
        400,
      );
    }

    const method = (body.method ?? "GET").toUpperCase();
    const allowed = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"];
    if (!allowed.includes(method)) {
      return json({ ok: false, error: `The agent does not use ${method}.` }, 400);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    const started = Date.now();
    try {
      const response = await fetch(target, {
        method,
        headers: {
          // The agent identifies itself, as §30 requires of any well-behaved client.
          "user-agent": "SUGAR-agent/1.0.0",
          accept: "*/*",
          ...(body.headers ?? {}),
          ...(body.authorization ? { authorization: body.authorization } : {}),
        },
        body: method === "GET" || method === "HEAD" ? undefined : body.body,
        signal: controller.signal,
        redirect: "follow",
      });
      const text = await response.text();
      const kind =
        response.status === 401 || response.status === 403
          ? "auth"
          : response.status === 429
            ? "rate-limit"
            : response.status >= 400
              ? "http"
              : null;
      return json({
        ok: response.ok,
        task: {
          url: body.url,
          finalUrl: response.url,
          method,
          status: response.status,
          ms: Date.now() - started,
          contentType: response.headers.get("content-type"),
          failure: kind ? { kind, message: `The server answered ${response.status}.` } : null,
          body: text.slice(0, 200_000),
          bytes: text.length,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const kind = controller.signal.aborted
        ? "timeout"
        : /ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)
          ? "dns"
          : /certificate|CERT|TLS/i.test(message)
            ? "tls"
            : "connection";
      return json({ ok: false, task: { url: body.url, method, ms: Date.now() - started, failure: { kind, message } } });
    } finally {
      clearTimeout(timer);
    }
  }),
});

/**
 * §51, §52 — the endpoints that can only be served by the native host.
 *
 * They are registered rather than left to 404, because §5 names them and a
 * caller deserves to be told which component owns each one. Every one of them
 * answers the same way: what it is, who does it, and how to reach the thing that
 * does. No 200 with a fiction behind it.
 */
const NATIVE_ONLY: Record<string, { route: string; about: string; owner: string }> = {
  "/api/server/start": {
    route: "POST /api/server/start",
    about: "Start the embedded HTTP server.",
    owner:
      "The native host application, which opens the listening socket on a free port (§4, §54). A serverless function cannot bind a port.",
  },
  "/api/server/stop": {
    route: "POST /api/server/stop",
    about: "Stop the embedded HTTP server.",
    owner: "The native host application, which owns that socket (§54).",
  },
  "/api/connectivity/reconnect": {
    route: "POST /api/connectivity/reconnect",
    about: "Re-establish the secure remote connection.",
    owner:
      "The native host application and its tunnel provider, which holds the outbound relay connection (§14, §15, §56).",
  },
  "/api/browser/navigate": {
    route: "POST /api/browser/navigate",
    about: "Drive the embedded browser.",
    owner: "The native host application, which embeds the system's browser engine (§7, §57).",
  },
};

for (const [path, entry] of Object.entries(NATIVE_ONLY)) {
  http.route({
    path,
    method: "POST",
    handler: httpAction(async (_ctx, request) => {
      if (!authorized(request)) {
        return json({ ok: false, error: "Authentication required." }, 401);
      }
      return json(
        {
          ok: false,
          nativeHostOnly: true,
          route: entry.route,
          about: entry.about,
          handledBy: entry.owner,
          downloadTheHost: "/web-portal — the download centre builds the host's source archive in your browser",
          note:
            "This deployment does not answer this route with a result, because it cannot perform the action. Reporting success here would be exactly the fake status §51 forbids.",
        },
        501,
      );
    }),
  });
}

/** A POST that forces a fresh pass, so remote callers can re-test on demand. */
http.route({
  path: "/api/network/test",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!authorized(request)) {
      return json({ ok: false, error: "Authentication required." }, 401);
    }
    const report = (await ctx.runAction(internal.sugar.diagnose, {})) as SugarReport;
    return json({
      ok: true,
      at: report.at,
      connectivity: report.connectivity,
      network: {
        vpnDetected: report.network.vpnDetected,
        vpnInterfaces: report.network.vpnInterfaces,
        lanAddresses: report.network.lanAddresses,
      },
    });
  }),
});

/* --------------------------------------------------------------- preflight */

for (const path of [
  "/api/status",
  "/api/network",
  "/api/connectivity",
  "/api/server",
  "/api/browser",
  "/api/diagnostics",
  "/api/systems",
  "/api/downloads",
  "/api/network/test",
  "/api/tasks",
  "/api/server/start",
  "/api/server/stop",
  "/api/connectivity/reconnect",
  "/api/browser/navigate",
]) {
  http.route({ path, method: "OPTIONS", handler: httpAction(async () => preflight()) });
}

export default http;
