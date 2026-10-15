# SUGAR — the native host application

The host half of the specification. A real program that contains a real HTTP
server, a real outbound Internet client, a real embedded browser engine, a real
local API, a real secure tunnel client, real authentication, real network and VPN
detection, real automatic recovery, a real download centre and real diagnostics.

```bash
bun run host.ts                 # start the host and the dashboard
bun run host.ts --diagnostics   # TEST EVERYTHING + SELF TEST, then exit
bun run host.ts --relay <url>   # enable remote access through a relay
bun run relay.ts --port 8443    # run a relay on the machine that has a public address
bun run selfcheck.ts            # prove it works, end to end
```

`selfcheck.ts` is the one to run first. It starts a real relay, a real server and
a real tunnel, then makes a request *through* the relay to this host and checks
the answer came back. It exits non-zero if anything fails.

## Why the host exists

A browser tab cannot bind a listening port, hold a background service, embed a
browser engine, read the interface table or inspect a firewall. The specification
says so, and that is the reason there are two components: this host does the
things that need the operating system, and the web portal does everything a
browser legitimately can.

## The modules (§53)

| Directory | What it is |
| --- | --- |
| `core/` | Paths, logging with redaction, versioning, and the start-up sequence |
| `network/` | Interfaces, DNS, HTTPS, VPN, Starlink/CGNAT probing, the change monitor |
| `client/` | The outbound Internet client and the §30 agent |
| `server/` | The embedded HTTP server and the local API |
| `browser/` | The browser engine, the bridge, and the per-OS window hosts |
| `tunnel/` | The replaceable `TunnelProvider`, a real relay client, a real relay, a WebSocket echo |
| `auth/` | Sessions, lockout, CSRF, the admin proof |
| `devices/` | Expiring, single-use, revocable device pairing |
| `downloads/` | The download catalogue, the installers, and a dependency-free ZIP writer |
| `diagnostics/` | Reserved for additional suites; the two suites live in `core/app.ts` beside the state they test |
| `security/` | Reserved for policy declared in one place; headers and redaction are in `core/log.ts` and `server/server.ts` |
| `storage/` | One configuration file per section, plus the OS credential store |
| `ui/` | The dashboard and a real QR encoder |
| `platform/` | `windows/`, `linux/`, `macos/`: the firewall and the engine for each |
| `web-portal/` | The pages a remote browser gets |

## The interfaces the specification names

- §54 `startServer` `stopServer` `restartServer` `getServerStatus` `getLocalAddress` `getPort` `getConnections` — `server/server.ts`
- §55 `detectInterfaces` `getActiveInterface` `testInternet` `testDNS` `testHTTPS` `getVPNStatus` `getNetworkStatus` — `network/network.ts`
- §56 `connectRemote` `disconnectRemote` `reconnectRemote` `getRemoteStatus` `getPublicUrl` `testRemoteConnection` — `tunnel/provider.ts` and `SugarApp.remote()`
- §57 `createBrowser` `navigate` `back` `forward` `reload` `stop` `download` `getBrowserStatus` — `browser/engine.ts`
- §58 `runFullDiagnostics` `runNetworkDiagnostics` `runServerDiagnostics` `runBrowserDiagnostics` `runRemoteDiagnostics` `exportDiagnostics` — `core/app.ts`

## Running a relay

A Starlink connection cannot accept incoming connections; that is carrier-grade
NAT doing its job, not a fault. So the host holds one encrypted **outbound**
connection to a relay, and a remote browser talks to the relay.

```bash
# on a small server that has a real address
bun run relay.ts --port 8443 --secret "$(openssl rand -hex 24)"

# on the computer at home
bun run host.ts --relay http://that-server:8443 --secret <the same secret>
```

The address the relay assigns is the address the dashboard shows. If the tunnel
is not connected, the dashboard says there is no remote address — it never
invents one (§16).

## What the host will not pretend

- It will not claim a window exists when the machine has no display. The browser
  area still navigates, keeps history, holds cookies and saves downloads.
- It will not claim an inbound connection works when nothing has connected in.
- It will not disable a firewall. It reads the state, explains it, and changes
  one rule only after the user says yes (§25).
- It will not offer a signed installer it cannot sign. It offers a real installer
  script per platform instead (§26, §51).

## Requirements

`bun` (or Node 20+). For the browser *window* only: WebView2 + the .NET SDK on
Windows, WebKitGTK and PyGObject on Linux, `pyobjc-framework-WebKit` on macOS.
Each is listed with its official source in the download centre (§67), and each is
optional — the host runs and is reachable without any of them.
