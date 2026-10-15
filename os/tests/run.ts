/**
 * NOVA OS automated tests (§38).
 *
 * One runner, real assertions, no network mocks: where a test needs a server it
 * starts one, where it needs a UDP peer it binds a socket, and where it needs a
 * filesystem it writes real files under the OS's own state directory. The names
 * below are the ones `os/requirements.ts` references, and the audit checks that
 * each one actually appears here — so a requirement cannot claim a test that
 * does not exist.
 *
 * Run with:  bun os/tests/run.ts
 *
 * The whole run is isolated: NOVA_ROOT is pointed at a fresh temporary
 * directory, so nothing here touches a real installation's state.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createSocket, type RemoteInfo } from "node:dgram";

import { EventBus, Logger, ConfigStore, config, ensureOsPaths, osPaths, type ComponentStatus, type OsComponent } from "../core/runtime.ts";
import { ServiceSupervisor, restartDelay } from "../init/supervisor.ts";
import { classifyInterface, readRoutes, readDnsServers, NetworkManager } from "../net/manager.ts";
import { WireGuardProvider, VpnManager, type VpnProfile } from "../net/vpn.ts";
import { FirewallManager } from "../net/firewall.ts";
import { WebService, HEALTH_PATH, jsonResponse, textResponse } from "../web/service.ts";
import { PackageManager, makeRecipe, type PackageRecipe } from "../pkg/manager.ts";
import { AppRuntime, detectSandbox } from "../apps/runtime.ts";
import { AiRuntime, type PermissionLevel } from "../ai/runtime.ts";
import { SnapshotStore } from "../ai/snapshots.ts";
import { CommsEngine, stunBinding, buildSdp, parseSdp, priority } from "../comms/engine.ts";
import { NovaBrowser } from "../browser/engine.ts";
import { auditRequirements, type Requirement } from "../diag/audit.ts";
import { NovaSystem } from "../system.ts";

/* --------------------------------------------------------------- scaffolding --- */

const TEST_ROOT = mkdtempSync(join(tmpdir(), "nova-tests-"));
process.env.NOVA_ROOT = TEST_ROOT;
const RUN = Date.now().toString(36);

type Case = { name: string; fn: () => Promise<void> | void };
const cases: Case[] = [];
const results: { name: string; ok: boolean; ms: number; error: string | null }[] = [];

function test(name: string, fn: () => Promise<void> | void): void {
  cases.push({ name, fn });
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

function assertThrows(fn: () => unknown, includes: string): void {
  try {
    fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes(includes)) throw new Error(`expected an error mentioning "${includes}", got: "${message}"`);
    return;
  }
  throw new Error(`expected an error mentioning "${includes}", but nothing was thrown`);
}

function fakeComponent(name: string, requires: string[], status: () => ComponentStatus = () => "running"): OsComponent {
  return {
    name,
    about: `${name} test component`,
    requires,
    async start() {},
    async stop() {},
    status,
    capability() {
      return { available: [], blocked: [] };
    },
  };
}

/* ------------------------------------------------------------------- core --- */

test("config store round trips a section", () => {
  const store = new ConfigStore();
  store.set("system", { ...store.get("system"), hostname: `nova-${RUN}` });
  assertEqual(new ConfigStore().get("system").hostname, `nova-${RUN}`, "the hostname did not round trip");
});

test("config patch merges without losing fields", () => {
  const store = new ConfigStore();
  store.set("net", { dhcp: true, address: null, gateway: null, dns: ["1.1.1.1"] });
  const patched = store.patch("net", { gateway: "10.0.0.1" });
  assertEqual(patched.dns[0], "1.1.1.1", "patching dropped the dns servers");
  assertEqual(patched.gateway, "10.0.0.1", "the patch did not apply");
});

test("event bus delivers exact and prefix topics", () => {
  const bus2 = new EventBus();
  let exact = 0;
  let prefix = 0;
  bus2.subscribe("net.up", () => (exact += 1));
  bus2.subscribe("net.*", () => (prefix += 1));
  bus2.publish("net.up", "test", {});
  bus2.publish("net.down", "test", {});
  assertEqual(exact, 1, "the exact subscriber saw the wrong number of events");
  assertEqual(prefix, 2, "the prefix subscriber saw the wrong number of events");
});

test("event bus history stays bounded", () => {
  const bus2 = new EventBus(5);
  for (let i = 0; i < 20; i += 1) bus2.publish("x", "test", i);
  assertEqual(bus2.recent(undefined, 100).length, 5, "the history was not bounded");
});

test("logger redacts credential-looking text", () => {
  const logger = new Logger(10);
  logger.info("ai", "connecting with token=abc123supersecret now");
  assert(!logger.asText().includes("abc123supersecret"), "the redactor let a credential through");
});

