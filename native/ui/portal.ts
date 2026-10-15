/**
 * §20 the dashboard, §21 status indicators, §23/§24 beginner and advanced mode,
 * §29 the browser area, §36 the remote-access page, §49 the documentation,
 * §50 the troubleshooting wizard, §63 the first-run result.
 *
 * The page is rendered from the live snapshot on every request, in the server
 * process, with no client build step and no framework. That is deliberate: the
 * dashboard must show what the host measured a moment ago, and a page built from
 * a cached bundle cannot promise that. Every value below comes from the snapshot
 * that was taken for this request (§51).
 */

import { auth } from "../auth/auth.ts";
import { config } from "../storage/config.ts";
import { pairing } from "../devices/pairing.ts";
import { RELEASE } from "../core/version.ts";
import { toSvg, qrCapability } from "./qr.ts";
import type { AppSnapshot } from "../core/app.ts";
import type { LogEntry } from "../core/log.ts";

export type PortalModel = {
  snapshot: AppSnapshot;
  origin: string;
  mode: "beginner" | "advanced";
  logs: LogEntry[];
  /** Whether the caller already holds a session. */
  signedIn?: boolean;
  /** Whether the host requires sign-in at all right now. */
  passwordSet?: boolean;
  /** What the first-run wizard decided (§63). */
  firstRunResult?: string;
};

/* ------------------------------------------------------------------ helpers -- */

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

type Tone = "green" | "yellow" | "blue" | "red" | "gray";

/** §21 — the five colours, and the words that go with them. */
const TONES: Record<Tone, string> = {
  green: "#34d399",
  yellow: "#fbbf24",
  blue: "#60a5fa",
  red: "#f87171",
  gray: "#94a3b8",
};

const TONE_WORDS: Record<Tone, string> = {
  green: "CONNECTED",
  yellow: "CONNECTING",
  blue: "TESTING CONNECTION",
  red: "CONNECTION FAILED",
  gray: "NOT CONFIGURED",
};

function chip(tone: Tone, label?: string): string {
  return `<span class="chip" style="--tone:${TONES[tone]}"><i></i>${esc(label ?? TONE_WORDS[tone])}</span>`;
}

function tile(label: string, value: string, tone: Tone, hint?: string): string {
  return `<div class="tile">
    <p class="tile-label">${esc(label)}</p>
    <p class="tile-value">${esc(value)}</p>
    ${chip(tone)}
    ${hint ? `<p class="tile-hint">${esc(hint)}</p>` : ""}
  </div>`;
}

function uptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days}d ${hours}h ${minutes}m`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m ${seconds % 60}s`;
}

/* ----------------------------------------------------------- the sign-in page -- */

function signInPage(model: PortalModel, message: string): string {
  return shell(
    model,
    `<section class="panel narrow">
      <h1>SUGAR</h1>
      <p class="lede">${esc(message)}</p>
      <form id="signin" autocomplete="on">
        <label for="label">What should this device be called?</label>
        <input id="label" name="label" value="A remote device" maxlength="40" />
        <label for="password">Portal password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required />
        <button type="submit">Sign in</button>
        <p class="note" id="signin-note"></p>
      </form>
    </section>`,
    true,
  );
}

/* --------------------------------------------------------------- the page ----- */

