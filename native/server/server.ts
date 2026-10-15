/**
 * §4 Embedded server, §54 server interface.
 *
 * This is a real HTTP server, created by the host with the operating system's
 * own `http` module. There is no Apache, no Nginx, no IIS, no separate Node
 * process, no Python server, no PHP and no Docker anywhere in the picture: the
 * application opens the socket itself.
 *
 * It listens on `127.0.0.1` always, and on the machine's LAN address when that
 * is allowed (§10 mode B), so a phone on the same Wi-Fi can reach it while the
 * outside world still cannot.
 *
 * Port selection is real: the preferred port is tried first, and on `EADDRINUSE`
 * the host asks the operating system for a free one instead of failing. The port
 * that was actually bound is what everything else reports (§4).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { networkInterfaces, hostname } from "node:os";
import { log } from "../core/log.ts";

export type HostRequest = {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: Buffer;
  /** The address the request came from, used for the audit log and lockout (§40). */
  remote: string | null;
  /** Whether the request arrived on the loopback interface. */
  loopback: boolean;
};

export type HostResponse = {
  status: number;
  headers: Record<string, string>;
  body: string | Buffer;
};

export type HostHandler = (request: HostRequest) => Promise<HostResponse>;

export type ServerState = {
  status: "stopped" | "starting" | "running" | "failed";
  port: number | null;
  localAddress: string | null;
  lanAddress: string | null;
  /** Whether the LAN address is being served as well as loopback. */
  listeningOnLan: boolean;
  startedAt: number | null;
  uptimeSeconds: number;
  connections: number;
  requests: number;
  lastError: string | null;
  hostname: string;
};

const MAX_BODY = 8 * 1024 * 1024;

export class EmbeddedServer {
  private server: Server | null = null;
  /** The LAN listener, when one was bound. Closed with the server. */
  private extras: Server[] = [];
  private state: ServerState = {
    status: "stopped",
    port: null,
    localAddress: null,
    lanAddress: null,
    listeningOnLan: false,
    startedAt: null,
    uptimeSeconds: 0,
    connections: 0,
    requests: 0,
    lastError: null,
    hostname: hostname(),
  };

  constructor(
    private readonly handler: HostHandler,
    private readonly options: { preferredPort: number; allowLan: boolean },
  ) {}

  /** §54 getServerStatus. */
  getServerStatus(): ServerState {
    return {
      ...this.state,
      uptimeSeconds: this.state.startedAt ? Math.round((Date.now() - this.state.startedAt) / 1000) : 0,
    };
  }

  /** §54 getPort. */
  getPort(): number | null {
    return this.state.port;
  }

  /** §54 getLocalAddress — the loopback URL, which always works. */
  getLocalAddress(): string | null {
    return this.state.port === null ? null : `http://127.0.0.1:${this.state.port}`;
  }

  /** §54 getConnections. */
  getConnections(): number {
    return this.state.connections;
  }

  /** §10 — the address another device on this network should use, if there is one. */
  getLanAddress(): string | null {
    return this.state.port === null || !this.state.lanAddress
      ? null
      : `http://${this.state.lanAddress}:${this.state.port}`;
  }

  /** The address the host is reachable at from anywhere (§11). */
  getPublicAddress(): string | null {
    return null;
  }

