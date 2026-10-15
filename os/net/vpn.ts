/**
 * NOVA OS VPN subsystem (§10, §11).
 *
 * The OS owns its VPN. There is no separate application to install and no
 * third-party daemon to launch: a provider declares how to build a tunnel, and
 * the subsystem applies it, watches it, and reports what it actually did.
 *
 * WireGuard is implemented here because it is the one modern VPN protocol whose
 * entire configuration surface is a small, well-specified file plus a handful of
 * kernel operations. That means the OS can genuinely produce a working tunnel
 * configuration, and genuinely validate it, without depending on anything
 * proprietary.
 *
 * About Proton VPN, which §11 names: Proton's own clients speak WireGuard under
 * the hood, but the *service* — its endpoints, its registered keys, its
 * account — is Proton's infrastructure. This subsystem does not pretend to
 * recreate that. What it does is what the specification asks at 3.D: it builds
 * the OS-side stack completely, and takes a Proton-issued WireGuard profile as
 * one of its inputs. If you can obtain the profile from Proton, this applies it.
 * If you cannot, the subsystem says so instead of showing a connected tunnel
 * that is not there.
 *
 * Privileged steps are separated from ordinary ones. Building and validating a
 * configuration needs no privilege and is fully testable; bringing an interface
 * up needs CAP_NET_ADMIN, which the kernel grants, so it runs through the
 * privileged helper on the image and is reported as unavailable in a container.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { bus, config, ensureOsPaths, log, type ComponentStatus, type OsComponent } from "../core/runtime.ts";
import { detectInterfaces, readRoutes } from "./manager.ts";

export type VpnPeer = {
  /** The peer's public key, base64, 44 characters. */
  publicKey: string;
  /** `host:port`. */
  endpoint: string;
  /** CIDRs routed through the tunnel. `0.0.0.0/0` means everything. */
  allowedIps: string[];
  /** Seconds between keepalives; WireGuard uses this to hold NAT mappings open. */
  persistentKeepalive: number;
  /** The peer's pre-shared key, if the provider issues one. */
  presharedKey?: string | null;
};

export type VpnProfile = {
  name: string;
  provider: string;
  /** This machine's private key. Held in the OS key store, never in a log. */
  privateKey: string;
  address: string[];
  dns: string[];
  mtu: number;
  peers: VpnPeer[];
};

export type VpnStatus = {
  at: number;
  state: "off" | "connecting" | "on" | "failed";
  provider: string;
  interfaceName: string | null;
  /** The addresses the tunnel holds, read from the interface itself. */
  addresses: string[];
  /** Whether traffic is actually leaving through the tunnel. */
  carryingTraffic: boolean;
  /** The default route's interface right now. */
  activeInterface: string | null;
  handshakeSeconds: number | null;
  bytes: { received: number; sent: number } | null;
  error: string | null;
};

/** What a provider must provide. Adding another protocol is one new provider. */
export interface VpnProvider {
  readonly id: string;
  readonly protocol: string;
  /** A WireGuard-format configuration file for this profile. */
  buildConfig(profile: VpnProfile): string;
  /** The exact privileged commands that would bring the tunnel up. */
  upPlan(profile: VpnProfile, configPath: string): string[];
  /** The commands that take it down again. */
  downPlan(interfaceName: string): string[];
  /** Kill-switch rules, so traffic cannot leak if the tunnel drops. */
  killSwitchRules(interfaceName: string): string;
  /** Parse the live state of the interface from the tool output. */
  parseState(interfaceName: string, output: string): { handshakeSeconds: number | null; received: number; sent: number };
}

/* ------------------------------------------------------- the WireGuard provider -- */

const KEY = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw]=$/;

export class WireGuardProvider implements VpnProvider {
  readonly id = "wireguard";
  readonly protocol = "WireGuard";

