/**
 * §25 Firewall handling — Linux.
 *
 * Linux has no single firewall: a machine may run ufw, firewalld, plain
 * nftables, plain iptables, or nothing at all. The host looks for each in turn
 * and reports what it found. As on every platform, nothing is changed without
 * consent, and the consenting call opens exactly one TCP port.
 */

import { execFileSync } from "node:child_process";
import type { FirewallState } from "../windows/firewall.ts";

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

function have(file: string): boolean {
  return run("which", [file]).ok;
}

export function detect(ruleName: string, port: number): FirewallState {
  const detail: string[] = [];

  if (have("ufw")) {
    const status = run("ufw", ["status"]);
    // "Status: inactive" or "ERROR: You need to be root" — both are answers.
    const active = /status:\s*active/i.test(status.out);
    const allowed = new RegExp(`^${port}/tcp\\s+ALLOW`, "im").test(status.out);
    detail.push(status.out.trim().split("\n").slice(0, 8).join("\n"));
    return {
      supported: true,
      enabled: active,
      ruleExists: allowed,
      allowed,
      needsAdmin: !status.ok,
      explanation: !status.ok
        ? "The host could not read ufw's rules without administrator rights, so it cannot yet say whether the firewall is blocking remote devices."
        : allowed
          ? `ufw is ${active ? "active" : "inactive"} and already allows TCP ${port}, so devices on your network can reach the host.`
          : `ufw is ${active ? "active" : "inactive"} and does not allow TCP ${port}. If it is active, other devices on your network cannot reach the host.`,
      detail,
    };
  }

  if (have("firewall-cmd")) {
    const state = run("firewall-cmd", ["--state"]);
    const active = /running/i.test(state.out);
    const ports = run("firewall-cmd", ["--list-ports"]);
    const allowed = new RegExp(`\\b${port}/tcp\\b`).test(ports.out);
    detail.push(`firewalld ${state.out.trim() || "unknown"}`, `open ports: ${ports.out.trim() || "none reported"}`);
    return {
      supported: true,
      enabled: active,
      ruleExists: allowed,
      allowed,
      needsAdmin: false,
      explanation: allowed
        ? `firewalld is running and already opens TCP ${port} for this machine.`
        : `firewalld is ${active ? "running" : "stopped"} and does not open TCP ${port}. Open it only if you want devices on your network to reach the host.`,
      detail,
    };
  }

  if (have("nft")) {
    const rules = run("nft", ["list", "ruleset"]);
    const allowed = new RegExp(`dport\\s*\\{?[^}]*\\b${port}\\b`).test(rules.out);
    detail.push(allowed ? `An nftables rule mentions port ${port}.` : "No nftables rule mentions this port.");
    return {
      supported: true,
      enabled: rules.ok ? true : null,
      ruleExists: allowed,
      allowed,
      needsAdmin: !rules.ok,
      explanation: !rules.ok
        ? "The nftables ruleset needs administrator rights to read, so the host cannot yet tell whether the firewall is involved."
        : allowed
          ? `nftables already has a rule for TCP ${port}.`
          : `nftables has no rule for TCP ${port}. If a policy is dropping inbound traffic, other devices on your network cannot reach the host.`,
      detail,
    };
  }

  if (have("iptables")) {
    const rules = run("iptables", ["-S"]);
    const allowed = new RegExp(`--dport ${port}\\b`).test(rules.out);
    detail.push(`iptables ${rules.ok ? "read" : "needs administrator rights"}.`);
    return {
      supported: true,
      enabled: rules.ok ? null : null,
      ruleExists: allowed,
      allowed,
      needsAdmin: !rules.ok,
      explanation:
        "This machine uses plain iptables. The host will not change those rules on its own — a single wrong rule can cut a server off entirely.",
      detail,
    };
  }

  detail.push("No ufw, firewalld, nftables or iptables command was found.");
  return {
    supported: false,
    enabled: null,
    ruleExists: false,
    allowed: null,
    needsAdmin: false,
    explanation: "No Linux firewall tool was found on this machine, so nothing appears to be blocking the host locally.",
    detail,
  };
}

/** Open exactly one TCP port, only after the user consents. */
export function allow(ruleName: string, port: number): { ok: boolean; command: string; output: string } {
  if (have("ufw")) {
    const command = `ufw allow ${port}/tcp comment '${ruleName}'`;
    const result = run("ufw", ["allow", `${port}/tcp`, "comment", ruleName]);
    return { ok: result.ok, command, output: result.out.trim() || (result.ok ? "Rule added." : "Elevation was refused.") };
  }
  if (have("firewall-cmd")) {
    const command = `firewall-cmd --add-port=${port}/tcp --permanent && firewall-cmd --reload`;
    const add = run("firewall-cmd", [`--add-port=${port}/tcp`, "--permanent"]);
    const reload = add.ok ? run("firewall-cmd", ["--reload"]) : { ok: false, out: "" };
    return {
      ok: add.ok && reload.ok,
      command,
      output: `${add.out.trim()} ${reload.out.trim()}`.trim() || (add.ok ? "Port opened." : "Elevation was refused."),
    };
  }
  return {
    ok: false,
    command: "",
    output:
      "This machine has no supported firewall tool, so there is nothing for the host to change. If remote access still fails, the block is elsewhere.",
  };
}
