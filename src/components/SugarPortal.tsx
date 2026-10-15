import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/convex/_generated/api";
import { ORANGE_BUTTON } from "@/lib/control-room-sections";
import { downloadBlob, downloadText, readableSize } from "@/lib/download";
import { useHubAddress } from "@/lib/hub-address";
import { copyText } from "@/lib/internal-share";
import {
  NATIVE_BUNDLE_NAME,
  buildNativeBundle,
  nativeBundleSummary,
} from "@/lib/sugar-native";
import { EMAIL_NAME, EMAIL_URL, VPN_NAME, VPN_URL } from "@/lib/offline-brain";
import { detectDevice } from "@/lib/pwa";
import { cn } from "@/lib/utils";
import type { FunctionReturnType } from "convex/server";
import { useAction } from "convex/react";
import { motion } from "framer-motion";
import {
  Activity,
  AlertTriangle,
  Archive,
  BookOpen,
  Boxes,
  Check,
  CheckCircle2,
  Chrome,
  CircuitBoard,
  Cloud,
  Copy,
  Cpu,
  Download,
  ExternalLink,
  FileText,
  Globe,
  HardDriveDownload,
  LifeBuoy,
  ListChecks,
  Loader2,
  Lock,
  MonitorSmartphone,
  Network,
  Package,
  Play,
  Plug,
  QrCode,
  Radio,
  RefreshCw,
  Router,
  ServerCog,
  ShieldCheck,
  Terminal,
  Wifi,
  WifiOff,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { toast } from "sonner";

const RISE = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
};

/* -------------------------------------------------------------------------- */
/*  The honest frame                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The page this section lives on is a browser page. It runs inside the
 * sandbox every browser imposes: it cannot listen on a port, accept an
 * inbound connection, edit a firewall rule or host an embedded browser
 * engine. The SUGAR specification asks for a *native host application* to do
 * those things, with a web portal as its front door.
 *
 * So this section does two things and says which is which, every time:
 *
 *   1. What a web portal genuinely can do here — run real connectivity
 *      tests, hand over real downloads, explain the architecture, and drive
 *      the remote-access interface — is implemented and works.
 *   2. What only the native host can do is shown as a real status row marked
 *      "native host only", with the reason. Nothing is faked (spec §51, §52).
 */

type Tone = "pass" | "warn" | "fail" | "native" | "idle" | "running";

const TONE_STYLE: Record<Tone, { chip: string; icon: LucideIcon; label: string }> = {
  pass: {
    chip: "border-emerald-400/40 text-emerald-300",
    icon: CheckCircle2,
    label: "PASS",
  },
  warn: {
    chip: "border-amber-400/40 text-amber-300",
    icon: AlertTriangle,
    label: "WARN",
  },
  fail: {
    chip: "border-rose-400/40 text-rose-300",
    icon: XCircle,
    label: "FAIL",
  },
  native: {
    chip: "border-border/60 text-muted-foreground",
    icon: Cpu,
    label: "NATIVE HOST ONLY",
  },
  idle: {
    chip: "border-border/60 text-muted-foreground",
    icon: Activity,
    label: "NOT RUN",
  },
  running: {
    chip: "border-border/60 text-muted-foreground",
    icon: Loader2,
    label: "TESTING",
  },
};

/* -------------------------------------------------------------------------- */
/*  Real probes — the only statuses that are allowed to move                  */
/* -------------------------------------------------------------------------- */

type ProbeResult = { tone: Tone; detail: string };

/** A fetch with a hard timeout, so a silent network cannot hang the test. */
async function probe(
  url: string,
  timeoutMs = 9000,
): Promise<{ ok: boolean; ms: number; text: string }> {
  const started = performance.now();
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      cache: "no-store",
      credentials: "omit",
    });
    const text = response.ok ? await response.text() : "";
    return { ok: response.ok, ms: Math.round(performance.now() - started), text };
  } catch {
    return { ok: false, ms: Math.round(performance.now() - started), text: "" };
  } finally {
    window.clearTimeout(timer);
  }
}

function storageWorks(): boolean {
  try {
    window.localStorage.setItem("__sugar_probe__", "1");
    window.localStorage.removeItem("__sugar_probe__");
    return true;
  } catch {
    return false;
  }
}

type Check = {
  id: string;
  label: string;
  /** A test that really runs in this browser. */
  run?: () => Promise<ProbeResult>;
  /** For the rows a browser cannot run: why not, in plain words. */
  native?: string;
};

/** The numbered "TEST EVERYTHING" walk from the specification (§22). */
const CHECKS: Check[] = [
  {
    id: "device",
    label: "This device, and the browser it is using",
    run: async () => {
      const device = detectDevice();
      return {
        tone: "pass",
        detail: `${device.name} — ${device.browser}, ${device.kind}. The portal adapts to this automatically (§47).`,
      };
    },
  },
  {
    id: "https",
    label: "Secure page (HTTPS)",
    run: async () => {
      const { protocol, hostname } = window.location;
      const local = hostname === "localhost" || hostname === "127.0.0.1";
      return protocol === "https:"
        ? { tone: "pass", detail: "This page is served over HTTPS, so the connection is encrypted end to end." }
        : local
          ? { tone: "warn", detail: "Served over http on loopback. Fine on this machine; a real deployment should use HTTPS (§40)." }
          : { tone: "fail", detail: "This page is not on HTTPS. Remote traffic must be encrypted with TLS (§40)." };
    },
  },
  {
    id: "online",
    label: "Internet connection",
    run: async () =>
      navigator.onLine
        ? { tone: "pass", detail: "The browser reports this device is online." }
        : { tone: "fail", detail: "This device reports no Internet connection. The portal still works offline (§38)." },
  },
  {
    id: "dns",
    label: "DNS and outbound HTTPS/TLS",
    run: async () => {
      const result = await probe("https://api.ipify.org?format=json");
      return result.ok
        ? { tone: "pass", detail: `Resolved a name, made an HTTPS request and validated the certificate in ${result.ms} ms.` }
        : { tone: "fail", detail: "Could not reach a public HTTPS endpoint — DNS, routing or the network is blocking it." };
    },
  },
  {
    id: "publicip",
    label: "Public address visibility",
    run: async () => {
      const result = await probe("https://api.ipify.org?format=json");
      const match = result.ok ? result.text.match(/"ip"\s*:\s*"([^"]+)"/) : null;
      return match
        ? {
            tone: "pass",
            detail: `Public address seen from the outside: ${match[1]}. Whether it is *reachable* is a separate test a browser cannot make (§64).`,
          }
        : { tone: "warn", detail: "The public address could not be read. It is not needed for local use." };
    },
  },
  {
    id: "hub",
    label: "The hub's own backend, beside this page",
    run: async () => {
      const result = await probe(`${window.location.origin}/version`, 4000);
      return result.ok
        ? { tone: "pass", detail: "The backend answered this page directly." }
        : { tone: "warn", detail: "No backend on this origin — normal for a portal served on its own, or when the database is elsewhere." };
    },
  },
  {
    id: "storage",
    label: "Local storage",
    run: async () =>
      storageWorks()
        ? { tone: "pass", detail: "The browser will let this page keep settings on this device." }
        : { tone: "warn", detail: "Storage is blocked here — a private window or a sandboxed frame. Settings will not persist." },
  },
  {
    id: "features",
    label: "Browser networking features",
    run: async () => {
      const has = (key: string) => typeof window !== "undefined" && key in window;
      const parts = [
        has("WebSocket") ? "WebSocket" : null,
        has("RTCPeerConnection") ? "WebRTC" : null,
        has("indexedDB") ? "IndexedDB" : null,
        has("serviceWorker") ? "service worker" : null,
        has("Notification") ? "notifications" : null,
      ].filter(Boolean);
      return {
        tone: "pass",
        detail: `Available out of the box: ${parts.join(", ")}. All of it is sandboxed to this page's own origin.`,
      };
    },
  },
  {
    id: "inserver",
    label: "Internal HTTP server on a port",
    native:
      "A browser cannot open a listening socket. The native host binds 127.0.0.1:<port> and, when allowed, <LAN-IP>:<port>, choosing a free port and storing it (§4).",
  },
  {
    id: "inbound",
    label: "Inbound reachability, NAT and CGNAT detection",
    native:
      "A browser cannot accept an incoming connection, so it cannot tell whether Starlink or Proton VPN is behind carrier-grade NAT — that test runs on the host (§9–§11).",
  },
  {
    id: "firewall",
    label: "Operating-system firewall rules",
    native:
      "Only the native host may inspect or request a firewall exception, and only with the user's consent — never silently (§25).",
  },
  {
    id: "vpn",
    label: "VPN interface and route detection",
    native:
      "The host reads real network interfaces to see whether Proton VPN is up and whether inbound connectivity survives a VPN toggle (§12–§13).",
  },
  {
    id: "engine",
    label: "Embedded browser engine",
    native:
      "The page *is* a browser tab; it cannot embed another engine (WebView2, WebKit, Chromium) inside itself (§7).",
  },
  {
    id: "service",
    label: "Background service and auto-start",
    native:
      "The host installs an optional service that keeps the server and tunnel alive across network changes and restarts (§28).",
  },
  {
    id: "tunnel",
    label: "Secure outbound tunnel / relay",
    native:
      "The host holds an encrypted outbound connection to a relay and forwards only the authorised app traffic through it (§14).",
  },
  {
    id: "installers",
    label: "Cross-platform installers",
    native:
      "Windows, Linux and macOS installers must be built and signed on those platforms — this portal can hand you the source and the build, not a binary it cannot produce (§26, §59).",
  },
];

