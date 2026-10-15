/**
 * NOVA OS init and service supervisor.
 *
 * On the real image this is the first process after the kernel, started by the
 * initramfs hand-off. It is also the thing that runs inside a development
 * container, because if it only existed on a bootable image it could not be
 * tested — and an untested init is the worst possible thing to put on a machine.
 *
 * What it actually does:
 *
 *   · resolves the service graph from declared dependencies, refusing to start
 *     anything whose requirements are not satisfied;
 *   · starts services in dependency order and stops them in reverse;
 *   · restarts a service that dies, with exponential backoff, and gives up after
 *     a configurable failure count instead of looping forever;
 *   · records every transition on the OS bus, so the network manager, the
 *     diagnostics and the portal all see the same truth;
 *   · runs a health probe on a schedule and marks a service `degraded` rather
 *     than pretending it is fine.
 *
 * It does not raise signals it could not deliver, and it does not claim to be
 * PID 1 unless it really is: `isPidOne()` answers that question by asking the
 * kernel, not by assuming.
 */

import { bus, log, type ComponentStatus, type OsComponent } from "../core/runtime.ts";

export type ServiceSpec = {
  component: OsComponent;
  /** Restart policy when the component reports failure or throws. */
  restart: "always" | "on-failure" | "never";
  /** How many restarts before the supervisor gives up on it. */
  maxRestarts: number;
  /** Seconds between health probes. 0 disables probing. */
  healthSeconds: number;
};

export type ServiceState = {
  name: string;
  status: ComponentStatus;
  restarts: number;
  startedAt: number | null;
  stoppedAt: number | null;
  lastError: string | null;
  healthChecks: number;
  lastHealthAt: number | null;
};

/** Whether this process really is the first process on the machine. */
export function isPidOne(): boolean {
  return typeof process.pid === "number" && process.pid === 1;
}

/** The amount of time to wait before the Nth restart. Caps at a minute. */
export function restartDelay(attempt: number, baseMs = 500, capMs = 60_000): number {
  const grown = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return grown + Math.floor(Math.random() * Math.min(500, grown / 4));
}

export class ServiceSupervisor {
  private specs = new Map<string, ServiceSpec>();
  private serviceStates = new Map<string, ServiceState>();
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  private shuttingDown = false;

  constructor(private readonly options: { onFailure?: (name: string, error: string) => void } = {}) {}

  /** Register a service. Throws on a duplicate name or an unknown dependency. */
  register(spec: ServiceSpec): void {
    const { name } = spec.component;
    if (this.specs.has(name)) throw new Error(`A service called "${name}" is already registered.`);
    for (const required of spec.component.requires) {
      if (!this.specs.has(required)) {
        throw new Error(`"${name}" requires "${required}", which is not registered yet.`);
      }
    }
    this.specs.set(name, spec);
    this.serviceStates.set(name, {
      name,
      status: "stopped",
      restarts: 0,
      startedAt: null,
      stoppedAt: null,
      lastError: null,
      healthChecks: 0,
      lastHealthAt: null,
    });
  }

  names(): string[] {
    return [...this.specs.keys()];
  }

  state(name: string): ServiceState | null {
    return this.serviceStates.get(name) ?? null;
  }

  states(): ServiceState[] {
    return [...this.serviceStates.values()];
  }

  /**
   * The order services must start in: every dependency before its dependents.
   * A cycle is refused rather than silently broken.
   */
  startOrder(): string[] {
    const ordered: string[] = [];
    const visiting = new Set<string>();
    const done = new Set<string>();

    const visit = (name: string) => {
      if (done.has(name)) return;
      if (visiting.has(name)) throw new Error(`The service graph has a cycle at "${name}".`);
      visiting.add(name);
      const spec = this.specs.get(name);
      for (const required of spec?.component.requires ?? []) visit(required);
      visiting.delete(name);
      done.add(name);
      ordered.push(name);
    };

    for (const name of this.specs.keys()) visit(name);
    return ordered;
  }

  /** Start everything, in dependency order. Returns what actually started. */
  async startAll(): Promise<{ name: string; ok: boolean; error: string | null }[]> {
    const results: { name: string; ok: boolean; error: string | null }[] = [];
    for (const name of this.startOrder()) {
      const result = await this.start(name);
      results.push(result);
      // A service whose dependency failed is left stopped rather than started
      // into a state it cannot work in.
      if (!result.ok) {
        for (const dependent of this.dependentsOf(name)) {
          this.setState(dependent, "stopped", `its requirement "${name}" did not start`);
        }
      }
    }
    return results;
  }

