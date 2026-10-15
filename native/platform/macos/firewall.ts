/**
 * §25 Firewall handling — macOS.
 *
 * macOS has two relevant layers: the Application Firewall
 * (`/usr/libexec/ApplicationFirewall/socketfilterfw`), which decides whether a
 * given program may accept inbound connections, and PF, which is almost always
 * off by default. The host reads the Application Firewall and reports it. It
 * does not change it silently: `allow()` runs only on a consenting request.
 */

import { execFileSync } from "node:child_process";
import type { FirewallState } from "../windows/firewall.ts";

const SOCKETFILTER = "/usr/libexec/ApplicationFirewall/socketfilterfw";

function run(file: string, args: string[]): { ok: boolean; out: string } {
  try {
    return {
      ok: true,
      out: execFileSync(file, args, { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "ignore"] }),
    };
  } catch (error) {
    const out =
      error && typeof error === "object" && "stdout" in error
        ? String((error as { stdout?: unknown }).stdout ?? "")
        : "";
    return { ok: false, out };
  }
}

export function detect(executable: string): FirewallState {
  const detail: string[] = [];
  const global = run(SOCKETFILTER, ["--getglobalstate"]);
  const stealth = run(SOCKETFILTER, ["--getstealthmode"]);
  const app = run(SOCKETFILTER, ["--getappblocked", executable]);

  // The tool says "Firewall is enabled. (State = 1)" or "…disabled. (State = 0)".
  const enabledMatch = /state\s*=\s*(\d)/i.exec(global.out);
  const enabled = enabledMatch ? enabledMatch[1] === "1" : null;
  const blocked = /is blocked/i.test(app.out);
  const allowed = app.ok ? !blocked : null;

  detail.push(global.out.trim() || "global state not reported");
  detail.push(stealth.out.trim() || "stealth mode not reported");
  if (app.out.trim()) detail.push(app.out.trim());

  return {
    supported: true,
    enabled,
    ruleExists: app.ok ? !blocked : null,
    allowed,
    needsAdmin: !global.ok || !app.ok,
    explanation:
      enabled === null
        ? "macOS would not report its firewall state to this program, so the host cannot yet tell whether it is involved."
        : !enabled
          ? "The macOS application firewall is switched off, so it is not blocking incoming connections to the host."
          : allowed
            ? "The macOS application firewall is on and already lets this program accept incoming connections."
            : "The macOS application firewall is on and this program is not allowed to accept incoming connections, so other devices cannot reach the host.",
    detail,
  };
}

/** Allow the host's own executable, only after the user consents (§25). */
export function allow(executable: string): { ok: boolean; command: string; output: string } {
  const add = run(SOCKETFILTER, ["--add", executable]);
  const unblock = add.ok ? run(SOCKETFILTER, ["--unblockapp", executable]) : { ok: false, out: "" };
  const command = `${SOCKETFILTER} --add "${executable}" && ${SOCKETFILTER} --unblockapp "${executable}"`;
  return {
    ok: add.ok && unblock.ok,
    command,
    output: `${add.out.trim()} ${unblock.out.trim()}`.trim() || (add.ok ? "Allowed." : "Elevation was refused."),
  };
}
