/**
 * NOVA OS web service (§12).
 *
 * The OS hosts its own HTTP and HTTPS servers. There is no Apache, no Nginx and
 * no external runtime: this component opens the sockets, terminates TLS, and
 * keeps a registry of the services the OS and its applications publish.
 *
 * The registry is what makes this more than a static file server. A service
 * registers a name, a path prefix and a handler; the web service routes to it,
 * reports it in `getListeningPorts()`-equivalent form, and tears it down cleanly
 * when the application that owns it exits. That is the mechanism the portal, the
 * API, the diagnostics and any locally hosted application all use.
 *
 * TLS is real when it can be: the OS generates its own certificate with the
 * system's `openssl` on first start, stores the key with mode 0600, and serves
 * HTTPS with it. If `openssl` is absent the component serves HTTP and says so,
 * rather than claiming a secure listener it does not have.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createSecureServer, type Server as SecureServer } from "node:https";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { bus, config, ensureOsPaths, log, type ComponentStatus, type OsComponent } from "../core/runtime.ts";

export type WebRequest = {
  method: string;
  path: string;
  fullPath: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: Buffer;
  remote: string | null;
  loopback: boolean;
  secure: boolean;
};

export type WebResponse = {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
};

export type WebHandler = (request: WebRequest) => Promise<WebResponse> | WebResponse;

export type RegisteredService = {
  name: string;
  /** The path prefix this service answers, e.g. "/api" or "/portal". */
  prefix: string;
  about: string;
  handler: WebHandler;
  registeredAt: number;
  requests: number;
};

export type WebStatus = {
  at: number;
  http: { listening: boolean; port: number | null; address: string | null };
  https: { listening: boolean; port: number | null; address: string | null; certificate: string | null; note: string };
  services: { name: string; prefix: string; about: string; requests: number }[];
  requests: number;
  errors: number;
};

const MAX_BODY = 16 * 1024 * 1024;

export class WebService implements OsComponent {
  readonly name = "web";
  readonly about = "Hosts the OS HTTP and HTTPS servers, terminates TLS, and routes to registered OS and application services.";
  readonly requires: string[] = ["net", "firewall"];

  private http: Server | null = null;
  private https: SecureServer | null = null;
  private services = new Map<string, RegisteredService>();
  private current: ComponentStatus = "stopped";
  private requests = 0;
  private errors = 0;
  private tls: { cert: string; key: string } | null = null;
  private lastError: string | null = null;
  /** The ports actually bound, which differ from the configuration when it asked for 0. */
  private httpPort = 0;
  private httpsPort = 0;

  status(): ComponentStatus {
    return this.current;
  }

  async start(): Promise<void> {
    this.current = "starting";
    const settings = config.get("web");
    const httpPort = settings.httpPort;
    const httpsPort = settings.httpsPort;

    this.http = createServer((request, response) => void this.dispatch(request, response, false));
    this.httpPort = await listen(this.http, httpPort);
    log.info("web", `HTTP service listening on port ${this.httpPort}.`);

    this.tls = this.ensureCertificate();
    if (this.tls) {
      this.https = createSecureServer(
        { key: readFileSync(this.tls.key), cert: readFileSync(this.tls.cert) },
        (request, response) => void this.dispatch(request, response, true),
      );
      this.httpsPort = await listen(this.https, httpsPort);
      log.info("web", `HTTPS service listening on port ${this.httpsPort} with the OS's own certificate.`);
    } else {
      log.warn("web", "No TLS certificate could be generated here, so only HTTP is being served.");
    }

    this.current = "running";
    // The port that was actually bound is the one everything else is told about,
    // which matters when the configuration asked for an ephemeral port.
    config.patch("web", { httpPort: this.httpPort, httpsPort: this.httpsPort, tlsCert: this.tls?.cert ?? null, tlsKey: this.tls?.key ?? null });
  }

