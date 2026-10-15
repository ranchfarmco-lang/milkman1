/**
 * §60 Versioning.
 *
 * Every release carries a version, a build number, a date, the platform it was
 * built for, the architecture, a changelog and a checksum. The checksum is not
 * stored here — it is computed over the built artifact at package time and at
 * download time (`native/downloads/catalog.ts`), because a checksum written
 * next to the bytes it describes proves nothing.
 */

export type Release = {
  version: string;
  build: string;
  date: string;
  platform: NodeJS.Platform | "any";
  arch: string;
  notes: string[];
};

/** The running build. Bump `build` on every packaged artifact. */
export const RELEASE: Release = {
  version: "1.0.0",
  build: "2026.10.01.1",
  date: "2026-10-01",
  platform: "any",
  arch: process.arch,
  notes: [
    "Embedded HTTP server with automatic free-port selection.",
    "Embedded browser engine with history, cookies, downloads and TLS status.",
    "Outbound Internet client: HTTP/HTTPS/DNS/WebSocket, redirects, retries.",
    "Network, VPN, Starlink/CGNAT and inbound-reachability detection.",
    "Secure outbound tunnel/relay with a replaceable TunnelProvider.",
    "Session auth, brute-force lockout and expiring device pairing.",
    "Download centre with real files and real SHA-256 checksums.",
    "TEST EVERYTHING (15 checks) and SELF TEST (14 subsystems).",
    "Automatic recovery with exponential backoff.",
  ],
};

export const NAME = "SUGAR";

/** A single line, for logs and the API. */
export function versionLine(): string {
  return `${NAME} ${RELEASE.version} (build ${RELEASE.build}, ${RELEASE.date}, ${process.platform}/${process.arch}, node ${process.version})`;
}

export function changelog(): Release[] {
  return [RELEASE];
}
