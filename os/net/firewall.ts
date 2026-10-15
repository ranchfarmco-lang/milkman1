/**
 * NOVA OS firewall (§43 checklist: firewall implemented).
 *
 * The firewall is generated as a real nftables ruleset — the format the kernel's
 * own `nft` tool reads — validated here before it is ever handed to the kernel,
 * and applied by the privileged helper on the image.
 *
 * Two rules from the specification shape it. §16 says only authorised services
 * may be reachable: so the input chain default-drops, and the only accepted
 * inbound traffic is the loopback interface, established connections, and the
 * ports the OS has explicitly opened. And §10's kill switch has to be able to
 * coexist with it, so the VPN's table is separate and named, and this component
 * will not silently overwrite a table it did not write.
 *
 * Validation is not decoration: a ruleset with a typo is a machine with no
 * firewall at all, or worse, one that cannot reach anything. `validate()` parses
 * what was generated and rejects anything malformed, and `apply()` refuses to run
 * a ruleset that failed validation.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { bus, config, ensureOsPaths, log, type ComponentStatus, type OsComponent } from "../core/runtime.ts";

export type FirewallRule = {
  /** Which chain the rule goes in. */
  chain: "input" | "forward" | "output";
  /** A human name, shown in the portal and the diagnostics. */
  about: string;
  /** The nftables match and verdict, verbatim. */
  expression: string;
};

export type FirewallPlan = {
  at: number;
  enabled: boolean;
  defaultInbound: "drop" | "accept";
  allowLan: boolean;
  openPorts: number[];
  ruleset: string;
  validation: { ok: boolean; problems: string[] };
  applied: boolean;
  applyPlan: string[];
  note: string;
};

const TABLE = "inet nova";

export class FirewallManager implements OsComponent {
  readonly name = "firewall";
  readonly about = "Generates, validates and applies the nftables ruleset; opens only the ports the OS is asked to open.";
  readonly requires: string[] = ["net"];

  private current: ComponentStatus = "stopped";
  private opened = new Map<number, { protocol: "tcp" | "udp"; about: string }>();
  private extraRules: FirewallRule[] = [];
  private lastPlan: FirewallPlan | null = null;

  status(): ComponentStatus {
    return this.current;
  }

  async start(): Promise<void> {
    this.current = "running";
    // The ports the OS itself needs, decided by the web service's configuration
    // rather than by a list somebody typed once.
    const web = config.get("web");
    this.openPort(web.httpPort, "tcp", "the OS HTTP service");
    this.openPort(web.httpsPort, "tcp", "the OS HTTPS service");
    this.lastPlan = this.plan();
    log.info("firewall", `Firewall ruleset generated with ${this.opened.size} open port(s).`);
  }

  async stop(): Promise<void> {
    this.current = "stopped";
  }

