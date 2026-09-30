/*
 * Storage that may not exist.
 *
 * Some browsers refuse browser storage outright: a page embedded in a sandboxed
 * frame, or one whose third-party storage is blocked, throws
 * "Failed to read the 'localStorage' property from 'Window': Access is denied
 * for this document." the moment anything touches it. That is thrown by the
 * browser, not by this app, and there is nothing the app can do to be allowed
 * it.
 *
 * The hub needs very little from storage, but not nothing: Convex Auth keeps
 * its token there, the Local Brain remembers which folder it points at, the
 * Control Room remembers which devices were allowed. None of that is worth
 * failing to start over. In a frame with no storage the app should still open
 * and work — it simply forgets between reloads.
 *
 * So this module probes once, and if the real thing throws it swaps in an
 * ordinary in-memory stand-in with the same shape. On any normal browser the
 * probe succeeds and not one line here does anything.
 *
 * It installs itself on import, deliberately: `main.tsx` imports it first, so
 * the replacement is in place before any other module — including a library —
 * can touch storage at its own import time.
 */

/** A Storage that lives in a Map and disappears with the page. */
function memoryStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    clear() {
      entries.clear();
    },
    getItem(key: string) {
      return entries.has(key) ? (entries.get(key) as string) : null;
    },
    key(index: number) {
      return [...entries.keys()][index] ?? null;
    },
    removeItem(key: string) {
      entries.delete(key);
    },
    setItem(key: string, value: string) {
      entries.set(key, String(value));
    },
  };
}

/** True when this storage can actually be read and written right now. */
function works(read: () => Storage): boolean {
  try {
    const storage = read();
    const probe = "__hub_storage_probe__";
    storage.setItem(probe, "1");
    storage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

/** Which of the two storages to stand in for. */
type StorageName = "localStorage" | "sessionStorage";

function replaceIfUnusable(name: StorageName) {
  const win = window as unknown as Record<StorageName, Storage>;
  const read = () => win[name];
  if (works(read)) return;

  const stand = memoryStorage();
  // `window` itself first, then its prototype: whichever one owns the property
  // is the one that has to be shadowed.
  for (const target of [window, Object.getPrototypeOf(window)] as object[]) {
    try {
      Object.defineProperty(target, name, {
        configurable: true,
        get: () => stand,
      });
      if (works(read)) return;
    } catch {
      // Try the next target.
    }
  }

  console.warn(
    `[storage] ${name} is unavailable and could not be replaced — the hub will run without it.`,
  );
}

export function installSafeStorage() {
  if (typeof window === "undefined") return;
  replaceIfUnusable("localStorage");
  replaceIfUnusable("sessionStorage");
}

installSafeStorage();