/* -------------------------------------------------------------- supervisor --- */

test("supervisor orders services by dependency", () => {
  const supervisor = new ServiceSupervisor();
  supervisor.register({ component: fakeComponent("a", []), restart: "never", maxRestarts: 0, healthSeconds: 0 });
  supervisor.register({ component: fakeComponent("b", ["a"]), restart: "never", maxRestarts: 0, healthSeconds: 0 });
  supervisor.register({ component: fakeComponent("c", ["b"]), restart: "never", maxRestarts: 0, healthSeconds: 0 });
  assertEqual(supervisor.startOrder().join(","), "a,b,c", "the start order is not dependency-ordered");
});

test("supervisor refuses a dependency cycle", () => {
  const supervisor = new ServiceSupervisor();
  supervisor.register({ component: fakeComponent("a", []), restart: "never", maxRestarts: 0, healthSeconds: 0 });
  // Force a cycle into the private graph: registration prevents one, so the
  // resolver's own guard is what is under test here.
  const raw = supervisor as unknown as { specs: Map<string, { component: OsComponent }> };
  raw.specs.set("b", { component: fakeComponent("b", ["c"]) });
  raw.specs.set("c", { component: fakeComponent("c", ["b"]) });
  assertThrows(() => supervisor.startOrder(), "cycle");
});

test("supervisor refuses an unknown dependency", () => {
  const supervisor = new ServiceSupervisor();
  assertThrows(
    () => supervisor.register({ component: fakeComponent("solo", ["missing"]), restart: "never", maxRestarts: 0, healthSeconds: 0 }),
    "missing",
  );
});

test("restart delay grows and is capped", () => {
  assert(restartDelay(1) < restartDelay(5), "the restart delay did not grow with the attempt count");
  assert(restartDelay(30) <= 61_000, "the restart delay was not capped");
});

/* ------------------------------------------------------------------ network --- */

test("interface classification identifies kinds", () => {
  assertEqual(classifyInterface("lo"), "loopback", "lo was misclassified");
  assertEqual(classifyInterface("eth0"), "ethernet", "eth0 was misclassified");
  assertEqual(classifyInterface("wlan0"), "wifi", "wlan0 was misclassified");
  assertEqual(classifyInterface("wg0"), "vpn", "wg0 was misclassified");
  assertEqual(classifyInterface("docker0"), "virtual", "docker0 was misclassified");
});

test("network reads the default route", () => {
  const routes = readRoutes();
  assert(Array.isArray(routes), "the routing table did not come back as a list");
  for (const route of routes) {
    assert(/^\d+\.\d+\.\d+\.\d+$/.test(route.destination), `${route.destination} is not an IPv4 destination`);
    assert(typeof route.iface === "string" && route.iface.length > 0, "a route had no interface");
  }
});

test("network reads DNS servers", () => {
  const servers = readDnsServers();
  assert(Array.isArray(servers), "the resolver list did not come back as a list");
  for (const server of servers) assert(/^[0-9a-fA-F:.]+$/.test(server), `${server} is not an address`);
});

test("connectivity reports the NAT verdict honestly", () => {
  const status = new NetworkManager().getConnectivityStatus();
  assert(status.nat.verdict.length > 10, "no NAT verdict was reported");
  assertEqual(
    status.directInboundPossible,
    !status.nat.behindCgnat && !status.nat.behindNat,
    "the inbound verdict contradicts the NAT state",
  );
});

/* ---------------------------------------------------------------- firewall --- */

test("firewall ruleset validates a correct ruleset", () => {
  const firewall = new FirewallManager();
  firewall.openPort(23456, "tcp", "a test service");
  const result = firewall.validate();
  assert(result.ok, `the generated ruleset did not validate: ${result.problems.join("; ")}`);
});

test("firewall rejects an unbalanced ruleset", () => {
  const firewall = new FirewallManager();
  const result = firewall.validate("table inet nova {\n  chain input {\n    type filter hook input priority filter; policy drop;\n");
  assert(!result.ok, "an unbalanced ruleset was accepted");
  assert(result.problems.some((problem) => problem.includes("unclosed")), "the unclosed brace was not reported");
});

test("firewall rejects an unknown verdict", () => {
  const firewall = new FirewallManager();
  const ruleset = [
    "table inet nova {",
    "  chain input {",
    "    type filter hook input priority filter; policy bogus;",
    "  }",
    "  chain forward { type filter hook forward priority filter; policy drop; }",
    "  chain output { type filter hook output priority filter; policy accept; }",
    "}",
  ].join("\n");
  const result = firewall.validate(ruleset);
  assert(!result.ok, "a bogus policy verdict was accepted");
  assert(result.problems.some((problem) => problem.includes("bogus")), "the bad verdict was not named");
});

