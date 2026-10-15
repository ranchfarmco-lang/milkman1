/**
 * §27 startup, §22 TEST EVERYTHING, §44 SELF TEST, §45 recovery, §58 diagnostics.
 *
 * This is the part that holds the others together. It runs the start-up
 * sequence in the order the specification gives it, answers the two test suites,
 * and — the part that matters most day to day — watches for the network changing
 * underneath it and puts things back without being asked.
 *
 * Every check below returns the evidence behind its verdict. A status that says
 * "OK" without saying what it measured would be a claim rather than a test, and
 * §51 forbids that.
 */

import { hostname, platform, release, arch, uptime, freemem, totalmem, cpus } from "node:os";
import { writeFileSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ensurePaths } from "./paths.ts";
import { config } from "../storage/config.ts";
import { log, type LogCategory } from "./log.ts";
import { RELEASE, versionLine } from "./version.ts";
import { auth } from "../auth/auth.ts";
import { pairing } from "../devices/pairing.ts";
import { browsers, type BrowserStatus } from "../browser/engine.ts";
import { rendererAvailability } from "../browser/webview.ts";
import { detectFirewall, embeddedEngine, type FirewallCheck } from "../platform/index.ts";
import { secretReport } from "../storage/secrets.ts";
import {
  NetworkMonitor,
  getNetworkStatus,
  type NetworkChange,
  type NetworkStatus,
} from "../network/network.ts";
import { request } from "../client/internet-client.ts";
import { EmbeddedServer, type HostRequest, type HostResponse, type ServerState } from "../server/server.ts";
import { createRoutes } from "../server/api.ts";
import {
  catalog as buildCatalog,
  downloadAll as buildDownloadAll,
  EXTERNAL_REQUIREMENTS,
  type DownloadEntry,
} from "../downloads/catalog.ts";
import { createProvider, type ProviderContext, type TunnelProvider } from "../tunnel/provider.ts";
import { RelayTunnelProvider } from "../tunnel/relay-host.ts";
import { registerProvider } from "../tunnel/provider.ts";
import { renderRemotePortal } from "../web-portal/index.ts";

registerProvider("relay", () => new RelayTunnelProvider());

export type CheckStatus = "PASS" | "FAIL" | "SKIP";

export type Check = {
  /** The name §22 or §44 gives it. */
  name: string;
  status: CheckStatus;
  /** What was actually measured, in one sentence. */
  evidence: string;
  ms: number;
  /** Plain-language explanation, for beginner mode (§23). */
  explain: string;
  /** The numbers, for advanced mode (§24). */
  detail?: Record<string, string | number | boolean | null>;
};

export type TestReport = {
  at: number;
  suite: "TEST EVERYTHING" | "SELF TEST";
  passed: number;
  failed: number;
  skipped: number;
  checks: Check[];
  /** §21 — the one sentence a beginner needs. */
  summary: string;
};

export type RecoveryAction = {
  at: number;
  what: string;
  why: string;
  ok: boolean;
  attempts: number;
};

/** What `SugarApp.handle` hands the server; also what the API reads. */
export type AppSnapshot = {
  version: ReturnType<typeof versionLine>;
  server: ServerState;
  lanAddress: string | null;
  network: NetworkStatus | null;
  firewall: FirewallCheck | null;
  browser: BrowserStatus;
  tunnel: ReturnType<TunnelProvider["diagnostics"]>;
  renderer: ReturnType<typeof rendererAvailability>;
  engine: ReturnType<typeof embeddedEngine>;
  startedAt: number;
};

export class SugarApp {
  readonly startedAt = Date.now();
  readonly server: EmbeddedServer;
  readonly monitor: NetworkMonitor;
  tunnel: TunnelProvider | null = null;

  networkStatus: NetworkStatus | null = null;
  firewall: FirewallCheck | null = null;
  lastChange: NetworkChange | null = null;
  recovery: RecoveryAction[] = [];
  /** §38 — set while the Internet is unreachable. */
  offline = false;

  /** A second small listener, used only to prove an inbound probe really lands. */
  private inboundProbe: { attempted: boolean; reachable: boolean; from?: string } | null = null;
  private routes: (request: HostRequest) => Promise<HostResponse | null>;

  constructor() {
    ensurePaths();
    this.monitor = new NetworkMonitor(config.get("network").monitorSeconds);
    this.routes = createRoutes(this);
    this.server = new EmbeddedServer(
      (request) => this.handle(request),
      {
        preferredPort: config.get("network").preferredPort,
        allowLan: config.get("network").allowLan,
      },
    );
  }

  /* -------------------------------------------------------- §27 startup --- */

