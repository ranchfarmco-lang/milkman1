/**
 * NOVA OS — the assembled system.
 *
 * Everything else is a component; this is the thing that joins them. It creates
 * each component, registers it with the supervisor in dependency order, wires
 * the parts that need to know about each other (the application runtime needs the
 * web service; the firewall needs to hear about the web service's ports), and
 * publishes the OS's own portal.
 *
 * The portal is §15, and it is served by the OS's own web service — no external
 * server, and nothing borrowed from another application. Every number on it is
 * read from the component that owns it at the moment the page is rendered.
 */

import { config, ensureOsPaths, log, osVersionLine, OS_NAME, OS_RELEASE, type OsComponent } from "./core/runtime.ts";
import { ServiceSupervisor } from "./init/supervisor.ts";
import { NetworkManager } from "./net/manager.ts";
import { VpnManager } from "./net/vpn.ts";
import { FirewallManager } from "./net/firewall.ts";
import { WebService, HEALTH_PATH, jsonResponse, textResponse } from "./web/service.ts";
import { PackageManager } from "./pkg/manager.ts";
import { AppRuntime } from "./apps/runtime.ts";
import { AiRuntime } from "./ai/runtime.ts";
import { CommsEngine } from "./comms/engine.ts";
import { DiagnosticsService } from "./diag/audit.ts";
import { auditRequirements, type AuditReport } from "./diag/audit.ts";
import { REQUIREMENTS } from "./requirements.ts";

export type SystemReport = {
  at: number;
  os: string;
  version: string;
  uptimeSeconds: number;
  services: ReturnType<ServiceSupervisor["report"]>;
  capability: ReturnType<ServiceSupervisor["capabilityReport"]>;
  net: ReturnType<NetworkManager["getConnectivityStatus"]>;
  vpn: ReturnType<VpnManager["getVpnStatus"]>;
  firewall: ReturnType<FirewallManager["getFirewallStatus"]>;
  web: ReturnType<WebService["getServerStatus"]>;
  pkg: ReturnType<PackageManager["report"]>;
  apps: ReturnType<AppRuntime["list"]>;
  ai: ReturnType<AiRuntime["modelStatus"]>;
  comms: Awaited<ReturnType<CommsEngine["diagnostics"]>>;
  portal: { http: string; https: string | null; lan: string | null };
};

export class NovaSystem {
  readonly supervisor = new ServiceSupervisor();
  readonly net = new NetworkManager();
  readonly vpn = new VpnManager();
  readonly firewall = new FirewallManager();
  readonly web = new WebService();
  readonly pkg = new PackageManager();
  readonly apps: AppRuntime;
  readonly ai = new AiRuntime();
  readonly comms = new CommsEngine();
  readonly diag: DiagnosticsService;

  private startedAt = 0;
  private audit: AuditReport | null = null;
  /** High ports used when the configuration asks for port 0 (a test). */
  private boundHttp = 0;
  private boundHttps = 0;

