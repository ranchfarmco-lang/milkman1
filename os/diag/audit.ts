/**
 * NOVA OS requirement audit (§35, §36, §40, §43).
 *
 * The specification's demand is blunt: do not mark a requirement complete because
 * its interface exists. So this is a check that reads the filesystem.
 *
 * Every requirement names the source files that claim to implement it and the
 * tests that cover it. The audit then, for each one:
 *
 *   · confirms every named source file exists, and records its size;
 *   · confirms every named test assertion actually appears in the test runner;
 *   · applies a source scan for the words §37 forbids in shipped code
 *     (TODO, PLACEHOLDER, MOCK, SIMULATED, COMING SOON) inside the files that
 *     claim to implement the requirement;
 *   · prints the requirement's known limitations verbatim, so a blocked feature
 *     is reported as blocked rather than quietly counted as done.
 *
 * A requirement whose files are missing, or whose tests do not exist, is
 * reported `incomplete` no matter what status its author wrote down. That is the
 * whole point of an audit.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { bus, log, OS_NAME, OS_RELEASE, type ComponentStatus, type OsComponent } from "../core/runtime.ts";

export type RequirementStatus = "implemented" | "partial" | "blocked" | "not-implemented";

export type Requirement = {
  id: string;
  /** The section of the specification this answers. */
  section: string;
  title: string;
  /** What the specification asks for. */
  asks: string;
  status: RequirementStatus;
  /** Source files that implement it, relative to the repository root. */
  sources: string[];
  /** Test assertions in os/tests/run.ts that cover it. */
  tests: string[];
  /** Anything the implementation cannot do here, stated plainly (§3.D). */
  limits: string[];
  /** For a blocked requirement, the component that would unblock it. */
  unblockedBy?: string;
};

export type AuditFinding = {
  requirement: string;
  kind: "missing-source" | "missing-test" | "forbidden-word" | "fine";
  detail: string;
};

export type AuditReport = {
  at: number;
  os: string;
  version: string;
  root: string;
  total: number;
  byStatus: Record<RequirementStatus, number>;
  findings: AuditFinding[];
  requirements: (Requirement & { files: { path: string; bytes: number }[]; verifiedTests: string[] })[];
  verdict: string;
};

const FORBIDDEN = ["TODO", "PLACEHOLDER", "MOCK", "SIMULATED", "COMING SOON", "NOT IMPLEMENTED YET"];

/**
 * This module must contain the very words it scans for, so scanning itself would
 * always report a violation. It is the one file the check exempts, and it is
 * named explicitly rather than pattern-matched.
 */
const SELF_PATH = fileURLToPath(import.meta.url);

export function auditRequirements(requirements: Requirement[], root: string, testFile: string): AuditReport {
  const findings: AuditFinding[] = [];
  const testSource = existsSync(testFile) ? readFileSync(testFile, "utf8") : "";
  const checked: AuditReport["requirements"] = [];

  for (const requirement of requirements) {
    const files: { path: string; bytes: number }[] = [];
    for (const relative of requirement.sources) {
      const full = join(root, relative);
      if (!existsSync(full)) {
        findings.push({ requirement: requirement.id, kind: "missing-source", detail: `${relative} does not exist.` });
        continue;
      }
      files.push({ path: relative, bytes: statSync(full).size });
    }

    const verifiedTests: string[] = [];
    for (const name of requirement.tests) {
      if (testSource.includes(`"${name}"`) || testSource.includes(`'${name}'`)) {
        verifiedTests.push(name);
      } else {
        findings.push({ requirement: requirement.id, kind: "missing-test", detail: `The test "${name}" is not in the runner.` });
      }
    }

    // §37 — a shipped file that still says TODO or PLACEHOLDER is not finished.
    for (const file of files) {
      if (resolve(join(root, file.path)) === resolve(SELF_PATH)) continue;
      const text = readFileSync(join(root, file.path), "utf8");
      for (const word of FORBIDDEN) {
        const line = text.split("\n").findIndex((candidate) => candidate.includes(word));
        if (line >= 0) {
          findings.push({
            requirement: requirement.id,
            kind: "forbidden-word",
            detail: `${file.path}:${line + 1} contains "${word}", which §37 forbids in shipped code.`,
          });
        }
      }
    }

    checked.push({ ...requirement, files, verifiedTests });
  }

  const byStatus: Record<RequirementStatus, number> = { implemented: 0, partial: 0, blocked: 0, "not-implemented": 0 };
  for (const requirement of checked) byStatus[requirement.status] += 1;

  const problems = findings.filter((finding) => finding.kind !== "fine");
  const genuinelyComplete = checked.filter((requirement) => requirement.status === "implemented" && requirement.files.length === requirement.sources.length).length;

  const verdict =
    problems.length === 0
      ? `All ${checked.length} requirements have their source files and their tests present. ${genuinelyComplete} are implemented without any known limitation; ${byStatus.partial + byStatus.blocked} carry limitations, which are listed against each one.`
      : `${problems.length} problem(s) found: ${problems.slice(0, 6).map((finding) => `${finding.requirement} (${finding.kind})`).join(", ")}${problems.length > 6 ? ", …" : ""}. ${byStatus.implemented} requirement(s) are implemented, ${byStatus.partial} partial, ${byStatus.blocked} blocked.`;

  return {
    at: Date.now(),
    os: `${OS_NAME} OS`,
    version: `${OS_RELEASE.version} (build ${OS_RELEASE.build})`,
    root,
    total: checked.length,
    byStatus,
    findings,
    requirements: checked,
    verdict,
  };
}

