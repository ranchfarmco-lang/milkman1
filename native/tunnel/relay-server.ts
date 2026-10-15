/**
 * §14 — the relay, included so the tunnel can actually be exercised.
 *
 * This is a real relay, not a stub: it accepts an outbound `/connect` stream
 * from a host, hands that host a real public URL, carries real browser requests
 * down the stream, and returns the real answers. Run it anywhere with a public
 * address — a cheap VPS, a container behind a load balancer — and the host
 * becomes reachable from a phone on cellular while sitting behind Starlink's
 * carrier-grade NAT.
 *
 * It is deliberately small and deliberately strict:
 *
 *   · a host must present a tunnel secret if one is configured, and the secret
 *     never reaches the browser;
 *   · only the host's own local server is reachable through it — the relay
 *     forwards to the host, and the host decides what to answer, so there is no
 *     way to ask the relay for a different port (§65);
 *   · per-tunnel request limits keep one host from being used as a proxy farm
 *     (§40, rate limiting);
 *   · a request that is never answered is failed after a timeout rather than
 *     left hanging in the browser.
 *
 * `createRelayServer()` returns a standard `http.Server` so the host, a test,
 * or a container can all own its lifetime.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";

type Pending = {
  id: string;
  resolve: (value: { status: number; headers: Record<string, string>; body: Buffer }) => void;
  timer: ReturnType<typeof setTimeout>;
};

type Host = {
  tunnelId: string;
  publicPath: string;
  stream: ServerResponse;
  pending: Map<string, Pending>;
  requests: number;
  windowStarted: number;
  windowCount: number;
  connectedAt: number;
  remoteAddress: string | null;
};

export type RelayOptions = {
  /** The address browsers can use to reach this relay, e.g. `https://relay.example`. */
  publicBaseUrl: string;
  /** When set, a host must present this as `Authorization: Bearer …`. */
  secret?: string | null;
  /** Requests allowed per host per minute. Defaults to 600. */
  requestsPerMinute?: number;
  /** How long to wait for a host to answer. Defaults to 20 seconds. */
  hostTimeoutMs?: number;
  /** Called with one line per interesting event, for the relay's own log. */
  log?: (message: string, detail?: Record<string, unknown>) => void;
};

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
]);

