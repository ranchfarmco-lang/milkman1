import { useEffect, useState, useSyncExternalStore } from "react";

/**
 * How the connection in front of you is doing, measured rather than guessed.
 *
 * Nothing here is invented: every number comes from the browser itself. Where
 * the browser offers nothing — Firefox and Safari have no network-information
 * API at all — the reading is absent rather than faked, because a made-up speed
 * is worse than a blank one.
 */

/** What the browser will say about the link, where it says anything. */
export type DeviceLink = {
  online: boolean;
  /** 4g, 3g, 2g, slow-2g — the browser's own estimate of the link. */
  effectiveType: string | null;
  /** Megabits a second, as the browser estimates it. */
  downlinkMbps: number | null;
  /** Round trip in milliseconds, as the browser estimates it. */
  rttMs: number | null;
};

type NetworkInformation = {
  effectiveType?: string;
  downlink?: number;
  rtt?: number;
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
};

function connectionInfo(): NetworkInformation | null {
  if (typeof navigator === "undefined") return null;
  const withConnection = navigator as Navigator & {
    connection?: NetworkInformation;
  };
  return withConnection.connection ?? null;
}

function readLink(): DeviceLink {
  const info = connectionInfo();
  return {
    online: typeof navigator === "undefined" ? true : navigator.onLine,
    effectiveType: info?.effectiveType ?? null,
    downlinkMbps: typeof info?.downlink === "number" ? info.downlink : null,
    rttMs: typeof info?.rtt === "number" ? info.rtt : null,
  };
}

// `useSyncExternalStore` compares snapshots by identity, so the reading is
// cached: building a fresh object on every call would re-render for ever.
let cached: DeviceLink | null = null;
let cachedKey = "";

function snapshot(): DeviceLink {
  const next = readLink();
  const key = `${next.online}|${next.effectiveType}|${next.downlinkMbps}|${next.rttMs}`;
  if (cached === null || key !== cachedKey) {
    cachedKey = key;
    cached = next;
  }
  return cached;
}

function subscribe(onChange: () => void) {
  if (typeof window === "undefined") return () => {};

  const info = connectionInfo();
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  info?.addEventListener?.("change", onChange);

  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
    info?.removeEventListener?.("change", onChange);
  };
}

/** Online, and as much about the link as this browser is willing to say. */
export function useDeviceLink(): DeviceLink {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** How long a window the rate is averaged over. */
const WINDOW_MS = 10_000;

/** How often the figure moves. */
const TICK_MS = 1_000;

export type PageRate = {
  /** Bytes a second this page has been pulling in, over the last ten seconds. */
  perSecond: number;
  /** Everything this page has received since it opened. */
  totalBytes: number;
};

/**
 * What this page is actually pulling down, live.
 *
 * Measured from the browser's own resource timings — every response the page
 * receives is counted — so it is real traffic, not an estimate. It is the rate
 * the hub's own data arrives at: the board, the trace, the conversation.
 */
export function usePageRate(): PageRate {
  const [rate, setRate] = useState<PageRate>({ perSecond: 0, totalBytes: 0 });

  useEffect(() => {
    if (typeof PerformanceObserver === "undefined") return;

    let total = 0;
    let recent: { at: number; bytes: number }[] = [];

    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const bytes = (entry as PerformanceResourceTiming).transferSize ?? 0;
        if (!bytes) continue;
        total += bytes;
        recent.push({ at: Date.now(), bytes });
      }
    });

    try {
      observer.observe({ type: "resource", buffered: false });
    } catch {
      return;
    }

    const timer = window.setInterval(() => {
      const cutoff = Date.now() - WINDOW_MS;
      recent = recent.filter((one) => one.at >= cutoff);
      const bytes = recent.reduce((sum, one) => sum + one.bytes, 0);
      setRate({
        perSecond: Math.round(bytes / (WINDOW_MS / 1000)),
        totalBytes: total,
      });
    }, TICK_MS);

    return () => {
      observer.disconnect();
      window.clearInterval(timer);
    };
  }, []);

  return rate;
}
