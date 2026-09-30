import { vlyPlugin } from "@vly-ai/integrations";
import { DEV_BACKEND, isLoopbackUrl } from "./src/lib/backend";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { defineConfig, type UserConfig } from "vite";

/**
 * The Freebuff/Vly plugin is optional, and loaded through `import()` rather
 * than a top-level `import` on purpose.
 *
 * Nothing the app does at runtime needs it — it only matters while the project
 * is being edited inside Freebuff. A top-level `import` would mean a copy of
 * this project on a machine that is not Freebuff (a downloaded backup, your own
 * laptop) fails before Vite even starts, because the package is not there. This
 * way the build carries on without it, so nothing outside your computer can
 * stop it from running.
 */
async function loadVlyPlugin() {
  // Never on a real deploy. `VERCEL` is set by Vercel's build image, so a site
  // built there is built without Freebuff's plugin even if the package happens
  // to be installed. Nothing the app runs needs it.
  if (process.env.VERCEL) return null;
  try {
    const mod = await import("@vly-ai/integrations");
    return mod.vlyPlugin();
  } catch {
    return null;
  }
}

/**
 * Carry the paths Convex uses through to the backend running on this machine.
 *
 * A development run always talks to `DEV_BACKEND` (see `src/lib/backend.ts`).
 * Read on this machine that address is used directly, and this proxy is simply
 * never asked for. Read from a browser somewhere else it cannot work at all —
 * there `127.0.0.1` is the reader's own computer — so the page uses its own
 * origin instead, and these two paths carry the calls the rest of the way.
 *
 * `ws: true` is the part that matters. The client's connection to `/api/sync` is
 * a WebSocket, and a hosted preview is served over https, so it arrives as
 * `wss` — the dev server terminates that and forwards a plain `ws` onwards.
 * Without it the client would fail on the one request that carries everything
 * live.
 *
 * Only for `vite dev`, never `vite preview`: a built app talks to the deployment
 * it was built with, and must not depend on a proxy that only exists while
 * developing.
 */
function backendProxy(target: string) {
  return {
    "/api": { target, changeOrigin: true, ws: true },
    "/version": { target, changeOrigin: true },
  };
}

// https://vite.dev/config/
export default defineConfig(async ({ command }): Promise<UserConfig> => {
  const vly = await loadVlyPlugin();

  // The backend beside the page, carried through this server for a page that is
  // being read from somewhere else.
  const forwardBackend = command === "serve" && isLoopbackUrl(DEV_BACKEND);

  return {
    plugins: [react(), ...(vly ? [vly] : []), tailwindcss()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
      // Force a single copy of React across all packages (including vlyPlugin).
      // Without this, @vly-ai/integrations can resolve its own React copy, which
      // triggers "Invalid hook call" errors at runtime.
      dedupe: ["react", "react/jsx-runtime", "react-dom", "react-dom/client"],
    },
    build: {
      // Enable source maps for better debugging (disable in production if needed)
      sourcemap: false,
      // Optimize chunk splitting
      rollupOptions: {
        output: {
          // Manual chunk splitting for better caching and lazy loading
          manualChunks: {
            // Vendor chunks for large libraries
            'react-vendor': ['react', 'react-dom', 'react-router'],
            'convex-vendor': ['convex'],
            // Large UI library chunks
            'radix-ui': [
              '@radix-ui/react-accordion',
              '@radix-ui/react-alert-dialog',
              '@radix-ui/react-avatar',
              '@radix-ui/react-checkbox',
              '@radix-ui/react-collapsible',
              '@radix-ui/react-context-menu',
              '@radix-ui/react-dialog',
              '@radix-ui/react-dropdown-menu',
              '@radix-ui/react-hover-card',
              '@radix-ui/react-label',
              '@radix-ui/react-menubar',
              '@radix-ui/react-navigation-menu',
              '@radix-ui/react-popover',
              '@radix-ui/react-progress',
              '@radix-ui/react-radio-group',
              '@radix-ui/react-scroll-area',
              '@radix-ui/react-select',
              '@radix-ui/react-separator',
              '@radix-ui/react-slider',
              '@radix-ui/react-switch',
              '@radix-ui/react-tabs',
              '@radix-ui/react-toggle',
              '@radix-ui/react-toggle-group',
              '@radix-ui/react-tooltip',
            ],
            // Heavy optional libraries - separate chunks for better lazy loading
            'framer-motion': ['framer-motion'],
            'charts': ['recharts'],
            'forms': ['react-hook-form', '@hookform/resolvers', 'zod'],
          },
          // Optimize chunk size
          chunkFileNames: 'assets/[name]-[hash].js',
          entryFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash].[ext]',
        },
      },
      // Increase chunk size warning limit for better chunking
      chunkSizeWarningLimit: 1000,
      // Target modern browsers for better optimization
      target: 'esnext',
      // Minify options - using esbuild (faster than terser)
      minify: 'esbuild',
    },
    // Optimize dependencies
    optimizeDeps: {
      // Only scan the app entry HTML; avoids crawling unrelated *.html files
      // if a legacy snapshot accidentally contains leaked package folders.
      entries: ['index.html'],
      include: [
        'react',
        'react/jsx-runtime',
        'react-dom',
        'react-dom/client',
        'react-router',
        '@convex-dev/auth/react',
        'framer-motion',
        // Only when the plugin is actually here: vlyPlugin() injects this import
        // at serve time, so the dep scanner never sees it. Without it here the
        // first page load discovers it, re-optimizes and full-reloads the preview
        // mid-screenshot. Naming a package that is not installed would break the
        // build, so it is added only when the plugin loaded.
        ...(vly ? ['@vly-ai/integrations'] : []),
      ],
    },
    // Performance hints
    server: { allowedHosts: true,
      // Bind to all interfaces so the browser runtime's server-ready event fires.
      host: true,
      port: 5173,
      // Keep HMR on, but disable full-screen error overlay
      hmr: {
        overlay: false,
      },
      // Only a backend on this machine, read from a page that is somewhere else,
      // needs the dev server to carry the Convex paths through to it. See
      // `src/lib/backend.ts` for the whole rule.
      ...(forwardBackend ? { proxy: backendProxy(DEV_BACKEND) } : {}),
    },
  };
});