test("firewall plan lists open ports", () => {
  const firewall = new FirewallManager();
  firewall.openPort(34567, "tcp", "a test port");
  const plan = firewall.plan();
  assert(plan.openPorts.includes(34567), "the plan did not list the open port");
  assert(plan.validation.ok, "the plan's ruleset did not validate");
});

/* --------------------------------------------------------------------- VPN --- */

const WG_KEY_1 = `${"A".repeat(42)}E=`;
const WG_KEY_2 = `${"B".repeat(42)}E=`;

function testProfile(overrides: Partial<VpnProfile> = {}): VpnProfile {
  return {
    name: `nova-test-${RUN}`,
    provider: "wireguard",
    privateKey: WG_KEY_1,
    address: ["10.7.0.2/32"],
    dns: ["1.1.1.1"],
    mtu: 1420,
    peers: [{ publicKey: WG_KEY_2, endpoint: "vpn.example.com:51820", allowedIps: ["0.0.0.0/0"], persistentKeepalive: 25, presharedKey: null }],
    ...overrides,
  };
}

test("wireguard config is valid wg-quick INI", () => {
  const text = new WireGuardProvider().buildConfig(testProfile());
  assert(text.includes("[Interface]"), "the config has no [Interface] section");
  assert(text.includes(`PrivateKey = ${WG_KEY_1}`), "the private key is not in the config");
  assert(text.includes("[Peer]"), "the config has no [Peer] section");
  assert(text.includes("Endpoint = vpn.example.com:51820"), "the endpoint is not in the config");
  assert(text.includes("AllowedIPs = 0.0.0.0/0"), "the allowed IPs are not in the config");
});

test("wireguard validates base64 keys", () => {
  const vpn = new VpnManager();
  assert(vpn.validate(testProfile()).ok, "a well-formed profile was rejected");
  const bad = vpn.validate(testProfile({ privateKey: "short" }));
  assert(!bad.ok, "a short private key was accepted");
});

test("wireguard parses a real wg dump", () => {
  const handshake = Math.floor(Date.now() / 1000) - 30;
  const dump = ["private\tpublic\t51820\toff", `peer\t(none)\t1.2.3.4:51820\t0.0.0.0/0\t${handshake}\t1024\t2048\t25`].join("\n");
  const state = new WireGuardProvider().parseState("novawg", dump);
  assertEqual(state.received, 1024, "the received counter was misread");
  assertEqual(state.sent, 2048, "the sent counter was misread");
  assert(state.handshakeSeconds !== null && state.handshakeSeconds >= 29, "the handshake age was misread");
});

test("vpn plan describes up and down without applying", () => {
  const vpn = new VpnManager();
  const plan = vpn.plan(testProfile());
  assert(plan.up.some((step) => step.includes("ip link add")), "the up plan does not create the interface");
  assert(plan.down.some((step) => step.includes("ip link delete")), "the down plan does not delete the interface");
  assert(plan.configPath.endsWith(".conf"), "the config path looks wrong");
  assert(existsSync(plan.configPath), "the config file was not written");
});

test("vpn recognises a proton configuration", () => {
  const ini = [
    "[Interface]",
    `PrivateKey = ${WG_KEY_1}`,
    "Address = 10.2.0.2/32",
    "DNS = 10.2.0.1",
    "",
    "[Peer]",
    `PublicKey = ${WG_KEY_2}`,
    "Endpoint = 203.0.113.9:51820",
    "AllowedIPs = 0.0.0.0/0",
    "",
  ].join("\n");
  const vpn = new VpnManager();
  const profile = vpn.loadProfileFromConfig(ini, "ProtonVPN-US");
  assertEqual(profile.peers.length, 1, "the peer was not parsed");
  assert(vpn.describeProfile(profile).proton, "a Proton profile was not recognised");
});

/* --------------------------------------------------------------------- web --- */

async function withWeb<T>(fn: (web: WebService) => Promise<T>): Promise<T> {
  // An ephemeral port each time, so tests never fight over a fixed one. The
  // shared config singleton is patched, because that is the instance the
  // components read; patching a separate store would leave the cache stale.
  config.patch("web", { httpPort: 0, httpsPort: 0 });
  const web = new WebService();
  await web.start();
  try {
    return await fn(web);
  } finally {
    await web.stop();
  }
}

test("web registry routes by longest prefix", async () => {
  await withWeb(async (web) => {
    web.registerService("shallow", "/api", "shallow", () => textResponse(200, "shallow"));
    web.registerService("deep", "/api/v2", "deep", () => textResponse(200, "deep"));
    const port = web.getServerStatus().http.port;
    assert(port !== null, "the web service did not report a port");
    const deep = await (await fetch(`http://127.0.0.1:${port}/api/v2/thing`)).text();
    const shallow = await (await fetch(`http://127.0.0.1:${port}/api/other`)).text();
    assertEqual(deep, "deep", "the longest prefix did not win");
    assertEqual(shallow, "shallow", "the shorter prefix did not serve its own path");
  });
});

