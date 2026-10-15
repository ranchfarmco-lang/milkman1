/**
 * The one place that knows which operating system it is on.
 *
 * Everything OS-specific in the host goes through here, so the rest of the code
 * never asks "am I on Windows?" and never grows a conditional per platform.
 */

import type { FirewallState } from "./windows/firewall.ts";

export type PlatformId = "windows" | "linux" | "macos" | "other";

export function platformId(): PlatformId {
  switch (process.platform) {
    case "win32":
      return "windows";
    case "linux":
      return "linux";
    case "darwin":
      return "macos";
    default:
      return "other";
  }
}

export type FirewallCheck = FirewallState & { platform: PlatformId; ruleName: string | null };
export type FirewallResult = { ok: boolean; command: string; output: string };

/** Detect the local firewall state on this platform. Read-only. */
export async function detectFirewall(port: number, executable: string): Promise<FirewallCheck> {
  const id = platformId();
  const ruleName = "SUGAR Local Server";
  try {
    if (id === "windows") {
      const { detect } = await import("./windows/firewall.ts");
      return { ...detect(ruleName), platform: id, ruleName };
    }
    if (id === "linux") {
      const { detect } = await import("./linux/firewall.ts");
      return { ...detect(ruleName, port), platform: id, ruleName };
    }
    if (id === "macos") {
      const { detect } = await import("./macos/firewall.ts");
      return { ...detect(executable), platform: id, ruleName: null };
    }
  } catch (error) {
    return {
      supported: false,
      enabled: null,
      ruleExists: null,
      allowed: null,
      needsAdmin: false,
      platform: id,
      ruleName: null,
      explanation: `The firewall could not be inspected on this system: ${error instanceof Error ? error.message : String(error)}`,
      detail: [],
    };
  }
  return {
    supported: false,
    enabled: null,
    ruleExists: null,
    allowed: null,
    needsAdmin: false,
    platform: id,
    ruleName: null,
    explanation: "This operating system has no firewall adapter in the host yet.",
    detail: [],
  };
}

/**
 * Add the one rule that lets this program be reached. Only called with consent
 * (§25); never disables the firewall and never opens more than the host's port.
 */
export async function allowFirewall(port: number, executable: string): Promise<FirewallResult> {
  const id = platformId();
  if (id === "windows") {
    const { allow } = await import("./windows/firewall.ts");
    return allow("SUGAR Local Server", executable, port);
  }
  if (id === "linux") {
    const { allow } = await import("./linux/firewall.ts");
    return allow("SUGAR Local Server", port);
  }
  if (id === "macos") {
    const { allow } = await import("./macos/firewall.ts");
    return allow(executable);
  }
  return { ok: false, command: "", output: "This operating system has no firewall adapter in the host yet." };
}

/**
 * The embedded browser engine this platform provides (§7). The host's message
 * is: use the system's own engine, never a bundled download of one.
 */
export function embeddedEngine(): { engine: string; detail: string } {
  switch (platformId()) {
    case "windows":
      return { engine: "WebView2", detail: "Microsoft Edge WebView2, the engine Windows itself ships and updates." };
    case "macos":
      return { engine: "WKWebView", detail: "WebKit through WKWebView, the engine Safari uses on this system." };
    case "linux":
      return {
        engine: "WebKitGTK",
        detail: "WebKitGTK when it is installed; otherwise the host renders through its own client and says so.",
      };
    default:
      return { engine: "none", detail: "No embedded engine is available on this system." };
  }
}