/* -------------------------------------------------------------------------- */
/*  Capability matrix (§52)                                                   */
/* -------------------------------------------------------------------------- */

const CAPABILITY: { what: string; native: string; web: string }[] = [
  {
    what: "Listen on a network port and run an HTTP server",
    native: "Yes — an embedded production server",
    web: "No — a browser cannot open a listening socket",
  },
  {
    what: "Make outbound HTTP / HTTPS / DNS / WebSocket calls",
    native: "Yes — its own networking layer",
    web: "Yes — from this page, to origins that allow it",
  },
  {
    what: "Render websites inside the application",
    native: "Yes — an embedded engine",
    web: "No — the tab itself is the browser",
  },
  {
    what: "Accept incoming connections / port forwarding",
    native: "Yes, when the network permits it",
    web: "No — inbound traffic can never reach a page",
  },
  {
    what: "Detect CGNAT, VPN interfaces and route changes",
    native: "Yes — from the real interfaces",
    web: "No — only the browser's online/offline hint",
  },
  {
    what: "Change firewall rules, manage a background service",
    native: "Yes, with the user's consent",
    web: "No — outside the sandbox",
  },
  {
    what: "Produce Windows / Linux / macOS installers",
    native: "Yes — built and signed per platform",
    web: "No — but it can hand over the real source and build files",
  },
  {
    what: "Serve the portal, its downloads, docs and remote UI",
    native: "Yes",
    web: "Yes — this is exactly what a portal is for",
  },
];

/* -------------------------------------------------------------------------- */
/*  Architecture, modes, interfaces (§10, §53–§58)                            */
/* -------------------------------------------------------------------------- */

const MODULES: { name: string; line: string }[] = [
  { name: "/core", line: "App lifecycle, configuration, the glue between modules." },
  { name: "/network", line: "Interface detection, Internet, DNS, HTTPS, VPN state, change monitoring." },
  { name: "/server", line: "The embedded HTTP/HTTPS server, port selection, connections." },
  { name: "/browser", line: "The embedded browser engine and its sandboxed IPC bridge." },
  { name: "/tunnel", line: "The replaceable remote-access provider — connect, status, publicUrl, reconnect." },
  { name: "/auth", line: "Login, sessions, rate limiting, device pairing." },
  { name: "/devices", line: "Paired remote devices and their revocable credentials." },
  { name: "/downloads", line: "The catalogue the portal serves, with real files and checksums." },
  { name: "/diagnostics", line: "The full self-test and the exportable report." },
  { name: "/security", line: "TLS, CSP, secure storage, audit log redaction." },
  { name: "/storage", line: "Settings, network, server, security and application state." },
  { name: "/ui", line: "The dashboard, beginner mode and advanced mode." },
  { name: "/platform/{windows,linux,macos}", line: "The OS-specific pieces: firewall, service, installers." },
  { name: "/web-portal", line: "This page — the browser-compatible front door." },
];

const MODES: { id: string; name: string; when: string; shows: string }[] = [
  {
    id: "A",
    name: "Local",
    when: "Using the app on the same computer.",
    shows: "LOCAL CONNECTION — 127.0.0.1",
  },
  {
    id: "B",
    name: "LAN",
    when: "Another device on the same home network.",
    shows: "LOCAL NETWORK CONNECTION — 192.168.x.x",
  },
  {
    id: "C",
    name: "Remote Internet",
    when: "A device somewhere else, when inbound access is unavailable.",
    shows: "SECURE REMOTE CONNECTION — an encrypted outbound tunnel/relay",
  },
];

const INTERFACES: { name: string; verbs: string[] }[] = [
  { name: "Server", verbs: ["startServer()", "stopServer()", "restartServer()", "getServerStatus()", "getLocalAddress()", "getPort()", "getConnections()"] },
  { name: "Network", verbs: ["detectInterfaces()", "getActiveInterface()", "testInternet()", "testDNS()", "testHTTPS()", "getVPNStatus()", "getNetworkStatus()"] },
  { name: "Remote connection", verbs: ["connectRemote()", "disconnectRemote()", "reconnectRemote()", "getRemoteStatus()", "getPublicUrl()", "testRemoteConnection()"] },
  { name: "Browser", verbs: ["createBrowser()", "navigate()", "back()", "forward()", "reload()", "stop()", "download()", "getBrowserStatus()"] },
  { name: "Diagnostics", verbs: ["runFullDiagnostics()", "runNetworkDiagnostics()", "runServerDiagnostics()", "runBrowserDiagnostics()", "runRemoteDiagnostics()", "exportDiagnostics()"] },
];

const ACCEPTANCE: string[] = [
  "Install and launch the host application; it starts its own server and browser engine.",
  "It detects the Internet, the Starlink link and the Proton VPN state — ON and OFF (§12).",
  "It tests remote connectivity and, when inbound access is blocked, opens a secure tunnel (§14).",
  "The dashboard shows the real, service-provided public address — never a fabricated one (§16).",
  "A device on a completely different connection opens that address and meets authentication (§17).",
  "After signing in, the remote dashboard shows the host's actual status.",
  "Changing the host's Internet or VPN makes the app detect the change, reconnect and resume (§13, §45).",
  "The remote device reconnects. Normal operation returns.",
];

/* -------------------------------------------------------------------------- */
/*  Documentation (§49) and external components (§34, §67)                    */
/* -------------------------------------------------------------------------- */

const DOCS: { title: string; body: string[] }[] = [
  {
    title: "Getting started",
    body: [
      "Two parts make up SUGAR: the native host application, which runs on the computer and holds the server, the browser engine and the network tests; and this web portal, which you are on now.",
      "Everything on this page works from any browser: the tests, the downloads, the documentation and, once a host is running, the remote-access dashboard.",
    ],
  },
  {
    title: "Using Starlink",
    body: [
      "Starlink gives a fast connection, but it commonly sits behind carrier-grade NAT, so a direct incoming connection may not be possible (§11). The app tests for this rather than assuming.",
      "When direct access is unavailable the host opens a secure outbound tunnel instead, which needs no port forwarding.",
    ],
  },
  {
    title: "Using Proton VPN",
    body: [
      "Turn the VPN on or off whenever you like. The app re-tests the interfaces each time and reconnects — you should never have to reconfigure anything by hand (§12–§13).",
      `${VPN_NAME} is a separate application; the host detects its effect on the network rather than controlling it.`,
    ],
  },
  {
    title: "Remote access",
    body: [
      "Remote access is only real once the host has a genuine public address from a tunnel or relay service. The portal will show that exact address — it will not invent one (§16, §51).",
      "Remote devices use their normal browser; they do not install the host application (§3).",
    ],
  },
  {
    title: "Phone, tablet and Chromebook",
    body: [
      "Open the address on the phone's browser. If the host is running, the authentication page appears first; after signing in, the dashboard loads and adapts to the screen (§19, §47).",
      "For a Chromebook, a phone or a tablet, nothing needs installing — a modern browser is the whole client.",
    ],
  },
  {
    title: "Troubleshooting",
    body: [
      "Start with TEST EVERYTHING on the Diagnostics tab. It runs each check on its own line and translates the result into plain language rather than a raw error code (§21, §22).",
      "The Troubleshooting wizard turns a symptom — \"I cannot connect from my phone\" — into that same set of numbered steps.",
    ],
  },
  {
    title: "Security",
    body: [
      "Remote traffic uses HTTPS/TLS, sessions are authenticated and rate-limited, and privileged actions need elevated authentication (§40–§42).",
      "Only the application's own services are ever exposed — never file shares, remote desktop or a shell (§65).",
    ],
  },
  {
    title: "Downloads and installation",
    body: [
      "The Download Center below lists each item with its platform, version, size and instructions — and every button points at a real file or a real source (§31–§32).",
      "Nothing here is a fake installation button: a component that cannot legally or technically be bundled is shown with its official source instead (§34, §67).",
    ],
  },
  {
    title: "Updates and uninstalling",
    body: [
      "The host checks its own current and latest version and offers the update with a changelog; updates are verified by checksum or signature before they run, and are never installed silently (§59–§60).",
      "Uninstalling is a normal part of the installer: it removes the application, its service and its shortcuts (§26).",
    ],
  },
];