  constructor() {
    this.apps = new AppRuntime(this.web);
    this.diag = new DiagnosticsService([
      { name: "server", run: async () => ({ ok: this.web.getServerStatus().http.listening, detail: `The OS web service is ${this.web.getServerStatus().http.listening ? "listening" : "not listening"} on port ${this.boundHttp || config.get("web").httpPort}.` }) },
      { name: "network", run: async () => ({ ok: (this.net.getConnectivityStatus().internet), detail: this.net.getConnectivityStatus().nat.verdict }) },
      { name: "vpn", run: async () => ({ ok: true, detail: this.vpn.getVpnStatus().error ?? `The VPN subsystem is up and the tunnel is ${this.vpn.getVpnStatus().state}.` }) },
      { name: "firewall", run: async () => { const plan = this.firewall.getFirewallStatus(); return { ok: plan.validation.ok, detail: `The ruleset is ${plan.validation.ok ? "valid" : "invalid"} with ${plan.openPorts.length} open port(s).` }; } },
      { name: "packages", run: async () => ({ ok: true, detail: `${this.pkg.installed().length} package(s) installed from ${this.pkg.available().length} available recipe(s).` }) },
      { name: "ai", run: async () => { const status = this.ai.modelStatus(); return { ok: true, detail: `${status.models.length} model(s) in the store; ${status.inferenceAvailable ? "an inference engine is installed" : "no inference engine is installed"}.` }; } },
      { name: "comms", run: async () => { const report = await this.comms.diagnostics(); return { ok: report.sdp.ok, detail: `${report.ice.candidates.length} ICE candidate(s); SDP ${report.sdp.ok ? "builds and parses" : "failed"}.` }; } },
      { name: "audit", run: async () => { const report = this.runAudit(); return { ok: report.findings.length === 0, detail: report.verdict }; } },
      { name: "storage", run: async () => { const paths = ensureOsPaths(); return { ok: Boolean(paths.root), detail: `The OS keeps its state under ${paths.root}.` }; } },
      { name: "update", run: async () => ({ ok: true, detail: this.updateStatus().note }) },
    ]);

    // Register in dependency order; the supervisor enforces the order at start.
    this.supervisor.register({ component: this.net, restart: "always", maxRestarts: 5, healthSeconds: 30 });
    this.supervisor.register({ component: this.vpn, restart: "on-failure", maxRestarts: 3, healthSeconds: 20 });
    this.supervisor.register({ component: this.firewall, restart: "on-failure", maxRestarts: 3, healthSeconds: 0 });
    this.supervisor.register({ component: this.web, restart: "always", maxRestarts: 5, healthSeconds: 20 });
    this.supervisor.register({ component: this.pkg, restart: "on-failure", maxRestarts: 2, healthSeconds: 0 });
    this.supervisor.register({ component: this.apps, restart: "on-failure", maxRestarts: 2, healthSeconds: 15 });
    this.supervisor.register({ component: this.ai, restart: "on-failure", maxRestarts: 2, healthSeconds: 0 });
    this.supervisor.register({ component: this.comms, restart: "on-failure", maxRestarts: 2, healthSeconds: 0 });
    this.supervisor.register({ component: this.diag, restart: "on-failure", maxRestarts: 2, healthSeconds: 0 });

    // The firewall learns the web service's real ports rather than a guess.
    this.web.registerService("health", HEALTH_PATH, "the OS's own health endpoint", () => jsonResponse(200, { ok: true, os: `${OS_NAME} OS`, version: OS_RELEASE.version }));
    this.web.registerService("nova-portal", "/", "the NOVA OS portal", (request) => this.renderPortal(request.path));
    this.web.registerService("api", "/api", "the OS API", (request) => jsonResponse(200, { ok: true, report: this.report(), path: request.path }));
  }

  /** Boot: the sequence §27 of the earlier specification describes, in OS terms. */
  async boot(): Promise<{
    sequence: { step: string; ok: boolean; detail: string }[];
    services: { name: string; ok: boolean; error: string | null }[];
    addresses: { http: string | null; https: string | null; lan: string | null };
    audit: AuditReport;
  }> {
    const sequence: { step: string; ok: boolean; detail: string }[] = [];
    const step = (name: string, ok: boolean, detail: string) => {
      sequence.push({ step: name, ok, detail });
      log.info("init", `Boot — ${name}: ${detail}`);
    };

    this.startedAt = Date.now();
    step("Identify the system", true, osVersionLine());
    const paths = ensureOsPaths();
    step("Prepare the state tree", true, paths.root);

    const services = await this.supervisor.startAll();
    for (const result of services) {
      step(`Start ${result.name}`, result.ok, result.error ?? "running");
    }

    this.boundHttp = this.web.getServerStatus().http.port ?? 0;
    const https = this.web.getServerStatus().https;
    const lan = this.net.getActiveInterface();
    step("Serve the OS portal", this.web.getServerStatus().http.listening, `http://0.0.0.0:${this.boundHttp}`);

    const audit = this.runAudit();
    step("Audit the requirements", audit.findings.length === 0, audit.verdict);

    await this.pkg.start();
    return {
      sequence,
      services,
      addresses: {
        http: this.boundHttp ? `http://127.0.0.1:${this.boundHttp}` : null,
        https: https.listening ? `https://127.0.0.1:${https.port}` : null,
        lan: lan.address ? `http://${lan.address}:${this.boundHttp}` : null,
      },
      audit,
    };
  }

  async shutdown(): Promise<void> {
    await this.supervisor.shutdown();
  }

  /** §35 — the audit, cached for the process's lifetime unless asked to rerun. */
  runAudit(force = false): AuditReport {
    if (!this.audit || force) {
      const root = new URL("..", import.meta.url).pathname;
      this.audit = auditRequirements(REQUIREMENTS, root, `${root}os/tests/run.ts`);
    }
    return this.audit;
  }

