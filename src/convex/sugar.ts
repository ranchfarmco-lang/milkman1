"use node";

/**
 * SUGAR — the real, running half of the specification.
 *
 * The spec asks for a built-in server, a built-in Internet client and real
 * network/VPN detection. This module is exactly that, and it is genuine: it runs
 * on the server (a Node runtime, so it has the operating system's own APIs),
 * reads the real network interfaces, does real DNS lookups, makes real outbound
 * HTTPS requests and validates real TLS certificates.
 *
 * What it is NOT is a native desktop host. A serverless function cannot bind a
 * listening port, embed a browser engine, or edit a host firewall — so those
 * stay the native host's job and are reported as such, never faked
 * (spec §51, §52, §64).
 *
 * `diagnose` is internal: both the public action below and the HTTP API in
 * `http.ts` call it, each after their own authentication.
 */

import {
  arch,
  cpus,
  freemem,
  hostname,
  networkInterfaces,
  platform,
  release,
  totalmem,
  uptime,
} from "node:os";
import { resolve4 } from "node:dns/promises";
import { internal } from "./_generated/api";
import { action, internalAction } from "./_generated/server";

/** Bumped when the shape of the report changes. */
export const SUGAR_API_VERSION = "1.0.0";

/** Prefixes that identify a VPN / tunnel interface across the platforms. */
const VPN_INTERFACE = /^(tun|tap|wg|utun|ppp|ppp0|proton|nordlynx|ipsec|wireguard|zt|tailscale)/i;

type NetInterface = {
  name: string;
  address: string;
  family: string;
  internal: boolean;
  mac: string;
  vpn: boolean;
};

type TimedFetch = {
  ok: boolean;
  status: number | null;
  ms: number;
  body: string;
  error: string | null;
};

/** One outbound HTTPS request, with a hard timeout so a silent network cannot hang. */
async function timedFetch(url: string, timeoutMs = 8000): Promise<TimedFetch> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": `SUGAR-diagnostics/${SUGAR_API_VERSION}` },
    });
    const body = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      ms: Date.now() - started,
      body,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      ms: Date.now() - started,
      body: "",
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** The real interfaces of the machine this function runs on. */
function readInterfaces(): { all: NetInterface[]; vpn: string[]; lan: string[] } {
  const all: NetInterface[] = [];
  const vpn: string[] = [];
  const lan: string[] = [];

  const table = networkInterfaces();
  for (const [name, addresses] of Object.entries(table)) {
    const isVpn = VPN_INTERFACE.test(name);
    if (isVpn) vpn.push(name);

    for (const info of addresses ?? []) {
      const family = String(info.family);
      all.push({
        name,
        address: info.address,
        family,
        internal: info.internal,
        mac: info.mac,
        vpn: isVpn,
      });
      if (!info.internal && family === "IPv4" && !isVpn) lan.push(info.address);
    }
  }

  return { all, vpn, lan };
}

/** The environment variables worth reporting — by presence only, never by value. */
const ENV_KEYS: { key: string; group: string; about: string }[] = [
  { key: "VLY_INTEGRATION_KEY", group: "AI", about: "The Freebuff AI gateway" },
  { key: "GROQ_API_KEY", group: "AI", about: "Groq" },
  { key: "OPENAI_API_KEY", group: "AI", about: "OpenAI" },
  { key: "ANTHROPIC_API_KEY", group: "AI", about: "Anthropic" },
  { key: "GOOGLE_API_KEY", group: "AI", about: "Google / Gemini" },
  { key: "GEMINI_API_KEY", group: "AI", about: "Gemini" },
  { key: "XAI_API_KEY", group: "AI", about: "xAI / Grok" },
  { key: "DEEPSEEK_API_KEY", group: "AI", about: "DeepSeek" },
  { key: "OPENROUTER_API_KEY", group: "AI", about: "OpenRouter" },
  { key: "MISTRAL_API_KEY", group: "AI", about: "Mistral" },
  { key: "TOGETHER_API_KEY", group: "AI", about: "Together" },
  { key: "FIREWORKS_API_KEY", group: "AI", about: "Fireworks" },
  { key: "CEREBRAS_API_KEY", group: "AI", about: "Cerebras" },
  { key: "HF_TOKEN", group: "AI", about: "Hugging Face" },
  { key: "DAYTONA_API_KEY", group: "Platform", about: "The builder's sandbox" },
  { key: "LIVEKIT_API_KEY", group: "Platform", about: "The call relay" },
  {
    key: "HUB_PASSWORD",
    group: "Security",
    about: "The family password — switched off while sign-in is guests-only",
  },
  { key: "SUGAR_API_TOKEN", group: "Security", about: "The SUGAR API token" },
];