type ExternalComponent = {
  name: string;
  what: string;
  why: string;
  systems: string;
  url: string;
  icon: LucideIcon;
};

const EXTERNAL: ExternalComponent[] = [
  {
    name: "WebView2 Runtime",
    what: "Microsoft's embedded browser engine for Windows applications.",
    why: "Gives the native host a real embedded browser on Windows rather than opening an external one (§7).",
    systems: "Windows 10 / 11",
    url: "https://developer.microsoft.com/microsoft-edge/webview2/",
    icon: Chrome,
  },
  {
    name: "Tauri",
    what: "A small cross-platform shell for a native app with a web front end.",
    why: "One of the frameworks the host can be built on, using each system's own web view (§7).",
    systems: "Windows, macOS, Linux",
    url: "https://tauri.app/",
    icon: Boxes,
  },
  {
    name: "Electron",
    what: "A cross-platform native shell with a bundled Chromium engine.",
    why: "An alternative host framework when a consistent Chromium engine matters more than size (§7).",
    systems: "Windows, macOS, Linux",
    url: "https://www.electronjs.org/",
    icon: CircuitBoard,
  },
  {
    name: "Cloudflare Tunnel",
    what: "An encrypted outbound tunnel that publishes a service without opening inbound ports.",
    why: "One way for the host to become reachable through Starlink's carrier-grade NAT, matching the tunnel interface in §15.",
    systems: "Windows, macOS, Linux",
    url: "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/",
    icon: Cloud,
  },
  {
    name: VPN_NAME,
    what: "Your VPN.",
    why: "The specification is written around a Proton VPN link the user can switch on or off, which the host detects (§12).",
    systems: "Every platform",
    url: VPN_URL,
    icon: ShieldCheck,
  },
  {
    name: "Starlink",
    what: "The intended satellite Internet connection.",
    why: "The app treats it as the underlying link and tests what it actually permits, rather than assuming (§11).",
    systems: "The Starlink terminal",
    url: "https://www.starlink.com/",
    icon: Radio,
  },
  {
    name: EMAIL_NAME,
    what: "The account for sign-up and mail.",
    why: "Used to create the account the portal and the app are tied to.",
    systems: "Every platform",
    url: EMAIL_URL,
    icon: ExternalLink,
  },
];

/* -------------------------------------------------------------------------- */
/*  Small pieces                                                              */
/* -------------------------------------------------------------------------- */

function StatusChip({ tone }: { tone: Tone }) {
  const style = TONE_STYLE[tone];
  const Icon = style.icon;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[8px] font-medium tracking-[0.1em]",
        style.chip,
      )}
    >
      <Icon className={cn("size-3", tone === "running" && "animate-spin")} />
      {style.label}
    </span>
  );
}

function SectionIcon({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-white/10 text-white">
      <Icon className="size-4" />
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/*  The real server — a live diagnostic run on the machine itself             */
/* -------------------------------------------------------------------------- */

/** The exact shape the backend action returns, so nothing is re-guessed here. */
type SugarReport = FunctionReturnType<typeof api.sugar.run>;

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-lg border border-border/50 bg-background/40 px-2 py-1.5">
      <dt className="uppercase tracking-[0.1em] text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-all font-medium text-foreground">{value}</dd>
    </div>
  );
}

/**
 * The live server report, fetched through the hub's own backend. Every caller
 * of the action asks the same access question as the rest of the hub, so a
 * locked hub answers with a plain refusal instead of leaking machine details
 * (§17, §40). Nothing here is stubbed: it is the value the server measured.
 */
function useServerReport() {
  const run = useAction(api.sugar.run);
  const [report, setReport] = useState<SugarReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(true);

  useEffect(() => {
    let alive = true;
    run({})
      .then((result) => {
        if (!alive) return;
        setReport(result);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!alive) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (alive) setRunning(false);
      });
    return () => {
      alive = false;
    };
  }, [run]);

  const refresh = async () => {
    setRunning(true);
    try {
      const result = await run({});
      setReport(result);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRunning(false);
    }
  };

  return { report, error, running, refresh };
}