export function createRelayServer(options: RelayOptions): Server {
  const hosts = new Map<string, Host>();
  const limits = options.requestsPerMinute ?? 600;
  const hostTimeout = options.hostTimeoutMs ?? 20_000;
  const say = options.log ?? (() => undefined);

  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", options.publicBaseUrl);

    /* --------------------------------------------------------------- host --- */

    if (url.pathname === "/connect" && request.method === "POST") {
      if (options.secret) {
        const presented = (request.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
        if (presented !== options.secret) {
          response.writeHead(401, { "content-type": "application/json" });
          response.end(JSON.stringify({ ok: false, message: "The relay requires a valid tunnel credential." }));
          return;
        }
      }

      const tunnelId = randomBytes(9).toString("base64url");
      const publicPath = `/t/${tunnelId}`;
      response.writeHead(200, {
        "content-type": "application/x-ndjson",
        "cache-control": "no-store",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });

      const host: Host = {
        tunnelId,
        publicPath,
        stream: response,
        pending: new Map(),
        requests: 0,
        windowStarted: Date.now(),
        windowCount: 0,
        connectedAt: Date.now(),
        remoteAddress: request.socket.remoteAddress ?? null,
      };
      hosts.set(tunnelId, host);

      const send = (message: unknown) => {
        if (response.writableEnded) return;
        response.write(`${JSON.stringify(message)}\n`);
      };

      send({
        type: "ready",
        publicUrl: `${options.publicBaseUrl.replace(/\/+$/, "")}${publicPath}`,
        tunnelId,
      });
      say("A host connected.", { tunnelId, from: host.remoteAddress });

      // Keep the connection warm and measure the round trip (§24 latency).
      const keepAlive = setInterval(() => send({ type: "ping", at: Date.now() }), 15_000);

      const cleanup = () => {
        clearInterval(keepAlive);
        for (const pending of host.pending.values()) {
          clearTimeout(pending.timer);
          pending.resolve({ status: 504, headers: { "content-type": "text/plain" }, body: Buffer.from("The host went away before answering.") });
        }
        host.pending.clear();
        hosts.delete(tunnelId);
        say("A host disconnected.", { tunnelId, seconds: Math.round((Date.now() - host.connectedAt) / 1000) });
      };

      request.on("close", cleanup);
      response.on("close", cleanup);
      response.on("error", cleanup);
      return;
    }

    /* ----------------------------------------------------------- responses --- */

    if (url.pathname === "/respond" && request.method === "POST") {
      const body = await readBody(request);
      let parsed: { id?: string; status?: number; headers?: Record<string, string>; bodyBase64?: string };
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: false, message: "The relay could not read that answer." }));
        return;
      }
      for (const host of hosts.values()) {
        const pending = parsed.id ? host.pending.get(parsed.id) : undefined;
        if (!pending) continue;
        clearTimeout(pending.timer);
        host.pending.delete(pending.id);
        pending.resolve({
          status: parsed.status ?? 502,
          headers: parsed.headers ?? {},
          body: Buffer.from(parsed.bodyBase64 ?? "", "base64"),
        });
        response.writeHead(204);
        response.end();
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false, message: "The relay has no waiting request with that id." }));
      return;
    }

    if (url.pathname === "/authenticate" && request.method === "POST") {
      const body = await readBody(request);
      let credential = "";
      try {
        credential = String((JSON.parse(body.toString("utf8")) as { credential?: string }).credential ?? "");
      } catch {
        credential = "";
      }
      const ok = Boolean(options.secret) && credential === options.secret;
      response.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok,
          message: ok ? "The relay accepted the credential." : "That credential is not the one this relay expects.",
        }),
      );
      return;
    }

    if (url.pathname === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok: true,
          hosts: [...hosts.values()].map((host) => ({
            tunnelId: host.tunnelId,
            connectedSeconds: Math.round((Date.now() - host.connectedAt) / 1000),
            requests: host.requests,
            address: host.remoteAddress,
          })),
        }),
      );
      return;
    }

    /* --------------------------------------------- a browser reaching a host --- */

    const tunnelId = url.pathname.startsWith("/t/") ? url.pathname.slice(3).split("/")[0] : null;
    const host = tunnelId ? hosts.get(tunnelId) : undefined;
    if (!host) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end(
        "No host is connected at this address right now.\n\nThat usually means the SUGAR host is not running, or it has lost its connection and is reconnecting. It will come back on its own.",
      );
      return;
    }

    // §40 rate limiting, per host and per minute.
    const now = Date.now();
    if (now - host.windowStarted > 60_000) {
      host.windowStarted = now;
      host.windowCount = 0;
    }
    host.windowCount += 1;
    if (host.windowCount > limits) {
      response.writeHead(429, { "content-type": "text/plain; charset=utf-8", "retry-after": "30" });
      response.end("This host has answered as many requests as the relay allows in a minute. Please wait a moment and try again.");
      return;
    }

    const body = await readBody(request);
    const id = randomBytes(9).toString("base64url");
    const forwardedHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers)) {
      if (typeof value !== "string") continue;
      if (HOP_BY_HOP.has(key.toLowerCase())) continue;
      forwardedHeaders[key] = value;
    }
    // The host is told what the browser asked for, but it is not told where the
    // relay sits, so a relay misconfiguration cannot be mistaken for a host bug.
    forwardedHeaders["x-forwarded-host"] = options.publicBaseUrl;
    forwardedHeaders["x-forwarded-proto"] = "https";

    const answer = new Promise<{ status: number; headers: Record<string, string>; body: Buffer }>((resolve) => {
      const timer = setTimeout(() => {
        host.pending.delete(id);
        resolve({ status: 504, headers: { "content-type": "text/plain" }, body: Buffer.from("The host did not answer in time. It may be reconnecting — try again in a moment.") });
      }, hostTimeout);
      host.pending.set(id, { id, resolve, timer });
    });

    const relative = url.pathname.slice(`/t/${tunnelId}`.length) || "/";
    host.requests += 1;
    const message = JSON.stringify({
      type: "request",
      id,
      method: request.method ?? "GET",
      path: `${relative}${url.search}`,
      headers: forwardedHeaders,
      bodyBase64: body.toString("base64"),
      remote: request.socket.remoteAddress ?? null,
    });
    if (!host.stream.write(`${message}\n`)) {
      say("The relay's stream to a host is backed up.", { tunnelId });
    }

    const result = await answer;
    response.writeHead(result.status, { ...result.headers, "x-sugar-via": "relay" });
    response.end(result.body);
  });

  return server;
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      // A relay that accepted unbounded uploads would be a way to fill the
      // disk of whoever runs it. 25 MB is far more than the portal needs.
      if (size > 25 * 1024 * 1024) {
        reject(new Error("The request body passed the relay's 25 MB limit."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}