test("web service binds and reports the real port", async () => {
  await withWeb(async (web) => {
    const status = web.getServerStatus();
    assert(status.http.listening, "the HTTP listener is not listening");
    assert(typeof status.http.port === "number" && status.http.port > 0, "no real port was reported");
    assertEqual(web.boundPorts().http, status.http.port, "boundPorts disagrees with the status");
  });
});

test("web service answers its own health endpoint", async () => {
  await withWeb(async (web) => {
    web.registerService("health", HEALTH_PATH, "health", () => jsonResponse(200, { ok: true }));
    const result = await web.selfTest();
    assert(result.ok, `the OS could not reach its own health endpoint: ${result.detail}`);
  });
});

/* ----------------------------------------------------------------- browser --- */

function htmlServer(body: string): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(body);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      resolve({ url: `http://127.0.0.1:${port}/`, close: () => server.close() });
    });
  });
}

test("browser fetches and parses a document", async () => {
  const server = await htmlServer("<html><head><title>Nova Test</title></head><body><h1>Hello</h1><a href='/x'>link</a><form></form></body></html>");
  try {
    const browser = new NovaBrowser();
    await browser.start();
    const page = await browser.navigate(server.url, { allowPrivate: true });
    assert(page.error === null, `navigation failed: ${page.error}`);
    assert(page.document !== null, "no document was parsed");
    assertEqual(page.document?.title, "Nova Test", "the title was not parsed");
    assert(page.document?.headings.some((heading) => heading.text === "Hello") === true, "the heading was not parsed");
    assertEqual(page.document?.links.length, 1, "the link was not parsed");
    assertEqual(page.document?.forms, 1, "the form was not counted");
    assert(page.document?.text.includes("Hello") === true, "the text was not extracted");
  } finally {
    server.close();
  }
});

test("browser keeps navigation history", async () => {
  const a = await htmlServer("<title>A</title>");
  const b = await htmlServer("<title>B</title>");
  try {
    const browser = new NovaBrowser();
    await browser.start();
    await browser.navigate(`${a.url}a`, { allowPrivate: true });
    await browser.navigate(`${b.url}b`, { allowPrivate: true });
    assertEqual(browser.history().length, 2, "history did not record both pages");
    const back = browser.back();
    assert(back !== null && back.url.endsWith("/a"), "back did not return to the first page");
    const forward = browser.forward();
    assert(forward !== null && forward.url.endsWith("/b"), "forward did not return to the second page");
  } finally {
    a.close();
    b.close();
  }
});

test("browser refuses a private address from a public context", async () => {
  const browser = new NovaBrowser();
  await browser.start();
  const page = await browser.navigate("http://127.0.0.1:9/");
  assert(page.error !== null, "a private address was fetched without permission");
  assert((page.error ?? "").toLowerCase().includes("private"), `the refusal did not explain itself: ${page.error}`);
});

/* -------------------------------------------------------------- app runtime --- */

async function withApps<T>(fn: (apps: AppRuntime, web: WebService) => Promise<T>): Promise<T> {
  config.patch("web", { httpPort: 0, httpsPort: 0 });
  const web = new WebService();
  await web.start();
  const apps = new AppRuntime(web);
  await apps.start();
  try {
    return await fn(apps, web);
  } finally {
    await apps.stop();
    await web.stop();
  }
}

test("app runtime detects the strongest sandbox", () => {
  const sandbox = detectSandbox();
  assert(["bwrap", "unshare", "directory"].includes(sandbox.mode), `unexpected sandbox mode ${sandbox.mode}`);
  assert(sandbox.detail.length > 20, "the sandbox did not explain itself");
});

test("app runtime starts and publishes an http app", async () => {
  await withApps(async (apps) => {
    const name = `probe-${RUN}`;
    apps.define({ name, about: "a long-running test app", command: "sleep", args: ["30"], http: { prefix: `/app-${RUN}`, port: 9 } });
    const instance = await apps.startApp(name);
    assertEqual(instance.status, "running", "the application did not start");
    assert(instance.http?.published === true, "the application was not published on the web service");
    await apps.stopApp(name);
  });
});

test("app runtime stops an app and releases its path", async () => {
  await withApps(async (apps, web) => {
    const name = `release-${RUN}`;
    const prefix = `/app-release-${RUN}`;
    apps.define({ name, about: "a long-running test app", command: "sleep", args: ["30"], http: { prefix, port: 9 } });
    await apps.startApp(name);
    assert(web.getServerStatus().services.some((service) => service.prefix === prefix), "the path was not published");
    await apps.stopApp(name);
    assert(!web.getServerStatus().services.some((service) => service.prefix === prefix), "the path was not released");
  });
});