  async stop(): Promise<void> {
    await Promise.all([closeServer(this.http), closeServer(this.https)]);
    this.http = null;
    this.https = null;
    this.current = "stopped";
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  /* ------------------------------------------------------- §12 interface --- */

  /** Publish a service under a path prefix. */
  registerService(name: string, prefix: string, about: string, handler: WebHandler): void {
    if (this.services.has(name)) throw new Error(`A web service called "${name}" is already registered.`);
    if (!prefix.startsWith("/")) throw new Error(`A service prefix must start with "/", not "${prefix}".`);
    this.services.set(name, { name, prefix, about, handler, registeredAt: Date.now(), requests: 0 });
    bus.publish("web.service", "web", { name, prefix, registered: true });
    log.info("web", `Service "${name}" published at ${prefix}.`);
  }

  unregisterService(name: string): boolean {
    const removed = this.services.delete(name);
    if (removed) bus.publish("web.service", "web", { name, registered: false });
    return removed;
  }

  getListeningPorts(): { protocol: "http" | "https"; port: number; address: string; services: string[] }[] {
    const names = [...this.services.keys()];
    const ports: { protocol: "http" | "https"; port: number; address: string; services: string[] }[] = [];
    if (this.http) ports.push({ protocol: "http", port: this.httpPort, address: "0.0.0.0", services: names });
    if (this.https) ports.push({ protocol: "https", port: this.httpsPort, address: "0.0.0.0", services: names });
    return ports;
  }

  getServerStatus(): WebStatus {
    return {
      at: Date.now(),
      http: { listening: Boolean(this.http), port: this.http ? this.httpPort : null, address: this.http ? "0.0.0.0" : null },
      https: {
        listening: Boolean(this.https),
        port: this.https ? this.httpsPort : null,
        address: this.https ? "0.0.0.0" : null,
        certificate: this.tls?.cert ?? null,
        note: this.https
          ? "TLS is terminated here, with the OS's own certificate. A public deployment should replace it with one issued by a certificate authority."
          : "HTTPS is not listening, so there is no secure listener. A browser may refuse to treat this origin as secure.",
      },
      services: [...this.services.values()].map((service) => ({ name: service.name, prefix: service.prefix, about: service.about, requests: service.requests })),
      requests: this.requests,
      errors: this.errors,
    };
  }

  /** Every registered prefix, for the diagnostics and the portal. */
  serviceList(): { name: string; prefix: string; about: string; requests: number }[] {
    return [...this.services.values()]
      .map(({ name, prefix, about, requests }) => ({ name, prefix, about, requests }))
      .sort((a, b) => a.prefix.localeCompare(b.prefix));
  }

  /* ------------------------------------------------------------- TLS --- */

  /**
   * The OS's own certificate. Generated once with the system's openssl, kept
   * with mode 0600 for the key, and reused afterwards. Returns null when no tool
   * can make one, so the caller reports HTTP-only instead of an empty promise.
   */
  ensureCertificate(): { cert: string; key: string } | null {
    const dir = join(ensureOsPaths().state, "tls");
    const cert = join(dir, "nova.crt");
    const key = join(dir, "nova.key");
    if (existsSync(cert) && existsSync(key)) return { cert, key };

    mkdirSync(dir, { recursive: true });
    try {
      execFileSync(
        "openssl",
        [
          "req", "-x509", "-newkey", "rsa:2048", "-nodes",
          "-keyout", key, "-out", cert,
          "-days", "825", "-subj", `/CN=${config.get("system").hostname}`,
          "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
        ],
        { stdio: "ignore", timeout: 30_000 },
      );
      chmodSync(key, 0o600);
      return { cert, key };
    } catch (error) {
      this.lastError = `No certificate could be generated: ${error instanceof Error ? error.message : String(error)}`;
      return null;
    }
  }

  /** Whether the certificate on disk is still valid, read from the file itself. */
  certificateValid(): { valid: boolean; expires: string | null; subject: string | null } {
    const path = this.tls?.cert;
    if (!path || !existsSync(path)) return { valid: false, expires: null, subject: null };
    try {
      const text = execFileSync("openssl", ["x509", "-in", path, "-noout", "-enddate", "-subject"], { encoding: "utf8", timeout: 8000 });
      const expires = /notAfter=(.+)/.exec(text)?.[1]?.trim() ?? null;
      const subject = /subject=(.+)/.exec(text)?.[1]?.trim() ?? null;
      return { valid: Boolean(expires && new Date(expires) > new Date()), expires, subject };
    } catch {
      return { valid: false, expires: null, subject: null };
    }
  }

  /** The ports actually bound, so the OS reports the truth when the config said 0. */
  boundPorts(): { http: number; https: number } {
    return { http: this.httpPort, https: this.httpsPort };
  }

  /** The health of the certificate file, reported with its real permissions. */
  certificateFileMode(): string | null {
    const path = this.tls?.key;
    if (!path || !existsSync(path)) return null;
    return `0${(statSync(path).mode & 0o777).toString(8)}`;
  }

  /* ---------------------------------------------------------- dispatch --- */

  private async dispatch(request: IncomingMessage, response: ServerResponse, secure: boolean): Promise<void> {
    this.requests += 1;
    const remote = request.socket.remoteAddress ?? null;
    const loopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    let body: Buffer;
    try {
      body = await readBody(request);
    } catch (error) {
      this.errors += 1;
      response.writeHead(413, { "content-type": "text/plain; charset=utf-8" });
      response.end(String(error instanceof Error ? error.message : error));
      return;
    }

    const url = new URL(request.url ?? "/", "http://localhost");
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers)) {
      if (typeof value === "string") headers[key] = value;
      else if (Array.isArray(value)) headers[key] = value.join(", ");
    }

