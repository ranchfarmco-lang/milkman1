/**
 * §25 Firewall handling — Windows.
 *
 * The rule the specification sets is the one implemented here: detect, explain,
 * and only ever change anything with the user's explicit consent. Nothing in
 * this file modifies a firewall rule on its own. `detect()` reads the current
 * state; `allow()` is only reachable from a request that carries consent, and
 * it names exactly the one rule it adds.
 */

import { execFileSync } from "node:child_process";

export type FirewallState = {
  supported: boolean;
  /** Whether a firewall is switched on at all. */
  enabled: boolean | null;
  /** Whether a rule already lets this program through. */
  ruleExists: boolean | null;
  /** Whether the program is already allowed for the current profile. */
  allowed: boolean | null;
  /** True when reading or changing the rules needs elevation. */
  needsAdmin: boolean;
  /** Plain-English sentence for beginner mode (§23). */
  explanation: string;
  detail: string[];
};

function netsh(args: string[]): { ok: boolean; out: string } {
  try {
    return {
      ok: true,
      out: execFileSync("netsh", args, { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }),
    };
  } catch (error) {
    const out =
      error && typeof error === "object" && "stdout" in error
        ? String((error as { stdout?: unknown }).stdout ?? "")
        : "";
    return { ok: false, out };
  }
}

export function detect(ruleName: string): FirewallState {
  const detail: string[] = [];
  const profile = netsh(["advfirewall", "show", "allprofiles", "state"]);

  if (!profile.ok) {
    return {
      supported: true,
      enabled: null,
      ruleExists: null,
      allowed: null,
      needsAdmin: true,
      explanation:
        "Windows would not report its firewall state to this program. Reading it needs an administrator, so the host cannot tell yet whether the firewall is blocking remote devices.",
      detail: [profile.out.trim() || "netsh returned nothing"],
    };
  }

  const enabledMatches = [...profile.out.matchAll(/State\s+(\w+)/gi)].map((m) => m[1].toLowerCase());
  const enabled = enabledMatches.includes("on");
  detail.push(...profile.out.trim().split("\n").map((line) => line.trim()).filter(Boolean));

  const rules = netsh(["advfirewall", "firewall", "show", "rule", `name=${ruleName}`]);
  const ruleExists = rules.ok && rules.out.includes(ruleName);
  detail.push(ruleExists ? `Firewall rule "${ruleName}" exists.` : `No firewall rule named "${ruleName}" yet.`);

  return {
    supported: true,
    enabled,
    ruleExists,
    allowed: ruleExists ? true : false,
    needsAdmin: !ruleExists,
    explanation: ruleExists
      ? "Windows Firewall is on and already has a rule for SUGAR, so devices on your network can reach it."
      : "Windows Firewall is on and has no rule for SUGAR yet. Windows may be stopping other devices on your network from reaching the host.",
    detail,
  };
}

/**
 * Add exactly one inbound rule for exactly one program on one port.
 * Called only after the user presses ALLOW (§25); the host never disables the
 * firewall, and never widens the rule beyond its own port.
 */
export function allow(ruleName: string, executable: string, port: number): { ok: boolean; command: string; output: string } {
  const args = [
    "advfirewall",
    "firewall",
    "add",
    "rule",
    `name=${ruleName}`,
    "dir=in",
    "action=allow",
    "protocol=TCP",
    `localport=${port}`,
    `program=${executable}`,
    "profile=private",
    "enable=yes",
  ];
  const command = `netsh ${args.join(" ")}`;
  const result = netsh(args);
  return { ok: result.ok, command, output: result.out.trim() || (result.ok ? "Rule added." : "Elevation was refused.") };
}