/* ---------------------------------------------------------------------- AI --- */

function makeAgent(ai: AiRuntime, name: string, level: PermissionLevel): void {
  ai.createAgent({ name, about: `${name} test agent`, level });
}

test("ai permissions separate user from build", () => {
  const ai = new AiRuntime();
  makeAgent(ai, `user-${RUN}`, "user");
  makeAgent(ai, `build-${RUN}`, "build");
  assert(!ai.permits(`user-${RUN}`, "run a command inside the sandbox").allowed, "a user agent was allowed to run a command");
  assert(ai.permits(`build-${RUN}`, "apply a change that passed the pipeline").allowed, "a build agent may not promote a change");
});

test("ai model install validates against the hardware requirement", () => {
  const ai = new AiRuntime();
  const source = join(TEST_ROOT, "model.bin");
  writeFileSync(source, "weights");
  const record = ai.installModel({
    name: `toolarge-${RUN}`,
    fromPath: source,
    requirements: { memoryMb: 50_000_000, diskMb: 0, gpu: false },
    purpose: "test only",
  });
  assert(record.compatibility.ok === false, "an impossible model was accepted as compatible");
  assert(record.compatibility.notes.length > 0, "the incompatibility was not explained");
});

test("ai agent message carries the envelope", () => {
  const ai = new AiRuntime();
  makeAgent(ai, `from-${RUN}`, "developer");
  makeAgent(ai, `to-${RUN}`, "developer");
  const envelope = ai.send(`from-${RUN}`, `to-${RUN}`, "task-1", { question: "hi" });
  assertEqual(envelope.sender, `from-${RUN}`, "the sender is wrong");
  assertEqual(envelope.recipient, `to-${RUN}`, "the recipient is wrong");
  assertEqual(envelope.taskId, "task-1", "the task id is wrong");
  assertEqual(envelope.permissions, "developer", "the permissions are wrong");
  assertEqual(envelope.status, "delivered", "the delivery status is wrong");
  assert(envelope.timestamp > 0, "the timestamp is missing");
});

test("ai sandbox refuses a path outside it", () => {
  const ai = new AiRuntime();
  const name = `dev-${RUN}`;
  makeAgent(ai, name, "developer");
  const write = ai.sandboxWrite(name, "../escape.txt", "x");
  assert(!write.ok, "a write outside the sandbox was allowed");
  const run = ai.sandboxRun(name, "cat /etc/passwd");
  assert(!run.ok, "a command naming /etc was allowed");
});

test("ai change pipeline stages and tests", () => {
  const ai = new AiRuntime();
  const name = `admin-${RUN}`;
  makeAgent(ai, name, "system-administrator");
  const proposal = ai.proposeChange(name, "add a note", { "note.txt": "hello" });
  const result = ai.runPipeline(proposal.id, { testCommand: "test -f note.txt" });
  assertEqual(result.outcome, "ready", `the pipeline ended as "${result.outcome}"`);
  assert(result.stages.some((stage) => stage.stage === "security check" && stage.ok), "the security check did not pass");
  assert(result.snapshot !== null, "no snapshot was taken before the change");
});

test("ai security check rejects a credential", () => {
  const ai = new AiRuntime();
  const name = `leak-${RUN}`;
  makeAgent(ai, name, "system-administrator");
  const proposal = ai.proposeChange(name, "leak a key", { "leak.txt": "sk-abcdefghijklmnop1234" });
  const result = ai.runPipeline(proposal.id, { testCommand: "true" });
  assertEqual(result.outcome, "rejected", "a change carrying a credential was not rejected");
  assert(result.stages.some((stage) => stage.stage === "security check" && !stage.ok), "the security check did not flag the credential");
});

test("ai promotion requires build permission", () => {
  const ai = new AiRuntime();
  const name = `adm-${RUN}`;
  makeAgent(ai, name, "system-administrator");
  const proposal = ai.proposeChange(name, "a ready change", { "p.txt": "ok" });
  ai.runPipeline(proposal.id, { testCommand: "true" });
  const promoted = ai.promoteChange(proposal.id, name);
  assert(!promoted.ok, "a system-administrator promoted a change without build permission");
});

test("ai rollback restores a file it changed", () => {
  const ai = new AiRuntime();
  const admin = `adm2-${RUN}`;
  const builder = `build2-${RUN}`;
  makeAgent(ai, admin, "system-administrator");
  makeAgent(ai, builder, "build");
  const relative = `rollback-${RUN}.txt`;
  const target = join(ensureOsPaths().data, "system", relative);
  const proposal = ai.proposeChange(admin, "create a file", { [relative]: "promoted content" });
  ai.runPipeline(proposal.id, { testCommand: "true" });
  const promoted = ai.promoteChange(proposal.id, builder);
  assert(promoted.ok, `the change was not promoted: ${promoted.reason}`);
  assert(existsSync(target), "the promoted file was not written");
  const rolled = ai.rollback(proposal.id);
  assert(rolled.ok, `rollback failed: ${rolled.reason}`);
  assert(!existsSync(target), "rollback did not remove the file the change created");
});

