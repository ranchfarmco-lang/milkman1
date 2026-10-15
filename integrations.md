# Integrations

This project needs **none** to run. This file says what the optional piece is
called, what it costs, and where the app's own equivalent lives — so nobody
reaches for it thinking the hub depends on it.

## The optional package: `@vly-ai/integrations`

It is Freebuff's own gateway to AI, email and payments (VLY integration keys,
`sk_*`). It sits in `package.json` as an **optional dependency**, and the only
things that name it are inside a `try`:

- `vite.config.ts` — the Freebuff build plugin, which matters only while this
  project is being edited inside Freebuff;
- `src/lib/vly-integrations.ts` — `loadVlyIntegrations()`, which nothing calls.

Nothing in the app imports either at load time, and that is deliberate: a copy of
this project on a machine that has never heard of Freebuff has to build and run
all the same. `bun tsc -b --noEmit` and Vite both pass with the package absent
from `node_modules` entirely (verified), and `src/vite-optional.d.ts` is what
keeps the type-checker agreeing.

**It is not free, and not needed.** The gateway is metered: *"all API calls are
automatically billed to your deployment based on usage"*, and the key is injected
during project creation on the Freebuff side. So it is the opposite of the way
this hub is built — see below.

## What this hub uses instead

Bring your own key, or run a model on your own machine; both are free of any
gateway and any billing, and neither needs a Freebuff variable:

| Need | Where it lives |
| --- | --- |
| The hub's AI boxes, with your own key | `src/components/forge/ByokBox.tsx`, `src/lib/forge/llm.ts` |
| An AI on this machine, no key at all | the **Local Brain** page (`src/pages/LocalBrain.tsx`) |
| The builder crew | `src/lib/forge/agent.ts`, `src/components/BuilderCrewPanel.tsx` |
| Email sign-in codes | `src/convex/auth/emailOtp.ts`, and only when a key is provided — `src/convex/auth.ts` |

Sign-in does not need any of it either: the hub signs devices in anonymously and
identifies them by the device rule (`src/convex/device_rule.ts`). See
`self-hosting/README.md` for the account-free way to run the whole thing.

## If you do want the gateway

Call the lazy loader where you use it, rather than importing the package at the
top of a module — that is the one rule that keeps it optional:

```typescript
"use node";

import { action } from "./_generated/server";
import { loadVlyIntegrations } from "../lib/vly-integrations";

export const generate = action({
  handler: async () => {
    const vly = await loadVlyIntegrations();

    // Not installed, or no VITE_VLY_INTEGRATION_KEY in this deployment: this is
    // a normal state, not an error. Fall back to your own key or a local model.
    if (!vly) return { ok: false, reason: "no integration" };

    return await vly.ai.completion({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "Hello!" }],
    });
  },
});
```

Keep it inside a Convex action with the `"use node"` directive: the key is a
server-side secret and must never reach the browser.