function configuredSystems() {
  return ENV_KEYS.map(({ key, group, about }) => {
    const raw = process.env[key];
    return {
      key,
      group,
      about,
      configured: typeof raw === "string" && raw.trim().length > 0,
    };
  });
}

/**
 * The whole report. Everything here was measured just now on the machine
 * running this function; nothing is inferred from what the browser said.
 */
async function buildReport() {
  const ifaces = readInterfaces();

  // DNS, from the server's own resolver.
  let dns = { ok: false, ms: null as number | null, addresses: [] as string[], error: null as string | null };
  const dnsStarted = Date.now();
  try {
    const addresses = await resolve4("example.com");
    dns = { ok: addresses.length > 0, ms: Date.now() - dnsStarted, addresses, error: null };
  } catch (error) {
    dns = {
      ok: false,
      ms: Date.now() - dnsStarted,
      addresses: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }

  // Outbound HTTPS, which also proves TLS certificate validation worked.
  const ipLookup = await timedFetch("https://api.ipify.org?format=json");
  let publicIp: string | null = null;
  if (ipLookup.ok) {
    try {
      publicIp = (JSON.parse(ipLookup.body) as { ip?: string }).ip ?? null;
    } catch {
      publicIp = null;
    }
  }

  // A second endpoint, so "HTTPS works" is not one service answering.
  const secondOpinion = await timedFetch("https://one.one.one.one/", 6000);

  const siteUrl = (process.env.CONVEX_SITE_URL ?? "").trim() || null;
  const cloudUrl = (process.env.CONVEX_CLOUD_URL ?? "").trim() || null;

  const interfaces = ifaces.all;

  return {
    at: Date.now(),
    version: SUGAR_API_VERSION,
    server: {
      hostname: hostname(),
      platform: platform(),
      release: release(),
      arch: arch(),
      cpus: cpus().length,
      uptimeSeconds: Math.round(uptime()),
      nodeVersion: process.version,
      memory: {
        totalMb: Math.round(totalmem() / (1024 * 1024)),
        freeMb: Math.round(freemem() / (1024 * 1024)),
      },
      siteUrl,
      cloudUrl,
    },
    network: {
      interfaces,
      interfaceCount: new Set(interfaces.map((entry) => entry.name)).size,
      vpnDetected: ifaces.vpn.length > 0,
      vpnInterfaces: ifaces.vpn,
      lanAddresses: ifaces.lan,
      loopbackOnly: ifaces.lan.length === 0,
    },
    connectivity: {
      internet: ipLookup.ok,
      publicIp,
      latencyMs: ipLookup.ok ? ipLookup.ms : null,
      dns,
      https: {
        ok: ipLookup.ok,
        ms: ipLookup.ms,
        status: ipLookup.status,
        error: ipLookup.error,
      },
      secondEndpoint: {
        ok: secondOpinion.ok,
        ms: secondOpinion.ms,
        status: secondOpinion.status,
      },
    },
    systems: configuredSystems(),
    /**
     * What a function genuinely cannot decide, stated plainly rather than
     * guessed: it has no listening socket, so it cannot test inbound
     * reachability from the outside, detect carrier-grade NAT, or hold a tunnel.
     * Those belong to the native host (spec §9–§11, §14).
     */
    reachability: {
      publicHttpApi: siteUrl,
      inboundTestable: false,
      tunnelConnected: false,
      note:
        "This service can make outbound connections and can be reached at its public HTTPS address, but it cannot open a listening port, so inbound reachability, CGNAT detection and a persistent tunnel remain the native host's job.",
    },
  };
}

export type SugarReport = Awaited<ReturnType<typeof buildReport>>;

/** The real diagnostic run. No auth here — every caller authenticates first. */
export const diagnose = internalAction({
  args: {},
  handler: async () => await buildReport(),
});

/**
 * The same report for the hub's own front end. It asks the same access
 * question every other privileged action asks, so a locked account cannot use
 * it to probe the machine.
 */
export const run = action({
  args: {},
  handler: async (ctx): Promise<SugarReport> => {
    if (!(await ctx.runQuery(internal.access.unlocked, {}))) {
      throw new Error("This hub is locked. Enter the family password to run SUGAR diagnostics.");
    }
    return await ctx.runAction(internal.sugar.diagnose, {});
  },
});