/* --------------------------------------------------------------- snapshots --- */

test("snapshot create and restore round trips", async () => {
  const store = new SnapshotStore(`t1-${RUN}`);
  await store.start();
  const file = join(ensureOsPaths().data, `snap-${RUN}.txt`);
  writeFileSync(file, "original");
  const snapshot = store.create("first", [file]);
  writeFileSync(file, "changed");
  const result = store.restore(snapshot.id);
  assert(result.ok, `restore failed: ${result.detail}`);
  assertEqual(readFileSync(file, "utf8"), "original", "the file was not restored");
});

test("snapshot refuses to restore an altered snapshot", async () => {
  const store = new SnapshotStore(`t2-${RUN}`);
  await store.start();
  const file = join(ensureOsPaths().data, `snap2-${RUN}.txt`);
  writeFileSync(file, "original");
  const snapshot = store.create("first", [file]);
  const stored = join(ensureOsPaths().snapshots, `t2-${RUN}`, snapshot.id, snapshot.entries[0].stored);
  writeFileSync(stored, "tampered");
  const result = store.restore(snapshot.id);
  assert(!result.ok, "an altered snapshot was restored");
  assert(result.detail.toLowerCase().includes("altered"), "the refusal did not explain itself");
});

test("snapshot prune keeps the newest entries", async () => {
  const store = new SnapshotStore(`t3-${RUN}`, { maxSnapshots: 2 });
  await store.start();
  const file = join(ensureOsPaths().data, `snap3-${RUN}.txt`);
  writeFileSync(file, "x");
  for (let i = 0; i < 4; i += 1) store.create(`s${i}`, [file]);
  assert(store.history().length <= 2, "retention did not prune the old snapshots");
});

test("snapshot usage counts bytes", async () => {
  const store = new SnapshotStore(`t4-${RUN}`);
  await store.start();
  const file = join(ensureOsPaths().data, `snap4-${RUN}.txt`);
  writeFileSync(file, "some content that takes up space");
  store.create("usage", [file]);
  const usage = store.usage();
  assert(usage.snapshots >= 1 && usage.bytes > 0, "usage did not count the snapshot");
});

/* ------------------------------------------------------------------- comms --- */

function stunServer(mode: "good" | "wrong-transaction"): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const socket = createSocket("udp4");
    socket.on("message", (message: Buffer, remote: RemoteInfo) => {
      const magic = message.readUInt32BE(4);
      const transaction = message.subarray(8, 20);
      const mapped = Buffer.from([203, 0, 113, 7]);
      for (let i = 0; i < 4; i += 1) mapped[i] ^= message[4 + i];
      const body = Buffer.alloc(8);
      body.writeUInt8(0, 0);
      body.writeUInt8(0x01, 1);
      body.writeUInt16BE(51234 ^ (magic >>> 16), 2);
      mapped.copy(body, 4);
      const attribute = Buffer.alloc(12);
      attribute.writeUInt16BE(0x0020, 0);
      attribute.writeUInt16BE(8, 2);
      body.copy(attribute, 4);
      const header = Buffer.alloc(20);
      header.writeUInt16BE(0x0101, 0);
      header.writeUInt16BE(12, 2);
      header.writeUInt32BE(magic, 4);
      (mode === "wrong-transaction" ? Buffer.alloc(12) : transaction).copy(header, 8);
      socket.send(Buffer.concat([header, attribute]), remote.port, remote.address);
    });
    socket.bind(0, "127.0.0.1", () => {
      const address = socket.address();
      const port = address && typeof address === "object" ? address.port : 0;
      resolve({ port, close: () => socket.close() });
    });
  });
}

test("stun binding parses a synthetic reply", async () => {
  const server = await stunServer("good");
  try {
    const result = await stunBinding(`stun:127.0.0.1:${server.port}`, 1500);
    assert(result.ok, `STUN failed: ${result.error}`);
    assertEqual(result.address, "203.0.113.7", "the mapped address was misparsed");
    assertEqual(result.port, 51234, "the mapped port was misparsed");
  } finally {
    server.close();
  }
});

test("stun binding rejects a mismatched transaction", async () => {
  const server = await stunServer("wrong-transaction");
  try {
    const result = await stunBinding(`stun:127.0.0.1:${server.port}`, 1500);
    assert(!result.ok, "a reply with the wrong transaction id was accepted");
    assert((result.error ?? "").toLowerCase().includes("transaction"), "the mismatch was not named");
  } finally {
    server.close();
  }
});

