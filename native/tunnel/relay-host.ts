/**
 * §14 Secure remote connection — the outbound side.
 *
 * The architecture the specification asks for, implemented literally: the host
 * opens ONE outbound HTTPS connection to a relay and holds it open. A remote
 * browser talks to the relay; the relay writes the request down that already
 * open connection; the host answers on a second outbound POST. Nothing ever
 * connects inward, which is the whole point — Starlink's carrier-grade NAT and
 * a Proton VPN both become irrelevant, because an outbound connection is
 * something any network allows.
 *
 * §65 is enforced by construction rather than by policy: the relay can only
 * reach `context.localBase`, and the host forwards only what the provider is
 * told to. There is no path from a relayed request to an operating-system
 * command, to a file share, or to any port other than the local server's.
 */

import {
  backoffDelay,
  type ForwardedRequest,
  type ForwardedResponse,
  type ProviderContext,
  type ProviderDiagnostics,
  type ProviderStatus,
  type TunnelProvider,
} from "./provider.ts";

/** The relay's framing: newline-delimited JSON, one message per line. */
type RelayMessage =
  | { type: "ready"; publicUrl: string; tunnelId: string; expiresAt?: number }
  | { type: "request"; id: string; method: string; path: string; headers?: Record<string, string>; bodyBase64?: string; remote?: string }
  | { type: "ping"; at: number }
  | { type: "error"; message: string }
  | { type: "closed"; reason?: string };

export class RelayTunnelProvider implements TunnelProvider {
  readonly id = "relay";
  readonly label = "Encrypted outbound relay";
  readonly requirements = [
    "A relay address (a URL that accepts outbound tunnel connections).",
    "Outbound HTTPS, which every network allows — no port forwarding and no inbound rule.",
    "The host's own portal password for the remote sign-in page (§17).",
  ];

  private current: ProviderStatus = "not-configured";
  private url: string | null = null;
  private context: ProviderContext | null = null;
  private handler: ((request: ForwardedRequest) => void) | null = null;
  private controller: AbortController | null = null;
  private stopping = false;
  private attempts = 0;
  private forwarded = 0;
  private latencyMs: number | null = null;
  private lastError: string | null = null;
  private detail: string[] = [];
  private firstAttempt: { resolve: (ok: boolean) => void } | null = null;

  status(): ProviderStatus {
    return this.current;
  }

  publicUrl(): string | null {
    return this.url;
  }

  onRequest(handler: (request: ForwardedRequest) => void): void {
    this.handler = handler;
  }

  diagnostics(): ProviderDiagnostics {
    return {
      at: Date.now(),
      provider: this.id,
      status: this.current,
      publicUrl: this.url,
      transport: this.context
        ? `Outbound HTTP connection from ${this.context.localBase} to ${this.context.relayUrl ?? "no relay configured"}`
        : "Not started.",
      latencyMs: this.latencyMs,
      forwarded: this.forwarded,
      attempts: this.attempts,
      lastError: this.lastError,
      detail: [...this.detail],
    };
  }

