import { connectionApi, wakeLockApi } from "@/lib/device-actions";
import { useCallback, useEffect, useState } from "react";

export type PermissionState =
  | "granted"
  | "denied"
  | "prompt"
  | "unsupported"
  | "unknown";

/** Setting id → the browser permission that backs it. */
const PERMISSIONS: Record<string, string> = {
  camera: "camera",
  microphone: "microphone",
  notifications: "notifications",
  clipboard: "clipboard-read",
};

export type DeviceStatus = {
  online: boolean;
  connection: string | null;
  downlink: number | null;
  permissions: Record<string, PermissionState>;
  supports: Record<string, boolean>;
  refresh: () => void;
  /** Note that this device allowed one of them, for the browsers that keep quiet. */
  remember: (id: string) => void;
};

/**
 * The browsers cannot all be asked. Chrome refuses to report the camera and the
 * microphone, so `query` throws and the Permissions API answers "unsupported";
 * Safari throws on names it does not know. Once a person has actually allowed
 * one of those on *this* device, that fact is written here — which is the only
 * honest way to keep the switch on for a permission the browser will not talk
 * about. It is per device and per browser, so a phone never inherits a
 * laptop's answer.
 */
const GRANTS_KEY = "hub.permission-grants";

function readGrants(): Record<string, boolean> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(GRANTS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, boolean>)
      : {};
  } catch {
    // Private browsing, or something else wrote there. Nothing is lost.
    return {};
  }
}

async function readPermission(name: string): Promise<PermissionState> {
  if (!navigator.permissions?.query) return "unknown";
  try {
    const status = await navigator.permissions.query({
      name,
    } as PermissionDescriptor);
    return status.state as PermissionState;
  } catch {
    // Chrome does not expose camera and microphone here; Safari throws on
    // names it does not know. Either way, we simply cannot tell yet.
    return "unsupported";
  }
}

/**
 * What this browser will actually let the app do. Nothing is guessed: every
 * value comes from a real capability or permission check.
 */
export function useDeviceStatus(): DeviceStatus {
  const [permissions, setPermissions] = useState<
    Record<string, PermissionState>
  >({});
  const [supports, setSupports] = useState<Record<string, boolean>>({});
  const [online, setOnline] = useState(true);
  const [connection, setConnection] = useState<string | null>(null);
  const [downlink, setDownlink] = useState<number | null>(null);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((value) => value + 1), []);

  const remember = useCallback((id: string) => {
    if (!(id in PERMISSIONS)) return;
    try {
      window.localStorage.setItem(
        GRANTS_KEY,
        JSON.stringify({ ...readGrants(), [id]: true }),
      );
    } catch {
      // If it cannot be written, the row still reads correctly for this visit.
    }
    setPermissions((previous) => ({ ...previous, [id]: "granted" }));
  }, []);

  useEffect(() => {
    let cancelled = false;

    setOnline(navigator.onLine);
    const net = connectionApi();
    setConnection(net?.effectiveType ?? net?.type ?? null);
    setDownlink(typeof net?.downlink === "number" ? net.downlink : null);

    setSupports({
      camera: Boolean(navigator.mediaDevices?.getUserMedia),
      microphone: Boolean(navigator.mediaDevices?.getUserMedia),
      notifications:
        typeof window !== "undefined" && "Notification" in window,
      clipboard: Boolean(navigator.clipboard?.readText),
      fullscreen: Boolean(document.documentElement.requestFullscreen),
      keep_screen_awake: Boolean(wakeLockApi()),
    });

    const grants = readGrants();
    const entries = Object.entries(PERMISSIONS);
    void Promise.all(
      entries.map(async ([id, name]) => {
        const state = await readPermission(name);
        // granted, denied and prompt always come from the browser itself; only
        // the two "cannot tell" answers fall back to what this device was told.
        const certain =
          state === "granted" || state === "denied" || state === "prompt";
        return [id, certain || !grants[id] ? state : "granted"] as const;
      }),
    ).then((results) => {
      if (cancelled) return;
      setPermissions(Object.fromEntries(results));
    });

    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    return () => {
      cancelled = true;
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [tick]);

  return {
    online,
    connection,
    downlink,
    permissions,
    supports,
    refresh,
    remember,
  };
}