export function renderPortal(model: PortalModel): string {
  const snapshot = model.snapshot;
  const passwordSet = model.passwordSet ?? auth.hasPassword();
  const signedIn = model.signedIn ?? true;

  if (passwordSet && !signedIn) {
    return signInPage(model, "This host is protected. Sign in to continue. Sessions expire on their own, and repeated failures are slowed down.");
  }

  const network = snapshot.network;
  const publicUrl = snapshot.tunnel.publicUrl;
  const renderer = snapshot.renderer;

  /* §20 — the dashboard, every field the specification names. */
  const tiles = [
    tile(
      "Server",
      snapshot.server.status === "running" ? `Running on port ${snapshot.server.port}` : snapshot.server.status,
      snapshot.server.status === "running" ? "green" : "red",
      `${snapshot.server.requests} requests · ${snapshot.server.connections} open connections`,
    ),
    tile(
      "Browser",
      renderer.available ? `${renderer.engine} — window available` : `${renderer.engine} — no window`,
      renderer.available ? "green" : "yellow",
      renderer.available ? "The system's own engine, not a second browser" : (renderer.reason ?? ""),
    ),
    tile(
      network?.internet.ok ? "Internet" : "Internet",
      network?.internet.ok ? `Working · ${network.internet.ms} ms` : "Not reachable",
      network?.internet.ok ? "green" : "red",
      network?.internet.publicIp ? `This network appears as ${network.internet.publicIp}` : undefined,
    ),
    tile(
      "VPN",
      network?.vpn.detected ? (network.vpn.active ? "On, carrying traffic" : "Present, not carrying traffic") : "Off",
      "green",
      network?.vpn.note,
    ),
    tile(
      "Starlink / network",
      network?.assessment.behindCarrierNat ? "Behind carrier-grade NAT" : "Direct address possible",
      network?.assessment.tunnelRequired ? "yellow" : "green",
      network?.assessment.conclusion.split(".")[0],
    ),
    tile(
      "Remote access",
      publicUrl ? "Connected" : snapshot.tunnel.status === "not-configured" ? "Not configured" : TONE_WORDS.gray,
      publicUrl ? "green" : snapshot.tunnel.status === "connecting" || snapshot.tunnel.status === "reconnecting" ? "yellow" : "gray",
      snapshot.tunnel.transport,
    ),
    tile(
      "Connected devices",
      `${pairing.list().filter((device) => !device.revoked).length} paired`,
      "green",
      `${auth.list().length} live session(s)`,
    ),
    tile("Local address", snapshot.server.localAddress ?? "Not listening", snapshot.server.localAddress ? "green" : "red", "On this computer — always works"),
    tile(
      "LAN address",
      snapshot.lanAddress ?? "Not on a private network",
      snapshot.lanAddress ? "green" : "gray",
      snapshot.lanAddress ? "Any device on this network can open this" : undefined,
    ),
    tile("Remote address", publicUrl ?? "None yet", publicUrl ? "green" : "gray", publicUrl ? "Reachable from anywhere" : "Needs a relay (§14)"),
    tile("Current interface", network?.active.name ?? "Unknown", network?.active.vpn ? "yellow" : "green", network?.active.address ?? undefined),
    tile("Uptime", uptime(Math.round((Date.now() - snapshot.startedAt) / 1000)), "green", `Version ${RELEASE.version}, build ${RELEASE.build}`),
  ].join("");

  /* §36 — the remote access page, with a real QR for the real address. */
  let qrBlock = `<p class="note">There is no public address yet, so there is no QR code and nothing to scan. A QR appears here the moment the tunnel is connected, and it carries only the portal address — never a credential (§48).</p>`;
  if (publicUrl) {
    try {
      qrBlock = `<div class="qr">${toSvg(publicUrl)}</div>
        <p class="mono">${esc(publicUrl)}</p>
        <button class="ghost" data-copy="${esc(publicUrl)}">COPY ADDRESS</button>`;
    } catch (error) {
      qrBlock = `<p class="note">The address is longer than this encoder covers, so no QR is shown rather than a broken one: ${esc(error instanceof Error ? error.message : String(error))}</p>
        <p class="mono">${esc(publicUrl)}</p>
        <button class="ghost" data-copy="${esc(publicUrl)}">COPY ADDRESS</button>`;
    }
  }

  const devices = pairing.list();
  const deviceRows = devices.length
    ? devices
        .map(
          (device) => `<tr>
            <td>${esc(device.label)}</td>
            <td>${device.revoked ? "Revoked" : "Paired"}</td>
            <td>${device.lastSeen ? new Date(device.lastSeen).toLocaleString() : "never"}</td>
            <td><button class="ghost admin-only" data-revoke="${esc(device.id)}" ${device.revoked ? "disabled" : ""}>Revoke</button></td>
          </tr>`,
        )
        .join("")
    : `<tr><td colspan="4" class="note">No device has been paired yet. Genuine pairing needs the host's own dashboard, which holds the code (§18).</td></tr>`;

  /* §27, §39, §45 — what the host has been doing, and what it did about it. */
  const logRows = model.logs
    .slice(0, 60)
    .map(
      (entry) => `<tr>
        <td class="mono">${new Date(entry.at).toLocaleTimeString()}</td>
        <td>${esc(entry.level)}</td>
        <td>${esc(entry.category)}</td>
        <td>${esc(entry.message)}</td>
      </tr>`,
    )
    .join("");

  const sections = [
    {
      id: "dashboard",
      label: "Dashboard",
      body: `<div class="grid">${tiles}</div>
        <div class="panel">
          <h2>What SUGAR is doing</h2>
          <p>${esc(network?.assessment.conclusion ?? "The network has not been measured yet.")}</p>
          <ul class="plain">${(network?.assessment.detail ?? []).map((line) => `<li>${esc(line)}</li>`).join("")}</ul>
        </div>`,
    },
    {
      id: "tests",
      label: "Test everything",
      body: `<div class="panel">
          <button id="run-everything">TEST EVERYTHING</button>
          <p class="note">Fifteen checks, run now, each shown separately with the evidence behind it (§22). Nothing here is a cached value.</p>
          <div id="everything-result"></div>
        </div>
        <div class="panel">
          <button class="ghost" id="run-self">SELF TEST (14 subsystems)</button>
          <div id="self-result"></div>
        </div>`,
    },
    {
      id: "browser",
      label: "Browser",
      body: `<div class="panel">
          <div class="row">
            <input id="url" placeholder="https://example.com" value="about:blank" />
            <button id="go">GO</button>
            <button class="ghost" data-nav="back">BACK</button>
            <button class="ghost" data-nav="forward">FORWARD</button>
            <button class="ghost" data-nav="reload">REFRESH</button>
            <button class="ghost" data-nav="stop">STOP</button>
            <button class="ghost" data-nav="home">HOME</button>
          </div>
          <p class="note">${
            renderer.available
              ? `Pages are rendered by ${esc(renderer.engine)}, the engine this system already has.`
              : `No window can be drawn on this machine: ${esc(renderer.reason ?? "")} The browser still navigates, keeps history, holds cookies and saves downloads.`
          }</p>
          <div id="browser-status"></div>
        </div>`,
    },
    {
      id: "remote",
      label: "Remote access",
      body: `<div class="panel">
          <h2>REMOTE ACCESS</h2>
          <div class="grid">
            ${tile("Status", publicUrl ? "CONNECTED" : TONE_WORDS.gray, publicUrl ? "green" : "gray")}
            ${tile("Connection type", snapshot.tunnel.provider, publicUrl ? "green" : "gray", snapshot.tunnel.transport)}
            ${tile("Public address", publicUrl ?? "None", publicUrl ? "green" : "gray")}
            ${tile("Forwarded requests", String(snapshot.tunnel.forwarded), "green", snapshot.tunnel.latencyMs !== null ? `${snapshot.tunnel.latencyMs} ms round trip` : undefined)}
          </div>
          ${qrBlock}
          <div class="row">
            <button class="admin-only" id="tunnel-action" data-action="reconnect">RECONNECT</button>
            <button class="admin-only ghost" data-action="disconnect">DISCONNECT</button>
          </div>
          <p class="note">${esc((snapshot.tunnel.detail ?? []).join(" ") || "No tunnel events yet.")}</p>
        </div>
        <div class="panel">
          <h2>Paired devices</h2>
          <table><thead><tr><th>Device</th><th>State</th><th>Last seen</th><th></th></tr></thead><tbody>${deviceRows}</tbody></table>
          <div class="row">
            <input id="pair-label" placeholder="What should the device be called?" value="A phone" maxlength="40" />
            <button class="admin-only" id="pair-begin">PAIR NEW DEVICE</button>
          </div>
          <div id="pair-result"></div>
        </div>`,
    },
    {
      id: "downloads",
      label: "Downloads",
      body: `<div class="panel">
          <h2>Downloads</h2>
          <p class="note">Every card below is a real file the host builds or serves, with its real size and checksum. Components that cannot be bundled are listed with their official source and no mirror (§32, §34, §51, §67).</p>
          <div id="downloads">Loading the catalogue…</div>
        </div>`,
    },
    {
      id: "logs",
      label: "Logs",
      body: `<div class="panel">
          <h2>Logs</h2>
          <p class="note">Server, network, browser, tunnel, security and application, with credentials redacted before they are ever written (§43).</p>
          <div class="row">
            <input id="log-query" placeholder="Search…" />
            <select id="log-category">
              <option value="">All categories</option>
              <option>server</option><option>network</option><option>browser</option>
              <option>tunnel</option><option>security</option><option>application</option>
            </select>
            <button class="ghost" id="log-search">Search</button>
            <button class="ghost" id="log-download">Download the log</button>
          </div>
          <div id="log-result"><table><thead><tr><th>Time</th><th>Level</th><th>Category</th><th>Message</th></tr></thead><tbody>${logRows}</tbody></table></div>
        </div>`,
    },
    {
      id: "help",
      label: "Troubleshooting",
      body: `<div class="panel">
          <h2>Troubleshooting</h2>
          <p>Choose what is happening, and the host will run the tests that answer it and explain the result in plain words (§50).</p>
          <div class="row">
            <button class="ghost" data-scenario="phone">I cannot connect from my phone</button>
            <button class="ghost" data-scenario="remote">Remote access is not available</button>
            <button class="ghost" data-scenario="browser">A page will not load in the browser</button>
          </div>
          <div id="scenario-result"></div>
        </div>
        <div class="panel">
          <h2>Documentation</h2>
          ${documentation()}
        </div>`,
    },
  ];

  const nav = sections
    .map(
      (section, index) =>
        `<button class="tab${index === 0 ? " on" : ""}" data-tab="${esc(section.id)}">${esc(section.label)}</button>`,
    )
    .join("");

  const panels = sections
    .map(
      (section, index) =>
        `<section class="tab-panel${index === 0 ? " on" : ""}" data-panel="${esc(section.id)}">${section.body}</section>`,
    )
    .join("");

  const advanced = model.mode === "advanced";

  return shell(
    model,
    `<div class="topbar">
      <div>
        <p class="brand">SUGAR</p>
        <p class="sub">${esc(snapshot.version)}</p>
      </div>
      <div class="chips">
        ${chip(snapshot.server.status === "running" ? "green" : "red", snapshot.server.status === "running" ? "SERVER RUNNING" : "SERVER " + snapshot.server.status.toUpperCase())}
        ${chip(network?.internet.ok ? "green" : "red", network?.internet.ok ? "INTERNET WORKING" : "OFFLINE MODE")}
        ${chip(network?.vpn.detected ? "yellow" : "green", network?.vpn.detected ? "VPN DETECTED" : "VPN OFF")}
        ${chip(publicUrl ? "green" : "gray", publicUrl ? "REMOTE ACCESS CONNECTED" : "REMOTE ACCESS NOT CONFIGURED")}
        ${chip("green", `MODE ${snapshot.network?.mode ?? "LOCAL CONNECTION"}`)}
      </div>
      <div class="row">
        <a class="ghost" href="/?mode=${advanced ? "beginner" : "advanced"}">${advanced ? "BEGINNER MODE" : "ADVANCED MODE"}</a>
        ${passwordSet ? `<button class="ghost" id="signout">Sign out</button>` : ""}
      </div>
    </div>

    ${model.firstRunResult ? `<p class="firstrun">${esc(model.firstRunResult)}</p>` : ""}

    <nav class="tabs">${nav}</nav>
    ${panels}

    ${
      advanced
        ? `<section class="panel"><h2>Advanced</h2>
            <table><tbody>
              <tr><td>Interfaces</td><td class="mono">${esc((network?.interfaces ?? []).map((entry) => `${entry.name} (${entry.vpn ? "VPN" : "direct"})`).join(", ") || "none")}</td></tr>
              <tr><td>Addresses</td><td class="mono">${esc((network?.interfaces ?? []).flatMap((entry) => entry.addresses.map((address) => `${address.interface} ${address.address} ${address.scope}`)).join(" · ") || "none")}</td></tr>
              <tr><td>DNS latency</td><td class="mono">${network?.dns.ms ?? "—"} ms</td></tr>
              <tr><td>TLS / HTTPS</td><td class="mono">${network?.https.ok ? "validated" : "not completing"} · ${network?.https.ms ?? "—"} ms</td></tr>
              <tr><td>Server port</td><td class="mono">${snapshot.server.port ?? "—"} · requests ${snapshot.server.requests} · connections ${snapshot.server.connections}</td></tr>
              <tr><td>Tunnel</td><td class="mono">${esc(snapshot.tunnel.status)} · attempts ${snapshot.tunnel.attempts} · forwarded ${snapshot.tunnel.forwarded}</td></tr>
              <tr><td>Engine</td><td class="mono">${esc(snapshot.engine.engine)} — ${esc(snapshot.engine.detail)}</td></tr>
              <tr><td>Secrets</td><td class="mono">${esc(secretSummary())}</td></tr>
            </tbody></table>
            <p class="note">No password, token or private key is ever shown here or written to a log (§24, §43).</p>
          </section>`
        : ""
    }`,
    false,
  );
}

