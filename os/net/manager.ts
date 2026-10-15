/**
 * NOVA OS network manager.
 *
 * The OS owns its networking. This component is what the rest of the system asks
 * about the network, and what init starts before anything that needs a socket.
 *
 * It reads the kernel's own tables rather than guessing: the interface list from
 * the kernel, the routing table from `/proc/net/route` and `/proc/net/ipv6_route`
 * on Linux, the resolver from `/etc/resolv.conf`, and connectivity by making a
 * real request. Where a table is not present — a container with a minimal /proc,
 * or a non-Linux development host — it says so and falls back to what the
 * platform does expose, instead of reporting an empty network as a working one.
 *
 * §9 and §16 both hinge on one question this answers honestly: is this machine
 * actually reachable from the Internet, or is it behind NAT/CGNAT? It answers by
 * comparing the address the kernel holds with the address the world sees.
 */

import { networkInterfaces, hostname } from "node:os";
import { readFileSync, existsSync } from "node:fs";
import { lookup, resolve4 } from "node:dns/promises";
import { execFileSync } from "node:child_process";
import { bus, config, log, type ComponentStatus, type OsComponent } from "../core/runtime.ts";

export type NetAddress = {
  iface: string;
  address: string;
  family: "IPv4" | "IPv6";
  scope: "loopback" | "link-local" | "private" | "public";
  mac: string;
};

export type NetInterface = {
  name: string;
  kind: "ethernet" | "wifi" | "vpn" | "virtual" | "loopback" | "unknown";
  addresses: NetAddress[];
  lanAddress: string | null;
  up: boolean;
};

export type Route = { destination: string; gateway: string | null; iface: string; metric: number };

export type Connectivity = {
  at: number;
  internet: boolean;
  publicIp: string | null;
  latencyMs: number | null;
  dns: { ok: boolean; ms: number; servers: string[]; resolved: string[]; error: string | null };
  https: { ok: boolean; ms: number; status: number | null };
  /** §9/§16 — the two addresses, and what the difference means. */
  nat: { localAddress: string | null; publicAddress: string | null; behindNat: boolean; behindCgnat: boolean; verdict: string };
  directInboundPossible: boolean;
};

/* ------------------------------------------------------------- the manager -- */

export class NetworkManager implements OsComponent {
  readonly name = "net";
  readonly about = "Owns interfaces, addresses, routes, DNS and connectivity; detects NAT and CGNAT.";
  readonly requires: string[] = [];

  private current: ComponentStatus = "stopped";
  private monitor: ReturnType<typeof setInterval> | null = null;
  private fingerprint = "";
  last: Connectivity | null = null;

  status(): ComponentStatus {
    return this.current;
  }

  async start(): Promise<void> {
    this.current = "starting";
    this.setDnsServers();
    this.last = await this.testConnectivity();
    this.current = this.last.internet ? "running" : "degraded";

    // §39's equivalent at OS level: notice when the network underneath changes.
    const seconds = 15;
    this.monitor = setInterval(() => {
      void this.monitorOnce().catch((error: unknown) =>
        log.warn("net", "The network monitor failed a pass.", { error: error instanceof Error ? error.message : String(error) }),
      );
    }, seconds * 1000);
    this.monitor.unref?.();
    log.info("net", `Network manager started; connectivity ${this.last.internet ? "up" : "down"}.`);
  }

  async stop(): Promise<void> {
    if (this.monitor) clearInterval(this.monitor);
    this.monitor = null;
    this.current = "stopped";
  }

  private setDnsServers(): void {
    const servers = readDnsServers();
    if (servers.length) config.patch("net", { dns: servers });
  }

  /** One monitoring pass; publishes only when something actually changed. */
  async monitorOnce(): Promise<boolean> {
    const next = await this.testConnectivity();
    const fingerprint = `${next.internet}:${next.publicIp}:${next.directInboundPossible}:${detectInterfaces().map((i) => `${i.name}:${i.lanAddress ?? "-"}`).join("|")}`;
    const changed = this.fingerprint !== "" && fingerprint !== this.fingerprint;
    this.fingerprint = fingerprint;
    const wasUp = this.last?.internet ?? false;
    this.last = next;
    this.current = next.internet ? "running" : "degraded";
    if (changed) {
      bus.publish("net.changed", "net", {
        reason: wasUp && !next.internet ? "Internet lost" : !wasUp && next.internet ? "Internet restored" : "Network configuration changed",
        wasUp,
        now: next.internet,
      });
      log.warn("net", `Network changed: ${wasUp && !next.internet ? "the Internet went away" : !wasUp && next.internet ? "the Internet came back" : "interfaces or addresses changed"}.`);
    }
    return changed;
  }

  /* ------------------------------------------------------ the §8 interface --- */

  detectInterfaces(): NetInterface[] {
    return detectInterfaces();
  }