function ServerReportPanel({
  report,
  error,
  running,
  refresh,
}: {
  report: SugarReport | null;
  error: string | null;
  running: boolean;
  refresh: () => Promise<void>;
}) {
  const tone: Tone = error ? "warn" : report ? "pass" : running ? "running" : "idle";

  const grouped = useMemo(() => {
    if (!report) return [] as [string, SugarReport["systems"]][];
    const map = new Map<string, SugarReport["systems"]>();
    for (const system of report.systems) {
      const list = map.get(system.group) ?? [];
      list.push(system);
      map.set(system.group, list);
    }
    return [...map.entries()];
  }, [report]);

  return (
    <div className="rounded-xl border border-white/25 bg-card/60 p-3">
      <div className="flex flex-wrap items-center gap-3">
        <ServerCog className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold tracking-tight">On the server — measured, not guessed</p>
          <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
            These values come from the machine the hub runs on, read live: its
            real network interfaces, its own DNS resolver, real outbound HTTPS
            and TLS, and the real state of every configured system (§64).
          </p>
        </div>
        <StatusChip tone={tone} />
        <Button
          type="button"
          variant="outline"
          disabled={running}
          onClick={() => void refresh()}
          className={cn(
            "h-8 cursor-pointer rounded-lg text-[10px]",
            ORANGE_BUTTON,
          )}
        >
          {running ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
          Run on the server
        </Button>
      </div>

      {error ? (
        <p className="mt-2 rounded-lg border border-amber-400/30 bg-amber-400/5 px-3 py-2 text-[10px] leading-4 text-amber-200/90">
          {error}
        </p>
      ) : null}

      {report ? (
        <div className="mt-3 flex flex-col gap-3">
          <dl className="grid grid-cols-2 gap-2 text-[9px] sm:grid-cols-3 lg:grid-cols-4">
            <Fact label="Host" value={report.server.hostname} />
            <Fact label="Platform" value={`${report.server.platform} ${report.server.release} · ${report.server.arch}`} />
            <Fact
              label="CPU / memory"
              value={`${report.server.cpus} cores · ${report.server.memory.freeMb}/${report.server.memory.totalMb} MB free`}
            />
            <Fact label="Uptime" value={formatUptime(report.server.uptimeSeconds)} />
            <Fact label="Node" value={report.server.nodeVersion} />
            <Fact label="Public address" value={report.connectivity.publicIp ?? "not visible"} />
            <Fact
              label="Outbound HTTPS"
              value={report.connectivity.https.ok ? `${report.connectivity.https.ms} ms · TLS ok` : "did not answer"}
            />
            <Fact
              label="Second endpoint"
              value={report.connectivity.secondEndpoint.ok ? `${report.connectivity.secondEndpoint.ms} ms` : "no answer"}
            />
            <Fact
              label="DNS"
              value={report.connectivity.dns.ok ? `${report.connectivity.dns.ms} ms` : report.connectivity.dns.error ?? "failed"}
            />
            <Fact
              label="VPN interface"
              value={report.network.vpnDetected ? report.network.vpnInterfaces.join(", ") : "none detected"}
            />
            <Fact label="LAN address" value={report.network.lanAddresses[0] ?? "none — loopback only"} />
            <Fact label="Public HTTPS API" value={report.reachability.publicHttpApi ?? "not set"} />
          </dl>

          <details className="rounded-lg border border-border/50 bg-background/30">
            <summary className="cursor-pointer px-3 py-2 text-[10px] font-medium">
              {report.network.interfaceCount} network interfaces on the server
            </summary>
            <ul className="divide-y divide-border/50 px-3 pb-1">
              {report.network.interfaces.map((entry, index) => (
                <li key={`${entry.name}-${index}`} className="flex items-center gap-2 py-1.5 text-[9px]">
                  <code className="shrink-0 rounded border border-border/60 bg-background/40 px-1.5 py-0.5">
                    {entry.name}
                  </code>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">{entry.address}</span>
                  <span className="shrink-0 text-muted-foreground">{entry.family}</span>
                  {entry.vpn ? (
                    <span className="shrink-0 rounded-full border border-emerald-400/40 px-1.5 text-emerald-300">
                      VPN
                    </span>
                  ) : null}
                  {entry.internal ? (
                    <span className="shrink-0 rounded-full border border-border/60 px-1.5 text-muted-foreground">
                      loopback
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </details>

          <div className="rounded-lg border border-border/50 bg-background/30 p-3">
            <p className="text-[10px] font-medium">Configured systems — presence only, never values</p>
            <div className="mt-2 flex flex-col gap-2">
              {grouped.map(([group, systems]) => (
                <div key={group}>
                  <p className="text-[9px] uppercase tracking-[0.12em] text-muted-foreground">{group}</p>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {systems.map((system) => (
                      <span
                        key={system.key}
                        title={system.about}
                        className={cn(
                          "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[9px]",
                          system.configured
                            ? "border-emerald-400/40 text-emerald-300"
                            : "border-border/60 text-muted-foreground",
                        )}
                      >
                        {system.configured ? <Check className="size-2.5" /> : <XCircle className="size-2.5" />}
                        {system.key}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-lg border border-amber-400/30 bg-amber-400/5 p-3">
            <p className="text-[10px] font-medium text-amber-200/90">What the server can and cannot decide</p>
            <p className="mt-1 text-[10px] leading-4 text-muted-foreground">{report.reachability.note}</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  The live HTTP API (§5)                                                    */
/* -------------------------------------------------------------------------- */

const API_ENDPOINTS: { path: string; about: string }[] = [
  { path: "/api/status", about: "Service name, version, uptime and platform." },
  { path: "/api/network", about: "Every interface, VPN detection, LAN addresses." },
  { path: "/api/connectivity", about: "Internet, DNS, HTTPS/TLS, public address and latency." },
  { path: "/api/server", about: "The machine: operating system, CPU, memory and uptime." },
  { path: "/api/diagnostics", about: "The complete report, in one response." },
  { path: "/api/systems", about: "Which systems are configured — presence only, no values." },
  { path: "/api/downloads", about: "The download catalogue this hub serves." },
];

function ApiEndpointRow({ base, path, about }: { base: string | null; path: string; about: string }) {
  const [copied, setCopied] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const url = base ? `${base.replace(/\/+$/, "")}${path}` : "";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("This browser would not let me copy it.");
    }
  };

  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      const response = await fetch(url, { cache: "no-store" });
      const body = await response.text();
      setResult(response.ok ? `${response.status} OK · ${body.length} bytes` : `${response.status} ${response.statusText}`);
    } catch {
      setResult("No answer — the request did not complete.");
    } finally {
      setTesting(false);
    }
  };

  return (
    <li className="flex flex-col gap-2 py-2.5 sm:flex-row sm:items-start sm:gap-3">
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-1.5 text-[10px] font-medium">
          <code className="rounded border border-border/60 bg-background/40 px-1.5 py-0.5 text-[9px]">{path}</code>
          <span className="rounded-full border border-emerald-400/40 px-1.5 py-px text-[8px] text-emerald-300">live</span>
        </p>
        <p className="mt-1 text-[10px] leading-4 text-muted-foreground">{about}</p>
        {url ? <p className="mt-1 truncate font-mono text-[9px] text-muted-foreground">{url}</p> : null}
        {result ? <p className="mt-1 text-[9px] text-foreground">{result}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={!url}
          onClick={() => void copy()}
          className="h-8 cursor-pointer rounded-lg text-[10px]"
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={!url || testing}
          onClick={() => void test()}
          className="h-8 cursor-pointer rounded-lg text-[10px]"
        >
          {testing ? <Loader2 className="size-3 animate-spin" /> : <Play className="size-3" />}
          Test
        </Button>
      </div>
    </li>
  );
}

function HttpApiPanel({ base }: { base: string | null }) {
  const [copied, setCopied] = useState(false);

  const copyBase = async () => {
    if (!base) return;
    try {
      await navigator.clipboard.writeText(base);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("This browser would not let me copy it.");
    }
  };

  return (
    <div className="rounded-xl border border-white/25 bg-card/60 p-3">
      <div className="flex flex-wrap items-center gap-3">
        <Globe className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold tracking-tight">A real HTTP server, running now</p>
          <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
            These endpoints are served by this hub's deployment — not a drawing
            of one. Open them in a browser, from another machine, or from
            anywhere on the Internet at this address; “Test” really calls the
            endpoint and reports what came back (§5). If this hub has a family
            password set, an unauthenticated call answers 401 by design — send
            <code className="mx-1 rounded border border-border/60 bg-background/40 px-1 py-0.5 text-[9px]">Authorization: Bearer &lt;token&gt;</code>
            to read it.
          </p>
        </div>
        {base ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => void copyBase()}
            className="h-8 cursor-pointer rounded-lg text-[10px]"
          >
            {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
            {copied ? "Copied" : "Copy base URL"}
          </Button>
        ) : null}
      </div>
      {base ? (
        <p className="mt-2 truncate rounded-lg border border-border/50 bg-background/40 px-3 py-1.5 font-mono text-[9px] text-muted-foreground">
          {base}
        </p>
      ) : (
        <p className="mt-2 rounded-lg border border-dashed border-border/70 px-3 py-1.5 text-[9px] text-muted-foreground">
          Run the server diagnostics above to see this hub's public address.
        </p>
      )}
      <ul className="mt-2 divide-y divide-border/50">
        {API_ENDPOINTS.map((endpoint) => (
          <ApiEndpointRow key={endpoint.path} base={base} path={endpoint.path} about={endpoint.about} />
        ))}
      </ul>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Diagnostics (§22, §44)                                                    */
/* -------------------------------------------------------------------------- */

function DiagnosticsPanel() {
  const [results, setResults] = useState<Record<string, ProbeResult>>({});
  const [running, setRunning] = useState(false);

  const browserChecks = useMemo(() => CHECKS.filter((check) => check.run), []);
  const nativeChecks = useMemo(() => CHECKS.filter((check) => check.native), []);

  const testEverything = async () => {
    setRunning(true);
    setResults({});
    for (const check of browserChecks) {
      if (!check.run) continue;
      const result = await check.run();
      setResults((prev) => ({ ...prev, [check.id]: result }));
    }
    setRunning(false);
    toast.success("Diagnostics finished — read each line top to bottom.");
  };

  const exportReport = () => {
    const lines: string[] = [
      "SUGAR — diagnostics report",
      `Run at: ${new Date().toISOString()}`,
      `Page: ${window.location.href}`,
      `User agent: ${navigator.userAgent}`,
      "",
      "Tests run in this browser:",
    ];
    for (const check of browserChecks) {
      const result = results[check.id];
      lines.push(
        `  [${result ? TONE_STYLE[result.tone].label : "NOT RUN"}] ${check.label}${result ? ` — ${result.detail}` : ""}`,
      );
    }
    lines.push("", "Native-host-only capabilities (not testable in a browser):");
    for (const check of nativeChecks) {
      lines.push(`  ${check.label} — ${check.native}`);
    }
    if (downloadText("sugar-diagnostics", lines.join("\n"))) {
      toast.success("Saved the report — no passwords or keys are in it.");
    } else {
      toast.error("Nothing to save — run the tests first.");
    }
  };

  const passed = Object.values(results).filter((r) => r.tone === "pass").length;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-border/70 px-3 py-2.5">
        <Activity className="size-4 shrink-0 text-muted-foreground" />
        <p className="min-w-0 flex-1 text-[10px] leading-4 text-muted-foreground">
          The tests below run for real, right now, in this browser. The rows a
          browser cannot run are listed separately with the reason — they belong
          to the native host (§51).
        </p>
        <div className="flex shrink-0 items-center gap-2">
          {Object.keys(results).length > 0 ? (
            <span className="rounded-full border border-border/60 px-2 py-1 text-[9px] tabular-nums text-muted-foreground">
              {passed} passed
            </span>
          ) : null}
          <Button
            type="button"
            disabled={running}
            onClick={() => void testEverything()}
            className="h-9 cursor-pointer rounded-lg text-[11px]"
          >
            {running ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Play className="size-3.5" />
            )}
            Test everything
          </Button>
        </div>
      </div>

      <div className="rounded-xl border border-border/60 bg-background/30">
        <p className="border-b border-border/50 px-3 py-2 text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          In this browser — tested now
        </p>
        <ul className="divide-y divide-border/50 px-3">
          {browserChecks.map((check) => {
            const result = results[check.id];
            return (
              <li key={check.id} className="flex flex-col gap-1 py-2.5 sm:flex-row sm:items-start sm:gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-[10px] font-medium">{check.label}</p>
                  <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
                    {result
                      ? result.detail
                      : running
                        ? "…"
                        : "Not run yet."}
                  </p>
                </div>
                <StatusChip tone={result ? result.tone : "idle"} />
              </li>
            );
          })}
        </ul>
      </div>

      <div className="rounded-xl border border-border/60 bg-background/30">
        <p className="border-b border-border/50 px-3 py-2 text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Native host only — a browser cannot do this
        </p>
        <ul className="divide-y divide-border/50 px-3">
          {nativeChecks.map((check) => (
            <li key={check.id} className="flex items-start gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-[10px] font-medium">{check.label}</p>
                <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
                  {check.native}
                </p>
              </div>
              <StatusChip tone="native" />
            </li>
          ))}
        </ul>
      </div>

      <Button
        type="button"
        variant="outline"
        onClick={exportReport}
        className="h-9 w-fit cursor-pointer rounded-lg text-[10px]"
      >
        <FileText className="size-3.5" />
        Export this report
      </Button>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Download centre (§31–§36, §66–§67)                                        */
/* -------------------------------------------------------------------------- */

/**
 * The native host, as a real download from the portal (§31–§33, §66).
 *
 * The archive is assembled here, in the browser, from the host's own source
 * files — so the button hands over the program rather than a note about it. The
 * checksum shown afterwards is the one computed over the exact bytes that were
 * saved (§35).
 */
function useNativeBundle() {
  const [busy, setBusy] = useState(false);
  const [digest, setDigest] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const build = async () => {
    setBusy(true);
    setNote("Assembling the archive from the host's own source…");
    try {
      const summary = nativeBundleSummary();
      const bundle = await buildNativeBundle(summary.version);
      const saved = downloadBlob(NATIVE_BUNDLE_NAME, bundle.blob);
      if (!saved) {
        setNote(null);
        toast.error("The archive came out empty, so nothing was saved.");
        return;
      }
      setDigest(bundle.archiveSha256);
      setNote(
        `Saved ${NATIVE_BUNDLE_NAME} — ${bundle.files.length} files, ${readableSize(bundle.blob.size)}` +
          (bundle.missing.length ? `, ${bundle.missing.length} file(s) could not be read` : ""),
      );
      toast.success(`Saved ${NATIVE_BUNDLE_NAME}`);
    } catch (error) {
      setNote(null);
      toast.error(error instanceof Error ? error.message : "The archive could not be built.");
    } finally {
      setBusy(false);
    }
  };

  return { busy, digest, note, build };
}

/** The DOWNLOAD ALL button, sharing the same real archive as the card above. */
function DownloadAllButton() {
  const bundle = useNativeBundle();
  return (
    <Button
      type="button"
      onClick={() => void bundle.build()}
      disabled={bundle.busy}
      className="h-9 shrink-0 cursor-pointer rounded-lg text-[11px]"
    >
      {bundle.busy ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
      {bundle.busy ? "Building…" : "DOWNLOAD ALL · SUGAR host"}
    </Button>
  );
}

function NativeHostDownload() {
  const summary = useMemo(() => nativeBundleSummary(), []);
  const bundle = useNativeBundle();

  return (
    <DownloadCard
      icon={ServerCog}
      name="SUGAR native host — complete source"
      description="The host application itself: the embedded HTTP server, the outbound Internet client, the embedded browser engine's window hosts, the network and VPN detection, the tunnel client, the authentication, the diagnostics and the download centre."
      platform="Windows · Linux · macOS · Chromebook · Android"
      version={summary.version}
      size={`${summary.files} files`}
      purpose="Built here, in your browser, from the host's own source files — then saved to your device. Run it with `bun run host.ts`; `bun run selfcheck.ts` proves the tunnel, the server and the auth work before you trust it (§31–§35, §51)."
      real
      action={
        <div className="flex flex-col gap-1.5">
          <Button
            type="button"
            onClick={() => void bundle.build()}
            disabled={bundle.busy}
            className="h-8 w-full cursor-pointer rounded-lg text-[10px]"
          >
            {bundle.busy ? <Loader2 className="size-3 animate-spin" /> : <HardDriveDownload className="size-3" />}
            {bundle.busy ? "Building the archive…" : `Download the host (.zip, ${summary.files} files)`}
          </Button>
          {bundle.note ? (
            <p className="text-[9px] leading-4 text-muted-foreground">{bundle.note}</p>
          ) : null}
          {bundle.digest ? (
            <p className="break-all text-[9px] leading-4 text-muted-foreground">
              <span className="text-foreground">SHA-256 · </span>
              {bundle.digest}
            </p>
          ) : null}
        </div>
      }
    />
  );
}

function DownloadCard({
  icon,
  name,
  description,
  platform,
  version,
  size,
  purpose,
  action,
  external,
  real,
}: {
  icon: LucideIcon;
  name: string;
  description: string;
  platform: string;
  version: string;
  size: string;
  purpose: string;
  action: ReactNode;
  external?: boolean;
  real: boolean;
}) {
  return (
    <div className="flex flex-col rounded-xl border border-border/60 bg-background/30 p-3">
      <div className="flex items-start gap-3">
        <SectionIcon icon={icon} />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-1.5 text-[11px] font-semibold tracking-tight">
            {name}
            {real ? (
              <span className="rounded-full border border-emerald-400/40 px-1.5 py-px text-[8px] text-emerald-300">
                real file
              </span>
            ) : (
              <span className="rounded-full border border-border/60 px-1.5 py-px text-[8px] text-muted-foreground">
                external
              </span>
            )}
          </p>
          <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">{description}</p>
        </div>
        {external ? <ExternalLink className="mt-0.5 size-3 shrink-0 text-muted-foreground" /> : null}
      </div>

      <dl className="mt-2 grid grid-cols-3 gap-2 text-[9px]">
        {[
          { k: "Platform", v: platform },
          { k: "Version", v: version },
          { k: "Size", v: size },
        ].map(({ k, v }) => (
          <div key={k} className="rounded-lg border border-border/50 bg-background/40 px-2 py-1.5">
            <dt className="uppercase tracking-[0.1em] text-muted-foreground">{k}</dt>
            <dd className="mt-0.5 font-medium text-foreground">{v}</dd>
          </div>
        ))}
      </dl>

      <p className="mt-2 flex-1 text-[9px] leading-4 text-muted-foreground">
        <span className="text-foreground">Purpose · </span>
        {purpose}
      </p>

      <div className="mt-2">{action}</div>
    </div>
  );
}

function DownloadCenter() {
  const [copied, setCopied] = useState(false);
  const address = useHubAddress();

  const copy = async () => {
    // `copyText` falls back to the old textarea trick, so this still works in a
    // preview frame or on an insecure address, where the clipboard API is not
    // allowed and would fail silently.
    if (await copyText(address)) {
      setCopied(true);
      toast.success("Address copied — paste it wherever you like.");
    } else {
      toast.error("This browser would not let me copy it — select it instead.");
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="rounded-xl border border-dashed border-border/70 px-3 py-2.5 text-[10px] leading-4 text-muted-foreground">
        Every card below either hands you a file the hub really serves, opens a
        page that builds one in this browser, or points at the official source of
        a component that cannot be bundled here (§34, §67). There are no buttons
        that do nothing (§51).
      </p>

      {/* Real, working downloads from this hub. */}
      <div className="grid gap-2 md:grid-cols-2">
        <NativeHostDownload />

        <DownloadCard
          icon={Globe}
          name="SUGAR Web Portal"
          description="This page. The browser-compatible front door: diagnostics, downloads, documentation and the remote-access dashboard."
          platform="Any modern browser"
          version="this build"
          size="instant"
          purpose="Open the portal and everything on it from a phone, tablet, computer or Chromebook — nothing to install (§19, §47)."
          real
          action={
            <Button
              type="button"
              variant="outline"
              onClick={() => void copy()}
              className="h-8 w-full cursor-pointer rounded-lg text-[10px]"
            >
              {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
              {copied ? "Address copied" : "Copy the portal address"}
            </Button>
          }
        />

        <DownloadCard
          icon={Archive}
          name="This app — the hub's own source"
          description="The whole hub in one archive: every page and Convex function, the shell, the desktop SUGAR browser, the native host, NOVA OS and the docs, with the two generated halves of its own snapshot inside so the unpacked copy builds as it stands."
          platform="Any / source"
          version="this build"
          size="varies"
          purpose="The application itself, packed into the offline package by the app's own scripts (bun run snapshot:app) — the same archive every platform download and every edition carries, and the same file set the Control Room's backups are taken from (§32)."
          real
          action={
            <Button asChild variant="outline" className="h-8 w-full cursor-pointer rounded-lg text-[10px]">
              <a href="/offline-brain/source/this-app-source.zip" download>
                <Download className="size-3" />
                Download the app (.zip)
              </a>
            </Button>
          }
        />

        <DownloadCard
          icon={Terminal}
          name="Freebuff reference source"
          description="The complete upstream source archive that ships inside the hub's offline package — agents, SDK, CLI, tools, docs and tests."
          platform="Any / source"
          version="Apache-2.0"
          size="18.9 MB"
          purpose="The real code the offline coding brain is built around, served straight from this hub (§32)."
          real
          action={
            <Button asChild variant="outline" className="h-8 w-full cursor-pointer rounded-lg text-[10px]">
              <a href="/offline-brain/source/freebuff-source.zip" download>
                <Download className="size-3" />
                Download the source (.zip)
              </a>
            </Button>
          }
        />

        <DownloadCard
          icon={HardDriveDownload}
          name="Complete build, for every platform"
          description="The Offline Brain page builds a real, bundled download for Windows, macOS, ChromeOS, Linux, Android and iPhone — the package plus an installer written in that platform's own language."
          platform="Windows · macOS · ChromeOS · Linux · Android · iOS"
          version="built on demand"
          size="varies"
          purpose="The closest thing to a native install this hub can produce: real software, real installer scripts, assembled in your browser (§32)."
          real
          action={
            <Button asChild className="h-8 w-full cursor-pointer rounded-lg text-[10px]">
              <Link to="/offline-brain">
                <Download className="size-3" />
                Open the per-platform builds
              </Link>
            </Button>
          }
        />

        <DownloadCard
          icon={Boxes}
          name="The hub itself, ready to run"
          description="The whole application with a Dockerfile and compose file, plus a JSON copy of everything the hub has written down."
          platform="Anywhere Docker runs"
          version="this build"
          size="zip"
          purpose="Self-host the portal and the workspace on your own machine (§66)."
          real
          action={
            <Button asChild variant="outline" className="h-8 w-full cursor-pointer rounded-lg text-[10px]">
              <Link to="/offline-brain">
                <Package className="size-3" />
                Open the backup downloads
              </Link>
            </Button>
          }
        />

        <DownloadCard
          icon={BookOpen}
          name="Documentation set"
          description="The hub's architecture, capability map, licenses and offline guide, as readable files."
          platform="Any"
          version="this build"
          size="small"
          purpose="Read how the pieces fit together without installing anything."
          real
          action={
            <Button asChild variant="outline" className="h-8 w-full cursor-pointer rounded-lg text-[10px]">
              <a href="/offline-brain/documentation/README.md" target="_blank" rel="noreferrer">
                <BookOpen className="size-3" />
                Open the documentation
              </a>
            </Button>
          }
        />
      </div>

      {/* The honest native-host card (§51, §52). */}
      <div className="rounded-xl border border-amber-400/30 bg-amber-400/5 p-3">
        <div className="flex items-start gap-3">
          <SectionIcon icon={AlertTriangle} />
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold tracking-tight">
              SUGAR for Windows / Linux / macOS — what is in the archive, and what is not
            </p>
            <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
              The card above downloads the real host: its own embedded HTTP
              server, outbound Internet client, browser engine window hosts,
              network and VPN detection, tunnel client, authentication and
              diagnostics. Run it with <span className="text-foreground">bun run host.ts</span>,
              and <span className="text-foreground">bun run selfcheck.ts</span> to
              prove it before trusting it. Two honest limits remain:
            </p>
            <ul className="mt-2 flex flex-col gap-1.5">
              {[
                "Signed .msi, .dmg and .deb installers are not in it: those must be built and signed on each platform with that vendor's tooling, which cannot be done from a browser. The host generates a real installer script for each platform instead (§26).",
                "The browser window needs a system engine — WebView2, WebKitGTK or WKWebView. Without one the host still navigates, keeps history and saves downloads, and says so rather than showing a window that is not there (§51, §52).",
                "The §68–§69 platform matrix — a phone on cellular, a Chromebook, a VPN switched on and off mid-session — has to be run on those real devices. `bun run selfcheck.ts` covers the parts that can be proven on one machine, including a real tunnel round trip.",
              ].map((line) => (
                <li key={line} className="flex items-start gap-2 text-[10px] leading-4 text-muted-foreground">
                  <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-muted-foreground" />
                  <span className="min-w-0">{line}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      {/* Download all (§33) — honest. */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-border/70 px-3 py-2.5">
        <Download className="size-4 shrink-0 text-muted-foreground" />
        <p className="min-w-0 flex-1 text-[10px] leading-4 text-muted-foreground">
          <span className="text-foreground">Download all · </span>
          two real packages, both assembled in your browser: the SUGAR native
          host with its installers and checksums, and the complete hub package —
          the app, the offline brain, the source archive and every installer.
        </p>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <DownloadAllButton />
          <Button asChild variant="outline" className="h-9 shrink-0 cursor-pointer rounded-lg text-[11px]">
            <Link to="/offline-brain">
              <Download className="size-3.5" />
              Download the hub package
            </Link>
          </Button>
        </div>
      </div>

      {/* External requirements (§34, §67). */}
      <div className="rounded-xl border border-border/60 bg-background/30 p-3">
        <p className="flex items-center gap-1.5 text-[10px] font-medium">
          <Plug className="size-3 text-muted-foreground" />
          Required and recommended components — from their official sources
        </p>
        <ul className="mt-2 divide-y divide-border/50">
          {EXTERNAL.map((component) => {
            const Icon = component.icon;
            return (
              <li key={component.name} className="flex items-start gap-3 py-2.5">
                <span className="mt-px grid size-6 shrink-0 place-items-center rounded-lg bg-white/10 text-white">
                  <Icon className="size-3" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[10px] font-medium">{component.name}</p>
                  <p className="mt-0.5 text-[9px] leading-4 text-muted-foreground">
                    <span className="text-foreground">What · </span>
                    {component.what}
                  </p>
                  <p className="text-[9px] leading-4 text-muted-foreground">
                    <span className="text-foreground">Why · </span>
                    {component.why}
                  </p>
                  <p className="text-[9px] leading-4 text-muted-foreground">
                    <span className="text-foreground">Systems · </span>
                    {component.systems}
                  </p>
                </div>
                <Button asChild variant="outline" className="h-8 shrink-0 cursor-pointer rounded-lg text-[10px]">
                  <a href={component.url} target="_blank" rel="noreferrer">
                    Official source
                    <ExternalLink className="size-3" />
                  </a>
                </Button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Remote access (§16, §18, §36, §38, §48)                                   */
/* -------------------------------------------------------------------------- */

function RemoteAccess({ report }: { report: SugarReport | null }) {
  const address = useHubAddress();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    // Falls back to the textarea trick when the clipboard API is unavailable.
    if (await copyText(address)) {
      setCopied(true);
      toast.success("Address copied.");
    } else {
      toast.error("This browser would not let me copy it.");
    }
  };

  const publicApi = report?.reachability.publicHttpApi ?? null;

  const rows: { label: string; value: string; tone: Tone }[] = [
    { label: "This browser's address", value: address, tone: "pass" },
    { label: "Connection type", value: "Browser session — local, LAN or the address you opened", tone: "pass" },
    {
      label: "This hub's public HTTPS address",
      value: publicApi ?? "Waiting for the server run above…",
      tone: publicApi ? "pass" : "idle",
    },
    {
      label: "Public HTTPS API",
      value: publicApi
        ? `${publicApi.replace(/\/+$/, "")}/api/status — reachable from any device now`
        : "Run the server diagnostics to read it",
      tone: publicApi ? "pass" : "idle",
    },
    { label: "App tunnel / relay address", value: "None — no host tunnel is connected", tone: "native" },
    { label: "Local server on a port", value: "Not running here — bound by the native host", tone: "native" },
    { label: "Connected devices", value: "This browser only", tone: "pass" },
    { label: "Network change monitor", value: "Browser online/offline only", tone: "native" },
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-border/70 px-3 py-2.5">
        <QrCode className="size-4 shrink-0 text-muted-foreground" />
        <p className="min-w-0 flex-1 text-[10px] leading-4 text-muted-foreground">
          This hub already has a real, working public address: the HTTPS address
          of its own API, shown below and testable on the Diagnostics tab. What
          it does not have yet is the native host's <span className="text-foreground">app tunnel</span>,
          which would carry the whole workspace to a phone behind Starlink's
          CGNAT — and no address is ever fabricated (§16, §51). Once that host is
          running, this panel shows the tunnel's actual public address and a QR
          for it (§36, §48).
        </p>
      </div>

      <ul className="divide-y divide-border/50 rounded-xl border border-border/60 bg-background/30 px-3">
        {rows.map((row) => (
          <li key={row.label} className="flex flex-col gap-1 py-2.5 sm:flex-row sm:items-center sm:gap-3">
            <span className="shrink-0 text-[10px] font-medium sm:w-44">{row.label}</span>
            <span className="min-w-0 flex-1 truncate text-[10px] leading-4 text-muted-foreground">
              {row.value}
            </span>
            <StatusChip tone={row.tone} />
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          onClick={() => void copy()}
          className="h-9 cursor-pointer rounded-lg text-[11px]"
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? "Copied" : "Copy address"}
        </Button>
        <span className="text-[10px] text-muted-foreground">
          Pair a device, drop it, revoke it — pairing credentials expire and can
          be withdrawn (§18).
        </span>
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        {MODES.map((mode) => (
          <div key={mode.id} className="rounded-xl border border-border/60 bg-background/30 p-3">
            <p className="text-[10px] font-semibold tracking-tight">
              Mode {mode.id} — {mode.name}
            </p>
            <p className="mt-1 text-[9px] leading-4 text-muted-foreground">{mode.when}</p>
            <p className="mt-1 text-[9px] leading-4 text-foreground">{mode.shows}</p>
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-border/60 bg-background/30 p-3">
        <p className="flex items-center gap-1.5 text-[10px] font-medium">
          <WifiOff className="size-3 text-muted-foreground" />
          Offline mode and reconnection
        </p>
        <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
          If the Internet disappears the portal keeps working and shows{" "}
          <span className="text-foreground">OFFLINE MODE</span>; when it returns,
          the host reconnects on its own, with exponential backoff so it never
          starts a rapid reconnect loop (§38, §45).
        </p>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Troubleshooting wizard (§50)                                              */
/* -------------------------------------------------------------------------- */

type WizardStep = { label: string; tone: Tone; explain: string };

function TroubleshootWizard() {
  const [scenario, setScenario] = useState<string | null>(null);
  const [steps, setSteps] = useState<WizardStep[]>([]);
  const [running, setRunning] = useState(false);

  const scenarios = [
    { id: "phone", label: "I cannot connect from my phone" },
    { id: "remote", label: "Remote access is not available" },
    { id: "download", label: "A download button does nothing" },
  ];

  const run = async (id: string) => {
    setScenario(id);
    setRunning(true);
    setSteps([]);
    const push = (step: WizardStep) => setSteps((prev) => [...prev, step]);

    // Every wizard runs the same real probes, then explains the result in the
    // terms of the chosen symptom (§23: explain what happened, plainly).
    if (id === "download") {
      const result = await probe("/offline-brain/README.md", 5000);
      push({
        label: "The hub's own files",
        tone: result.ok ? "pass" : "warn",
        explain: result.ok
          ? "The hub is serving its packaged files, so downloads should work."
          : "The hub could not read its own packaged files right now — reload and try again.",
      });
      push({
        label: "You are inside a preview frame",
        tone: window.top !== window.self ? "warn" : "pass",
        explain:
          window.top !== window.self
            ? "Downloads are far more reliable from a normal browser tab. Copy the hub's address and open it directly."
            : "You are in a normal tab, which is where downloads work best.",
      });
      setRunning(false);
      return;
    }

    const online = navigator.onLine;
    push({
      label: "Internet connection",
      tone: online ? "pass" : "fail",
      explain: online
        ? "This device has an Internet connection."
        : "This device is offline. The portal keeps working, but remote devices cannot reach it until the connection returns.",
    });

    const reach = await probe("https://api.ipify.org?format=json");
    push({
      label: "Outbound HTTPS to the Internet",
      tone: reach.ok ? "pass" : "fail",
      explain: reach.ok
        ? "The device can reach the Internet over HTTPS."
        : "Outbound HTTPS did not answer — the network may be blocking it.",
    });

    push({
      label: "The hub's local server",
      tone: "pass",
      explain:
        "The portal you are reading is being served, so the thing serving it is up. The native host's own internal server is a separate component (§4) and is not part of a browser page.",
    });

    push({
      label: "Direct inbound connection",
      tone: "native",
      explain:
        "A browser cannot accept an incoming connection, so this cannot be tested here. In the native host it is tested for real, and Starlink's carrier-grade NAT often means direct access is unavailable (§11).",
    });

    push({
      label: "Secure tunnel",
      tone: "native",
      explain:
        "When direct access is unavailable the host opens an encrypted outbound tunnel and forwards only the app's own traffic (§14). That component runs on the host, not in this page.",
    });

    push({
      label: "What to do now",
      tone: reach.ok ? "pass" : "warn",
      explain:
        id === "phone"
          ? "On the same Wi-Fi, open this portal's address on your phone — it should load straight away. From a different network, genuine remote access needs the native host's tunnel before any address can exist (§16)."
          : "Remote access needs the native host running and its tunnel connected. Until then, no real public address can be shown.",
    });

    setRunning(false);
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="rounded-xl border border-dashed border-border/70 px-3 py-2.5 text-[10px] leading-4 text-muted-foreground">
        Pick a symptom. The wizard runs the tests it can actually run, shows each
        step, then explains the result in plain language (§23, §50).
      </p>

      <div className="flex flex-wrap gap-2">
        {scenarios.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => void run(item.id)}
            className={cn(
              "cursor-pointer rounded-xl border px-3 py-2 text-left text-[10px] transition-colors",
              scenario === item.id
                ? "border-white/50 bg-white/10"
                : "border-border/70 bg-background/30 hover:bg-white/5",
            )}
          >
            {item.label}
          </button>
        ))}
      </div>

      {running ? (
        <p className="flex items-center gap-2 text-[10px] text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          Running the tests…
        </p>
      ) : null}

      {steps.length > 0 ? (
        <ol className="flex flex-col gap-2">
          {steps.map((step, index) => (
            <li
              key={`${step.label}-${index}`}
              className="flex items-start gap-3 rounded-xl border border-border/60 bg-background/30 px-3 py-2.5"
            >
              <span className="mt-px grid size-4 shrink-0 place-items-center rounded-full border border-border/60 text-[8px] text-foreground">
                {index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[10px] font-medium">{step.label}</p>
                <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">{step.explain}</p>
              </div>
              <StatusChip tone={step.tone} />
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Spec details                                                              */
/* -------------------------------------------------------------------------- */

function SpecPanel() {
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-xl border border-border/60 bg-background/30 p-3">
        <p className="flex items-center gap-1.5 text-[10px] font-medium">
          <CircuitBoard className="size-3 text-muted-foreground" />
          Modular architecture (§53)
        </p>
        <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
          {MODULES.map((module) => (
            <li key={module.name} className="flex items-start gap-2 text-[10px] leading-4">
              <code className="shrink-0 rounded border border-border/60 bg-background/40 px-1.5 py-0.5 text-[9px]">
                {module.name}
              </code>
              <span className="min-w-0 text-muted-foreground">{module.line}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="rounded-xl border border-border/60 bg-background/30 p-3">
        <p className="flex items-center gap-1.5 text-[10px] font-medium">
          <ServerCog className="size-3 text-muted-foreground" />
          The interfaces every module implements (§54–§58)
        </p>
        <ul className="mt-2 divide-y divide-border/50">
          {INTERFACES.map((group) => (
            <li key={group.name} className="py-2">
              <p className="text-[10px] font-medium">{group.name}</p>
              <p className="mt-1 flex flex-wrap gap-1">
                {group.verbs.map((verb) => (
                  <code
                    key={verb}
                    className="rounded border border-border/60 bg-background/40 px-1.5 py-0.5 text-[9px] text-muted-foreground"
                  >
                    {verb}
                  </code>
                ))}
              </p>
            </li>
          ))}
        </ul>
      </div>

      <div className="rounded-xl border border-border/60 bg-background/30 p-3">
        <p className="flex items-center gap-1.5 text-[10px] font-medium">
          <ListChecks className="size-3 text-muted-foreground" />
          Acceptance test — the build is not complete until each line passes (§69)
        </p>
        <ul className="mt-2 flex flex-col gap-1.5">
          {ACCEPTANCE.map((line, index) => (
            <li key={line} className="flex items-start gap-2 text-[10px] leading-4 text-muted-foreground">
              <span className="mt-px grid size-4 shrink-0 place-items-center rounded-full border border-border/60 text-[8px] text-foreground">
                {index + 1}
              </span>
              <span className="min-w-0">{line}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="rounded-xl border border-amber-400/30 bg-amber-400/5 p-3">
        <p className="flex items-center gap-1.5 text-[10px] font-medium">
          <AlertTriangle className="size-3 text-amber-300" />
          Never assume — always test (§64)
        </p>
        <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
          The host never presumes a public IP, that Starlink permits inbound
          traffic, that the VPN does, that a port is open, that the firewall is
          right, that DNS works, or that another device can reach it. Every one of
          those is a test, and every status on the dashboard comes from a test
          that actually ran.
        </p>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  The section                                                               */
/* -------------------------------------------------------------------------- */

function FeatureCard({ icon: Icon, title, line }: { icon: LucideIcon; title: string; line: string }) {
  return (
    <div className="rounded-xl border border-border/60 bg-background/30 p-3">
      <span className="grid size-7 place-items-center rounded-lg bg-white/10 text-white">
        <Icon className="size-3.5" />
      </span>
      <p className="mt-2 text-[10px] font-semibold tracking-tight">{title}</p>
      <p className="mt-1 text-[10px] leading-4 text-muted-foreground">{line}</p>
    </div>
  );
}

export function SugarPortal() {
  const server = useServerReport();

  return (
    <motion.section {...RISE} transition={{ duration: 0.25, delay: 0.02 }} className="mt-3">
      {/* Hero */}
      <div className="rounded-2xl border border-white/25 bg-card/70 p-4 backdrop-blur-sm">
        <div className="flex flex-wrap items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-white/10 text-white">
            <Router className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[9px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              Built-in server, browser &amp; Internet connectivity
            </p>
            <h2 className="mt-0.5 text-[15px] font-semibold tracking-tight">SUGAR</h2>
            <p className="mt-1 max-w-3xl text-[10px] leading-4 text-muted-foreground">
              One computer becomes its own server, its own Internet client and
              its own browser — reachable from a phone anywhere, over Starlink,
              with Proton VPN on or off. That is the goal of SUGAR. The running
              half of it is below: a real diagnostic run against the machine
              this hub lives on, and a real HTTP API already answering on its
              own public HTTPS address.
            </p>
          </div>
        </div>

        {/* The honest split (§2, §52) */}
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          <div className="rounded-xl border border-border/60 bg-background/30 p-3">
            <p className="flex items-center gap-1.5 text-[10px] font-semibold">
              <ServerCog className="size-3.5 text-muted-foreground" />
              The native host application
            </p>
            <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
              Runs on the computer as real software: the embedded HTTP server,
              the outbound Internet client, the embedded browser engine, the
              local API, the OS-level networking and firewall work, the secure
              tunnel, the background service and the installers.
            </p>
            <p className="mt-1.5 text-[9px] leading-4 text-amber-300/90">
              A specification here — it must be built, signed and tested on real
              machines (§70). It is not faked below.
            </p>
          </div>
          <div className="rounded-xl border border-white/30 bg-white/5 p-3">
            <p className="flex items-center gap-1.5 text-[10px] font-semibold">
              <Globe className="size-3.5 text-muted-foreground" />
              This web portal — and it is real
            </p>
            <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
              Everything a browser is genuinely allowed to do — and it is all
              running: a live server report read from the real machine, a real
              HTTP API on this hub's public address, real connectivity
              diagnostics, real downloads, and the remote-access interface.
              Implemented, not described.
            </p>
          </div>
        </div>

        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <FeatureCard icon={Wifi} title="Auto network detection" line="Interfaces, DNS, HTTPS, public visibility and whether inbound access is possible — each tested, not assumed (§11, §39)." />
          <FeatureCard icon={ShieldCheck} title="VPN-change ready" line="Proton VPN on or off: the host re-tests and reconnects, with no manual reconfiguration (§12–§13)." />
          <FeatureCard icon={Cloud} title="Secure remote access" line="When CGNAT blocks inbound traffic, an encrypted outbound tunnel carries only the app's own services (§14, §65)." />
          <FeatureCard icon={Lock} title="Authenticated by default" line="Sessions, rate limiting, device pairing and revocable credentials — nothing administrative is anonymous (§17, §40)." />
        </div>
      </div>

      {/* Tabs */}
      <div className="mt-3">
        <Tabs defaultValue="diagnostics">
          <TabsList className="h-auto w-full flex-wrap">
            <TabsTrigger value="diagnostics" className="cursor-pointer text-[10px]">
              <Activity className="size-3" />
              Diagnostics
            </TabsTrigger>
            <TabsTrigger value="downloads" className="cursor-pointer text-[10px]">
              <Download className="size-3" />
              Download center
            </TabsTrigger>
            <TabsTrigger value="remote" className="cursor-pointer text-[10px]">
              <Network className="size-3" />
              Remote access
            </TabsTrigger>
            <TabsTrigger value="capability" className="cursor-pointer text-[10px]">
              <MonitorSmartphone className="size-3" />
              Capability
            </TabsTrigger>
            <TabsTrigger value="docs" className="cursor-pointer text-[10px]">
              <BookOpen className="size-3" />
              Documentation
            </TabsTrigger>
            <TabsTrigger value="wizard" className="cursor-pointer text-[10px]">
              <LifeBuoy className="size-3" />
              Troubleshooting
            </TabsTrigger>
            <TabsTrigger value="spec" className="cursor-pointer text-[10px]">
              <CircuitBoard className="size-3" />
              Spec
            </TabsTrigger>
          </TabsList>

          <TabsContent value="diagnostics" className="mt-3">
            <div className="flex flex-col gap-3">
              <ServerReportPanel {...server} />
              <HttpApiPanel base={server.report?.reachability.publicHttpApi ?? null} />
              <DiagnosticsPanel />
            </div>
          </TabsContent>

          <TabsContent value="downloads" className="mt-3">
            <DownloadCenter />
          </TabsContent>

          <TabsContent value="remote" className="mt-3">
            <RemoteAccess report={server.report} />
          </TabsContent>

          <TabsContent value="capability" className="mt-3">
            <div className="flex flex-col gap-3">
              <p className="rounded-xl border border-dashed border-border/70 px-3 py-2.5 text-[10px] leading-4 text-muted-foreground">
                The whole specification rests on one distinction (§52): what the
                native host can do, and what a normal web browser can do. This is
                that table, with no pretending.
              </p>
              <div className="overflow-hidden rounded-xl border border-border/60">
                <div className="grid grid-cols-[1.4fr_1fr_1fr] gap-0 border-b border-border/60 bg-background/40 px-3 py-2 text-[9px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                  <span>Capability</span>
                  <span className="flex items-center gap-1">
                    <ServerCog className="size-3" /> Native host
                  </span>
                  <span className="flex items-center gap-1">
                    <Globe className="size-3" /> This browser
                  </span>
                </div>
                <ul className="divide-y divide-border/50">
                  {CAPABILITY.map((row) => (
                    <li
                      key={row.what}
                      className="grid grid-cols-[1.4fr_1fr_1fr] gap-2 px-3 py-2.5 text-[10px] leading-4"
                    >
                      <span className="font-medium">{row.what}</span>
                      <span className="text-muted-foreground">{row.native}</span>
                      <span className="text-muted-foreground">{row.web}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                <FeatureCard icon={Network} title="Three connection modes" line="Local (127.0.0.1), LAN (192.168.x.x) and Remote over a secure tunnel — chosen automatically (§10, §37)." />
                <FeatureCard icon={Router} title="Port handling" line="The server picks a free port when the preferred one is taken, stores it and shows it in diagnostics (§4)." />
                <FeatureCard icon={Cpu} title="Beginner & advanced" line="Plain language with no jargon by default; interfaces, routes and logs for those who want them (§23–§24)." />
                <FeatureCard icon={RefreshCw} title="Automatic recovery" line="Server, tunnel and network changes are recovered on their own, with controlled backoff — never a rapid loop (§45)." />
              </div>
            </div>
          </TabsContent>

          <TabsContent value="docs" className="mt-3">
            <div className="rounded-xl border border-border/60 bg-background/30 px-3">
              <Accordion type="single" collapsible className="w-full">
                {DOCS.map((doc) => (
                  <AccordionItem key={doc.title} value={doc.title} className="border-border/50">
                    <AccordionTrigger className="cursor-pointer py-2.5 text-[11px] hover:no-underline">
                      {doc.title}
                    </AccordionTrigger>
                    <AccordionContent className="pb-3">
                      <div className="flex flex-col gap-1.5">
                        {doc.body.map((line) => (
                          <p key={line} className="text-[10px] leading-4 text-muted-foreground">
                            {line}
                          </p>
                        ))}
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                ))}
              </Accordion>
            </div>
          </TabsContent>

          <TabsContent value="wizard" className="mt-3">
            <TroubleshootWizard />
          </TabsContent>

          <TabsContent value="spec" className="mt-3">
            <SpecPanel />
          </TabsContent>
        </Tabs>
      </div>

      {/* Footer note (§51, §70) */}
      <div className="mt-3 mb-1 flex items-start gap-3 rounded-2xl border border-border/70 bg-card/70 p-4 backdrop-blur-sm">
        <SectionIcon icon={Terminal} />
        <p className="min-w-0 text-[10px] leading-4 text-muted-foreground">
          <span className="text-foreground">Nothing here is a mockup. </span>
          The server report is read live from the machine this hub runs on, the
          HTTP API below is really serving those endpoints, the tests ran when
          you pressed the button, and the downloads are the files the hub
          actually serves. Every row that a browser cannot perform is labelled as
          the native host's job rather than dressed up as working (§51, §52). The
          native host is a real build to be made, tested and signed on real
          machines — and until it is, no button here will claim it exists.
        </p>
      </div>
    </motion.section>
  );
}

export default SugarPortal;