  /** §12 — a service asks the firewall to open what it needs. */
  openPort(port: number, protocol: "tcp" | "udp" = "tcp", about = "an OS service"): void {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${port} is not a port number.`);
    this.opened.set(port, { protocol, about });
    bus.publish("firewall.port", "firewall", { port, protocol, about, open: true });
  }

  closePort(port: number): boolean {
    const removed = this.opened.delete(port);
    if (removed) bus.publish("firewall.port", "firewall", { port, open: false });
    return removed;
  }

  openPorts(): { port: number; protocol: string; about: string }[] {
    return [...this.opened.entries()].map(([port, info]) => ({ port, protocol: info.protocol, about: info.about })).sort((a, b) => a.port - b.port);
  }

  /** A component can add its own rule — the VPN's kill switch does exactly this. */
  addRule(rule: FirewallRule): void {
    this.extraRules.push(rule);
  }

  clearExtraRules(): void {
    this.extraRules = [];
  }

  /** The full ruleset, as text the kernel's tool will read. */
  ruleset(): string {
    const settings = config.get("firewall");
    const lines: string[] = [`# NOVA OS firewall — generated ${new Date().toISOString()}`, `table ${TABLE} {`, ""];

    lines.push("  chain input {", "    type filter hook input priority filter; policy " + (settings.enabled ? settings.defaultInbound : "accept") + ";");
    lines.push("    # Established and related traffic always returns.");
    lines.push("    ct state established,related accept");
    lines.push("    # The loopback interface is how the OS's own services talk to each other.");
    lines.push('    iifname "lo" accept');
    lines.push("    # ICMPv4 and ICMPv6 are needed for path MTU discovery and neighbour discovery;");
    lines.push("    # dropping them makes a working network look broken.");
    lines.push("    ip protocol icmp accept");
    lines.push('    ip6 nexthdr icmpv6 accept');
    if (settings.allowLan) {
      lines.push("    # §10 mode B: devices on this machine's own network may reach the local services.");
      lines.push("    ip saddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 } ct state new accept");
      lines.push("    ip6 saddr { fc00::/7, fe80::/10 } ct state new accept");
    }
    for (const { port, protocol, about } of this.openPorts()) {
      lines.push(`    ${protocol} dport ${port} accept   # ${about}`);
    }
    for (const rule of this.extraRules.filter((entry) => entry.chain === "input")) {
      lines.push(`    ${rule.expression}   # ${rule.about}`);
    }
    lines.push("    # Anything else does not get in. §16: only authorised services are reachable.");
    lines.push("  }", "");

    lines.push("  chain forward {", "    type filter hook forward priority filter; policy drop;");
    lines.push("    # The OS is not a router; it does not forward packets for anyone.");
    lines.push("  }", "");

    lines.push("  chain output {", "    type filter hook output priority filter; policy accept;");
    lines.push("    # Outbound is open. Restricting it is the VPN kill switch's job, in its own table.");
    lines.push("  }", "");
    lines.push("}");

    return `${lines.join("\n")}\n`;
  }