function secretSummary(): string {
  // Deliberately a summary, not the values: the advanced view is not a
  // credential viewer (§24).
  return "held by the operating system's credential store";
}

/** §49 — the documentation set, shown in the portal itself. */
function documentation(): string {
  const topics: [string, string][] = [
    ["Getting started", "Stand up the host, pick a port, open the dashboard. The server is inside the application."],
    ["Installation", "Run the installer for your platform. It installs the runtime, the browser window host, and nothing else."],
    ["First start", "The wizard checks the computer, the Internet, the network, the VPN and the firewall, then reports READY, READY LOCALLY or ACTION REQUIRED."],
    ["Connecting to the Internet", "The host makes its own outbound connections. No browser has to be open."],
    ["Using Starlink", "Starlink is usually behind carrier-grade NAT, so direct incoming connections are not available. That is normal, and the tunnel is the answer."],
    ["Using Proton VPN", "The host reads the real interface table, so it works whether Proton VPN is on or off, and re-tests when you switch it."],
    ["Remote access", "If the Internet cannot reach this computer directly, the host holds one encrypted outbound connection to a relay. Nothing connects inward."],
    ["Phone connection", "Open the public address on the phone, sign in, and use the same dashboard."],
    ["Android", "The phone uses its own browser. The host's server can run in Termux, but Android has no window to embed."],
    ["iPhone", "Same: Safari and the public address. iOS does not allow a Linux container or a background server, and the host says so."],
    ["Chromebook", "Turn on the Linux container, run the installer, and reach the host at its LAN address."],
    ["Windows", "WebView2 for the browser window; the .NET SDK builds the small window host once."],
    ["Linux", "WebKitGTK for the browser window, installed from your distribution."],
    ["Mac", "WKWebView, which is already part of macOS."],
    ["Troubleshooting", "The wizard runs the tests and explains the result in sentences, not error codes."],
    ["Security", "Only the host's own HTTP server is reachable. No shell, no shares, no remote desktop (§65)."],
    ["Downloads", "Real files with real checksums, and official sources for what cannot be bundled."],
    ["Updates", "The host reports its current version, build and date, and will never install a file without asking."],
    ["Uninstallation", "Stop the host, remove its folder, and remove any firewall rule you allowed. Nothing else was changed."],
    ["Advanced settings", "Preferred port, LAN listening, session length, lockout policy, tunnel provider and relay address."],
  ];
  return `<dl class="docs">${topics
    .map(([title, body]) => `<dt>${esc(title)}</dt><dd>${esc(body)}</dd>`)
    .join("")}</dl>`;
}

