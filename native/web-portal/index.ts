/**
 * §19 the remote web portal, §47 the remote device experience, §63 the result.
 *
 * This module is the remote half of the user interface: what a phone, a tablet
 * or somebody else's computer gets when it opens the public address. It is the
 * same dashboard the host shows locally — the specification is explicit that a
 * remote user should see the actual host status, not a reduced one — with two
 * differences that exist for real reasons rather than for looks:
 *
 *   · the sign-in page is shown whenever the host has a password and the caller
 *     has no session, because remote access is exactly where authentication
 *     matters (§17);
 *   · a short line says where this page came from, so nobody has to guess
 *     whether they are looking at the host itself or at it through a relay.
 *
 * It is deliberately responsive with no separate mobile build (§47): one page,
 * fluid grid, touch-sized controls.
 */

import { renderPortal, firstRunLine, wizardState, type PortalModel } from "../ui/portal.ts";
import { config } from "../storage/config.ts";

export type { PortalModel };

/** Everything a remote browser is shown, for one request. */
export function renderRemotePortal(model: PortalModel): string {
  const state = wizardState();
  const firstRun =
    config.get("state").firstRunResult && config.get("state").firstRunResult !== "NOT RUN"
      ? firstRunLine(config.get("state").firstRunResult)
      : undefined;

  return renderPortal({
    ...model,
    firstRunResult: firstRun,
    mode: state.mode,
  });
}

/** §47 — what this build adapts to, stated so it can be checked rather than believed. */
export function remoteDeviceSupport(): { device: string; how: string }[] {
  return [
    { device: "Android phone or tablet", how: "Chrome, Edge, Firefox, Samsung Internet — the same dashboard, touch-sized controls." },
    { device: "iPhone or iPad", how: "Safari or Chrome for iOS. iOS cannot run the host itself; it is a portal client, which is all it needs to be." },
    { device: "Chromebook", how: "Chrome on ChromeOS. The host can also run inside the Linux container." },
    { device: "Windows computer", how: "Edge, Chrome or Firefox." },
    { device: "Linux computer", how: "Firefox, Chromium or WebKit." },
    { device: "macOS", how: "Safari or Chrome." },
  ];
}