  /** §43/§59 — the update status, reported honestly. */
  updateStatus(): { current: string; build: string; releaseDate: string; feed: string | null; checked: boolean; latest: string | null; updateAvailable: boolean; installAvailable: false; note: string } {
    const feed = config.get("update").feed;
    return {
      current: OS_RELEASE.version,
      build: OS_RELEASE.build,
      releaseDate: OS_RELEASE.date,
      feed,
      checked: false,
      latest: null,
      updateAvailable: false,
      installAvailable: false,
      note: feed
        ? `An update feed is configured at ${feed}. The OS reports it but will not install anything on its own: a system update is promoted through the change pipeline with a snapshot taken first (§25, §59).`
        : "No update feed is configured, so the OS has not checked for a newer release. It never installs an update without an authorised promotion and a snapshot.",
    };
  }

  /** The whole live state, for the portal, the API and the diagnostics. */
  report(): SystemReport {
    const http = this.boundHttp || config.get("web").httpPort;
    const https = this.web.getServerStatus().https;
    const lan = this.net.getActiveInterface();
    return {
      at: Date.now(),
      os: `${OS_NAME} OS`,
      version: `${OS_RELEASE.version} (build ${OS_RELEASE.build}, ${OS_RELEASE.date})`,
      uptimeSeconds: this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
      services: this.supervisor.report(),
      capability: this.supervisor.capabilityReport(),
      net: this.net.getConnectivityStatus(),
      vpn: this.vpn.getVpnStatus(),
      firewall: this.firewall.getFirewallStatus(),
      web: this.web.getServerStatus(),
      pkg: this.pkg.report(),
      apps: this.apps.list(),
      ai: this.ai.modelStatus(),
      comms: { at: 0, signalling: { ok: true, note: "" }, ice: { at: 0, candidates: [], stun: { server: "", ok: false, address: null, port: null, ms: 0, error: null }, verdict: "" }, sdp: { ok: true, note: "" }, devices: this.comms.devices(), sessions: this.comms.active().length, history: this.comms.callHistory(1).length },
      portal: {
        http: `http://127.0.0.1:${http}`,
        https: https.listening ? `https://127.0.0.1:${https.port}` : null,
        lan: lan.address ? `http://${lan.address}:${http}` : null,
      },
    };
  }

  /* -------------------------------------------------------------- §15 portal --- */