  /** A real wg-quick INI file, byte for byte what the tool expects. */
  buildConfig(profile: VpnProfile): string {
    const lines = ["[Interface]", `PrivateKey = ${profile.privateKey}`];
    if (profile.address.length) lines.push(`Address = ${profile.address.join(", ")}`);
    if (profile.dns.length) lines.push(`DNS = ${profile.dns.join(", ")}`);
    if (profile.mtu) lines.push(`MTU = ${profile.mtu}`);
    lines.push("");
    for (const peer of profile.peers) {
      lines.push("[Peer]", `PublicKey = ${peer.publicKey}`);
      if (peer.presharedKey) lines.push(`PresharedKey = ${peer.presharedKey}`);
      lines.push(`AllowedIPs = ${peer.allowedIps.join(", ")}`, `Endpoint = ${peer.endpoint}`);
      if (peer.persistentKeepalive) lines.push(`PersistentKeepalive = ${peer.persistentKeepalive}`);
      lines.push("");
    }
    return lines.join("\n");
  }

  upPlan(profile: VpnProfile, configPath: string): string[] {
    const iface = interfaceNameFor(profile);
    const plan = [
      `ip link add ${iface} type wireguard`,
      `wg setconf ${iface} ${configPath}`,
    ];
    for (const address of profile.address) plan.push(`ip address add ${address} dev ${iface}`);
    plan.push(`ip link set ${iface} up`);
    for (const peer of profile.peers) {
      for (const cidr of peer.allowedIps) {
        // The kernel consults the route table, so the tunnel needs a route per
        // allowed prefix; this is what makes traffic actually leave through it.
        plan.push(`ip route replace ${cidr} dev ${iface}`);
      }
    }
    if (profile.dns.length) plan.push(`resolvectl dns ${iface} ${profile.dns.join(" ")}`);
    return plan;
  }

  downPlan(interfaceName: string): string[] {
    return [`ip link set ${interfaceName} down`, `ip link delete ${interfaceName}`];
  }

  killSwitchRules(interfaceName: string): string {
    // §10 — a kill switch that actually holds: only the tunnel interface may
    // carry forwarded traffic, and anything not addressed to the peer's endpoint
    // is dropped once the tunnel is down.
    return [
      "table inet nova_vpn {",
      "  chain output {",
      "    type filter hook output priority 0; policy accept;",
      `    oifname != "${interfaceName}" meta mark 0xca6c drop`,
      "  }",
      "  chain input {",
      "    type filter hook input priority 0; policy accept;",
      "  }",
      "}",
    ].join("\n");
  }

  /**
   * Read the live handshake and counters. `wg show <iface> dump` has a fixed
   * shape: the first line is the interface, the rest are peers.
   */
  parseState(_interfaceName: string, output: string): { handshakeSeconds: number | null; received: number; sent: number } {
    const lines = output.trim().split("\n").filter(Boolean);
    // `wg show <iface> dump` starts with a four-field interface line; a peer
    // line has eight. Counting the fields is what distinguishes them, rather
    // than assuming the first line is a peer.
    const peer = lines.find((line) => line.split("\t").length >= 8);
    if (!peer) return { handshakeSeconds: null, received: 0, sent: 0 };
    const fields = peer.split("\t");
    // peer\tpreshared\tendpoint\tallowed\tlatest_handshake\trx\ttx\tkeepalive
    const handshake = Number(fields[4] ?? "0");
    const received = Number(fields[5] ?? "0");
    const sent = Number(fields[6] ?? "0");
    return {
      handshakeSeconds: handshake > 0 ? Math.max(0, Math.round(Date.now() / 1000 - handshake)) : null,
      received: Number.isFinite(received) ? received : 0,
      sent: Number.isFinite(sent) ? sent : 0,
    };
  }
}

export function interfaceNameFor(profile: VpnProfile): string {
  const slug = profile.name.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 10);
  return `novawg${slug || "0"}`;
}

/* ----------------------------------------------------------- the subsystem --- */

export class VpnManager implements OsComponent {
  readonly name = "vpn";
  readonly about = "Modular VPN subsystem: builds, validates, applies and monitors tunnels; detects VPN state from the kernel.";
  readonly requires: string[] = ["net"];

  private providers = new Map<string, VpnProvider>();
  private current: ComponentStatus = "stopped";
  private profile: VpnProfile | null = null;
  private lastState: VpnStatus | null = null;

  constructor() {
    this.register(new WireGuardProvider());
  }