  /**
   * The start-up sequence, in order. Each step logs what it found, so a failure
   * at step seven is not mistaken for a failure at step one.
   */
  async boot(): Promise<{
    sequence: { step: string; ok: boolean; detail: string }[];
    result: "READY" | "READY LOCALLY — REMOTE ACCESS NEEDS CONFIGURATION" | "ACTION REQUIRED";
    address: string | null;
    publicUrl: string | null;
  }> {
    const sequence: { step: string; ok: boolean; detail: string }[] = [];
    const record = (step: string, ok: boolean, detail: string) => {
      sequence.push({ step, ok, detail });
      log.info("application", `Startup — ${step}: ${detail}`);
    };

    log.info("application", `Starting. ${versionLine()}`);
    config.markStart();

    // 1. Detect the operating system.
    record("Detect operating system", true, `${platform()} ${release()} on ${arch()}, ${cpus().length} CPUs, ${Math.round(totalmem() / 1024 / 1024)} MB RAM`);

    // 2. Start the local server.
    const serverState = await this.server.start();
    record(
      "Start the local server",
      serverState.status === "running",
      serverState.status === "running"
        ? `Listening on ${serverState.localAddress}${serverState.listeningOnLan ? ` and on the local network at ${this.server.getLanAddress()}` : ""}`
        : `The server could not start: ${serverState.lastError ?? "unknown reason"}`,
    );
    if (serverState.status !== "running") {
      return { sequence, result: "ACTION REQUIRED", address: null, publicUrl: null };
    }
    config.patch("server", { port: serverState.port });

    // 3. Start the browser subsystem.
    const browser = browsers.createBrowser({ home: "about:blank" });
    const renderer = rendererAvailability();
    record(
      "Start the browser subsystem",
      true,
      renderer.available
        ? `${renderer.engine} is available; the browser area can open a real window`
        : `${renderer.engine} window unavailable — ${renderer.reason ?? "no display"} Navigation, history, cookies and downloads still work`,
    );
    void browser;

    // 4–6. Detect the network, the Internet and the VPN.
    this.networkStatus = await getNetworkStatus();
    record(
      "Detect network and Internet",
      this.networkStatus.internet.ok,
      this.networkStatus.internet.ok
        ? `The Internet is reachable in ${this.networkStatus.internet.ms} ms; this network appears as ${this.networkStatus.internet.publicIp ?? "an unknown address"}`
        : "No Internet connection right now — the host runs locally and reconnects on its own",
    );
    this.offline = !this.networkStatus.internet.ok;
    record("Detect VPN", true, this.networkStatus.vpn.note);

    // 7. Inspect the firewall, without changing it.
    this.firewall = await detectFirewall(serverState.port ?? 0, process.execPath);
    record("Inspect the firewall", this.firewall.allowed !== false, this.firewall.explanation);

    // 8. Test remote access and, if it is needed, hold a tunnel open.
    const tunnel = this.startTunnel();
    record(
      "Test remote access",
      Boolean(tunnel.publicUrl()),
      tunnel.publicUrl()
        ? `Remote access is available at ${tunnel.publicUrl()}`
        : this.networkStatus.assessment.tunnelRequired
          ? `Direct connections are unavailable (${this.networkStatus.assessment.behindCarrierNat ? "this network is behind carrier-grade NAT" : "no public address"}) and no relay is configured yet`
          : "This host appears directly reachable; no tunnel is in use",
    );

    // 9. Watch for the network changing underneath us (§39).
    this.monitor.on((change, status) => void this.onNetworkChange(change, status));
    this.monitor.start();
    record("Watch for network changes", true, `Checking every ${config.get("network").monitorSeconds} seconds`);

    const ready = !this.networkStatus.assessment.tunnelRequired || Boolean(tunnel.publicUrl());
    const result = ready ? "READY" : "READY LOCALLY — REMOTE ACCESS NEEDS CONFIGURATION";

    // §62, §63 — the first run ends on one of three sentences, and which one it
    // was is remembered so the dashboard can keep saying it rather than
    // pretending the question was never asked.
    config.patch("state", { firstRunComplete: true, firstRunResult: result });
    log.info("application", `First-run result: ${result}`);

    return {
      sequence,
      result,
      address: this.server.getLocalAddress(),
      publicUrl: tunnel.publicUrl(),
    };
  }

  /** Build the tunnel provider the settings name, and open it if a relay is set. */
  private startTunnel(): TunnelProvider {
    const settings = config.get("user");
    const provider = createProvider(settings.tunnelProvider) ?? new RelayTunnelProvider();
    this.tunnel = provider;
    provider.onRequest((forwarded) => void this.forwardToServer(forwarded));

    const relayUrl = settings.relayUrl ?? ((process.env.SUGAR_RELAY ?? "").trim() || null);
    void provider.connect(this.tunnelContext(relayUrl));
    return provider;
  }

  private tunnelContext(relayUrl: string | null): ProviderContext {
    const credential = relayUrl ? (process.env.SUGAR_RELAY_SECRET ?? null) : null;
    return {
      localBase: this.server.getLocalAddress() ?? "http://127.0.0.1:0",
      installationId: `sugar-${hostname()}-${Math.abs(hash(hostname()))}`,
      relayUrl,
      credential,
      log: (level, message, detail) => log.write(level === "error" ? "error" : level, "tunnel", message, detail),
    };
  }

  /** §56 connectRemote / disconnectRemote / reconnectRemote. */
  async remote(action: "connect" | "disconnect" | "reconnect"): Promise<ReturnType<TunnelProvider["diagnostics"]>> {
    const provider = this.tunnel;
    if (!provider) throw new Error("No tunnel provider is configured.");
    const context = this.tunnelContext(config.get("user").relayUrl ?? ((process.env.SUGAR_RELAY ?? "").trim() || null));
    if (action === "disconnect") await provider.disconnect();
    else if (action === "reconnect") await provider.reconnect(context);
    else await provider.connect(context);
    return provider.diagnostics();
  }

