/**
 * §14 — run the relay on its own, on the machine that has a public address.
 *
 * A Starlink connection cannot accept incoming connections; a small server with
 * a real address can. So the relay lives there and the host stays at home. This
 * is the whole of it:
 *
 *   bun run relay.ts --port 8443 --secret "$(openssl rand -hex 24)"
 *
 * Then, on the computer running the host:
 *
 *   bun run host.ts --relay http://that-server:8443 --secret <the same secret>
 *
 * Nothing about the host's own machine is exposed by this. The relay forwards
 * requests it receives to the one address the host offers — its own local server
 * — and the host decides what each request may do (§65).
 */

import { createRelayServer } from "./tunnel/relay-server.ts";
import { versionLine } from "./core/version.ts";
import { log } from "./core/log.ts";

function option(name: string, fallback: string | null): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

async function main(): Promise<void> {
  const port = Number(option("port", "8443"));
  const secret = option("secret", process.env.SUGAR_RELAY_SECRET ?? null);
  const advertised = option("public", `http://127.0.0.1:${port}`);

  log.echo = true;
  console.log(`${versionLine()}\n`);

  const relay = createRelayServer({
    publicBaseUrl: advertised as string,
    secret,
    log: (message, detail) => log.info("tunnel", message, detail),
  });

  await new Promise<void>((resolve) => relay.listen(port, "0.0.0.0", () => resolve()));

  console.log(`Relay listening on port ${port}.`);
  console.log(`Advertised public address: ${advertised}`);
  console.log(
    secret
      ? "A tunnel secret is required; a host must present it to connect."
      : "No secret is set. On a public machine, set one with --secret (§40).",
  );
  console.log(`\nPoint a host at it with:\n  bun run host.ts --relay ${advertised}${secret ? " --secret <the secret>" : ""}\n`);

  const shutdown = () => {
    console.log("Closing the relay.");
    relay.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  console.error(`The relay could not start: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
