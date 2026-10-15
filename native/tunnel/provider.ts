/**
 * §15 Tunnel configuration — the replaceable module.
 *
 * The specification is explicit that the whole application must not be built
 * around one provider. So the host knows nothing about any particular service:
 * it knows this interface, and it asks a registry for the one the user chose.
 * Adding a different provider later is one new file and one `register()` call;
 * no other module changes, because no other module has ever heard of a relay.
 *
 * §56's verbs — connectRemote, disconnectRemote, reconnectRemote,
 * getRemoteStatus, getPublicUrl, testRemoteConnection — are the methods below,
 * under the names the specification uses them by.
 */

export type ProviderStatus =
  | "not-configured"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "offline"
  | "failed";

export type ProviderDiagnostics = {
  at: number;
  provider: string;
  status: ProviderStatus;
  publicUrl: string | null;
  /** How the tunnel reached the relay, in plain words (§21, §23). */
  transport: string;
  /** Round-trip time of the last keep-alive, in milliseconds. */
  latencyMs: number | null;
  /** How many requests the relay has carried to this host. */
  forwarded: number;
  /** Consecutive reconnection attempts, for the backoff report (§45). */
  attempts: number;
  lastError: string | null;
  detail: string[];
};

/** What a provider is handed: how to reach the local server, and where to log. */
export type ProviderContext = {
  /** e.g. `http://127.0.0.1:8123` — the local server a provider forwards to. */
  localBase: string;
  /** A stable id for this installation, so a relay can recognise it. */
  installationId: string;
  /** The relay URL, if this provider needs one. */
  relayUrl: string | null;
  /** A credential the relay may require, read from the OS keychain (§40). */
  credential: string | null;
  log: (level: "info" | "warn" | "error", message: string, detail?: Record<string, unknown>) => void;
};

export type ForwardedRequest = {
  id: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  bodyBase64: string;
  /** Where the request came from, for the audit log (§40). */
  remote: string | null;
};

export type ForwardedResponse = {
  id: string;
  status: number;
  headers: Record<string, string>;
  bodyBase64: string;
};

/** The contract every provider implements. Everything optional is optional. */
export interface TunnelProvider {
  readonly id: string;
  readonly label: string;
  /** What this provider needs before it can work, shown in the portal (§34). */
  readonly requirements: string[];

  connect(context: ProviderContext): Promise<void>;
  disconnect(): Promise<void>;
  status(): ProviderStatus;
  publicUrl(): string | null;
  diagnostics(): ProviderDiagnostics;
  /** §45 — reconnect is a call, not a hope. */
  reconnect(context: ProviderContext): Promise<void>;
  /** §17 — a provider may need its own account on its own service. */
  authenticate(credential: string): Promise<{ ok: boolean; message: string }>;
  /** Push one forwarded request back to the relay. */
  respond(response: ForwardedResponse): Promise<void>;
  /** §56 testRemoteConnection — is the public address really this host? */
  testRemoteConnection(): Promise<{ ok: boolean; ms: number; detail: string }>;
  /** Who to call when a request arrives from the relay. */
  onRequest(handler: (request: ForwardedRequest) => void): void;
}

const registry = new Map<string, () => TunnelProvider>();

export function registerProvider(id: string, factory: () => TunnelProvider): void {
  registry.set(id, factory);
}

export function providerIds(): string[] {
  return [...registry.keys()];
}

export function createProvider(id: string): TunnelProvider | null {
  const factory = registry.get(id);
  return factory ? factory() : null;
}

/**
 * §45 — controlled exponential backoff. A reconnect loop that hammers a relay
 * is worse than one that waits: it burns the user's connection and can get the
 * account rate-limited. This helper is the single place the delays are decided.
 */
export function backoffDelay(attempt: number, baseMs = 1000, capMs = 60_000): number {
  const grown = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  // A little jitter, so several hosts coming back at once do not synchronise.
  const jitter = Math.floor(Math.random() * Math.min(1000, grown / 4));
  return grown + jitter;
}
