/**
 * §27 the start-up sequence, §28 the optional background service, §63 the result.
 *
 * This is the program. Run it and the host: detects the operating system, starts
 * its own HTTP server on a free port, starts the browser subsystem, tests the
 * Internet, detects the VPN, checks the firewall, opens the tunnel if the network
 * needs one, and prints the address the dashboard is on.
 *
 * There is no step in which the user installs a web server, and no step in which
 * they open a browser before anything works. The server is inside this process,
 * and the browser engine is the one the operating system already has.
 *
 *   bun run host.ts                     # normal start
 *   bun run host.ts --port 8123         # ask for a particular port
 *   bun run host.ts --relay https://…   # use a relay for remote access
 *   bun run host.ts --diagnostics       # run everything and exit
 *   bun run host.ts --service           # the background service (§28)
 */

import { SugarApp } from "./core/app.ts";
import { config } from "./storage/config.ts";
import { log } from "./core/log.ts";
import { RELEASE, versionLine } from "./core/version.ts";
import { firstRunLine } from "./ui/portal.ts";
import { remoteDeviceSupport } from "./web-portal/index.ts";
import { createRelayServer } from "./tunnel/relay-server.ts";
import { rendererAvailability } from "./browser/webview.ts";

type Options = {
  port: number | null;
  relay: string | null;
  secret: string | null;
  diagnostics: boolean;
  service: boolean;
  help: boolean;
  version: boolean;
  serveRelay: number | null;
};

function parse(args: string[]): Options {
  const options: Options = {
    port: null,
    relay: null,
    secret: null,
    diagnostics: false,
    service: false,
    help: false,
    version: false,
    serveRelay: null,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    switch (arg) {
      case "--port":
        options.port = Number(args[++i] ?? 0);
        break;
      case "--relay":
        options.relay = args[++i] ?? null;
        break;
      case "--secret":
        options.secret = args[++i] ?? null;
        break;
      case "--serve-relay":
        options.serveRelay = Number(args[++i] ?? 8443);
        break;
      case "--diagnostics":
      case "--test":
        options.diagnostics = true;
        break;
      case "--service":
        options.service = true;
        break;
      case "--version":
        options.version = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        if (arg.startsWith("--")) log.warn("application", `Ignoring an unknown option: ${arg}`);
    }
  }
  return options;
}

const HELP = `
SUGAR — built-in server, browser and Internet connectivity.

  bun run host.ts [options]

  --port <n>          Prefer this port; a free one is chosen if it is taken.
  --relay <url>       Use this relay for remote access when the network
                      cannot accept incoming connections.
  --secret <value>    The credential the relay expects, if it needs one.
  --diagnostics       Run TEST EVERYTHING and the SELF TEST, print the result,
                      and exit without starting the server.
  --service           Run as the background service: keep the server and the
                      tunnel alive, and reconnect on network changes (§28).
  --serve-relay <n>   Also run a relay on this machine, on port n. Useful when
                      this computer has a public address and can act as one.
  --version           Print the version and exit.
  --help              This text.
`;

async function runDiagnostics(): Promise<number> {
  const app = new SugarApp();
  await app.boot();
  const [everything, self] = await Promise.all([app.testEverything(), app.selfTest()]);
  log.echo = true;

  for (const report of [everything, self]) {
    console.log(`\n=== ${report.suite} ===`);
    for (const check of report.checks) {
      console.log(`  ${check.status.padEnd(4)}  ${check.name}`);
      console.log(`        ${check.explain}`);
      console.log(`        ${check.evidence}`);
    }
    console.log(`\n  ${report.summary}`);
  }

  await app.server.stop();
  return everything.failed + self.failed === 0 ? 0 : 1;
}

async function main(): Promise<number> {
  const options = parse(process.argv.slice(2));

  if (options.help) {
    console.log(HELP);
    return 0;
  }
  if (options.version) {
    console.log(versionLine());
    return 0;
  }

  if (options.port !== null) config.patch("network", { preferredPort: options.port });
  if (options.relay) config.patch("user", { relayUrl: options.relay });
  if (options.secret) process.env.SUGAR_RELAY_SECRET = options.secret;

  if (options.diagnostics) return await runDiagnostics();

  // §28 — the background service. The difference is not the code that runs; it
  // is that this one stays up, keeps the tunnel connected, and refuses to exit
  // on a signal until it has closed the server cleanly.
  if (options.service) {
    config.patch("server", { backgroundService: true });
    log.echo = true;
  }

  if (options.serveRelay !== null) {
    const relay = createRelayServer({
      publicBaseUrl: `http://127.0.0.1:${options.serveRelay}`,
      secret: options.secret,
      log: (message, detail) => log.info("tunnel", message, detail),
    });
    await new Promise<void>((resolve) => relay.listen(options.serveRelay as number, "0.0.0.0", () => resolve()));
    console.log(`Relay listening on port ${options.serveRelay}. Point the host at it with --relay.`);
  }

  console.log(`\n${versionLine()}\n`);

  const app = new SugarApp();
  const started = await app.boot();

  console.log("Start-up:");
  for (const step of started.sequence) {
    console.log(`  ${step.ok ? "✓" : "✗"} ${step.step}`);
    console.log(`      ${step.detail}`);
  }

  const renderer = rendererAvailability();
  console.log(`\n${firstRunLine(started.result)}`);
  console.log(`\n  Dashboard:  ${started.address ?? "the server did not start"}`);
  if (app.server.getLanAddress()) console.log(`  This network: ${app.server.getLanAddress()}`);
  if (started.publicUrl) {
    console.log(`  Remote:     ${started.publicUrl}`);
    console.log(`\n  Scan the QR on the Remote access tab, or open that address on any device:`);
    for (const device of remoteDeviceSupport()) console.log(`    ${device.device}`);
  } else {
    console.log(`  Remote:     not configured`);
    console.log(`\n  Why: ${app.networkStatus?.assessment.conclusion ?? "the network has not been measured"}`);
    console.log(`  To fix it, run a relay and pass its address:  bun run host.ts --relay <url>`);
  }
  if (!renderer.available) console.log(`\n  Browser window: ${renderer.reason}`);

  console.log(`\nVersion ${RELEASE.version}, build ${RELEASE.build}.`);

  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received — closing the server and the tunnel.`);
    app.monitor.stop();
    await app.tunnel?.disconnect();
    await app.server.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // A rejection that would otherwise take the host down silently takes it down
  // loudly instead, and the network monitor is what puts it back (§45).
  process.on("unhandledRejection", (reason) => {
    log.error("application", "An unhandled rejection reached the top level.", {
      reason: reason instanceof Error ? reason.message : String(reason),
    });
  });

  // The host owns the process lifetime: the server keeps the event loop alive,
  // so there is nothing to await here.
  return await new Promise<number>((resolve) => {
    process.on("beforeExit", () => resolve(0));
  });
}

main()
  .then((code) => {
    if (code !== 0) process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(`\nThe host could not start: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof Error && error.stack) console.error(error.stack);
    process.exitCode = 1;
  });