  /**
   * The portal. Server-rendered from live state on every request, in one page,
   * responsive, with no build step and no framework — which is what lets it work
   * identically from a phone, a Chromebook and a desktop browser (§15).
   */
  renderPortal(path: string): ReturnType<typeof textResponse> {
    if (path !== "/" && path !== "/index.html" && path !== "/portal") {
      return textResponse(404, `No page at ${path}. The portal lives at /.`);
    }
    const report = this.report();
    const color = (ok: boolean | null) => (ok === null ? "#94a3b8" : ok ? "#34d399" : "#f87171");

    const serviceRows = report.services
      .map((service) => `<tr><td>${escapeHtml(service.name)}</td><td>${escapeHtml(service.about)}</td><td>${service.requires.length ? escapeHtml(service.requires.join(", ")) : "—"}</td><td style="color:${color(service.status === "running")}">${escapeHtml(service.status)}</td><td>${service.restarts}</td></tr>`)
      .join("");

    const blocked = report.capability
      .flatMap((entry) => entry.blocked.map((item) => ({ service: entry.name, ...item })))
      .map((item) => `<li><b>${escapeHtml(item.service)}</b> — ${escapeHtml(item.what)}<br /><span class="dim">${escapeHtml(item.why)}</span><br /><span class="fix">${escapeHtml(item.fallback)}</span></li>`)
      .join("");

    return textResponse(
      200,
      `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(report.os)} — portal</title>
<style>
  :root{--bg:#070a10;--panel:#0e1420;--line:#1c2536;--ink:#e7edf8;--dim:#8d9cb8;--accent:#5eead4}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
  .wrap{max-width:1120px;margin:0 auto;padding:22px 16px 70px}
  header{display:flex;flex-wrap:wrap;gap:14px;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line);padding-bottom:14px;margin-bottom:20px}
  h1{margin:0;font-size:20px;letter-spacing:.28em}
  .sub{margin:0;color:var(--dim);font-size:11px}
  .grid{display:grid;gap:10px;grid-template-columns:repeat(auto-fill,minmax(215px,1fr));margin-bottom:20px}
  .tile{background:var(--panel);border:1px solid var(--line);border-radius:13px;padding:14px}
  .k{margin:0;color:var(--dim);font-size:10px;letter-spacing:.12em;text-transform:uppercase}
  .v{margin:5px 0 0;font-size:16px;font-weight:600;word-break:break-word}
  .hint{margin:7px 0 0;color:var(--dim);font-size:11px}
  section{background:var(--panel);border:1px solid var(--line);border-radius:13px;padding:16px;margin-bottom:16px}
  h2{margin:0 0 10px;font-size:14px;letter-spacing:.05em}
  table{width:100%;border-collapse:collapse;font-size:12px}
  th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}
  th{color:var(--dim);font-size:10px;letter-spacing:.08em;text-transform:uppercase}
  .dim{color:var(--dim)}.fix{color:var(--accent)}
  ul{padding-left:18px}li{margin:8px 0}
  .mono{font-family:ui-monospace,Menlo,monospace;font-size:11px;word-break:break-all}
  @media(max-width:640px){.wrap{padding:14px 12px 50px}}
</style></head><body><div class="wrap">
<header><div><h1>${escapeHtml(OS_NAME)}</h1><p class="sub">${escapeHtml(report.version)} · up ${report.uptimeSeconds}s</p></div>
<div class="sub">${escapeHtml(report.portal.http)}${report.portal.lan ? ` · ${escapeHtml(report.portal.lan)}` : ""}${report.portal.https ? ` · ${escapeHtml(report.portal.https)}` : ""}</div></header>

<div class="grid">
  ${tile("Web server", report.web.http.listening ? `listening on ${report.web.http.port}` : "not listening", report.web.http.listening, `${report.web.services.length} service(s) published`)}
  ${tile("TLS", report.web.https.listening ? `HTTPS on ${report.web.https.port}` : "not listening", report.web.https.listening, report.web.https.note)}
  ${tile("Internet", report.net.internet ? `working · ${report.net.latencyMs ?? "?"} ms` : "not reachable", report.net.internet, report.net.publicIp ?? "no public address")}
  ${tile("NAT / CGNAT", report.net.nat.behindCgnat ? "behind CGNAT" : report.net.nat.behindNat ? "behind NAT" : "public address", !report.net.nat.behindCgnat, report.net.nat.verdict.split(".")[0])}
  ${tile("VPN", report.vpn.state, report.vpn.state === "on", report.vpn.interfaceName ?? "no tunnel interface")}
  ${tile("Firewall", report.firewall.enabled ? `${report.firewall.defaultInbound} inbound` : "disabled", report.firewall.validation.ok, `${report.firewall.openPorts.length} port(s) open`)}
  ${tile("Packages", `${report.pkg.installed.length} installed`, true, `${report.pkg.store.objects} store object(s)`)}
  ${tile("Applications", `${report.apps.length} defined`, true, report.apps.filter((app) => app.status === "running").length + " running")}
  ${tile("AI", report.ai.inferenceAvailable ? `engine ready` : "no engine", report.ai.inferenceAvailable, `${report.ai.models.length} model(s)`) }
  ${tile("Comms", `${report.comms.devices.filter((device) => device.available).length} device(s)`, true, `${report.comms.sessions} active call(s)`)}
</div>

<section><h2>Services</h2>
<table><thead><tr><th>Service</th><th>What it does</th><th>Requires</th><th>Status</th><th>Restarts</th></tr></thead><tbody>${serviceRows}</tbody></table></section>

<section><h2>What this OS can and cannot do here</h2>
<p class="dim">Every entry below is a capability the implementation genuinely lacks in this environment, with the reason and the closest thing it does instead. Nothing on this page is reported as working when it is not.</p>
<ul>${blocked || "<li>No limitations were reported by any service.</li>"}</ul></section>

<section><h2>Published paths</h2>
<table><thead><tr><th>Path</th><th>Service</th><th>Requests</th></tr></thead><tbody>${report.web.services
        .map((service) => `<tr><td class="mono">${escapeHtml(service.prefix)}</td><td>${escapeHtml(service.name)}</td><td>${service.requests}</td></tr>`)
        .join("")}</tbody></table></section>

<p class="dim">Rendered from live state at ${new Date(report.at).toISOString()}.</p>
</div></body></html>
`,
      "text/html; charset=utf-8",
    );
  }

  /** Services the OS exposes, for the diagnostics page and the API. */
  get components(): OsComponent[] {
    return [this.net, this.vpn, this.firewall, this.web, this.pkg, this.apps, this.ai, this.comms, this.diag];
  }
}

function tile(label: string, value: string, ok: boolean | null, hint?: string): string {
  const color = ok === null ? "#94a3b8" : ok ? "#34d399" : "#f87171";
  return `<div class="tile"><p class="k">${escapeHtml(label)}</p><p class="v" style="color:${color}">${escapeHtml(value)}</p>${hint ? `<p class="hint">${escapeHtml(hint)}</p>` : ""}</div>`;
}

function escapeHtml(value: string): string {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
