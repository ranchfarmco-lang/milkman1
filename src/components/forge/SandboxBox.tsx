/**
 * Box 3 — WebContainer / Sandbox Runtime.
 *
 * Boot, Tear Down, Restart and Mount Project act on the real engine (the
 * same singleton the Builder page uses — one sandbox for the whole forge).
 * The light is a reading of its state, the auto-boot switch is the config's,
 * and the terminal snippet is the engine's own last lines, not a mock.
 */
import { ForgeBox, MiniButton } from "@/components/forge/ForgeBox";
import { Switch } from "@/components/ui/switch";
import { useForgeConfig, useSandbox } from "@/hooks/use-forge";
import { writeConfig } from "@/lib/forge/config";
import { applyFiles, currentProject, projectFiles } from "@/lib/forge/files";
import { Box, Power, PowerOff, RotateCcw, Terminal, Usb } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

export function SandboxBox() {
  const sandbox = useSandbox();
  const config = useForgeConfig();
  const [mounting, setMounting] = useState(false);

  const tone = sandbox.booted ? "good" : sandbox.detail.startsWith("Emergency") ? "bad" : "muted";
  const value = sandbox.booted
    ? sandbox.mode === "webcontainer"
      ? "WEBCONTAINER UP"
      : "LOCALBOX UP"
    : "NOT BOOTED";

  const mount = async () => {
    setMounting(true);
    try {
      const project = await currentProject();
      const files = await projectFiles(project.id);
      if (!files.length) {
        toast("The live project has no files to mount yet.");
        return;
      }
      await sandbox.engine.hydrate();
      await sandbox.engine.mount(project.id, files);
      toast.success(`Mounted ${files.length} file(s) from “${project.name}”.`);
    } finally {
      setMounting(false);
    }
  };

  /** Put the sandbox's files back into the live project (read-only mirror). */
  const unmountMirror = async () => {
    const project = await currentProject();
    const files = sandbox.engine.fileList();
    if (!files.length) {
      toast("The sandbox holds no files.");
      return;
    }
    await applyFiles(project.id, files);
    toast.success(`Copied ${files.length} sandbox file(s) into “${project.name}”.`);
  };

  return (
    <ForgeBox
      id="forge-sandbox"
      icon={Box}
      title="WebContainer / Sandbox Runtime"
      light={{ tone, value, note: sandbox.detail }}
      onRefresh={() => {
        // The status is a live subscription; the light note already carries it.
        void sandbox.engine.hydrate();
      }}
      test={{
        label: "Health Check",
        onTest: async () => {
          await sandbox.engine.hydrate();
          const lines = sandbox.lines;
          const finding = !sandbox.booted
            ? sandbox.detail
            : `${sandbox.mode} up · ${sandbox.files} file(s) · last terminal line: ${lines[lines.length - 1] ?? "none yet"}`;
          toast(finding);
        },
      }}
      hint="Building happens only inside this sandbox. The live app is never a build target — leaving the sandbox takes Apply to Live Project, pressed by a person."
    >
      <div className="flex flex-wrap items-center gap-2">
        <MiniButton onClick={() => void sandbox.engine.boot()} disabled={sandbox.booted || sandbox.building}>
          <Power className="size-3" />
          Boot
        </MiniButton>
        <MiniButton onClick={() => void sandbox.engine.teardown()} disabled={!sandbox.booted}>
          <PowerOff className="size-3" />
          Tear Down
        </MiniButton>
        <MiniButton onClick={() => void sandbox.engine.restart()} disabled={sandbox.building}>
          <RotateCcw className="size-3" />
          Restart
        </MiniButton>
        <MiniButton onClick={mount} disabled={mounting} title="Load the live project's files into the sandbox">
          <Usb className="size-3" />
          {mounting ? "Mounting…" : "Mount Project"}
        </MiniButton>
        <MiniButton onClick={unmountMirror} title="Copy the sandbox's current files into the live project">
          copy back
        </MiniButton>

        <label className="ml-auto flex items-center gap-2 text-[10px] text-foreground/90">
          <Switch
            checked={config.autoBoot}
            onCheckedChange={(checked) => void writeConfig({ autoBoot: checked })}
          />
          Auto-boot
        </label>
      </div>

      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <div className="rounded-xl border border-border/60 bg-background/50 p-2">
          <p className="flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
            <Terminal className="size-3" />
            Terminal
          </p>
          <pre className="mt-1 h-28 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[9px] leading-4 text-foreground/80">
            {sandbox.lines.length
              ? sandbox.lines.slice(-40).join("\n")
              : "The terminal is quiet. Boot the sandbox or run a build and its real output appears here."}
          </pre>
        </div>
        <div className="rounded-xl border border-border/60 bg-background/50 p-2">
          <p className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
            Runtime readings
          </p>
          <ul className="mt-1 flex flex-col gap-1 text-[10px] leading-4 text-muted-foreground">
            <li>
              Engine:{" "}
              <span className="text-foreground">
                {sandbox.mode === "webcontainer" ? "WebContainer (npm available)" : "LocalBox (in-browser)"}
              </span>
            </li>
            <li>
              Files in sandbox: <span className="text-foreground">{sandbox.files}</span>
            </li>
            <li>
              Mounted:{" "}
              <span className="text-foreground">{sandbox.mounted ? "live project copy" : "nothing yet"}</span>
            </li>
            <li>
              Building: <span className="text-foreground">{sandbox.building ? "yes" : "no"}</span>
            </li>
            <li>
              Cross-origin isolated:{" "}
              <span className="text-foreground">
                {typeof crossOriginIsolated !== "undefined" && crossOriginIsolated ? "yes" : "no"}
              </span>
            </li>
          </ul>
        </div>
      </div>
    </ForgeBox>
  );
}