/* ------------------------------------------------------------------ the shell -- */

function shell(model: PortalModel, body: string, minimal: boolean): string {
  const mode = model.mode;
  return `<!doctype html>
<html lang="en" data-mode="${esc(mode)}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>SUGAR — built-in server, browser and Internet connectivity</title>
<style>
  :root{--bg:#080b12;--panel:#0f141f;--line:#1e2637;--ink:#e6ecf7;--dim:#93a1bd;--accent:#5eead4;}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  a{color:var(--accent)}
  .wrap{max-width:1180px;margin:0 auto;padding:20px 16px 64px}
  .topbar{display:flex;flex-wrap:wrap;gap:14px;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line);padding-bottom:14px;margin-bottom:18px}
  .brand{margin:0;font-size:20px;letter-spacing:.30em;font-weight:700}
  .sub{margin:0;color:var(--dim);font-size:11px}
  .chips{display:flex;flex-wrap:wrap;gap:6px}
  .chip{display:inline-flex;align-items:center;gap:6px;border:1px solid color-mix(in srgb,var(--tone) 45%,transparent);background:color-mix(in srgb,var(--tone) 12%,transparent);color:var(--tone);border-radius:999px;padding:3px 9px;font-size:10px;letter-spacing:.08em}
  .chip i{width:7px;height:7px;border-radius:999px;background:var(--tone);display:block}
  .tabs{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:18px}
  .tab{background:var(--panel);border:1px solid var(--line);color:var(--dim);border-radius:10px;padding:8px 13px;font-size:12px;cursor:pointer}
  .tab.on{color:var(--ink);border-color:var(--accent)}
  .tab-panel{display:none}
  .tab-panel.on{display:block}
  .panel{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px;margin-bottom:16px}
  .panel.narrow{max-width:420px;margin:80px auto}
  h1{margin:0 0 6px;letter-spacing:.2em;font-size:22px}
  h2{margin:0 0 10px;font-size:15px;letter-spacing:.04em}
  .lede{color:var(--dim)}
  .grid{display:grid;gap:10px;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));margin-bottom:16px}
  .tile{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:14px}
  .tile-label{margin:0;color:var(--dim);font-size:10px;letter-spacing:.12em;text-transform:uppercase}
  .tile-value{margin:4px 0 8px;font-size:17px;font-weight:600;word-break:break-word}
  .tile-hint{margin:8px 0 0;color:var(--dim);font-size:11px}
  button{background:var(--accent);color:#04111a;border:0;border-radius:10px;padding:9px 15px;font-weight:600;cursor:pointer;font-size:12px}
  button:disabled{opacity:.45;cursor:default}
  button.ghost,a.ghost{background:transparent;border:1px solid var(--line);color:var(--ink);font-weight:500;padding:8px 13px;border-radius:10px;text-decoration:none;display:inline-block;font-size:12px}
  .row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:10px 0}
  input,select{background:#0b1120;border:1px solid var(--line);border-radius:10px;color:var(--ink);padding:9px 11px;font-size:12px;min-width:0;flex:1}
  label{display:block;margin:12px 0 4px;color:var(--dim);font-size:11px}
  table{width:100%;border-collapse:collapse;font-size:12px;margin-top:8px}
  th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}
  th{color:var(--dim);font-weight:500;font-size:10px;letter-spacing:.08em;text-transform:uppercase}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;word-break:break-all}
  .note{color:var(--dim);font-size:11.5px}
  .plain{color:var(--dim);font-size:12px;padding-left:18px;margin:8px 0}
  .check{border-left:3px solid var(--line);padding:9px 12px;margin:8px 0;background:#0b1120;border-radius:0 10px 10px 0}
  .check.pass{border-color:${TONES.green}}
  .check.fail{border-color:${TONES.red}}
  .check.skip{border-color:${TONES.gray}}
  .check b{font-size:12px}
  .qr{background:#fff;padding:10px;border-radius:12px;display:inline-block;margin:12px 0}
  .qr svg{display:block;width:190px;height:190px}
  .docs dt{font-weight:600;margin-top:12px}
  .docs dd{margin:2px 0 0;color:var(--dim);font-size:12px}
  .firstrun{border:1px solid color-mix(in srgb,${TONES.yellow} 45%,transparent);background:color-mix(in srgb,${TONES.yellow} 10%,transparent);color:${TONES.yellow};border-radius:12px;padding:10px 14px;font-size:12px;letter-spacing:.06em}
  ${minimal ? "" : ".admin-only[data-may=no]{opacity:.5}"}
  @media(max-width:640px){.wrap{padding:14px 12px 48px}.tile-value{font-size:15px}}
</style>
</head>
<body>
<div class="wrap">${body}</div>
<script>
(function(){
  var csrf=null, admin=null;
  function headers(){var h={"content-type":"application/json"};
    if(csrf)h["x-sugar-csrf"]=csrf; if(admin)h["x-sugar-admin"]=admin; return h;}
  function api(path,options){return fetch(path,Object.assign({headers:headers(),credentials:"same-origin"},options||{}))
    .then(function(r){return r.json().then(function(b){return {status:r.status,body:b};});});}

  // Sessions: the dashboard reads its own state so a reloaded page keeps its
  // CSRF token, and so sign-in really establishes the cookie the host set.
  api("/api/auth/state").then(function(r){csrf=r.body.csrf||null;});

  var form=document.getElementById("signin");
  if(form){form.addEventListener("submit",function(e){e.preventDefault();
    var note=document.getElementById("signin-note");
    note.textContent="Signing in…";
    api("/api/auth/login",{method:"POST",body:JSON.stringify({
      password:document.getElementById("password").value,
      label:document.getElementById("label").value})})
      .then(function(r){ if(r.body.ok){window.location.reload();}
        else{note.textContent=r.body.error||"That did not work.";} });});}

  document.querySelectorAll(".tab").forEach(function(tab){tab.addEventListener("click",function(){
    document.querySelectorAll(".tab").forEach(function(t){t.classList.toggle("on",t===tab);});
    document.querySelectorAll(".tab-panel").forEach(function(p){
      p.classList.toggle("on",p.getAttribute("data-panel")===tab.getAttribute("data-tab"));});});});

  document.querySelectorAll("[data-copy]").forEach(function(button){button.addEventListener("click",function(){
    var value=button.getAttribute("data-copy");
    if(navigator.clipboard){navigator.clipboard.writeText(value).then(function(){button.textContent="COPIED";});}
    else{window.prompt("Copy the address:",value);} });});

  var signout=document.getElementById("signout");
  if(signout){signout.addEventListener("click",function(){api("/api/auth/logout",{method:"POST"}).then(function(){window.location.reload();});});}

  function renderChecks(container,report){
    var html='<p class="note">'+report.summary+'</p>';
    report.checks.forEach(function(check){
      html+='<div class="check '+check.status.toLowerCase()+'"><b>'+check.status+' · '+check.name+'</b>'+
        '<p class="note">'+check.explain+'</p><p class="mono">'+check.evidence+'</p></div>';});
    container.innerHTML=html;}

  var runAll=document.getElementById("run-everything");
  if(runAll){runAll.addEventListener("click",function(){
    var out=document.getElementById("everything-result"); out.innerHTML="<p class=\\"note\\">Running fifteen checks…</p>";
    api("/api/tests/everything",{method:"POST"}).then(function(r){
      if(r.status===403&&r.body&&r.body.error){out.innerHTML="<p class=\\"note\\">"+r.body.error+"</p>";return;}
      renderChecks(out,r.body.report);});});}

  var runSelf=document.getElementById("run-self");
  if(runSelf){runSelf.addEventListener("click",function(){
    var out=document.getElementById("self-result"); out.innerHTML="<p class=\\"note\\">Running the self test…</p>";
    api("/api/tests/self",{method:"POST"}).then(function(r){renderChecks(out,r.body.report);});});}

  function nav(action,url){
    var out=document.getElementById("browser-status");
    api("/api/browser/navigate",{method:"POST",body:JSON.stringify({action:action,url:url})})
      .then(function(r){
        if(!r.body||!r.body.browser){out.innerHTML="<p class=\\"note\\">"+(r.body&&r.body.error||"No answer.")+"</p>";return;}
        var b=r.body.browser;
        var security=b.security.secure?"HTTPS, certificate validated":"not encrypted";
        out.innerHTML='<table><tbody>'+
          '<tr><td>Address</td><td class="mono">'+b.url+'</td></tr>'+
          '<tr><td>Title</td><td>'+b.title+'</td></tr>'+
          '<tr><td>Security</td><td>'+security+'</td></tr>'+
          '<tr><td>Answer</td><td class="mono">'+(b.status||"—")+' · '+b.contentType+' · '+b.bytes+' bytes</td></tr>'+
          '<tr><td>Renderer</td><td>'+b.renderer.engine+(b.renderer.windowOpen?" (window open)":" (no window on this machine)")+'</td></tr>'+
          '<tr><td>Cookies</td><td>'+b.cookies+'</td></tr>'+
          '<tr><td>History</td><td>'+b.history.length+' entries</td></tr>'+
          (b.lastError?'<tr><td>Last error</td><td class="mono">'+b.lastError+'</td></tr>':'')+
        '</tbody></table>';});}

  var go=document.getElementById("go");
  if(go){go.addEventListener("click",function(){nav("navigate",document.getElementById("url").value);});}
  document.querySelectorAll("[data-nav]").forEach(function(button){
    button.addEventListener("click",function(){nav(button.getAttribute("data-nav"),"");});});

  var tunnel=document.getElementById("tunnel-action");
  if(tunnel){tunnel.addEventListener("click",function(){
    api("/api/connectivity/reconnect",{method:"POST",body:JSON.stringify({action:tunnel.getAttribute("data-action")})})
      .then(function(){window.location.reload();});});}
  document.querySelectorAll("[data-action]").forEach(function(button){
    if(button.id==="tunnel-action")return;
    button.addEventListener("click",function(){
      api("/api/connectivity/reconnect",{method:"POST",body:JSON.stringify({action:button.getAttribute("data-action")})})
        .then(function(){window.location.reload();});});});

  var pairBegin=document.getElementById("pair-begin");
  if(pairBegin){pairBegin.addEventListener("click",function(){
    var out=document.getElementById("pair-result");
    api("/api/pair/begin",{method:"POST",body:JSON.stringify({label:document.getElementById("pair-label").value})})
      .then(function(r){
        if(!r.body.ok){out.innerHTML="<p class=\\"note\\">"+(r.body.error||"Could not start pairing.")+"</p>";return;}
        out.innerHTML='<p class="mono">Code: '+r.body.code+' — valid for five minutes, single use.</p>'+
          '<p class="note">On the device, open '+r.body.qrPayload+' and enter the code. The code is not a password and expires on its own (§18).</p>';});});}

  document.querySelectorAll("[data-revoke]").forEach(function(button){
    button.addEventListener("click",function(){
      api("/api/devices/revoke",{method:"POST",body:JSON.stringify({id:button.getAttribute("data-revoke")})})
        .then(function(){window.location.reload();});});});

  var downloads=document.getElementById("downloads");
  if(downloads){api("/api/downloads").then(function(r){
    if(!r.body.ok){downloads.innerHTML="<p class=\\"note\\">"+(r.body.error||"The download catalogue needs a signed-in session.")+"</p>";return;}
    var html='';
    r.body.entries.forEach(function(entry){
      html+='<div class="check"><b>'+entry.name+'</b>'+
        '<p class="note">'+entry.description+'</p>'+
        '<p class="mono">'+entry.platform+' · '+entry.version+' · '+entry.size+'</p>'+
        '<p class="note">'+entry.purpose+'</p>'+
        (entry.sha256?'<p class="mono">SHA-256 '+entry.sha256+'</p>':'')+
        (entry.href?'<p><a href="'+entry.href+'" download>Download</a></p>':'')+
        (entry.officialUrl?'<p><a href="'+entry.officialUrl+'" target="_blank" rel="noreferrer">Official source</a></p>':'')+
        '</div>';});
    downloads.innerHTML=html;});}

  var logSearch=document.getElementById("log-search");
  if(logSearch){logSearch.addEventListener("click",function(){
    var q=document.getElementById("log-query").value;
    var c=document.getElementById("log-category").value;
    api("/api/logs?limit=200&q="+encodeURIComponent(q)+"&category="+encodeURIComponent(c)).then(function(r){
      var rows=(r.body.entries||[]).map(function(e){
        return '<tr><td class="mono">'+new Date(e.at).toLocaleTimeString()+'</td><td>'+e.level+'</td><td>'+e.category+'</td><td>'+
          String(e.message).replace(/</g,"&lt;")+'</td></tr>';}).join("");
      document.getElementById("log-result").innerHTML='<table><tbody>'+rows+'</tbody></table>';});});}
  var logDownload=document.getElementById("log-download");
  if(logDownload){logDownload.addEventListener("click",function(){window.location="/api/logs/download";});}

  document.querySelectorAll("[data-scenario]").forEach(function(button){
    button.addEventListener("click",function(){
      var out=document.getElementById("scenario-result");
      out.innerHTML='<p class="note">Running the tests for this…</p>';
      api("/api/tests/everything",{method:"POST"}).then(function(r){
        if(!r.body.report){out.innerHTML='<p class="note">The tests need a signed-in session.</p>';return;}
        var wanted={phone:["Local server","LAN accessibility","Public connectivity","Tunnel connectivity"],
                    remote:["Public connectivity","Tunnel connectivity","Authentication service","Remote portal"],
                    browser:["Internet connection","DNS","HTTPS","Embedded browser"]}[button.getAttribute("data-scenario")];
        var html="";
        r.body.report.checks.forEach(function(check){
          if(wanted.indexOf(check.name)<0)return;
          html+='<div class="check '+check.status.toLowerCase()+'"><b>'+check.name+': '+check.status+'</b><p class="note">'+check.explain+'</p></div>';});
        var failures=r.body.report.checks.filter(function(c){return wanted.indexOf(c.name)>=0&&c.status==="FAIL";});
        html+= failures.length? '<p class="note">'+r.body.report.summary+'</p>' : '<p class="note">REMOTE ACCESS RESTORED — everything these checks cover is working.</p>';
        out.innerHTML=html;});});});
})();
</script>
</body>
</html>`;
}

/** §63 — the sentence the first run ends on. */
export function firstRunLine(result: string): string {
  switch (result) {
    case "READY":
      return "READY — the host is running, and it can be reached from anywhere.";
    case "READY LOCALLY — REMOTE ACCESS NEEDS CONFIGURATION":
      return "READY LOCALLY — the host works on this computer and this network. Remote access needs a relay address (§14).";
    default:
      return "ACTION REQUIRED — something above needs attention before the host can be reached.";
  }
}

/** What the settings currently say, for the first-run wizard's report (§62). */
export function wizardState() {
  return {
    firstRunComplete: config.get("state").firstRunComplete,
    mode: config.get("user").mode,
    tunnelProvider: config.get("user").tunnelProvider,
    qr: qrCapability(),
  };
}