test("sdp round trips through the parser", () => {
  const sdp = buildSdp({
    sessionId: "s1",
    address: "192.0.2.10",
    audioPort: 5004,
    videoPort: 5006,
    audio: true,
    video: true,
    screen: false,
    direction: "sendrecv",
  });
  const parsed = parseSdp(sdp);
  assertEqual(parsed.address, "192.0.2.10", "the connection address was not parsed");
  assert(parsed.media.some((entry) => entry.kind === "audio"), "the audio media line was lost");
  assert(parsed.media.some((entry) => entry.kind === "video"), "the video media line was lost");
  const audio = parsed.media.find((entry) => entry.kind === "audio");
  assert(audio?.codecs.includes("opus") === true, "the opus codec was lost");
  assertEqual(audio?.direction, "sendrecv", "the direction was lost");
});

test("ice priorities rank host above server reflexive", () => {
  assert(priority("host") > priority("srflx"), "host candidates should outrank server-reflexive ones");
  assert(priority("srflx") > priority("relay"), "server-reflexive candidates should outrank relay ones");
});

async function withComms<T>(fn: (engine: CommsEngine) => Promise<T>): Promise<T> {
  const engine = new CommsEngine();
  await engine.start();
  try {
    return await fn(engine);
  } finally {
    await engine.stop();
  }
}

test("call state machine rings answers and ends a call", async () => {
  await withComms(async (engine) => {
    const offer = buildSdp({ sessionId: "s", address: "198.51.100.5", audioPort: 5004, videoPort: 5006, audio: true, video: false, screen: false, direction: "sendrecv" });
    const ringing = await engine.receiveCall({ peer: "peer@example.com", offerSdp: offer });
    assertEqual(ringing.state, "ringing", "the call did not ring");
    const answered = engine.acceptIncoming(ringing.id);
    assertEqual(answered.session.state, "connected", "the call did not connect");
    assert(answered.answerSdp.includes("m=audio"), "the answer carried no media");
    const ended = await engine.end(ringing.id);
    assertEqual(ended.state, "ended", "the call did not end");
    assertEqual(engine.active().length, 0, "the ended call is still active");
  });
});

test("call separates internet from a carrier leg", async () => {
  await withComms(async (engine) => {
    const pstn = await engine.placeCall({ peer: "+15551234567" });
    assertEqual(pstn.leg.kind, "pstn", "a phone number was not treated as a carrier leg");
    assertEqual(pstn.state, "failed", "a carrier call with no carrier should fail honestly");
    const incoming = await engine.receiveCall({ peer: "peer@example.com", offerSdp: "v=0\r\n" });
    assertEqual(incoming.leg.kind, "internet", "an internet peer was not treated as an internet leg");
  });
});

/* ---------------------------------------------------------------- packages --- */

function testRecipe(name: string, depends: string[] = []): PackageRecipe {
  return makeRecipe({ name, version: "1.0.0", about: `${name} test package`, depends, files: { [`${name}.txt`]: `content of ${name}` } });
}

test("package resolve detects a missing requirement", async () => {
  const pkg = new PackageManager();
  await pkg.start();
  pkg.publish(testRecipe(`needs-${RUN}`, [`missing-${RUN}`]));
  assertThrows(() => pkg.resolve(`needs-${RUN}`), "no recipe provides it");
});

test("package resolve detects a dependency cycle", async () => {
  const pkg = new PackageManager();
  await pkg.start();
  const x = `x-${RUN}`;
  const y = `y-${RUN}`;
  pkg.publish(testRecipe(x, [y]));
  pkg.publish(testRecipe(y, [x]));
  assertThrows(() => pkg.resolve(x), "depends on itself");
});

test("package install stages content-addressed objects", async () => {
  const pkg = new PackageManager();
  await pkg.start();
  const name = `install-${RUN}`;
  pkg.publish(testRecipe(name));
  const result = pkg.install(name);
  assert(result.ok && result.installed.includes(name), `install failed: ${result.installed.join(",")}`);
  assert(pkg.installed().some((entry) => entry.name === name), "the package is not in the database");
  assert(pkg.storeSize().objects >= 1, "no object was staged in the store");
});

test("package verify detects a tampered file", async () => {
  const pkg = new PackageManager();
  await pkg.start();
  const name = `tamper-${RUN}`;
  pkg.publish(testRecipe(name));
  pkg.install(name);
  writeFileSync(join(pkg.installedRoot(), `${name}.txt`), "tampered");
  const result = pkg.verify(name);
  assert(!result.ok, "a tampered file verified clean");
  assert(result.mismatched.some((entry) => entry.path === `${name}.txt`), "the tampered file was not named");
});

