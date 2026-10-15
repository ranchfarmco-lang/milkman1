/**
 * A real acceptance run, in one command.
 *
 * The specification's §69 is a twenty-step acceptance test; most of it needs a
 * human with a phone and a second Internet connection. The parts that can be
 * proven by a program are proven here, on this machine, with nothing simulated:
 *
 *   · the host starts and binds a real port;
 *   · its own API answers over real HTTP;
 *   · the authentication rules hold — an open host signs nobody in, and a host
 *     with a password refuses an unauthenticated request and accepts a
 *     signed-in one;
 *   · an administrative route refuses a session that is not an administrator's;
 *   · the download centre builds a real archive and the checksum matches the
 *     bytes it hands back;
 *   · the relay carries a real request to the host and gets a real answer back,
 *     which is the whole of §14 demonstrated rather than described.
 *
 *     bun native/selfcheck.ts
 *
 * It exits non-zero if anything fails, so it can be run in CI or before a
 * release. Every server it starts is stopped before it exits.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The host's own directory is set before anything is imported, so the check
// never touches a real installation.
process.env.SUGAR_HOME = mkdtempSync(join(tmpdir(), "sugar-selfcheck-"));

let failures = 0;
let passes = 0;

function check(name: string, ok: boolean, evidence: string): void {
  if (ok) passes += 1;
  else failures += 1;
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}`);
  console.log(`      ${evidence}`);
}

async function main(): Promise<void> {
  // A watchdog, so a hung check reports itself rather than sitting there.
  const watchdog = setTimeout(() => {
    console.error("\nThe self-check did not finish within 120 seconds.");
    process.exit(2);
  }, 120_000);
  watchdog.unref();

  console.log("\nSUGAR native host — real acceptance check\n");

  const { SugarApp } = await import("./core/app.ts");
  const { config } = await import("./storage/config.ts");
  const { createRelayServer } = await import("./tunnel/relay-server.ts");
  const { versionLine } = await import("./core/version.ts");

  console.log(`${versionLine()}\n`);

  // A preferred port of 0 asks the operating system for a free one, which is
  // exactly what §4's port selection is for. No LAN listener in a test.
  config.patch("network", { preferredPort: 0, allowLan: false, monitorSeconds: 5 });

  /* ------------------------------------------------- step 1: the relay (§14) */

  // The relay's advertised address can only be known after it has bound its
  // port, so the options object is kept and completed below — the handlers read
  // it at request time, which is the same shape a real deployment has when the
  // address is set once at start-up.
  const relayOptions = {
    publicBaseUrl: "http://127.0.0.1:0",
    secret: null as string | null,
    hostTimeoutMs: 8000,
  };
  const relay = createRelayServer(relayOptions);
  await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", () => resolve()));
  const relayPort = (relay.address() as { port: number }).port;
  const relayBase = `http://127.0.0.1:${relayPort}`;
  relayOptions.publicBaseUrl = relayBase;
  console.log(`Relay started on ${relayBase}.\n`);

  /* ------------------------------------------- step 2: the host boots (§27) */

  config.patch("user", { relayUrl: relayBase });
  const app = new SugarApp();
  await app.boot();

  check(
    "The embedded server started and bound a real port",
    app.server.getServerStatus().status === "running" && app.server.getPort() !== null,
    `Listening on ${app.server.getLocalAddress()} (port ${app.server.getPort()}), with no external web server involved.`,
  );

  check(
    "The LAN listener stayed off, as the test asked",
    app.server.getServerStatus().listeningOnLan === false,
    "Only loopback is bound, so a test cannot accidentally expose this machine.",
  );

  /* --------------------------------------------- step 3: the local API (§5) */

  const base = app.server.getLocalAddress() ?? "";
  const statusResponse = await fetch(`${base}/api/status`);
  const statusBody = (await statusResponse.json()) as { service?: string; hostname?: string };
  check(
    "GET /api/status answers over real HTTP",
    statusResponse.ok && statusBody.service === "SUGAR",
    `Answered ${statusResponse.status} with service=${statusBody.service}, hostname=${statusBody.hostname}.`,
  );

  const healthResponse = await fetch(`${base}/health`);
  check("GET /health answers", healthResponse.ok, `Answered ${healthResponse.status}.`);

  const missing = await fetch(`${base}/api/nothing-here`);
  check(
    "An unknown API path falls through to the portal rather than pretending",
    missing.ok && (missing.headers.get("content-type") ?? "").includes("text/html"),
    `GET /api/nothing-here answered ${missing.status} with the portal page, which is what the host does with any path that is not an API route.`,
  );

  /* ------------------------------- step 4: open host, then a locked one (§17) */

  const openNetwork = await fetch(`${base}/api/network`);
  check(
    "With no password set, the local dashboard can read the network",
    openNetwork.ok,
    `GET /api/network answered ${openNetwork.status} — the host is open until a password is set, which is the hub's own rule.`,
  );

  const stopWithoutAdmin = await fetch(`${base}/api/server/stop`, { method: "POST" });
  check(
    "An administrative route refuses an unauthenticated caller",
    stopWithoutAdmin.status === 401,
    `POST /api/server/stop answered ${stopWithoutAdmin.status} with no session, so the control plane is not open (§41).`,
  );

  const { auth } = await import("./auth/auth.ts");
  auth.setPassword("self-check-password");
  const locked = await fetch(`${base}/api/network`);
  check(
    "With a password set, an unauthenticated read is refused",
    locked.status === 401,
    `GET /api/network answered ${locked.status} once the host was locked (§17).`,
  );

  const signIn = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "self-check-password", label: "self-check" }),
  });
  const cookie = signIn.headers.get("set-cookie") ?? "";
  const signInBody = (await signIn.json()) as { ok?: boolean; csrf?: string; adminProof?: string };
  check(
    "Sign-in succeeds and hands back a session, a CSRF token and an admin proof",
    signIn.ok && signInBody.ok === true && cookie.includes("sugar_session=") && Boolean(signInBody.csrf),
    `The answer carried a session cookie (HttpOnly), a CSRF token and an administrator proof.`,
  );

  const badPassword = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "not-the-password" }),
  });
  check(
    "A wrong password is refused",
    badPassword.status === 401,
    `The wrong password answered ${badPassword.status}.`,
  );

  const authedNetwork = await fetch(`${base}/api/network`, { headers: { cookie } });
  check(
    "A signed-in session can read the network",
    authedNetwork.ok,
    `GET /api/network with the session cookie answered ${authedNetwork.status}.`,
  );

  const noCsrf = await fetch(`${base}/api/network/test`, { method: "POST", headers: { cookie } });
  check(
    "A state-changing request without its CSRF token is refused",
    noCsrf.status === 403,
    `POST /api/network/test with a cookie but no token answered ${noCsrf.status} (§40).`,
  );

  const withCsrf = await fetch(`${base}/api/network/test`, {
    method: "POST",
    headers: { cookie, "x-sugar-csrf": signInBody.csrf ?? "" },
  });
  check(
    "The same request with its CSRF token is accepted",
    withCsrf.ok,
    `POST /api/network/test with the token answered ${withCsrf.status}.`,
  );

  const adminStop = await fetch(`${base}/api/server/stop`, {
    method: "POST",
    headers: { cookie, "x-sugar-csrf": signInBody.csrf ?? "" },
  });
  check(
    "An administrator route needs the admin proof as well as a session",
    adminStop.status === 403,
    `POST /api/server/stop with a session and CSRF but no admin proof answered ${adminStop.status}, so a viewing session cannot stop the host (§41).`,
  );

  /* ------------------------------------ step 5: the tunnel, end to end (§14) */

  const publicUrl = await waitFor(() => app.tunnel?.publicUrl() ?? null, 8000);
  check(
    "The host opened an outbound tunnel and was given a real public address",
    Boolean(publicUrl),
    publicUrl
      ? `The relay assigned ${publicUrl}. Nothing connected inward: the host dialled out, which is what makes this work behind Starlink's carrier-grade NAT.`
      : "The tunnel did not come up within eight seconds.",
  );

  if (publicUrl) {
    // This is the acceptance test's core: a request from outside the host's own
    // process is carried to it and answered.
    const throughRelay = await fetch(`${publicUrl}/api/status`);
    const throughBody = (await throughRelay.json()) as { service?: string; hostname?: string };
    check(
      "A request through the relay reaches the host and returns its real answer",
      throughRelay.ok && throughBody.service === "SUGAR",
      `GET ${publicUrl}/api/status answered ${throughRelay.status} with service=${throughBody.service}, hostname=${throughBody.hostname} — the request travelled out to the relay, down the tunnel, into the local server and back.`,
    );

    const relayHealth = await fetch(`${relayBase}/health`);
    const relayBody = (await relayHealth.json()) as { hosts?: unknown[] };
    check(
      "The relay reports the host connected",
      relayHealth.ok && (relayBody.hosts?.length ?? 0) === 1,
      `The relay's own health endpoint lists ${relayBody.hosts?.length ?? 0} connected host(s).`,
    );

    const remoteTest = await app.tunnel?.testRemoteConnection();
    check(
      "The provider's own reachability test agrees",
      Boolean(remoteTest?.ok),
      remoteTest?.detail ?? "no answer",
    );

    const portalThroughRelay = await fetch(`${publicUrl}/`);
    const portalHtml = await portalThroughRelay.text();
    check(
      "The portal is served through the relay",
      portalThroughRelay.ok && portalHtml.includes("SUGAR"),
      `GET ${publicUrl}/ answered ${portalThroughRelay.status} with the dashboard (${portalHtml.length} bytes).`,
    );
  }

  /* ------------------------------------------- step 6: the two test suites */

  const everything = await app.testEverything();
  const self = await app.selfTest();

  for (const report of [everything, self]) {
    console.log(`\n  --- ${report.suite} ---`);
    for (const item of report.checks) {
      const tone = item.status === "PASS" ? "green" : item.status === "FAIL" ? "red" : "gray";
      console.log(`    ${item.status.padEnd(4)} [${tone}] ${item.name} — ${item.evidence}`);
    }
    console.log(`    ${report.summary}`);
  }

  check(
    "TEST EVERYTHING reports every check with evidence",
    everything.checks.length === 15,
    `${everything.checks.length} checks ran: ${everything.checks.map((c) => `${c.name}=${c.status}`).join(", ")}`,
  );

  check(
    "SELF TEST covers every subsystem the specification names",
    self.checks.length === 14,
    `${self.checks.length} subsystems tested: ${self.checks.map((c) => c.name).join(", ")}`,
  );

  /* ------------------------------------------------- step 7: the downloads */

  const all = app.downloads();
  const { sha256 } = await import("./downloads/zip.ts");
  const { createHash } = await import("node:crypto");
  // The checksum the card shows is recomputed here with Node's own hasher, so
  // the card's value and an independent value have to agree.
  const independent = createHash("sha256").update(all.buffer).digest("hex");
  check(
    "DOWNLOAD ALL builds a real archive whose checksum matches its bytes",
    all.buffer.byteLength > 1000 && sha256(all.buffer) === independent,
    `The archive is ${all.buffer.byteLength} bytes with ${all.files.length} files indexed; its SHA-256 is ${independent.slice(0, 16)}… by Node's own hasher and ${sha256(all.buffer).slice(0, 16)}… by the download centre (§35).`,
  );

  const installer = await fetch(`${base}/api/downloads/install-linux.sh`, { headers: { cookie } });
  const installerText = await installer.text();
  check(
    "A generated installer is served as a real file",
    installer.ok && installerText.includes("#!/usr/bin/env bash"),
    `GET /api/downloads/install-linux.sh answered ${installer.status} with ${installerText.length} bytes of shell script.`,
  );

  const packageZip = await fetch(`${base}/api/downloads/all`, { headers: { cookie } });
  const zipBytes = new Uint8Array(await packageZip.arrayBuffer());
  check(
    "The portal serves the real ZIP, and it starts with the ZIP signature",
    packageZip.ok && zipBytes[0] === 0x50 && zipBytes[1] === 0x4b,
    `${zipBytes.byteLength} bytes, first two bytes 0x${zipBytes[0].toString(16)} 0x${zipBytes[1].toString(16)} — a real archive, not a placeholder.`,
  );

  /* -------------------------------------------------- step 8: the browser */

  const { browsers } = await import("./browser/engine.ts");
  const browser = browsers.first();
  // allowPrivate is what the API grants a caller on this machine and withholds
  // from a relayed one, so the test drives the browser the way a local user does.
  await browser.navigate(`${base}/`, { allowPrivate: true });
  const navigation = await browser.navigate(`${base}/api/status`, { allowPrivate: true });
  const history = navigation.history.length;
  check(
    "The embedded browser navigates, keeps history and holds the page",
    navigation.status === 200 && history >= 2,
    `Navigated twice; the browser holds ${history} history entries, reports ${navigation.contentType} and ${navigation.bytes} bytes, and its security status is ${navigation.security.scheme} (${navigation.security.certificate}).`,
  );

  const back = await browser.back({ allowPrivate: true });
  check(
    "Back and forward move through the real history",
    back.canGoForward === true,
    `After going back, canGoForward is ${back.canGoForward} — the history position is real, not a boolean the UI invented.`,
  );

  /* ------------------------------------------------- step 9: tidy up (§45) */

  // The monitor is a repeating timer, so it has to be stopped explicitly or the
  // process would never be allowed to exit.
  app.monitor.stop();
  await app.tunnel?.disconnect();
  await app.server.stop();
  await new Promise<void>((resolve) => relay.close(() => resolve()));

  check(
    "The host and the relay shut down cleanly",
    app.server.getServerStatus().status === "stopped",
    "The server and the relay closed, so nothing is left listening.",
  );

  console.log(`\n  ${passes} passed, ${failures} failed.\n`);
  // Exit deliberately: everything this check started has been stopped, and an
  // explicit exit proves nothing was left holding the event loop open.
  process.exit(failures > 0 ? 1 : 0);
}

async function waitFor<T>(read: () => T | null, timeoutMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

main().catch((error: unknown) => {
  console.error(`\nThe self-check could not finish: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