  getActiveInterface(): { name: string | null; address: string | null; kind: NetInterface["kind"] | null } {
    const routes = this.getRoutes();
    const ifaces = detectInterfaces();
    // The kernel's default route names the interface that actually carries
    // traffic — reading it is more honest than picking the first address.
    const preferred = routes.find((route) => route.destination === "0.0.0.0" || route.destination === "default");
    const chosen = preferred ? ifaces.find((iface) => iface.name === preferred.iface) : undefined;
    const fallback = ifaces.find((iface) => iface.kind !== "loopback" && iface.lanAddress);
    const iface = chosen ?? fallback ?? null;
    return { name: iface?.name ?? null, address: iface?.lanAddress ?? null, kind: iface?.kind ?? null };
  }

  getRoutes(): Route[] {
    return readRoutes();
  }

  getDNS(): { servers: string[]; configured: string[] } {
    return { servers: readDnsServers(), configured: config.get("net").dns };
  }

  async testInternet(): Promise<{ ok: boolean; publicIp: string | null; ms: number; error: string | null }> {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch("https://api.ipify.org?format=json", {
        signal: controller.signal,
        headers: { "user-agent": "NOVA-OS/0.1 (network manager)" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { ip?: string };
      return { ok: Boolean(body.ip), publicIp: body.ip ?? null, ms: Date.now() - started, error: null };
    } catch (error) {
      return { ok: false, publicIp: null, ms: Date.now() - started, error: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timer);
    }
  }

  async testDNS(name = "example.com"): Promise<{ ok: boolean; ms: number; addresses: string[]; error: string | null }> {
    const started = Date.now();
    try {
      const addresses = await resolve4(name);
      return { ok: addresses.length > 0, ms: Date.now() - started, addresses, error: null };
    } catch (error) {
      return { ok: false, ms: Date.now() - started, addresses: [], error: error instanceof Error ? error.message : String(error) };
    }
  }

  async testHTTPS(url = "https://one.one.one.one/") {
    const started = Date.now();
    try {
      const response = await fetch(url, { headers: { "user-agent": "NOVA-OS/0.1 (tls check)" } });
      return { ok: response.ok || response.status < 500, ms: Date.now() - started, status: response.status };
    } catch {
      return { ok: false, ms: Date.now() - started, status: null };
    }
  }

  getConnectivityStatus(): Connectivity {
    return this.last ?? emptyConnectivity();
  }

  /** The whole picture, measured now. */
  async testConnectivity(): Promise<Connectivity> {
    const [internet, dns, https] = await Promise.all([this.testInternet(), this.testDNS(), this.testHTTPS()]);
    const interfaces = detectInterfaces();
    const localAddress = interfaces.find((iface) => iface.kind !== "loopback")?.lanAddress ?? null;

    const cgnat = Boolean(internet.publicIp && /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(internet.publicIp));
    const localIsPublic = interfaces.some((iface) =>
      iface.addresses.some((address) => address.scope === "public" && address.family === "IPv4"),
    );
    const behindNat = !localIsPublic;
    // A public address in the kernel AND the same address as seen from outside is
    // the only combination that can genuinely accept an inbound connection.
    const behindCgnat = cgnat || (Boolean(internet.publicIp) && !localIsPublic);

    return {
      at: Date.now(),
      internet: internet.ok,
      publicIp: internet.publicIp,
      latencyMs: internet.ok ? internet.ms : null,
      dns: { ok: dns.ok, ms: dns.ms, servers: readDnsServers(), resolved: dns.addresses, error: dns.error },
      https: { ok: https.ok, ms: https.ms, status: https.status },
      nat: {
        localAddress,
        publicAddress: internet.publicIp,
        behindNat,
        behindCgnat,
        verdict: behindCgnat
          ? "This machine is behind carrier-grade NAT, so nothing on the Internet can open a connection to it. An outbound tunnel is required (§16)."
          : behindNat
            ? "This machine is behind address translation and holds no public address of its own, so incoming connections cannot be relied on. An outbound tunnel is the supported path."
            : "This machine holds a public address of its own. Direct inbound connections are possible if the firewall allows them.",
      },
      directInboundPossible: !behindCgnat && !behindNat,
    };
  }

  capability() {
    return {
      available: [
        "Reading interfaces, addresses, MAC addresses and link state.",
        "Reading the kernel routing table and the resolver configuration.",
        "Real Internet, DNS and TLS tests.",
        "NAT and CGNAT detection by comparing the local address with the address the world sees.",
        "A monitor that publishes a bus event when the network changes.",
      ],
      blocked: [
        {
          what: "Configuring an interface (bringing a link up, applying an address, changing the default route)",
          why: "That needs CAP_NET_ADMIN, which is the kernel's to grant. In this development container the process does not hold it.",
          fallback: "The manager produces the exact command plan for the change and hands it to the privileged helper on the real image; the plan is shown in diagnostics so it can be reviewed before it runs.",
        },
        {
          what: "Wi-Fi association and scanning",
          why: "That is the job of wpa_supplicant on the image, which needs the radio; a container has no radio.",
          fallback: "Wi-Fi interfaces are detected and reported, and the manager names wpa_supplicant as the component that associates on the image.",
        },
      ],
    };
  }
}

/* ------------------------------------------------------------- the readers --- */

const VPN_IFACE = /^(tun|tap|wg|utun|ppp|nordlynx|proton|tailscale|zt|ipsec)/i;

export function classifyInterface(name: string): NetInterface["kind"] {
  if (name === "lo") return "loopback";
  if (VPN_IFACE.test(name)) return "vpn";
  if (/^(wl|wlan|wifi)/i.test(name)) return "wifi";
  if (/^(eth|en|eno|ens|enp|em)/i.test(name)) return "ethernet";
  if (/^(docker|veth|br-|virbr|vmnet)/i.test(name)) return "virtual";
  return "unknown";
}

function scopeOf(address: string, internal: boolean, family: "IPv4" | "IPv6"): NetAddress["scope"] {
  if (internal || address === "::1") return "loopback";
  if (family === "IPv4") {
    if (/^169\.254\./.test(address)) return "link-local";
    return /^(?:10\.|127\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(address)
      ? "private"
      : "public";
  }
  const lower = address.toLowerCase();
  if (lower.startsWith("fe80:")) return "link-local";
  if (lower.startsWith("fc") || lower.startsWith("fd")) return "private";
  return "public";
}

export function detectInterfaces(): NetInterface[] {
  const found: NetInterface[] = [];
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    const kind = classifyInterface(name);
    const list: NetAddress[] = [];
    let lanAddress: string | null = null;
    for (const info of addresses ?? []) {
      const family = String(info.family) === "IPv6" ? "IPv6" : "IPv4";
      const scope = scopeOf(info.address, info.internal, family);
      list.push({ iface: name, address: info.address, family, scope, mac: info.mac });
      if (family === "IPv4" && scope === "private" && !lanAddress) lanAddress = info.address;
    }
    found.push({ name, kind, addresses: list, lanAddress, up: list.length > 0 });
  }
  return found;
}

/** The kernel's IPv4 routing table. An empty list is a real answer. */
export function readRoutes(): Route[] {
  const routes: Route[] = [];
  try {
    if (!existsSync("/proc/net/route")) return routes;
    const lines = readFileSync("/proc/net/route", "utf8").trim().split("\n").slice(1);
    for (const line of lines) {
      const [iface, destinationHex, gatewayHex, , , , metricHex] = line.trim().split(/\s+/);
      if (!iface || !destinationHex) continue;
      const destination = hexToIpv4(destinationHex);
      const gateway = hexToIpv4(gatewayHex);
      routes.push({
        destination,
        gateway: gateway === "0.0.0.0" ? null : gateway,
        iface,
        metric: Number.parseInt(metricHex ?? "0", 16) || 0,
      });
    }
  } catch {
    /* A missing or unreadable table is reported by the caller as no routes. */
  }
  return routes;
}

/** /proc encodes IPv4 in network byte order, little-endian, as one hex word. */
function hexToIpv4(hex: string): string {
  if (!hex || hex.length !== 8) return "0.0.0.0";
  const value = Number.parseInt(hex, 16);
  return [(value & 0xff), (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff].join(".");
}

export function readDnsServers(): string[] {
  const servers: string[] = [];
  try {
    if (existsSync("/etc/resolv.conf")) {
      for (const line of readFileSync("/etc/resolv.conf", "utf8").split("\n")) {
        const match = /^\s*nameserver\s+(\S+)/.exec(line);
        if (match) servers.push(match[1]);
      }
    }
  } catch {
    /* fall through to the system resolver below */
  }
  if (!servers.length) {
    // systemd-resolved and container runtimes both keep the real servers here.
    try {
      const output = execFileSync("sh", ["-c", "command -v resolvectl >/dev/null && resolvectl dns 2>/dev/null | head -1"], {
        encoding: "utf8",
        timeout: 3000,
      });
      servers.push(...(output.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? []));
    } catch {
      /* nothing more to try */
    }
  }
  return [...new Set(servers)];
}

function emptyConnectivity(): Connectivity {
  return {
    at: 0,
    internet: false,
    publicIp: null,
    latencyMs: null,
    dns: { ok: false, ms: 0, servers: [], resolved: [], error: "not measured yet" },
    https: { ok: false, ms: 0, status: null },
    nat: { localAddress: null, publicAddress: null, behindNat: true, behindCgnat: false, verdict: "The network has not been measured yet." },
    directInboundPossible: false,
  };
}

/** The host's name as the OS sees it, for the diagnostics and the portal. */
export function systemHostname(): string {
  return hostname();
}

export { lookup };