  async start(name: string): Promise<{ name: string; ok: boolean; error: string | null }> {
    const spec = this.specs.get(name);
    const state = this.serviceStates.get(name);
    if (!spec || !state) return { name, ok: false, error: `No service called "${name}" is registered.` };
    if (state.status === "running") return { name, ok: true, error: null };

    for (const required of spec.component.requires) {
      if (this.serviceStates.get(required)?.status !== "running") {
        const error = `"${name}" needs "${required}" to be running first.`;
        this.setState(name, "stopped", error);
        return { name, ok: false, error };
      }
    }

    this.setState(name, "starting", null);
    try {
      await spec.component.start();
      const reported = spec.component.status();
      this.setState(name, reported === "failed" ? "failed" : reported, null);
      state.startedAt = Date.now();
      state.lastError = null;
      if (spec.healthSeconds > 0) this.watch(name, spec.healthSeconds);
      log.info("init", `${name} started.`);
      return { name, ok: true, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.fail(name, message);
      return { name, ok: false, error: message };
    }
  }

  /** A service reported a failure: apply its restart policy. */
  private fail(name: string, message: string): void {
    const spec = this.specs.get(name);
    const state = this.serviceStates.get(name);
    if (!spec || !state) return;

    this.setState(name, "failed", message);
    log.error("init", `${name} failed: ${message}`);
    this.options.onFailure?.(name, message);

    if (this.shuttingDown || spec.restart === "never") return;
    if (spec.restart === "on-failure" && state.restarts >= spec.maxRestarts) {
      log.error("init", `${name} has failed ${state.restarts} times; the supervisor is leaving it stopped rather than looping.`);
      return;
    }
    if (state.restarts >= spec.maxRestarts) {
      log.error("init", `${name} has restarted ${state.restarts} times and is being left alone.`);
      return;
    }

    state.restarts += 1;
    const delay = restartDelay(state.restarts);
    log.warn("init", `Restarting ${name} in ${Math.round(delay / 1000)}s (attempt ${state.restarts}).`);
    setTimeout(() => {
      if (this.shuttingDown) return;
      void this.start(name).then((result) => {
        if (!result.ok && result.error) log.warn("init", `The restart of ${name} did not take: ${result.error}`);
      });
    }, delay).unref?.();
  }

  private setState(name: string, status: ComponentStatus, error: string | null): void {
    const state = this.serviceStates.get(name);
    if (!state) return;
    const changed = state.status !== status || state.lastError !== error;
    state.status = status;
    state.lastError = error;
    if (status === "stopped") state.stoppedAt = Date.now();
    if (changed) bus.publish("init.service", "init", { name, status, error });
  }

  /** The periodic health probe: a service that stops reporting `running` is marked degraded. */
  private watch(name: string, seconds: number): void {
    if (this.timers.has(name)) return;
    const timer = setInterval(() => {
      const spec = this.specs.get(name);
      const state = this.serviceStates.get(name);
      if (!spec || !state || this.shuttingDown) return;
      try {
        const reported = spec.component.status();
        state.healthChecks += 1;
        state.lastHealthAt = Date.now();
        if (reported === "failed") this.fail(name, "the health probe reported a failure");
        else if (reported !== state.status && reported !== "starting") this.setState(name, reported, state.lastError);
      } catch (error) {
        this.fail(name, `the health probe threw: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, Math.max(1, seconds) * 1000);
    timer.unref?.();
    this.timers.set(name, timer);
  }

  private dependentsOf(name: string): string[] {
    const found: string[] = [];
    for (const [candidate, spec] of this.specs) {
      if (candidate !== name && spec.component.requires.includes(name)) found.push(candidate);
    }
    return found;
  }

  async stop(name: string): Promise<void> {
    const spec = this.specs.get(name);
    if (!spec) return;
    const timer = this.timers.get(name);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(name);
    }
    this.setState(name, "stopped", null);
    try {
      await spec.component.stop();
      log.info("init", `${name} stopped.`);
    } catch (error) {
      log.warn("init", `${name} did not stop cleanly.`, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Stop everything, in the reverse of the start order. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const name of this.startOrder().reverse()) await this.stop(name);
    log.info("init", "All services are stopped.");
  }

  /** One line per service, for the portal and the diagnostics. */
  report(): { name: string; status: ComponentStatus; restarts: number; about: string; requires: string[] }[] {
    return this.startOrder().map((name) => {
      const spec = this.specs.get(name);
      const state = this.serviceStates.get(name);
      return {
        name,
        status: state?.status ?? "stopped",
        restarts: state?.restarts ?? 0,
        about: spec?.component.about ?? "",
        requires: spec?.component.requires ?? [],
      };
    });
  }

  /** A component that is running but cannot do one of its jobs says so here. */
  capabilityReport(): { name: string; available: string[]; blocked: { what: string; why: string; fallback: string }[] }[] {
    return this.startOrder().map((name) => {
      const spec = this.specs.get(name);
      const reported = spec?.component.capability() ?? { available: [], blocked: [] };
      return { name, ...reported };
    });
  }
}