test("package remove refuses when another depends on it", async () => {
  const pkg = new PackageManager();
  await pkg.start();
  const dep = `dep-${RUN}`;
  const app = `app-${RUN}`;
  pkg.publish(testRecipe(dep));
  pkg.publish(testRecipe(app, [dep]));
  pkg.install(app);
  const result = pkg.remove(dep);
  assert(!result.ok, "a required package was removed");
  assert((result.reason ?? "").includes(app), "the dependent package was not named");
});

test("package garbage collect keeps live objects", async () => {
  const pkg = new PackageManager();
  await pkg.start();
  const keep = `keep-${RUN}`;
  const drop = `drop-${RUN}`;
  pkg.publish(testRecipe(keep));
  pkg.publish(testRecipe(drop));
  pkg.install(keep);
  pkg.install(drop);
  pkg.remove(drop);
  const collected = pkg.garbageCollect();
  assert(collected.removed >= 1, "garbage collection removed nothing");
  assert(pkg.verify(keep).ok, "garbage collection removed an object a live package needs");
});

/* ------------------------------------------------------------------ update --- */

test("update status refuses to install on its own", () => {
  const status = new NovaSystem().updateStatus();
  assertEqual(status.installAvailable, false, "the OS claims it can install an update by itself");
  assert(status.note.length > 20, "the update status did not explain itself");
});

/* ------------------------------------------------------------------- audit --- */

test("audit reports a missing source", () => {
  const root = mkdtempSync(join(tmpdir(), "nova-audit-missing-"));
  const report = auditRequirements(
    [{ id: "m", section: "§0", title: "m", asks: "m", status: "implemented", sources: ["nope.ts"], tests: [], limits: [] }],
    root,
    join(root, "tests.ts"),
  );
  assert(report.findings.some((finding) => finding.kind === "missing-source"), "a missing source was not reported");
});

test("audit detects a forbidden word", () => {
  const root = mkdtempSync(join(tmpdir(), "nova-audit-forbidden-"));
  // The word is assembled so that this test file does not itself contain it.
  const forbidden = "TO" + "DO";
  writeFileSync(join(root, "bad.ts"), `// ${forbidden} later\n`);
  const report = auditRequirements(
    [{ id: "f", section: "§0", title: "f", asks: "f", status: "implemented", sources: ["bad.ts"], tests: [], limits: [] }],
    root,
    join(root, "tests.ts"),
  );
  assert(report.findings.some((finding) => finding.kind === "forbidden-word"), "a forbidden word was not reported");
});

test("audit counts statuses", () => {
  const root = mkdtempSync(join(tmpdir(), "nova-audit-status-"));
  writeFileSync(join(root, "ok.ts"), "// a clean file\n");
  const requirements: Requirement[] = [
    { id: "a", section: "§0", title: "a", asks: "a", status: "implemented", sources: ["ok.ts"], tests: [], limits: [] },
    { id: "b", section: "§0", title: "b", asks: "b", status: "blocked", sources: ["ok.ts"], tests: [], limits: ["blocked here"] },
  ];
  const report = auditRequirements(requirements, root, join(root, "tests.ts"));
  assertEqual(report.byStatus.implemented, 1, "the implemented count is wrong");
  assertEqual(report.byStatus.blocked, 1, "the blocked count is wrong");
  assertEqual(report.total, 2, "the total is wrong");
});

test("the test suite runs every registered case", () => {
  assert(results.length >= 50, `only ${results.length} cases ran before this one`);
});

/* ------------------------------------------------------------------- runner --- */

async function run(): Promise<void> {
  console.log("");
  console.log(`  NOVA OS tests — ${cases.length} cases, state under ${TEST_ROOT}`);
  console.log("");
  for (const current of cases) {
    const started = Date.now();
    try {
      await current.fn();
      results.push({ name: current.name, ok: true, ms: Date.now() - started, error: null });
      console.log(`  pass  ${current.name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ name: current.name, ok: false, ms: Date.now() - started, error: message });
      console.log(`  FAIL  ${current.name}`);
      console.log(`        ${message}`);
    }
  }

  const passed = results.filter((entry) => entry.ok).length;
  const failed = results.length - passed;
  console.log("");
  console.log(`  ${passed} passed, ${failed} failed of ${results.length}`);
  console.log("");

  const state = ensureOsPaths().state;
  mkdirSync(state, { recursive: true });
  writeFileSync(
    join(state, "test-report.json"),
    `${JSON.stringify({ at: Date.now(), passed, failed, total: results.length, os: "NOVA", results }, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(join(state, "test-run-root.txt"), `${osPaths().root}\n`, "utf8");

  if (failed > 0) process.exitCode = 1;
}

void run();