    const webRequest: WebRequest = {
      method: request.method ?? "GET",
      path: url.pathname,
      fullPath: `${url.pathname}${url.search}`,
      query: url.searchParams,
      headers,
      body,
      remote,
      loopback,
      secure,
    };

    // Longest matching prefix wins, so "/api/v2" beats "/api".
    const candidates = [...this.services.values()]
      .filter((service) => url.pathname === service.prefix || url.pathname.startsWith(`${service.prefix}/`) || service.prefix === "/")
      .sort((a, b) => b.prefix.length - a.prefix.length);

    const service = candidates[0];
    if (!service) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end(
        `No service is published at ${url.pathname}.\n\nPublished paths: ${this.serviceList().map((entry) => entry.prefix).join(", ") || "none"}\n`,
      );
      return;
    }

    try {
      const answer = await service.handler(webRequest);
      service.requests += 1;
      const status = answer.status ?? 200;
      response.writeHead(status, {
        "cache-control": "no-store",
        "x-nova-service": service.name,
        ...(answer.headers ?? {}),
      });
      response.end(answer.body ?? "");
      if (status >= 400) this.errors += 1;
    } catch (error) {
      this.errors += 1;
      const message = error instanceof Error ? error.message : String(error);
      log.error("web", `Service "${service.name}" could not answer ${url.pathname}.`, { error: message });
      response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: false, error: "That service could not answer the request.", detail: message, service: service.name }));
    }
  }

  /** A request made to the OS's own server, used by the diagnostics. */
  async selfTest(): Promise<{ ok: boolean; status: number | null; ms: number; detail: string }> {
    const port = this.httpPort || config.get("web").httpPort;
    const started = Date.now();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/.nova/health`, { signal: AbortSignal.timeout(5000) });
      return { ok: response.ok, status: response.status, ms: Date.now() - started, detail: `The OS's own HTTP server answered ${response.status} in ${Date.now() - started} ms.` };
    } catch (error) {
      return { ok: false, status: null, ms: Date.now() - started, detail: `The OS's own HTTP server did not answer: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  capability() {
    return {
      available: [
        "A real HTTP listener on a configurable port.",
        "A real HTTPS listener with TLS terminated by the OS's own generated certificate.",
        "A service registry with path-prefix routing, so the OS, its portal and its applications all publish through one host.",
        "Per-service request accounting and clean teardown.",
      ],
      blocked: [
        {
          what: "A certificate a public browser will trust without a warning",
          why: "That requires a certificate authority to sign it, which is an external service, and a hostname you control.",
          fallback: "The OS generates its own certificate for local and LAN use; the diagnostics say plainly that a public deployment must install a CA-issued certificate at the paths it names.",
        },
        {
          what: "Binding ports below 1024 without privilege",
          why: "The kernel reserves them for privileged processes; in this container ports 80 and 443 cannot be bound.",
          fallback: "The default ports are 8080 and 8443. On the image the privileged helper binds 80 and 443 and forwards, which is recorded in os/build.",
        },
      ],
    };
  }
}

/* ---------------------------------------------------------------- helpers --- */

/** Bind, and answer with the port that was actually bound (0 means "any free one"). */
function listen(server: Server | SecureServer, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.removeListener("listening", onListening);
      // A taken port is a real condition: the caller is told, not guessed at.
      reject(new Error(`Port ${port} could not be bound: ${error.code ?? error.message}`));
    };
    const onListening = () => {
      server.removeListener("error", onError);
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "0.0.0.0");
  });
}

function closeServer(server: Server | SecureServer | null): Promise<void> {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("the OS web service limits a request body to 16 MB"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

/** The path the OS always answers, so the health of the server is checkable. */
export const HEALTH_PATH = "/.nova/health";

/** A small helper for services: JSON, with the headers the portal expects. */
export function jsonResponse(status: number, body: unknown): WebResponse {
  return { status, headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body, null, 2) };
}

export function textResponse(status: number, body: string, type = "text/plain; charset=utf-8"): WebResponse {
  return { status, headers: { "content-type": type }, body };
}

/** The file the OS writes its certificate to, for the diagnostics. */
export function tlsPaths(): { cert: string; key: string; keyMode: string | null } {
  const dir = join(ensureOsPaths().state, "tls");
  const key = join(dir, "nova.key");
  return { cert: join(dir, "nova.crt"), key, keyMode: existsSync(key) ? `0${(statSync(key).mode & 0o777).toString(8)}` : null };
}

export { writeFileSync };