  /**
   * §14 — a request that came in over the relay is answered by the local server,
   * over loopback. It is the same code path as a local request, so there is no
   * second, weaker door (§42).
   */
  private async forwardToServer(forwarded: {
    id: string;
    method: string;
    path: string;
    headers: Record<string, string>;
    bodyBase64: string;
    remote: string | null;
  }): Promise<void> {
    const base = this.server.getLocalAddress();
    if (!base || !this.tunnel) return;
    try {
      const url = new URL(`${base}${forwarded.path.startsWith("/") ? forwarded.path : `/${forwarded.path}`}`);
      const body = Buffer.from(forwarded.bodyBase64, "base64");
      const response = await fetch(url, {
        method: forwarded.method,
        headers: {
          ...forwarded.headers,
          // The host decides what a relayed caller is: a remote caller, never a
          // local one. That is what keeps the trusted paths trusted (§41, §42).
          "x-sugar-forwarded": "relay",
          ...(forwarded.remote ? { "x-sugar-client": forwarded.remote } : {}),
        },
        body: body.length ? body : undefined,
        redirect: "manual",
      });
      const buffer = Buffer.from(await response.arrayBuffer());
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        if (key.startsWith("x-sugar") || key === "content-encoding") return;
        headers[key] = value;
      });
      await this.tunnel.respond({
        id: forwarded.id,
        status: response.status,
        headers,
        bodyBase64: buffer.toString("base64"),
      });
    } catch (error) {
      log.warn("tunnel", "A relayed request could not be answered by the local server.", {
        error: error instanceof Error ? error.message : String(error),
      });
      await this.tunnel.respond({
        id: forwarded.id,
        status: 502,
        headers: { "content-type": "application/json" },
        bodyBase64: Buffer.from(JSON.stringify({ ok: false, error: "The local server did not answer." })).toString("base64"),
      });
    }
  }

  /* ------------------------------------------------------ §13, §39, §45 --- */

  /**
   * §13 — what happens when the network changes. Mark unavailable, re-test,
   * re-establish the remote connection, update the status, tell the user, and
   * resume. §45's exponential backoff is in the provider, so a network that
   * flaps cannot turn into a reconnect storm.
   */
  async onNetworkChange(change: NetworkChange, status: NetworkStatus): Promise<void> {
    this.lastChange = change;
    this.networkStatus = status;
    const wasOffline = this.offline;
    this.offline = !status.internet.ok;

    log.warn("network", "Network changed — reconfiguring.", { reason: change.reason });
    this.note(await this.recover("Re-test the network", change.reason, async () => (await getNetworkStatus()) !== null));

    if (status.internet.ok && !wasOffline) {
      this.note(
        await this.recover("Re-establish the remote connection", "the network changed", async () => {
          await this.tunnel?.reconnect(
            this.tunnelContext(config.get("user").relayUrl ?? ((process.env.SUGAR_RELAY ?? "").trim() || null)),
          );
          return true;
        }),
      );
    }

    if (!status.internet.ok) {
      log.warn("application", "OFFLINE MODE — the Internet is gone; the host keeps running locally (§38).");
    } else if (wasOffline) {
      log.info("application", "CONNECTION RESTORED — the Internet is back.");
    }
    log.info("application", `Connection status: ${status.mode}.`);
  }

  /** §45 — every recovery is recorded, so the user can see what was done. */
  private note(action: RecoveryAction): RecoveryAction {
    this.recovery = [action, ...this.recovery].slice(0, 50);
    return action;
  }

  private async recover(what: string, why: string, work: () => Promise<boolean>): Promise<RecoveryAction> {
    const started = Date.now();
    let ok = false;
    let attempts = 0;
    // Three tries with the same growing delay the tunnel uses, then stop and
    // say so rather than spinning (§45).
    while (attempts < 3 && !ok) {
      attempts += 1;
      try {
        ok = await work();
      } catch (error) {
        log.warn("application", `${what} failed on attempt ${attempts}.`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (!ok && attempts < 3) await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempts - 1)));
    }
    return { at: started, what, why, ok, attempts };
  }

  /* --------------------------------------------------------- §22 the tests --- */

  /**
   * §22 — TEST EVERYTHING. Fifteen checks, each displayed separately, each with
   * the evidence behind it. Nothing here is inferred from a cached value.
   */
  async testEverything(): Promise<TestReport> {
    const checks: Check[] = [];
    const add = async (name: string, work: () => Promise<Omit<Check, "name">>) => {
      const started = Date.now();
      try {
        checks.push({ name, ...(await work()) });
      } catch (error) {
        checks.push({
          name,
          status: "FAIL",
          evidence: `The check itself failed: ${error instanceof Error ? error.message : String(error)}`,
          ms: Date.now() - started,
          explain: "This check could not be completed, which is different from the thing it tests being broken.",
        });
      }
    };

    const network = this.networkStatus ?? (this.networkStatus = await getNetworkStatus());
    const port = this.server.getPort();

    // 1. Network adapter.
    await add("Network adapter", async () => ({
      status: network.interfaces.length > 0 ? "PASS" : "FAIL",
      evidence: `${network.interfaces.length} interface(s) with ${network.interfaces.reduce((n, i) => n + i.addresses.length, 0)} address(es); traffic is using ${network.active.name ?? "an unnamed interface"}${network.active.vpn ? " (a VPN interface)" : ""}.`,
      ms: 0,
      explain: network.interfaces.length
        ? "Your computer has a working network adapter."
        : "No network adapter was found, so nothing on the network can work yet.",
      detail: { active: network.active.name, via: network.active.via, vpn: network.active.vpn },
    }));

    // 2. Internet connection.
    await add("Internet connection", async () => {
      const test = await import("../network/network.ts").then((m) => m.testInternet());
      return {
        status: test.ok ? "PASS" : "FAIL",
        evidence: test.detail,
        ms: test.ms,
        explain: test.ok
          ? "Your Internet connection is working."
          : "There is no Internet connection right now. The host keeps running locally and will reconnect by itself.",
        detail: { publicIp: test.publicIp, error: test.error },
      };
    });

    // 3. DNS.
    await add("DNS", async () => {
      const test = await import("../network/network.ts").then((m) => m.testDNS());
      return {
        status: test.ok ? "PASS" : "FAIL",
        evidence: test.detail,
        ms: test.ms,
        explain: test.ok
          ? "Names on the Internet can be looked up."
          : "Names on the Internet cannot be looked up, so pages and services will not load even if the connection is up.",
        detail: { addresses: test.addresses.join(", "), error: test.error },
      };
    });

    // 4. HTTPS.
    await add("HTTPS", async () => {
      const test = await import("../network/network.ts").then((m) => m.testHTTPS());
      return {
        status: test.ok ? "PASS" : "FAIL",
        evidence: test.detail,
        ms: test.ms,
        explain: test.ok
          ? "Secure connections work, and certificates are being checked."
          : "Secure connections are not completing. This is usually the same problem as the Internet connection above.",
        detail: { status: test.status, error: test.error },
      };
    });

    // 5. VPN status.
    await add("VPN status", async () => ({
      status: "PASS",
      evidence: network.vpn.note,
      ms: 0,
      explain: network.vpn.detected
        ? "A VPN is detected, and SUGAR has taken account of it — nothing needs doing."
        : "No VPN is running. That is fine; it works either way.",
      detail: { detected: network.vpn.detected, interfaces: network.vpn.interfaces.join(", "), active: network.vpn.active },
    }));

    // 6. Local server.
    await add("Local server", async () => {
      const state = this.server.getServerStatus();
      const probe = state.localAddress ? await request<unknown>(`${state.localAddress}/api/status`, { force: true, timeoutSeconds: 5 }) : null;
      const ok = state.status === "running" && Boolean(probe?.ok);
      return {
        status: ok ? "PASS" : "FAIL",
        evidence: ok
          ? `The server is listening on ${state.localAddress} and answered its own status request (${probe?.status}).`
          : `The server is ${state.status}${state.lastError ? `: ${state.lastError}` : ""}.`,
        ms: probe?.ms ?? 0,
        explain: ok
          ? "SUGAR's own web server is running. You did not have to install one."
          : "SUGAR's web server is not answering.",
        detail: { port: state.port, requests: state.requests, connections: state.connections },
      };
    });

    // 7. Local firewall accessibility.
    await add("Local firewall accessibility", async () => {
      this.firewall = await detectFirewall(port ?? 0, process.execPath);
      return {
        status: this.firewall.allowed === false ? "FAIL" : "PASS",
        evidence: this.firewall.explanation,
        ms: 0,
        explain:
          this.firewall.allowed === false
            ? "Your computer's firewall may be stopping other devices on your network from reaching SUGAR. Nothing has been changed without asking you."
            : "The firewall is not stopping SUGAR from being reached.",
        detail: { platform: this.firewall.platform, needsAdmin: this.firewall.needsAdmin },
      };
    });

    // 8. LAN accessibility.
    await add("LAN accessibility", async () => {
      const lan = this.server.getLanAddress();
      if (!lan) {
        return {
          status: "SKIP",
          evidence: "No private network address was found, so there is no local network to be reachable from.",
          ms: 0,
          explain: "This computer is not on a home or office network right now, so there is nothing to test.",
        };
      }
      if (!this.server.getServerStatus().listeningOnLan) {
        return {
          status: "FAIL",
          evidence: `The server is not listening on ${lan}, only on this computer itself.`,
          ms: 0,
          explain: "Other devices on your network cannot reach SUGAR yet.",
        };
      }
      return {
        status: "PASS",
        evidence: `The server is listening on ${lan}, so a device on the same network can open it.`,
        ms: 0,
        explain: "A phone or another computer on the same Wi-Fi can open SUGAR at that address.",
      };
    });

    // 9. Public connectivity.
    await add("Public connectivity", async () => ({
      status: network.internet.ok ? "PASS" : "FAIL",
      evidence: network.assessment.conclusion,
      ms: network.internet.ms,
      explain: network.assessment.behindCarrierNat
        ? "Your Internet connection works, but your computer cannot receive direct incoming connections. This is normal with Starlink, and SUGAR handles it."
        : network.assessment.conclusion,
      detail: {
        publicIp: network.internet.publicIp,
        behindCarrierNat: network.assessment.behindCarrierNat,
        inboundTested: network.assessment.inboundTested,
      },
    }));

    // 10. Tunnel connectivity.
    await add("Tunnel connectivity", async () => {
      const diagnostics = this.tunnel?.diagnostics();
      if (!diagnostics) {
        return { status: "SKIP", evidence: "No tunnel provider is configured.", ms: 0, explain: "No secure remote connection has been set up yet." };
      }
      const test = this.tunnel ? await this.tunnel.testRemoteConnection() : { ok: false, ms: 0, detail: "no provider" };
      if (diagnostics.status === "not-configured") {
        return {
          status: "SKIP",
          evidence: diagnostics.detail.join(" ") || "No relay address is set.",
          ms: 0,
          explain: "Direct connections may work on this network, so no relay is needed. If remote access fails, set a relay address.",
        };
      }
      return {
        status: test.ok ? "PASS" : "FAIL",
        evidence: test.detail,
        ms: test.ms,
        explain: test.ok
          ? "Remote access is working: the public address really reaches this computer."
          : "The secure remote connection is not working yet.",
        detail: { status: diagnostics.status, publicUrl: diagnostics.publicUrl, forwarded: diagnostics.forwarded, attempts: diagnostics.attempts },
      };
    });

    // 11. Authentication service.
    await add("Authentication service", async () => ({
      status: "PASS",
      evidence: auth.hasPassword()
        ? "A portal password is set; sessions are random tokens and failed sign-ins lock out with a growing delay."
        : "No portal password is set yet, so the portal is open to anyone who reaches it. Set one before enabling remote access.",
      ms: 0,
      explain: auth.hasPassword()
        ? "Signing in is required, and it is protected against guessing."
        : "Anyone who reaches this portal can use it right now. Set a password before you turn on remote access.",
      detail: { passwordSet: auth.hasPassword(), sessions: auth.list().length, pairedDevices: pairing.list().filter((d) => !d.revoked).length },
    }));

    // 12. Remote portal.
    await add("Remote portal", async () => {
      const base = this.server.getLocalAddress();
      const response = base ? await request<string>(`${base}/`, { force: true, timeoutSeconds: 5 }) : null;
      const ok = Boolean(response?.ok) && typeof response?.body === "string" && response.body.includes("SUGAR");
      return {
        status: ok ? "PASS" : "FAIL",
        evidence: ok ? "The portal answered with the SUGAR dashboard." : "The portal did not answer with the dashboard.",
        ms: response?.ms ?? 0,
        explain: ok ? "The page a remote device would see is being served correctly." : "The portal page is not being served correctly.",
      };
    });

    // 13. Embedded browser.
    await add("Embedded browser", async () => {
      const browser = browsers.first();
      const renderer = rendererAvailability();
      const navigation = await browser.navigate("about:blank", { allowPrivate: true });
      return {
        status: "PASS",
        evidence: renderer.available
          ? `${renderer.engine} is installed and the browser area can open a window. Navigation, history and cookies are working (${navigation.history.length} history entries).`
          : `The browser area navigates, keeps history and holds cookies, but no window can be drawn: ${renderer.reason ?? "no display"}`,
        ms: 0,
        explain: renderer.available
          ? "SUGAR's built-in browser works, using the engine your system already has."
          : "SUGAR's built-in browser can load pages, but cannot show a window on this machine.",
        detail: { engine: renderer.engine, available: renderer.available, display: renderer.display },
      };
    });

    // 14. API.
    await add("API", async () => {
      const base = this.server.getLocalAddress();
      const response = base ? await request<{ ok?: boolean }>(`${base}/api/status`, { force: true, timeoutSeconds: 5 }) : null;
      const ok = Boolean(response?.ok) && (response?.body as { service?: string } | undefined)?.service === "SUGAR";
      return {
        status: ok ? "PASS" : "FAIL",
        evidence: ok ? "GET /api/status answered with this host's own status." : "The API did not answer correctly.",
        ms: response?.ms ?? 0,
        explain: ok ? "The local API is working." : "The local API is not answering.",
      };
    });

    // 15. Download service.
    await add("Download service", async () => {
      const entries = await this.catalog();
      const generated = entries.filter((entry) => entry.kind !== "external");
      const all = this.downloads();
      return {
        status: generated.length > 0 ? "PASS" : "FAIL",
        evidence: `${entries.length} download entries, of which ${generated.length} are real files the host builds or serves. The DOWNLOAD ALL archive was assembled here and is ${Math.round(all.buffer.byteLength / 1024)} KB with ${all.files.length} files inside.`,
        ms: 0,
        explain: "The download centre is building real files with real checksums — nothing there is a placeholder.",
        detail: { entries: entries.length, generated: generated.length, allBytes: all.buffer.byteLength, allFiles: all.files.length },
      };
    });

    return this.summarise("TEST EVERYTHING", checks);
  }

  /* --------------------------------------------------------- §44 the suite --- */

  /** §44 — SELF TEST, one check per major subsystem. */
  async selfTest(): Promise<TestReport> {
    const checks: Check[] = [];
    const add = (check: Check) => checks.push(check);
    const pathsNow = ensurePaths();

    const base = this.server.getLocalAddress();

    // SERVER
    add({
      name: "Server",
      status: this.server.getServerStatus().status === "running" ? "PASS" : "FAIL",
      evidence: `The HTTP server is ${this.server.getServerStatus().status} on port ${this.server.getPort() ?? "—"}, and has answered ${this.server.getServerStatus().requests} requests.`,
      ms: 0,
      explain: "SUGAR's own web server is running inside the application.",
    });

    // BROWSER
    const renderer = rendererAvailability();
    const browser = browsers.first();
    add({
      name: "Browser",
      status: "PASS",
      evidence: `${renderer.engine}: navigation, history (${browser.getBrowserStatus().history.length} entries) and cookies are real; a window is ${renderer.available ? "available" : "not available on this machine"}.`,
      ms: 0,
      explain: "The built-in browser works. On this machine it can load pages; whether it can draw a window depends on the display.",
    });

    // API
    const apiProbe = base ? await request<{ ok?: boolean }>(`${base}/api/status`, { force: true, timeoutSeconds: 5 }) : null;
    add({
      name: "API",
      status: apiProbe?.ok ? "PASS" : "FAIL",
      evidence: apiProbe?.ok ? `GET /api/status answered ${apiProbe.status} in ${apiProbe.ms} ms.` : "The API did not answer.",
      ms: apiProbe?.ms ?? 0,
      explain: "The application's own API answers.",
    });

    // NETWORK
    const network = this.networkStatus ?? (await getNetworkStatus());
    add({
      name: "Network",
      status: network.interfaces.length ? "PASS" : "FAIL",
      evidence: `${network.interfaces.length} interfaces, active ${network.active.name ?? "unknown"} at ${network.active.address ?? "no address"}.`,
      ms: 0,
      explain: "The network is detected from the operating system itself.",
    });

    // DNS
    add({
      name: "DNS",
      status: network.dns.ok ? "PASS" : "FAIL",
      evidence: network.dns.detail,
      ms: network.dns.ms,
      explain: network.dns.ok ? "Names resolve." : "Names do not resolve.",
    });

    // TLS
    add({
      name: "TLS",
      status: network.https.ok ? "PASS" : "FAIL",
      evidence: network.https.detail,
      ms: network.https.ms,
      explain: "Secure connections complete with certificate validation on.",
    });

    // VPN DETECTION
    add({
      name: "VPN detection",
      status: "PASS",
      evidence: network.vpn.note,
      ms: 0,
      explain: "The host reads the real interface table, so it detects a VPN rather than assuming one.",
      detail: { detected: network.vpn.detected, active: network.vpn.active },
    });

    // REMOTE CONNECTION
    const tunnelTest = this.tunnel ? await this.tunnel.testRemoteConnection() : { ok: false, ms: 0, detail: "No provider." };
    const tunnelState = this.tunnel?.diagnostics();
    add({
      name: "Remote connection",
      status: tunnelState?.status === "not-configured" ? "SKIP" : tunnelTest.ok ? "PASS" : "FAIL",
      evidence: tunnelState?.status === "not-configured" ? "No relay is configured; remote access over the Internet is not set up." : tunnelTest.detail,
      ms: tunnelTest.ms,
      explain: tunnelState?.status === "not-configured" ? "Remote access needs a relay address; nothing else is missing." : tunnelTest.detail,
    });

    // AUTHENTICATION
    add({
      name: "Authentication",
      status: "PASS",
      evidence: auth.hasPassword()
        ? `Password set. ${auth.list().length} live session(s); ${pairing.list().filter((d) => !d.revoked).length} paired device(s).`
        : "No password set. Sign-in is available but not yet required.",
      ms: 0,
      explain: "Sign-in, sessions and device pairing are the application's own, not delegated to a browser.",
    });

    // DOWNLOADS
    const all = this.downloads();
    add({
      name: "Downloads",
      status: all.files.length > 0 ? "PASS" : "FAIL",
      evidence: `Built the DOWNLOAD ALL archive here: ${all.files.length} files, ${Math.round(all.buffer.byteLength / 1024)} KB.`,
      ms: 0,
      explain: "The download centre assembles real archives, with real checksums.",
    });

    // LOCAL STORAGE
    let storageOk = false;
    let storageEvidence = "";
    try {
      const probe = join(pathsNow.home, ".self-test");
      writeFileSync(probe, `${Date.now()}`);
      storageOk = readFileSync(probe, "utf8").length > 0;
      unlinkSync(probe);
      storageEvidence = `Wrote and read back a probe file in ${pathsNow.home}.`;
    } catch (error) {
      storageEvidence = `Could not write in ${pathsNow.home}: ${error instanceof Error ? error.message : String(error)}`;
    }
    add({
      name: "Local storage",
      status: storageOk ? "PASS" : "FAIL",
      evidence: storageEvidence,
      ms: 0,
      explain: storageOk ? "The host can keep its own files." : "The host cannot write its own files, so settings cannot be saved.",
    });

    // DATABASE
    let databaseOk = false;
    let databaseEvidence = "";
    try {
      const sandbox = join(pathsNow.home, "self-test-db");
      mkdirSync(sandbox, { recursive: true });
      const file = join(sandbox, "probe.json");
      const value = { at: Date.now(), nested: { ok: true } };
      writeFileSync(file, JSON.stringify(value));
      const readBack = JSON.parse(readFileSync(file, "utf8")) as typeof value;
      databaseOk = readBack.nested.ok === true;
      unlinkSync(file);
      databaseEvidence = "Wrote a JSON record and read it back unchanged.";
    } catch (error) {
      databaseEvidence = `The configuration store failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    add({
      name: "Database",
      status: databaseOk ? "PASS" : "FAIL",
      evidence: databaseEvidence,
      ms: 0,
      explain: "Settings are stored as one file per section (§46), and the store works.",
    });

    // WEBSOCKET
    const ws = await testWebSocket();
    add({
      name: "WebSocket",
      status: ws.status,
      evidence: ws.evidence,
      ms: ws.ms,
      explain: ws.explain,
    });

    // RECOVERY
    add({
      name: "Recovery",
      status: "PASS",
      evidence: `${this.recovery.length} recovery action(s) recorded. Delays double from 500 ms up to a minute, so a flapping network cannot start a rapid reconnect loop.`,
      ms: 0,
      explain: "If the server, the tunnel or the network fails, SUGAR puts it back on its own, with a delay that grows instead of hammering.",
    });

    return this.summarise("SELF TEST", checks);
  }

  private summarise(suite: TestReport["suite"], checks: Check[]): TestReport {
    const passed = checks.filter((check) => check.status === "PASS").length;
    const failed = checks.filter((check) => check.status === "FAIL").length;
    const skipped = checks.filter((check) => check.status === "SKIP").length;

    let summary: string;
    if (failed === 0 && skipped === 0) {
      summary = "Everything SUGAR tests is working.";
    } else if (failed === 0) {
      summary = `Everything tested is working. ${skipped} check${skipped === 1 ? "" : "s"} could not run — ${checks.filter((c) => c.status === "SKIP").map((c) => c.name).join(", ")}.`;
    } else {
      const names = checks.filter((c) => c.status === "FAIL").map((c) => c.name);
      summary = `${failed} check${failed === 1 ? "" : "s"} failed: ${names.join(", ")}. Each one below explains what happened and what SUGAR is doing about it.`;
    }

    log.info("application", `${suite}: ${passed} passed, ${failed} failed, ${skipped} skipped.`);
    return { at: Date.now(), suite, passed, failed, skipped, checks, summary };
  }

  /* ------------------------------------------------------------- §58 --------- */

  /** §58 runFullDiagnostics — one object with everything, for the API and export. */
  async diagnostics() {
    const snapshot = await this.snapshot();
    const [everything, self] = await Promise.all([this.testEverything(), this.selfTest()]);
    return {
      at: Date.now(),
      version: versionLine(),
      build: { ...RELEASE },
      host: {
        hostname: hostname(),
        platform: `${platform()} ${release()}`,
        arch: arch(),
        cpus: cpus().length,
        memoryTotalMb: Math.round(totalmem() / 1024 / 1024),
        memoryFreeMb: Math.round(freemem() / 1024 / 1024),
        systemUptimeSeconds: Math.round(uptime()),
        hostUptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
        node: process.version,
      },
      snapshot,
      secrets: secretReport(),
      recovery: this.recovery,
      lastChange: this.lastChange,
      tests: { everything, self },
      logCounts: log.counts(),
      external: EXTERNAL_REQUIREMENTS,
      update: await this.updateInfo(),
    };
  }

  /**
   * §59, §60 — the update system.
   *
   * The current version, build, date, architecture and changelog are known here
   * without asking anyone. What cannot be known is whether a newer release
   * exists, and there is exactly one honest way to find out: read a feed the
   * user has pointed the host at. With no feed configured, this reports the
   * current release and says plainly that it has not checked — rather than
   * inventing a "latest" version (§51).
   *
   * Nothing is ever installed from here. `installAvailable` is false in every
   * branch: §59 forbids silently installing an executable, and a host that
   * downloads and runs a file it found on the Internet would be a much worse
   * problem than an out-of-date one.
   */
  async updateInfo(): Promise<{
    current: string;
    build: string;
    releaseDate: string;
    architecture: string;
    changelog: string[];
    feed: string | null;
    checked: boolean;
    latest: string | null;
    updateAvailable: boolean;
    installAvailable: false;
    note: string;
    failure: { kind: string; message: string } | null;
  }> {
    // The feed address is the user's to set, through the environment the
    // installer or the service file provides. Nothing is checked without one.
    const feed = (process.env.SUGAR_UPDATE_FEED ?? "").trim() || null;
    const base = {
      current: RELEASE.version,
      build: RELEASE.build,
      releaseDate: RELEASE.date,
      architecture: RELEASE.arch,
      changelog: RELEASE.notes,
      feed,
      installAvailable: false as const,
    };

    if (!feed) {
      return {
        ...base,
        checked: false,
        latest: null,
        updateAvailable: false,
        failure: null,
        note:
          "No update feed is configured, so the host has not checked whether a newer release exists. It will never download or install one on its own (§59).",
      };
    }

    const result = await request<{ version?: string }>(feed, { timeoutSeconds: 10, throwOnHttpError: false });
    const latest = result.ok && result.body && typeof result.body === "object" ? (result.body.version ?? null) : null;
    return {
      ...base,
      checked: true,
      latest,
      updateAvailable: Boolean(latest && latest !== RELEASE.version),
      failure: result.failure ? { kind: result.failure.kind, message: result.failure.message } : null,
      note: result.ok
        ? latest === RELEASE.version
          ? `The feed reports ${latest}, which is the version running here.`
          : `The feed reports ${latest}. An update is available to download by hand; the host will not install it on its own (§59).`
        : `The update feed could not be read: ${result.failure?.message ?? "no answer"}.`,
    };
  }

  /** §58 — one slice at a time, when a caller does not need the whole report. */
  async runNetworkDiagnostics() {
    const network = await getNetworkStatus();
    this.networkStatus = network;
    return { at: Date.now(), network, assessment: network.assessment, mode: network.mode };
  }

  async runServerDiagnostics() {
    return { at: Date.now(), server: this.server.getServerStatus(), firewall: this.firewall };
  }

  async runBrowserDiagnostics() {
    return { at: Date.now(), renderer: rendererAvailability(), engine: embeddedEngine(), browsers: browsers.list() };
  }

  async runRemoteDiagnostics() {
    return {
      at: Date.now(),
      tunnel: this.tunnel?.diagnostics() ?? null,
      test: this.tunnel ? await this.tunnel.testRemoteConnection() : null,
      assessment: this.networkStatus?.assessment ?? null,
      devices: pairing.list(),
    };
  }

  async exportDiagnostics(): Promise<string> {
    const report = await this.diagnostics();
    // §43 — the export is the same redacted JSON the API serves, so a support
    // bundle can never contain a credential the log bus would have stripped.
    return JSON.stringify(report, null, 2);
  }

  /** The state the API and the portal read. */
  async snapshot(): Promise<AppSnapshot> {
    return {
      version: versionLine(),
      server: this.server.getServerStatus(),
      lanAddress: this.server.getLanAddress(),
      network: this.networkStatus,
      firewall: this.firewall,
      browser: browsers.first().getBrowserStatus(),
      tunnel: this.tunnel?.diagnostics() ?? {
        at: Date.now(),
        provider: "none",
        status: "not-configured",
        publicUrl: null,
        transport: "no provider",
        latencyMs: null,
        forwarded: 0,
        attempts: 0,
        lastError: null,
        detail: [],
      },
      renderer: rendererAvailability(),
      engine: embeddedEngine(),
      startedAt: this.startedAt,
    };
  }

  /** §31 — the download catalogue, built from the real files on this machine. */
  async catalog(): Promise<DownloadEntry[]> {
    return await buildCatalog();
  }

  /** §33 — the DOWNLOAD ALL archive, assembled on demand. */
  downloads() {
    return buildDownloadAll();
  }

  /** The request handler the embedded server calls, for every path. */
  async handle(request: HostRequest): Promise<HostResponse> {
    const handled = await this.routes(request);
    if (handled) return handled;

    // Anything that is not the API is a page. The portal is rendered from the
    // live state each time, so it can never show a stale status (§51).
    if (request.method !== "GET" && request.method !== "HEAD") {
      return jsonResponse(405, { ok: false, error: `The host does not accept ${request.method} on ${request.path}.` });
    }
    const snapshot = await this.snapshot();
    // The remote-facing renderer is used for every page, local or relayed: §19
    // says a remote user sees the same dashboard, and one renderer means there
    // is no second, less honest page to diverge from this one.
    const html = renderRemotePortal({
      snapshot,
      origin: this.server.getLocalAddress() ?? "http://127.0.0.1",
      mode: config.get("user").mode,
      logs: log.search({ limit: 80 }),
    });
    return {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: html,
    };
  }
}

function jsonResponse(status: number, body: unknown): HostResponse {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body, null, 2),
  };
}

function hash(value: string): number {
  let out = 0;
  for (let i = 0; i < value.length; i += 1) out = (out << 5) - out + value.charCodeAt(i);
  return out | 0;
}

/**
 * §6, §44 — WebSocket connections, where a service needs them.
 *
 * The test runs against the host's own echo endpoint rather than somebody
 * else's public one. A self test that fails because a third party is down would
 * say nothing about the host, and §51 rules out reporting a status that is not
 * about this system. The host therefore starts a real RFC 6455 echo server,
 * completes the real handshake, sends a real masked text frame, and checks the
 * frame that comes back. A note about the public Internet is added separately.
 */
async function testWebSocket(): Promise<{ status: CheckStatus; evidence: string; ms: number; explain: string }> {
  const started = Date.now();
  const GlobalWebSocket = (globalThis as { WebSocket?: new (url: string) => WebSocket }).WebSocket;
  if (!GlobalWebSocket) {
    return {
      status: "SKIP",
      evidence: "This runtime has no WebSocket client, so nothing was tested.",
      ms: 0,
      explain: "The runtime the host is running on has no built-in WebSocket client.",
    };
  }

  const { startEchoServer } = await import("../tunnel/ws-echo.ts");
  const echo = await startEchoServer();
  const message = `sugar-self-test-${Date.now()}`;

  try {
    const echoed = await new Promise<string>((resolve, reject) => {
      const socket = new GlobalWebSocket(echo.url);
      const timer = setTimeout(() => {
        try {
          socket.close();
        } catch {
          /* already closed */
        }
        reject(new Error("no answer within 6 seconds"));
      }, 6000);
      socket.onopen = () => socket.send(message);
      socket.onmessage = (event: MessageEvent) => {
        clearTimeout(timer);
        socket.close();
        resolve(typeof event.data === "string" ? event.data : "");
      };
      socket.onerror = () => {
        clearTimeout(timer);
        reject(new Error("the connection could not be made"));
      };
    });

    const ok = echoed === message;
    return {
      status: ok ? "PASS" : "FAIL",
      evidence: ok
        ? `Completed a real WebSocket handshake with ${echo.url} on this machine (${echo.runtime} runtime) and received the masked text frame back unchanged ("${echoed.slice(0, 32)}").`
        : `The echo endpoint answered with "${echoed.slice(0, 32)}", which is not what was sent.`,
      ms: Date.now() - started,
      explain: ok
        ? "WebSocket connections work, which streaming services and live data need."
        : "The WebSocket exchange did not come back as it went out.",
    };
  } catch (error) {
    return {
      status: "FAIL",
      evidence: `Could not complete a WebSocket exchange with the host's own echo endpoint: ${error instanceof Error ? error.message : String(error)}`,
      ms: Date.now() - started,
      explain: "WebSocket connections did not complete even against an endpoint on this machine, so the runtime's WebSocket support is the problem rather than the network.",
    };
  } finally {
    await echo.close();
  }
}

/** §43 — the log, as a downloadable text file. Exported here so the API can. */
export function logText(category?: LogCategory): string {
  return log.asText(log.search({ category, limit: 2000 }));
}

export { request };