  async authenticate(credential: string): Promise<{ ok: boolean; message: string }> {
    if (!this.context?.relayUrl) {
      return { ok: false, message: "No relay address is configured yet, so there is nothing to authenticate against." };
    }
    try {
      const response = await fetch(`${this.context.relayUrl.replace(/\/+$/, "")}/authenticate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ credential }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean; message?: string };
      return {
        ok: response.ok && body.ok !== false,
        message: body.message ?? (response.ok ? "The relay accepted the credential." : `The relay answered ${response.status}.`),
      };
    } catch (error) {
      return { ok: false, message: `The relay could not be reached: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async connect(context: ProviderContext): Promise<void> {
    this.context = context;
    this.stopping = false;
    if (!context.relayUrl) {
      this.current = "not-configured";
      this.detail = [
        "No relay address is set. The host still works locally and on the local network; only remote access over the Internet needs a relay.",
      ];
      return;
    }
    const connected = new Promise<boolean>((resolve) => {
      this.firstAttempt = { resolve };
    });
    void this.loop();
    await connected;
  }

  async reconnect(context: ProviderContext): Promise<void> {
    this.attempts = 0;
    await this.disconnect();
    await this.connect(context);
  }

  async disconnect(): Promise<void> {
    this.stopping = true;
    this.controller?.abort();
    this.controller = null;
    if (this.current !== "not-configured") this.current = "offline";
    this.url = null;
    this.detail.push("Tunnel closed by the user.");
    this.context?.log("info", "Tunnel disconnected.");
  }

  /**
   * The connection loop. One outbound POST per attempt, held open for as long
   * as the relay keeps talking; when it ends, the delay grows exponentially
   * (with jitter) up to a minute, so a relay outage cannot turn into a storm of
   * reconnections (§45).
   */
  private async loop(): Promise<void> {
    const context = this.context;
    if (!context?.relayUrl) return;
    const base = context.relayUrl.replace(/\/+$/, "");

    while (!this.stopping) {
      this.attempts += 1;
      this.current = this.attempts === 1 ? "connecting" : "reconnecting";
      const controller = new AbortController();
      this.controller = controller;

      try {
        // `duplex` is what Node needs to send a request whose body length is
        // not known up front; it is not in every RequestInit definition, so the
        // init is typed loosely rather than guessed at.
        const init: RequestInit & { duplex?: string } = {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/x-ndjson",
            ...(context.credential ? { authorization: `Bearer ${context.credential}` } : {}),
          },
          body: JSON.stringify({ installationId: context.installationId, local: context.localBase }),
          signal: controller.signal,
          duplex: "half",
        };
        const response = await fetch(`${base}/connect`, init);

        if (!response.ok || !response.body) {
          throw new Error(`The relay answered ${response.status}.`);
        }

        this.detail.push(`Tunnel opened at ${new Date().toISOString()}.`);
        context.log("info", "Tunnel connection opened to the relay.");
        await this.readStream(response.body as ReadableStream<Uint8Array>);
      } catch (error) {
        if (this.stopping) break;
        this.lastError = error instanceof Error ? error.message : String(error);
        this.current = "failed";
        context.log("warn", "The tunnel connection dropped.", { error: this.lastError });
      }

      // Whether the connection was ever established is what the first attempt
      // reports, captured before the address is dropped.
      const wasConnected = this.url !== null;
      this.url = null;
      this.firstAttempt?.resolve(this.attempts === 1 && wasConnected);
      this.firstAttempt = null;

      if (this.stopping) break;
      const delay = backoffDelay(this.attempts);
      this.detail.push(`Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.attempts}).`);
      context.log("info", `Tunnel reconnecting in ${Math.round(delay / 1000)}s.`, { attempt: this.attempts });
      await this.wait(delay);
    }
    this.current = "offline";
  }

  /**
   * A sleep that can be cut short. A plain `setTimeout` would hold the process
   * open for up to a minute after the user asked the host to stop, and would
   * make a connection that is closing look like one that is reconnecting.
   */
  private async wait(ms: number): Promise<void> {
    const deadline = Date.now() + ms;
    while (!this.stopping && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, deadline - Date.now())));
    }
  }

  private async readStream(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffered = "";

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (line) this.handleLine(line);
        newline = buffered.indexOf("\n");
      }
    }
    if (buffered.trim()) this.handleLine(buffered.trim());
  }

  private handleLine(line: string): void {
    let message: RelayMessage;
    try {
      message = JSON.parse(line) as RelayMessage;
    } catch {
      this.context?.log("warn", "The relay sent a message that could not be read.");
      return;
    }

    switch (message.type) {
      case "ready": {
        this.url = message.publicUrl;
        this.current = "connected";
        this.attempts = 0;
        this.firstAttempt?.resolve(true);
        this.firstAttempt = null;
        this.detail.push(`Relay assigned the public address ${message.publicUrl}.`);
        this.context?.log("info", "Remote access is available.", { publicUrl: message.publicUrl });
        break;
      }
      case "ping": {
        this.latencyMs = Math.max(0, Date.now() - message.at);
        break;
      }
      case "request": {
        const request: ForwardedRequest = {
          id: message.id,
          method: message.method,
          path: message.path,
          headers: message.headers ?? {},
          bodyBase64: message.bodyBase64 ?? "",
          remote: message.remote ?? null,
        };
        this.forwarded += 1;
        this.handler?.(request);
        break;
      }
      case "error": {
        this.lastError = message.message;
        this.context?.log("warn", "The relay reported an error.", { message: message.message });
        break;
      }
      case "closed": {
        this.detail.push(`The relay closed the tunnel${message.reason ? `: ${message.reason}` : "."}`);
        break;
      }
    }
  }

  /** The second outbound POST: the answer to a relayed request. */
  async respond(response: ForwardedResponse): Promise<void> {
    const context = this.context;
    if (!context?.relayUrl) return;
    const base = context.relayUrl.replace(/\/+$/, "");
    try {
      await fetch(`${base}/respond`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(context.credential ? { authorization: `Bearer ${context.credential}` } : {}),
        },
        body: JSON.stringify(response),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      context.log("warn", "A tunneled answer could not be delivered.", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * §56 testRemoteConnection — is the public address really serving this host?
   * The check fetches the host's own `/api/status` through the public URL, so it
   * fails if the address is a placeholder, if the relay is up but the host is
   * not, and if the host is answering but with somebody else's data.
   */
  async testRemoteConnection(): Promise<{ ok: boolean; ms: number; detail: string }> {
    const url = this.url;
    if (!url) return { ok: false, ms: 0, detail: "There is no public address yet — the tunnel is not connected." };
    const started = Date.now();
    try {
      const response = await fetch(`${url.replace(/\/+$/, "")}/api/status`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      const ms = Date.now() - started;
      const body = (await response.json().catch(() => null)) as { service?: string; hostname?: string } | null;
      const ok = response.ok && body?.service === "SUGAR";
      return {
        ok,
        ms,
        detail: ok
          ? `The public address answered with this host's own status in ${ms} ms (host ${body?.hostname ?? "?"}).`
          : `The public address answered ${response.status}, but the answer did not come from this host.`,
      };
    } catch (error) {
      return {
        ok: false,
        ms: Date.now() - started,
        detail: `The public address could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
