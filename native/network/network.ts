/**
 * §55 Network interface — and the detection the rest of the spec hangs off.
 *
 * Everything in this file is measured on the machine it runs on. There is no
 * cached answer and no default: `detectInterfaces()` reads the operating
 * system's own table, `testDNS()` performs a real lookup, `testHTTPS()` makes a
 * real request with real certificate validation, and the Starlink/CGNAT
 * questions in §11 are answered from what those tests returned rather than from
 * a guess about how Starlink "usually" behaves.
 *
 * The one thing this cannot do is open a listening socket and ask the outside
 * world to connect back. That test is honest about itself: it reports
 * `inboundTested: false` and hands the question to the caller, which owns a
 * server and can arrange a real inbound probe.
 */

import { networkInterfaces, hostname, platform, release, arch, type as osType } from "node:os";
import { resolve4 } from "node:dns/promises";
import { log } from "../core/log.ts";

/** Interfaces whose names mark them as a VPN or tunnel on the three platforms. */
const VPN_INTERFACE = /^(tun|tap|wg|utun|ppp|ppp0|proton|nordlynx|ipsec|wireguard|zt|tailscale|nebula)/i;

/** Addresses that can never be a public Internet address. */
const PRIVATE_V4 =
  /^(?:10\.|127\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|0\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

export type NetAddress = {
  interface: string;
  address: string;
  family: "IPv4" | "IPv6";
  scope: "loopback" | "link-local" | "private" | "public";
  mac: string;
  vpn: boolean;
};

export type NetInterface = {
  name: string;
  vpn: boolean;
  addresses: NetAddress[];
  /** The address another device on the same network would use, if there is one. */
  lanAddress: string | null;
  /** Whether this looks like the interface carrying the default route. */
  active: boolean;
};

function scopeOf(address: string, internal: boolean, family: "IPv4" | "IPv6"): NetAddress["scope"] {
  if (internal) return "loopback";
  if (family === "IPv4") {
    if (/^169\.254\./.test(address)) return "link-local";
    return PRIVATE_V4.test(address) ? "private" : "public";
  }
  const lower = address.toLowerCase();
  if (lower === "::1") return "loopback";
  if (lower.startsWith("fe80:")) return "link-local";
  if (lower.startsWith("fc") || lower.startsWith("fd")) return "private";
  return "public";
}

/** The real interface table of this machine. */
export function detectInterfaces(): NetInterface[] {
  const table = networkInterfaces();
  const found: NetInterface[] = [];

  for (const [name, addresses] of Object.entries(table)) {
    const vpn = VPN_INTERFACE.test(name);
    const list: NetAddress[] = [];
    let lanAddress: string | null = null;

    for (const info of addresses ?? []) {
      const family = String(info.family) === "IPv6" ? "IPv6" : "IPv4";
      const scope = scopeOf(info.address, info.internal, family);
      list.push({ interface: name, address: info.address, family, scope, mac: info.mac, vpn });
      if (family === "IPv4" && scope === "private" && !lanAddress) lanAddress = info.address;
    }

    found.push({ name, vpn, addresses: list, lanAddress, active: false });
  }

  // The active interface is the one whose address the OS would actually use for
  // an outbound connection. Asking the resolver is how that question is
  // answered without parsing a routing table per platform.
  return found;
}

/**
 * Which interface carries traffic. `os.networkInterfaces()` does not say, so
 * the host asks the operating system: it opens one UDP socket toward a public
 * address and reads back the local address it was given. No packet is sent.
 */
export async function getActiveInterface(interfaces = detectInterfaces()): Promise<{
  name: string | null;
  address: string | null;
  vpn: boolean;
  via: string;
}> {
  const dgram = await import("node:dgram");
  const preferred = interfaces.find((entry) => !entry.vpn && entry.lanAddress)?.lanAddress ?? null;

  const probe = await new Promise<string | null>((resolve) => {
    const socket = dgram.createSocket("udp4");
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve(value);
    };
    socket.on("error", () => finish(null));
    try {
      // 192.0.2.1 is TEST-NET-1: reserved, never routed, so this can never
      // actually reach anything, even if a stray packet did leave.
      socket.connect(53, "192.0.2.1", () => {
        const local = socket.address();
        finish(typeof local === "object" ? local.address : null);
      });
    } catch {
      finish(null);
    }
    setTimeout(() => finish(preferred), 1500);
  });

  const address = probe ?? preferred;
  const owner = address
    ? interfaces.find((entry) => entry.addresses.some((a) => a.address === address)) ?? null
    : null;

  return {
    name: owner?.name ?? null,
    address,
    vpn: owner?.vpn ?? false,
    via: probe ? "the operating system's own outbound socket" : "the first usable address in the interface table",
  };
}