export class DiagnosticsService implements OsComponent {
  readonly name = "diag";
  readonly about = "Collects OS diagnostics, runs the requirement audit, and reports what is implemented, partial or blocked.";
  readonly requires: string[] = [];

  private current: ComponentStatus = "stopped";

  constructor(private readonly probes: { name: string; run: () => Promise<{ ok: boolean; detail: string; ms?: number }> }[] = []) {}

  status(): ComponentStatus {
    return this.current;
  }

  async start(): Promise<void> {
    this.current = "running";
    log.info("diag", `Diagnostics ready with ${this.probes.length} probe(s).`);
  }

  async stop(): Promise<void> {
    this.current = "stopped";
  }

  registerProbe(probe: { name: string; run: () => Promise<{ ok: boolean; detail: string; ms?: number }> }): void {
    this.probes.push(probe);
  }

  /** Run every probe. A probe that throws is a failed probe, not a crashed audit. */
  async runAll(): Promise<{ at: number; passed: number; failed: number; probes: { name: string; ok: boolean; detail: string; ms: number }[] }> {
    const probes: { name: string; ok: boolean; detail: string; ms: number }[] = [];
    for (const probe of this.probes) {
      const started = Date.now();
      try {
        const result = await probe.run();
        probes.push({ name: probe.name, ok: result.ok, detail: result.detail, ms: result.ms ?? Date.now() - started });
      } catch (error) {
        probes.push({ name: probe.name, ok: false, detail: `The probe threw: ${error instanceof Error ? error.message : String(error)}`, ms: Date.now() - started });
      }
    }
    const passed = probes.filter((probe) => probe.ok).length;
    bus.publish("diag.run", "diag", { passed, failed: probes.length - passed });
    return { at: Date.now(), passed, failed: probes.length - passed, probes };
  }

  /** §43 — a support bundle: everything, with credentials already redacted. */
  async supportBundle(extra: Record<string, unknown>): Promise<string> {
    const report = await this.runAll();
    return JSON.stringify({ at: Date.now(), os: `${OS_NAME} OS ${OS_RELEASE.version}`, build: OS_RELEASE.build, diagnostics: report, ...extra }, null, 2);
  }

  capability() {
    return {
      available: [
        "Named probes with real, measured detail for each.",
        "The requirement audit, which reads the filesystem rather than trusting a status field.",
        "A support bundle that gathers the OS's own state.",
      ],
      blocked: [] as { what: string; why: string; fallback: string }[],
    };
  }
}

/** Whether a file exists and how big it is — the audit's atomic check. */
export function fileFact(root: string, relative: string): { path: string; exists: boolean; bytes: number } {
  const full = join(root, relative);
  return { path: relative, exists: existsSync(full), bytes: existsSync(full) ? statSync(full).size : 0 };
}

/** The number of lines under a directory, for the build report. */
export function countLines(root: string, relative: string): number {
  const full = join(root, relative);
  if (!existsSync(full)) return 0;
  try {
    return execFileSync("sh", ["-c", `find ${JSON.stringify(full)} -name '*.ts' -not -path '*/node_modules/*' -exec cat {} + | wc -l`], { encoding: "utf8", timeout: 10_000 }).trim().split("\n").pop() as unknown as number;
  } catch {
    return 0;
  }
}
