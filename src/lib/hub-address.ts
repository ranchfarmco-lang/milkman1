/**
 * The address the hub calls itself.
 *
 * One address, decided in one place, so the portal, the invite and the box
 * links cannot disagree. The owner sets it in the Control Room (`site.address`
 * in the database); when it has never been set the hub falls back to the page's
 * own origin, which is exactly what it did before the address was settable.
 *
 * The stored value is a bare address with no trailing slash; everything that
 * shows or copies it wants the trailing slash, so that is added here.
 */
import { api } from "@/convex/_generated/api";
import { useQuery } from "convex/react";
import { useEffect } from "react";

/** Turn whatever was typed into one clean address, or "" if it cannot be one. */
export function normaliseHubAddress(raw: string | null | undefined): string {
  const trimmed = String(raw ?? "")
    .replace(/\s+/g, "")
    .replace(/\/+$/, "");
  if (!trimmed) return "";
  const withScheme = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return withScheme;
  } catch {
    return "";
  }
}

/** This page's own origin, without a trailing slash. Empty off the browser. */
function pageOrigin(): string {
  if (typeof window === "undefined") return "";
  return window.location.origin.replace(/\/+$/, "");
}

/**
 * The hub's address with a trailing slash, given a configured value and (for
 * tests) an origin. Pure: the same inputs always give the same answer, so the
 * screen that shows the address and the button that copies it agree.
 */
export function resolveHubAddress(
  configured: string | null | undefined,
  here?: string | null,
): string {
  const clean = normaliseHubAddress(configured);
  if (clean) return `${clean}/`;
  const origin = String(here ?? "").replace(/\/+$/, "");
  return origin ? `${origin}/` : "";
}

/**
 * The address for a plain caller — a copy handler, a link builder — that is not
 * a hook. It uses the last value the hub read, which the hook below keeps fresh,
 * and falls back to this page's own origin until then.
 */
let lastAddress: string | null = null;

export function hubBase(): string {
  const clean = normaliseHubAddress(lastAddress) || pageOrigin();
  return clean;
}

/** One full link to a page of the hub, e.g. `hubLink("/offline-brain")`. */
export function hubLink(path = "/"): string {
  const base = hubBase();
  if (!base) return path;
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * The hub's address, live from the database. Reactive: changing it in the
 * Control Room moves every screen showing it, with no reload.
 */
export function useHubAddress(): string {
  const stored = useQuery(api.site.address);
  const value = resolveHubAddress(stored, pageOrigin());
  useEffect(() => {
    lastAddress = stored ?? null;
  }, [stored]);
  return value;
}