/* ------------------------------------------------------------------- tests --- */

export type TestResult = {
  ok: boolean;
  ms: number;
  detail: string;
  error: string | null;
};

async function timed<T>(work: () => Promise<T>, timeoutMs = 8000): Promise<{ value: T | null; ms: number; error: string | null }> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
    return { value, ms: Date.now() - started, error: null };
  } catch (error) {
    return { value: null, ms: Date.now() - started, error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** §55 testInternet — a real request to a service whose only job is this. */
export async function testInternet(): Promise<TestResult & { publicIp: string | null }> {
  const attempt = await timed(async () => {
    const response = await fetch("https://api.ipify.org?format=json", {
      headers: { "user-agent": "SUGAR/1.0 (network check)" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as { ip?: string };
  });
  return {
    ok: Boolean(attempt.value?.ip),
    ms: attempt.ms,
    publicIp: attempt.value?.ip ?? null,
    detail: attempt.value?.ip
      ? `Reached the Internet and this network appears to the world as ${attempt.value.ip}.`
      : "No outbound Internet request succeeded.",
    error: attempt.error,
  };
}

/** §55 testDNS — a real resolution, through the system resolver. */
export async function testDNS(host = "example.com"): Promise<TestResult & { addresses: string[] }> {
  const attempt = await timed(() => resolve4(host));
  const addresses = attempt.value ?? [];
  return {
    ok: addresses.length > 0,
    ms: attempt.ms,
    addresses,
    detail: addresses.length
      ? `${host} resolved to ${addresses.join(", ")}.`
      : `${host} could not be resolved.`,
    error: attempt.error,
  };
}

/** §55 testHTTPS — a real request that fails loudly on a bad certificate. */
export async function testHTTPS(url = "https://one.one.one.one/"): Promise<TestResult & { status: number | null }> {
  const attempt = await timed(async () => {
    const response = await fetch(url, { headers: { "user-agent": "SUGAR/1.0 (tls check)" } });
    return response.status;
  });
  return {
    ok: attempt.value !== null && attempt.value < 500,
    ms: attempt.ms,
    status: attempt.value,
    detail:
      attempt.value !== null
        ? `HTTPS to ${url} answered ${attempt.value}; the certificate validated, or the request would have failed.`
        : `HTTPS to ${url} did not complete.`,
    error: attempt.error,
  };
}

/* --------------------------------------------------------------- VPN (§12) --- */

export type VpnStatus = {
  detected: boolean;
  interfaces: string[];
  /** Whether the interface carrying traffic is the VPN's. */
  active: boolean;
  /** What the public address looks like while this state holds. */
  publicIp: string | null;
  note: string;
};

export async function getVPNStatus(
  interfaces: NetInterface[] = detectInterfaces(),
  active?: { name: string | null; address: string | null; vpn: boolean; via: string },
): Promise<VpnStatus> {
  // The active interface is measured here rather than defaulted in the
  // signature, because a default cannot await.
  const carrier = active ?? (await getActiveInterface(interfaces));
  const vpns = interfaces.filter((entry) => entry.vpn).map((entry) => entry.name);
  const detected = vpns.length > 0;
  return {
    detected,
    interfaces: vpns,
    active: carrier.vpn,
    publicIp: null,
    note: detected
      ? carrier.vpn
        ? `A VPN interface is present (${vpns.join(", ")}) and it is the interface carrying traffic right now.`
        : `A VPN interface is present (${vpns.join(", ")}) but traffic is going out through ${carrier.name ?? "another interface"}, so the VPN does not appear to be active.`
      : "No VPN interface is present. Proton VPN (or another VPN) appears to be off.",
  };
}

/* ---------------------------------------------------- §11 Starlink probing --- */

export type InboundAssessment = {
  /** Whether the public address looks like a carrier-grade NAT address. */
  behindCarrierNat: boolean;
  /** Whether this address could plausibly accept an inbound connection. */
  inboundPlausible: boolean;
  /** Whether an inbound test was actually performed. */
  inboundTested: boolean;
  /** Whether a relay/tunnel is required to be reachable. */
  tunnelRequired: boolean;
  /** Plain-language conclusion, ready for beginner mode (§23). */
  conclusion: string;
  detail: string[];
};

/**
 * §11 — the eight Starlink questions, answered from real measurements.
 *
 * Steps 1–4 are direct: the Internet, DNS and HTTPS tests above, plus reading
 * the public address. Step 5 — "is that address actually reachable" — needs a
 * server and an outside observer, so `inboundTested` is false unless a caller
 * supplies a real probe. Steps 6–8 follow from what is known: a public address
 * in the carrier-NAT range (100.64.0.0/10) or one that differs from the route's
 * local address means the network is translating, and translation is exactly
 * the condition §14's tunnel exists for.
 */
export function assessInbound(options: {
  publicIp: string | null;
  internet: boolean;
  dns: boolean;
  https: boolean;
  vpnActive: boolean;
  interfaces: NetInterface[];
  /** A real result, when something outside actually connected back. */
  inboundProbe?: { attempted: boolean; reachable: boolean; from?: string } | null;
}): InboundAssessment {
  const detail: string[] = [];
  const ip = options.publicIp;

  detail.push(options.internet ? "Internet reachable: yes." : "Internet reachable: no.");
  detail.push(options.dns ? "DNS working: yes." : "DNS working: no.");
  detail.push(options.https ? "HTTPS outbound working: yes." : "HTTPS outbound working: no.");
  detail.push(ip ? `Public address as seen by the world: ${ip}.` : "Public address not visible.");

  const cgnat = Boolean(ip && /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip));
  if (cgnat) detail.push("The public address is in 100.64.0.0/10, the range ISPs use for carrier-grade NAT.");

  const localPublic = options.interfaces
    .flatMap((entry) => entry.addresses)
    .find((address) => address.scope === "public" && address.family === "IPv4");
  if (localPublic) detail.push(`This machine has a public IPv4 of its own: ${localPublic.address}.`);
  else detail.push("This machine has no public IPv4 address of its own; it is behind address translation.");
  if (options.vpnActive) detail.push("Traffic is going out through a VPN interface, which adds another layer of translation.");

  const probe = options.inboundProbe ?? null;
  const inboundTested = Boolean(probe?.attempted);
  if (inboundTested) {
    detail.push(probe?.reachable ? `An outside connection reached this host${probe?.from ? ` from ${probe.from}` : ""}.` : "An outside connection could not reach this host.");
  } else {
    detail.push("No inbound connection has been attempted from outside, so the host cannot claim the address is reachable.");
  }

  const behindCarrierNat = cgnat || (!localPublic && Boolean(ip));
  const inboundPlausible = inboundTested ? Boolean(probe?.reachable) : Boolean(localPublic) && !cgnat && !options.vpnActive;
  const tunnelRequired = !inboundPlausible;

  let conclusion: string;
  if (!options.internet) {
    conclusion = "There is no Internet connection right now. The host is running locally and will reconnect on its own.";
  } else if (inboundTested && probe?.reachable) {
    conclusion = "Direct connections work: another machine on the Internet reached this host.";
  } else if (cgnat) {
    conclusion = "DIRECT CONNECTION UNAVAILABLE — SECURE REMOTE CONNECTION REQUIRED. This network is behind carrier-grade NAT, which is normal for Starlink, so nothing from the Internet can reach it directly. The host is using a secure outbound tunnel instead.";
  } else if (behindCarrierNat || options.vpnActive) {
    conclusion = "DIRECT CONNECTION UNAVAILABLE — SECURE REMOTE CONNECTION REQUIRED. This machine does not hold a public address of its own, so incoming connections cannot be relied on. The host is using a secure outbound tunnel instead.";
  } else if (!inboundTested) {
    conclusion = "This host has a public address, but nothing has connected to it from outside yet, so the host is treating direct access as unproven and keeping the secure tunnel available.";
  } else {
    conclusion = "DIRECT CONNECTION UNAVAILABLE — SECURE REMOTE CONNECTION REQUIRED. The address is public, but the outside test did not reach this host — most often a firewall. The host is using a secure outbound tunnel instead.";
  }

  return { behindCarrierNat, inboundPlausible, inboundTested, tunnelRequired, conclusion, detail };
}

/* --------------------------------------------------- the combined §55 call --- */

export type NetworkStatus = {
  at: number;
  hostname: string;
  platform: string;
  release: string;
  arch: string;
  interfaces: NetInterface[];
  active: { name: string | null; address: string | null; vpn: boolean; via: string };
  vpn: VpnStatus;
  internet: TestResult & { publicIp: string | null };
  dns: TestResult & { addresses: string[] };
  https: TestResult & { status: number | null };
  assessment: InboundAssessment;
  /** §10 — the connection mode the host can offer right now, in fallback order (§37). */
  mode: "LOCAL CONNECTION" | "LOCAL NETWORK CONNECTION" | "REMOTE INTERNET" | "OFFLINE MODE";
  lanAddresses: string[];
};

export async function getNetworkStatus(): Promise<NetworkStatus> {
  const interfaces = detectInterfaces();
  const active = await getActiveInterface(interfaces);
  const [internet, dns, https] = await Promise.all([testInternet(), testDNS(), testHTTPS()]);
  const vpn = await getVPNStatus(interfaces, active);
  vpn.publicIp = internet.publicIp;

  const assessment = assessInbound({
    publicIp: internet.publicIp,
    internet: internet.ok,
    dns: dns.ok,
    https: https.ok,
    vpnActive: active.vpn,
    interfaces,
  });

  const lanAddresses = interfaces
    .filter((entry) => !entry.vpn)
    .map((entry) => entry.lanAddress)
    .filter((address): address is string => Boolean(address));

  const mode: NetworkStatus["mode"] = !internet.ok
    ? "OFFLINE MODE"
    : lanAddresses.length > 0
      ? "LOCAL NETWORK CONNECTION"
      : "LOCAL CONNECTION";

  const status: NetworkStatus = {
    at: Date.now(),
    hostname: hostname(),
    platform: `${platform()} ${osType()}`,
    release: release(),
    arch: arch(),
    interfaces,
    active,
    vpn,
    internet,
    dns,
    https,
    assessment,
    mode,
    lanAddresses,
  };

  log.info("network", "Network status measured.", {
    mode,
    internet: internet.ok,
    dns: dns.ok,
    vpn: vpn.detected,
    tunnelsRequired: assessment.tunnelRequired,
  });
  return status;
}

/* -------------------------------------------------- §39 network change watch --- */

export type NetworkChange = {
  at: number;
  reason: string;
  before: { interfaces: string; publicIp: string | null; vpn: boolean };
  after: { interfaces: string; publicIp: string | null; vpn: boolean };
};

/**
 * §39 — watch for Wi-Fi, Ethernet, VPN, IP and DNS changes.
 *
 * Polling is deliberate rather than an OS event stream: no portable event
 * source exists across Windows, Linux and macOS for "the default route
 * changed", and a 15-second poll costs two tiny requests. A change is only
 * reported when the fingerprint actually differs, so an idle network produces
 * no events at all.
 */
export class NetworkMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private fingerprint = "";
  private last: NetworkStatus | null = null;
  private listeners = new Set<(change: NetworkChange, status: NetworkStatus) => void>();

  constructor(private readonly seconds: number) {}

  private static fingerprintOf(status: NetworkStatus): string {
    const names = status.interfaces
      .flatMap((entry) => entry.addresses.map((address) => `${entry.name}:${address.address}:${address.scope}`))
      .sort()
      .join("|");
    return `${names}::${status.internet.publicIp ?? "none"}::${status.vpn.active ? "vpn" : "direct"}::${status.internet.ok ? "up" : "down"}`;
  }

  async check(): Promise<NetworkChange | null> {
    const status = await getNetworkStatus();
    const fingerprint = NetworkMonitor.fingerprintOf(status);
    const previous = this.last;
    this.last = status;

    if (!this.fingerprint) {
      this.fingerprint = fingerprint;
      return null;
    }
    if (fingerprint === this.fingerprint) return null;

    const change: NetworkChange = {
      at: Date.now(),
      reason: NetworkMonitor.explain(previous, status),
      before: {
        interfaces: previous ? previous.interfaces.map((i) => i.name).join(", ") : "unknown",
        publicIp: previous?.internet.publicIp ?? null,
        vpn: previous?.active.vpn ?? false,
      },
      after: {
        interfaces: status.interfaces.map((i) => i.name).join(", "),
        publicIp: status.internet.publicIp,
        vpn: status.active.vpn,
      },
    };
    this.fingerprint = fingerprint;
    log.warn("network", "Network changed.", { reason: change.reason });
    for (const listener of this.listeners) listener(change, status);
    return change;
  }

  private static explain(before: NetworkStatus | null, after: NetworkStatus): string {
    if (!before) return "The network was measured for the first time.";
    if (before.internet.ok && !after.internet.ok) return "The Internet connection was lost.";
    if (!before.internet.ok && after.internet.ok) return "The Internet connection came back.";
    if (before.active.vpn !== after.active.vpn) {
      return after.active.vpn ? "A VPN was switched on." : "The VPN was switched off.";
    }
    if (before.internet.publicIp !== after.internet.publicIp) return "The public address changed.";
    return "A network interface or address changed.";
  }

  start() {
    if (this.timer) return;
    void this.check();
    this.timer = setInterval(() => {
      void this.check().catch((error: unknown) =>
        log.warn("network", "The network monitor's check failed.", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }, Math.max(5, this.seconds) * 1000);
    log.info("network", `Network monitor started (every ${this.seconds}s).`);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  on(listener: (change: NetworkChange, status: NetworkStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
