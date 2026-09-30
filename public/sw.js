/*
 * Family Chat Hub — offline-ish shell.
 *
 * This worker exists for two reasons: browsers refuse to install a web app that
 * has no fetch handler, and the icons should not be re-downloaded every launch.
 *
 * It is deliberately narrow. It never touches navigations, the app shell or the
 * Convex endpoints, so a stale cache can never serve an old build — the app is
 * useless without the server anyway. Bump VERSION to force a clean cache.
 */
const VERSION = "family-chat-hub-v1";

/** Icons and the logo: tiny, never hashed, safe to keep. */
const ASSET_PATH = /^\/(icons\/[^/]+|logo\.svg)$/;

/** Vite's build output always carries a content hash, so a hit is always current. */
const HASHED_ASSET = /^\/assets\/[^/]+\.[0-9a-f]{8,}\.(?:js|css|woff2?|png|svg|webp)$/;

const MANIFEST_PATH = "/manifest.webmanifest";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) =>
        cache.addAll([
          "/icons/icon-192.png",
          "/icons/icon-512.png",
          "/icons/icon-maskable-512.png",
          "/icons/apple-touch-icon.png",
          "/logo.svg",
        ]),
      )
      // A missing icon must never block the install.
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key !== VERSION).map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  // Anything off-origin — Convex, the AI providers, the calls signalling — is
  // none of this worker's business.
  if (url.origin !== self.location.origin) return;

  const cacheFirst =
    ASSET_PATH.test(url.pathname) || HASHED_ASSET.test(url.pathname);

  if (cacheFirst) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ??
          fetch(request).then((response) => {
            if (response.ok && response.type === "basic") {
              const copy = response.clone();
              void caches.open(VERSION).then((cache) => cache.put(request, copy));
            }
            return response;
          }),
      ),
    );
    return;
  }

  // The manifest is read when the browser decides whether it can install, so it
  // is served fresh whenever there is a network and from cache when there is not.
  if (url.pathname === MANIFEST_PATH) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(VERSION).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request)),
    );
  }
});