  /**
   * Bind one port. `0` means "any free port", which is the safe fallback when
   * the preferred one is taken by something else on this machine.
   */
  private bind(port: number, host: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer((request, response) => void this.dispatch(request, response));

      server.on("connection", (socket) => {
        this.state.connections += 1;
        socket.on("close", () => {
          this.state.connections = Math.max(0, this.state.connections - 1);
        });
      });

      server.on("error", (error: NodeJS.ErrnoException) => {
        server.close();
        reject(error);
      });

      server.listen(port, host, () => {
        const address = server.address();
        const bound = typeof address === "object" && address ? address.port : port;
        this.server = server;
        resolve(bound);
      });
    });
  }

  async start(): Promise<ServerState> {
    if (this.state.status === "running") return this.getServerStatus();
    this.state.status = "starting";
    this.state.lastError = null;

    try {
      let port: number;
      try {
        port = await this.bind(this.options.preferredPort, "127.0.0.1");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EADDRINUSE") throw error;
        log.warn("server", `Port ${this.options.preferredPort} is already in use; asking the system for a free one.`);
        port = await this.bind(0, "127.0.0.1");
        // The preferred port was taken; the bound server is the free-port one.
      }

      this.state.port = port;
      this.state.localAddress = `http://127.0.0.1:${port}`;
      this.state.status = "running";
      this.state.startedAt = Date.now();
      log.info("server", `Local server listening on 127.0.0.1:${port}.`);

      // The LAN address is a second listener on the same port, so a phone on
      // this Wi-Fi can reach the host without the Internet being involved.
      if (this.options.allowLan) {
        const lan = this.firstLanAddress();
        if (lan) {
          try {
            await new Promise<void>((resolve, reject) => {
              const extra = createServer((request, response) => void this.dispatch(request, response));
              extra.on("error", reject);
              extra.listen(port, lan, () => {
                this.extras.push(extra);
                resolve();
              });
            });
            this.state.lanAddress = lan;
            this.state.listeningOnLan = true;
            log.info("server", `Also listening on ${lan}:${port} for the local network.`);
          } catch (error) {
            log.warn("server", "The LAN address could not be bound; the host stays reachable on this computer.", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }

      return this.getServerStatus();
    } catch (error) {
      this.state.status = "failed";
      this.state.lastError = error instanceof Error ? error.message : String(error);
      log.error("server", "The local server could not start.", { error: this.state.lastError });
      return this.getServerStatus();
    }
  }

  private firstLanAddress(): string | null {
    for (const addresses of Object.values(networkInterfaces())) {
      for (const info of addresses ?? []) {
        if (info.internal || String(info.family) !== "IPv4") continue;
        if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(info.address)) return info.address;
      }
    }
    return null;
  }

  async stop(): Promise<void> {
    const server = this.server;
    const extras = this.extras;
    this.server = null;
    this.extras = [];
    await Promise.all(extras.map((extra) => new Promise<void>((resolve) => extra.close(() => resolve()))));
    this.state.status = "stopped";
    this.state.port = null;
    this.state.localAddress = null;
    this.state.lanAddress = null;
    this.state.listeningOnLan = false;
    this.state.startedAt = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      log.info("server", "Local server stopped.");
    }
  }

  /** §54 restartServer — §45's recovery path for a wedged listener. */
  async restart(): Promise<ServerState> {
    await this.stop();
    return await this.start();
  }

  /* -------------------------------------------------------------- dispatch --- */

  private async dispatch(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const started = Date.now();
    const remote = request.socket.remoteAddress ?? null;
    const loopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";

    let body: Buffer;
    try {
      body = await readBody(request);
    } catch (error) {
      response.writeHead(413, { "content-type": "text/plain; charset=utf-8" });
      response.end(`That request was too large: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    const url = new URL(request.url ?? "/", "http://localhost");
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers)) {
      if (typeof value === "string") headers[key] = value;
      else if (Array.isArray(value)) headers[key] = value.join(", ");
    }

    this.state.requests += 1;

    try {
      const answer = await this.handler({
        method: request.method ?? "GET",
        path: url.pathname,
        query: url.searchParams,
        headers,
        body,
        remote,
        loopback,
      });
      response.writeHead(answer.status, {
        "cache-control": "no-store",
        ...answer.headers,
      });
      response.end(answer.body);
      if (answer.status >= 400) {
        log.debug("server", `${request.method} ${url.pathname} → ${answer.status}`, { ms: Date.now() - started });
      }
    } catch (error) {
      // A handler that throws must not take the server down with it (§45).
      const message = error instanceof Error ? error.message : String(error);
      log.error("server", "A request could not be answered.", { path: url.pathname, error: message });
      response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: false, error: "The host could not answer that request.", detail: message }));
    }
  }
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("the host's request limit is 8 MB"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}