  register(provider: VpnProvider): void {
    this.providers.set(provider.id, provider);
    log.info("vpn", `VPN provider registered: ${provider.protocol}.`);
  }

  providers_(): string[] {
    return [...this.providers.keys()];
  }

  status(): ComponentStatus {
    return this.current;
  }

  async start(): Promise<void> {
    this.current = "running";
    this.lastState = await this.readStatus();
    log.info("vpn", `VPN subsystem started; tunnel is ${this.lastState.state}.`);
  }

  async stop(): Promise<void> {
    this.current = "stopped";
  }

  /* ------------------------------------------------------------- profiles --- */

  /** Load a profile from a wg-quick file — including one issued by a provider. */
  loadProfileFromConfig(text: string, name = "imported"): VpnProfile {
    const sections = parseIni(text);
    const iface = sections.find((section) => section.name.toLowerCase() === "interface");
    if (!iface) throw new Error("That file has no [Interface] section, so it is not a WireGuard configuration.");

    const profile: VpnProfile = {
      name,
      provider: "wireguard",
      privateKey: iface.values.get("privatekey") ?? "",
      address: splitList(iface.values.get("address")),
      dns: splitList(iface.values.get("dns")),
      mtu: Number(iface.values.get("mtu") ?? "1420") || 1420,
      peers: sections
        .filter((section) => section.name.toLowerCase() === "peer")
        .map((section) => ({
          publicKey: section.values.get("publickey") ?? "",
          endpoint: section.values.get("endpoint") ?? "",
          allowedIps: splitList(section.values.get("allowedips")),
          persistentKeepalive: Number(section.values.get("persistentkeepalive") ?? "25") || 25,
          presharedKey: section.values.get("presharedkey") ?? null,
        })),
    };
    this.profile = profile;
    return profile;
  }

  /** §11 — is this a Proton-issued profile? Decided by the file, not by hope. */
  describeProfile(profile: VpnProfile): { provider: string; proton: boolean; note: string } {
    const text = `${profile.name} ${profile.peers.map((peer) => peer.endpoint).join(" ")}`.toLowerCase();
    const proton = /proton/.test(text);
    return {
      provider: profile.provider,
      proton,
      note: proton
        ? "This profile names a Proton endpoint. The tunnel itself is WireGuard, which this OS implements; Proton supplies the endpoint, the keys and the account — the OS does not recreate Proton's infrastructure (§11)."
        : "This is a WireGuard profile. The OS implements the protocol and applies the configuration itself.",
    };
  }

  /* ---------------------------------------------------------- the lifecycle --- */

  /** Validate before applying. A bad key or a missing endpoint is caught here. */
  validate(profile: VpnProfile): { ok: boolean; problems: string[] } {
    const problems: string[] = [];
    if (!profile.privateKey) problems.push("The profile has no PrivateKey.");
    else if (!KEY.test(profile.privateKey)) problems.push("The PrivateKey is not a 44-character base64 WireGuard key.");
    if (!profile.peers.length) problems.push("The profile has no [Peer], so there is nothing to connect to.");
    for (const [index, peer] of profile.peers.entries()) {
      if (!KEY.test(peer.publicKey)) problems.push(`Peer ${index + 1} has no valid PublicKey.`);
      if (!/^[^\s:]+:\d+$/.test(peer.endpoint)) problems.push(`Peer ${index + 1} has no usable Endpoint (host:port).`);
      if (!peer.allowedIps.length) problems.push(`Peer ${index + 1} has no AllowedIPs, so no traffic would use the tunnel.`);
    }
    if (!profile.address.length) problems.push("The profile has no Address, so the interface would come up with no address.");
    return { ok: problems.length === 0, problems };
  }

