/**
 * NOVA OS — the entry point.
 *
 * On the real image this file is what `/sbin/init` launches, and on a
 * development machine it is what `bun os/main.ts` runs. Both paths boot the same
 * `NovaSystem`, because an init that only existed on an image could not be
 * tested, and an untested init is the last thing to put on a machine.
 *
 * Flags:
 *   --diagnostics   boot, run every probe, print the report, exit.
 *   --audit         boot, run the requirement audit, print it, exit.
 *   --quiet         do not echo the log to stdout.
 */

import { log, osVersionLine, config, ensureOsPaths } from "./core/runtime.ts";
import { NovaSystem } from "./system.ts";

const argv = new Set(process.argv.slice(2));
log.echo = !argv.has("--quiet");

async function main(): Promise<void> {
  const system = new NovaSystem();

  console.log("");
  console.log("  " + osVersionLine());
  console.log("  state directory: " + ensureOsPaths().root);
  console.log("");

  const boot = await system.boot();
  for (const step of boot.sequence) {
    console.log(`  ${step.ok ? "ok  " : "FAIL"}  ${step.step.padEnd(28)} ${step.detail}`);
  }
  console.log("");

  const addresses = [boot.addresses.http, boot.addresses.https, boot.addresses.lan].filter(Boolean);
  console.log("  portal: " + (addresses.length ? addresses.join("   ") : "not listening"));
  const web = config.get("web");
  console.log(`  web service configured for http ${web.httpPort} / https ${web.httpsPort}`);
  console.log("");

  console.log("  requirement audit");
  console.log(`  ${boot.audit.verdict}`);
  console.log(
    `  implemented ${boot.audit.byStatus.implemented} · partial ${boot.audit.byStatus.partial} · blocked ${boot.audit.byStatus.blocked} · total ${boot.audit.total}`,
  );
  console.log("");

  if (argv.has("--audit")) {
    for (const requirement of boot.audit.requirements) {
      console.log(`  [${requirement.status}] ${requirement.section} ${requirement.id} — ${requirement.title}`);
      for (const limit of requirement.limits) console.log(`        limit: ${limit}`);
    }
    console.log("");
    await system.shutdown();
    return;
  }

  if (argv.has("--diagnostics")) {
    const report = await system.diag.runAll();
    for (const probe of report.probes) {
      console.log(`  ${probe.ok ? "pass" : "FAIL"}  ${probe.name.padEnd(12)} ${probe.detail}`);
    }
    console.log(`\n  ${report.passed} passed, ${report.failed} failed\n`);
    await system.shutdown();
    return;
  }

  console.log("  The OS is up. Press Ctrl-C to shut down cleanly.");
  console.log("");

  const shutdown = async (signal: string) => {
    console.log(`\n  ${signal} received; stopping services in reverse order.`);
    await system.shutdown();
    const stopped = system.supervisor.report().every((service) => service.status === "stopped");
    console.log(`  all services stopped: ${stopped ? "yes" : "no"}`);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  log.error("init", `The system could not boot: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