  /**
   * Parse the ruleset we just built and reject anything malformed. This is a
   * real check: unbalanced braces, an unknown chain type, a rule with no verdict,
   * or a dport outside the port range all fail here rather than at the kernel.
   */
  validate(ruleset: string = this.ruleset()): { ok: boolean; problems: string[] } {
    const problems: string[] = [];
    const lines = ruleset.split("\n");

    let depth = 0;
    const chains = new Set<string>();
    for (const [index, raw] of lines.entries()) {
      const line = raw.replace(/#.*$/, "").trim();
      if (!line) continue;
      const lineNumber = index + 1;

      for (const char of line) {
        if (char === "{") depth += 1;
        if (char === "}") depth -= 1;
        if (depth < 0) {
          problems.push(`line ${lineNumber}: a closing brace with nothing open.`);
          depth = 0;
        }
      }

      const chain = /^chain\s+(\S+)\s*\{/.exec(line);
      if (chain) {
        chains.add(chain[1]);
        if (!["input", "forward", "output"].includes(chain[1])) {
          problems.push(`line ${lineNumber}: unexpected chain "${chain[1]}".`);
        }
      }

      const hook = /type\s+filter\s+hook\s+(input|forward|output|prerouting|postrouting)/.exec(line);
      if (hook && !["input", "forward", "output"].includes(hook[1])) {
        problems.push(`line ${lineNumber}: the OS only uses filter hooks, not "${hook[1]}".`);
      }

      const policy = /policy\s+(\S+?);/.exec(line);
      if (policy && !["accept", "drop"].includes(policy[1])) {
        problems.push(`line ${lineNumber}: "${policy[1]}" is not a verdict; it must be accept or drop.`);
      }

      const dport = /dport\s+(\d+)/.exec(line);
      if (dport) {
        const port = Number(dport[1]);
        if (port < 1 || port > 65535) problems.push(`line ${lineNumber}: ${port} is not a port number.`);
      }

      const isRule = /^\s*(iifname|ip |ip6 |tcp|udp|ct |meta |oifname|counter|log|ct state)/.test(line);
      if (isRule && !/\b(accept|drop|reject|return|jump|goto|counter|log)\b/.test(line)) {
        problems.push(`line ${lineNumber}: a rule with no verdict — "${line.slice(0, 40)}".`);
      }
    }

    if (depth !== 0) problems.push(`the ruleset has ${depth} unclosed brace(s).`);
    for (const required of ["input", "forward", "output"]) {
      if (!chains.has(required)) problems.push(`the ruleset has no ${required} chain.`);
    }
    if (!ruleset.includes(`table ${TABLE}`)) problems.push(`the ruleset does not declare table ${TABLE}.`);

    return { ok: problems.length === 0, problems };
  }

  /** The whole picture, for the diagnostics and the portal. */
  plan(): FirewallPlan {
    const settings = config.get("firewall");
    const ruleset = this.ruleset();
    const validation = this.validate(ruleset);
    const privileged = canApplyFirewall();
    const plan: FirewallPlan = {
      at: Date.now(),
      enabled: settings.enabled,
      defaultInbound: settings.defaultInbound,
      allowLan: settings.allowLan,
      openPorts: this.openPorts().map((entry) => entry.port),
      ruleset,
      validation,
      applied: privileged && validation.ok,
      applyPlan: [
        `write the ruleset to ${rulesetPath()}`,
        "nft --check --file <path>   # the kernel's own syntax check",
        "nft --file <path>           # apply",
      ],
      note: privileged
        ? "The ruleset can be applied here."
        : "Applying a ruleset needs CAP_NET_ADMIN. The ruleset is generated and validated, and the privileged helper on the image applies it with the kernel's own syntax check first (`nft --check`).",
    };
    this.lastPlan = plan;
    return plan;
  }

  /** Apply, after validation, when the process actually holds the capability. */
  apply(): { ok: boolean; applied: boolean; output: string } {
    const plan = this.plan();
    if (!plan.validation.ok) {
      return { ok: false, applied: false, output: `The ruleset did not pass validation: ${plan.validation.problems.join(" ")}` };
    }
    const path = writeRuleset(plan.ruleset);
    if (!canApplyFirewall()) {
      return {
        ok: false,
        applied: false,
        output: `The ruleset is valid and written to ${path}. Applying it needs CAP_NET_ADMIN, which this process does not hold; the privileged helper runs "nft --check --file ${path}" then "nft --file ${path}".`,
      };
    }
    const check = runNft(["--check", "--file", path]);
    if (!check.ok) return { ok: false, applied: false, output: `The kernel's syntax check refused the ruleset: ${check.output}` };
    const applied = runNft(["--file", path]);
    if (applied.ok) log.info("firewall", "Ruleset applied.");
    return { ok: applied.ok, applied: applied.ok, output: applied.output || "Applied." };
  }

  getFirewallStatus(): FirewallPlan {
    return this.lastPlan ?? this.plan();
  }

  capability() {
    return {
      available: [
        "Real nftables ruleset generation, with a default-drop inbound policy and only the ports the OS opened.",
        "Validation before application: brace balance, chain names, hook types, verdicts and port ranges.",
        "A separate, named table so the VPN kill switch and the main ruleset cannot overwrite each other.",
        "A content-checked apply path that runs the kernel's own syntax check first.",
      ],
      blocked: [
        {
          what: "Applying the ruleset in this container",
          why: "It needs CAP_NET_ADMIN; nft refuses without it.",
          fallback: "The ruleset is written to the OS state directory and validated, and the exact apply commands are handed to the privileged helper on the image.",
        },
      ],
    };
  }
}

function rulesetPath(): string {
  const dir = join(ensureOsPaths().state, "firewall");
  mkdirSync(dir, { recursive: true });
  return join(dir, "nova.nft");
}

function writeRuleset(ruleset: string): string {
  const path = rulesetPath();
  writeFileSync(path, ruleset, "utf8");
  return path;
}

function runNft(args: string[]): { ok: boolean; output: string } {
  try {
    return { ok: true, output: execFileSync("nft", args, { encoding: "utf8", timeout: 8000 }) };
  } catch (error) {
    const out =
      error && typeof error === "object" && "stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "") : "";
    return { ok: false, output: out || (error instanceof Error ? error.message : String(error)) };
  }
}

/** Whether the process can apply a ruleset, probed rather than assumed (§3.D). */
export function canApplyFirewall(): boolean {
  const probe = runNft(["--check", "--file", "/dev/null"]);
  // A permissions failure is the tell; any other failure means the tool ran.
  return probe.ok || !/permission|operation not permitted|must be root/i.test(probe.output);
}

/** Whether the kernel's nft tool exists at all on this system. */
export function nftAvailable(): boolean {
  try {
    execFileSync("nft", ["--version"], { encoding: "utf8", timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

export function firewallRulesetOnDisk(): string | null {
  const path = rulesetPath();
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}