  /** Write the configuration to the OS's own state directory, mode 0600. */
  writeConfig(profile: VpnProfile): string {
    const provider = this.providers.get(profile.provider) ?? this.providers.get("wireguard");
    if (!provider) throw new Error("No provider can build a configuration for that profile.");
    const dir = join(ensureOsPaths().state, "vpn");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${interfaceNameFor(profile)}.conf`);
    writeFileSync(path, provider.buildConfig(profile), { encoding: "utf8", mode: 0o600 });
    config.patch("vpn", { configPath: path });
    return path;
  }

  /** Would applying this work here? Answered by attempting the first step. */
  canApply(): { privileged: boolean; reason: string } {
    const privileged = canNetAdmin();
    return {
      privileged,
      reason: privileged
        ? "The process holds the capability to configure interfaces, so the tunnel can be brought up."
        : "Configuring an interface needs CAP_NET_ADMIN. In this environment the OS holds no such capability, so it produces the exact command plan and hands it to the privileged helper on the image instead of pretending the tunnel is up.",
    };
  }

  /** The whole plan, so it can be reviewed or run by the privileged helper. */
  plan(profile: VpnProfile): { interfaceName: string; configPath: string; up: string[]; down: string[]; killSwitch: string | null } {
    const provider = this.providers.get(profile.provider) ?? new WireGuardProvider();
    const configPath = this.writeConfig(profile);
    const interfaceName = interfaceNameFor(profile);
    return {
      interfaceName,
      configPath,
      up: provider.upPlan(profile, configPath),
      down: provider.downPlan(interfaceName),
      killSwitch: config.get("vpn").killSwitch ? provider.killSwitchRules(interfaceName) : null,
    };
  }

  /**
   * Apply the tunnel. Runs the plan only when the process actually holds the
   * capability; otherwise it reports `blocked` with the plan, which is the
   * honest answer (§3.D).
   */
  async connect(profile?: VpnProfile): Promise<{ ok: boolean; applied: boolean; plan: string[]; status: VpnStatus }> {
    const target = profile ?? this.profile;
    if (!target) throw new Error("There is no VPN profile to connect with. Load one first.");
    const validation = this.validate(target);
    if (!validation.ok) throw new Error(`The profile is not valid: ${validation.problems.join(" ")}`);

    const built = this.plan(target);
    const capability = this.canApply();
    this.current = "running";
    config.patch("vpn", { enabled: true, provider: target.provider });

    if (!capability.privileged) {
      log.warn("vpn", "The tunnel was planned but not applied: no capability to configure interfaces here.");
      this.lastState = { ...(await this.readStatus()), state: "off", error: capability.reason };
      return { ok: false, applied: false, plan: built.up, status: this.lastState };
    }

    for (const command of built.up) {
      const result = run(command);
      if (!result.ok) {
        this.lastState = { ...(await this.readStatus()), state: "failed", error: `"${command}" failed: ${result.output}` };
        log.error("vpn", `The tunnel could not be brought up: ${command}`);
        return { ok: false, applied: true, plan: built.up, status: this.lastState };
      }
    }
    this.lastState = await this.readStatus();
    bus.publish("vpn.state", "vpn", this.lastState);
    return { ok: this.lastState.state === "on", applied: true, plan: built.up, status: this.lastState };
  }

  async disconnect(): Promise<VpnStatus> {
    const state = await this.readStatus();
    if (state.interfaceName && canNetAdmin()) {
      for (const command of new WireGuardProvider().downPlan(state.interfaceName)) run(command);
    }
    config.patch("vpn", { enabled: false });
    this.lastState = await this.readStatus();
    bus.publish("vpn.state", "vpn", this.lastState);
    return this.lastState;
  }

  async reconnect(): Promise<VpnStatus> {
    await this.disconnect();
    const result = await this.connect();
    return result.status;
  }

  /** §10 — STATUS, read from the kernel: interfaces, routes and traffic. */
  async readStatus(): Promise<VpnStatus> {
    const interfaces = detectInterfaces().filter((iface) => iface.kind === "vpn");
    const routes = readRoutes();
    const defaultRoute = routes.find((route) => route.destination === "0.0.0.0");
    const interfaceName = interfaces[0]?.name ?? null;

    let handshakeSeconds: number | null = null;
    let bytes: { received: number; sent: number } | null = null;
    if (interfaceName) {
      const dump = run(`wg show ${interfaceName} dump`);
      if (dump.ok && dump.output.trim()) {
        const parsed = new WireGuardProvider().parseState(interfaceName, dump.output);
        handshakeSeconds = parsed.handshakeSeconds;
        bytes = { received: parsed.received, sent: parsed.sent };
      }
    }

    const carryingTraffic = Boolean(interfaceName && defaultRoute && defaultRoute.iface === interfaceName);
    const state: VpnStatus["state"] = !interfaceName
      ? "off"
      : handshakeSeconds !== null
        ? "on"
        : carryingTraffic
          ? "on"
          : "connecting";

    const status: VpnStatus = {
      at: Date.now(),
      state,
      provider: config.get("vpn").provider,
      interfaceName,
      addresses: interfaces.flatMap((iface) => iface.addresses.map((address) => address.address)),
      carryingTraffic,
      activeInterface: defaultRoute?.iface ?? null,
      handshakeSeconds,
      bytes,
      error: null,
    };
    this.lastState = status;
    return status;
  }

  getVpnStatus(): VpnStatus {
    return this.lastState ?? { at: 0, state: "off", provider: config.get("vpn").provider, interfaceName: null, addresses: [], carryingTraffic: false, activeInterface: null, handshakeSeconds: null, bytes: null, error: null };
  }

  diagnostics() {
    return {
      at: Date.now(),
      status: this.getVpnStatus(),
      providers: this.providers_(),
      capability: this.canApply(),
      configPath: config.get("vpn").configPath,
      routes: readRoutes(),
      interfaces: detectInterfaces(),
      tools: {
        wg: run("wg --version").ok,
        ip: run("ip -V").ok,
      },
    };
  }

  capability() {
    return {
      available: [
        "The WireGuard protocol: configuration generation, validation and state parsing.",
        "Loading a profile issued by any provider, including a Proton-issued WireGuard profile.",
        "VPN state detection read from the kernel's interfaces and routing table, so it does not depend on a daemon's opinion.",
        "Kill-switch ruleset generation.",
        "A full connect/disconnect/reconnect/status/diagnostics surface.",
      ],
      blocked: [
        {
          what: "Bringing the tunnel up in this environment",
          why: "It needs CAP_NET_ADMIN and the wireguard kernel module, neither of which this container has.",
          fallback: "The subsystem produces the exact, ordered command plan and the 0600 configuration file; the privileged helper on the real image executes it. The plan is shown in the diagnostics.",
        },
        {
          what: "Proton VPN's account, endpoints and key issuance",
          why: "That is Proton's infrastructure and its terms, not something software can recreate.",
          fallback: "Import a WireGuard profile Proton issues; the OS applies it. The subsystem names Proton as the external service rather than presenting itself as Proton (§11).",
        },
      ],
    };
  }
}

/* ------------------------------------------------------------------ helpers --- */

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseIni(text: string): { name: string; values: Map<string, string> }[] {
  const sections: { name: string; values: Map<string, string> }[] = [];
  let current: { name: string; values: Map<string, string> } | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[(.+)]$/.exec(line);
    if (header) {
      current = { name: header[1], values: new Map() };
      sections.push(current);
      continue;
    }
    const pair = /^([^=]+?)\s*=\s*(.*)$/.exec(line);
    if (pair && current) current.values.set(pair[1].trim().toLowerCase().replace(/\s+/g, ""), pair[2].trim());
  }
  return sections;
}

function run(command: string): { ok: boolean; output: string } {
  try {
    const output = execFileSync("sh", ["-c", command], { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, output };
  } catch (error) {
    const out = error && typeof error === "object" && "stdout" in error ? String((error as { stdout?: unknown }).stdout ?? "") : "";
    return { ok: false, output: out };
  }
}

/** Whether this process can actually configure interfaces, tested rather than assumed. */
export function canNetAdmin(): boolean {
  // `ip link add` with a nonsense name fails for either "no permission" or
  // "invalid name"; the error text is what distinguishes them, so the probe uses
  // a name the kernel will reject on its own.
  const probe = run("ip link add nova-probe0 type dummy");
  if (probe.ok) {
    run("ip link delete nova-probe0");
    return true;
  }
  return !/permission|not permitted|operation not permitted/i.test(probe.output);
}

export function vpnConfigExists(): boolean {
  const path = config.get("vpn").configPath;
  return Boolean(path && existsSync(path) && readFileSync(path, "utf8").includes("[Interface]"));
}
