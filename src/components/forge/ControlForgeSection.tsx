/**
 * The ControlForge section of the Control Room: the beginner's line about
 * what the forge is, then all ten required boxes in spec order — LLM
 * Providers, Active Agents, Sandbox Runtime, Storage & Projects, File System
 * & Context, GitHub, Deployment, Research, Diagnostics, Quick Actions.
 */
import { AgentsBox } from "@/components/forge/AgentsBox";
import { ByokBox } from "@/components/forge/ByokBox";
import { FilesBox, StorageBox } from "@/components/forge/StorageFilesBoxes";
import { GithubBox, DeployBox, ResearchBox } from "@/components/forge/IntegrationBoxes";
import { HealthBox, QuickActionsBox } from "@/components/forge/HealthActionBoxes";
import { SandboxBox } from "@/components/forge/SandboxBox";
import { Boxes } from "lucide-react";
import { Link } from "react-router";

export function ControlForgeSection() {
  return (
    <div id="section-forge" className="flex flex-col gap-3 scroll-mt-28">
      <section className="rounded-2xl border border-white/25 bg-card/70 p-4 backdrop-blur-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            <Boxes className="size-3" />
            ControlForge — the AI app builder's mission control
          </h3>
          <span className="text-[9px] text-muted-foreground">
            Everything local: keys, projects and logs never leave this browser
          </span>
        </div>

        <p className="mt-2 text-[11px] leading-5 text-muted-foreground">
          Three pages make up the forge, and each has one job. The{" "}
          <span className="text-foreground">Control Room</span> (this page) holds every setting,
          light and control. The{" "}
          <Link to="/ai-builder" className="text-foreground underline decoration-dotted hover:underline">
            AI Builder
          </Link>{" "}
          is the only place code is written — it works inside an isolated sandbox, so the running
          app can never be broken by a build. The{" "}
          <Link to="/ai-assistant" className="text-foreground underline decoration-dotted hover:underline">
            AI Assistant
          </Link>{" "}
          is the calm voice you talk to: she reads everything, changes small things, and sends
          build requests to the Builder when something needs building. Boxes below follow the
          forge in order: who provides the models, who is working, where the sandbox stands, what
          is stored, and how to take it all somewhere else.
        </p>
      </section>

      <ByokBox />
      <AgentsBox />
      <SandboxBox />
      <StorageBox />
      <FilesBox />
      <GithubBox />
      <DeployBox />
      <ResearchBox />
      <HealthBox />
      <QuickActionsBox />
    </div>
  );
}
