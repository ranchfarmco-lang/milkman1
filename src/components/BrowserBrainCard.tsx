import { Panel, Stat } from "@/components/BrainPanel";
import {
  browserCapabilities,
  capabilityLines,
  listBrowserFiles,
  loadStore,
  type BrowserCapabilities,
} from "@/lib/browser-brain";
import { cn } from "@/lib/utils";
import { motion } from "framer-motion";
import { Check, Cpu, Database, FileCode, HardDrive, MemoryStick, Wifi, WifiOff } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * The brain that lives in this page.
 *
 * The local brain is Python on your machine and this page pairs with it. This
 * card is what is here when nothing is paired — and it is not an empty state:
 * it is a working brain of its own, with memory, an offline file workspace,
 * offline code running, and every tool the browser can honestly run. When the
 * local brain is paired, the two of them are one system and this half keeps
 * working offline regardless.
 */

const RISE = { initial: { opacity: 0, y: 10 }, animate: { opacity: 1, y: 0 } };

export function BrowserBrainCard({ compact = false }: { compact?: boolean }) {
  const [caps, setCaps] = useState<BrowserCapabilities | null>(null);
  const [counts, setCounts] = useState({ memory: 0, files: 0 });

  useEffect(() => {
    let alive = true;
    void browserCapabilities().then((found) => {
      if (alive) setCaps(found);
    });
    const store = loadStore();
    setCounts({ memory: store.memory.length, files: store.files.length });

    // Storage written by other panels (memory, workspace) should show up here
    // without a reload: storage events fire for other tabs, and a short poll
    // catches this tab's own writes.
    const sync = () => {
      const store = loadStore();
      setCounts({ memory: store.memory.length, files: store.files.length });
    };
    window.addEventListener("storage", sync);
    const timer = window.setInterval(sync, 4000);
    return () => {
      alive = false;
      window.removeEventListener("storage", sync);
      window.clearInterval(timer);
    };
  }, []);

  const lines = caps ? capabilityLines(caps) : [];

  return (
    <Panel className={compact ? "" : "border-white/25"}>
      <div className="flex flex-wrap items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-white/10 text-white">
          <Cpu className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-1.5 text-[12px] font-semibold tracking-tight">
            The brain in this browser
            <span className="rounded-full border border-white/40 px-2 py-0.5 text-[9px] font-medium">
              works offline
            </span>
          </h2>
          <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
            This page is not an empty shell waiting for the Python brain — it carries its own half
            of the system: memory kept in this browser, an offline file workspace, code it can run
            with no network, and the tools a browser can honestly run. Pair the brain on your
            machine below and the two halves become one system; until then, this half still thinks.
          </p>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat
          label="Memory"
          value={`${counts.memory} item${counts.memory === 1 ? "" : "s"}`}
          note="kept in this browser"
          icon={Database}
        />
        <Stat
          label="Workspace"
          value={`${counts.files} file${counts.files === 1 ? "" : "s"}`}
          note="offline, editable"
          icon={FileCode}
        />
        <Stat
          label="Network"
          value={caps ? (caps.network === "online" ? "online" : caps.network === "offline" ? "offline" : "unknown") : "…"}
          note={caps?.network === "offline" ? "offline tools answering" : "compiler runner ready"}
          icon={caps?.network === "offline" ? WifiOff : Wifi}
        />
        <Stat
          label="Cores / memory"
          value={caps ? `${caps.cores}${caps.memoryGb ? ` · ${caps.memoryGb} GB` : ""}` : "…"}
          note={caps?.browser ?? ""}
          icon={MemoryStick}
        />
      </div>

      {caps ? (
        <motion.ul {...RISE} transition={{ duration: 0.25, delay: 0.05 }} className="mt-3 flex flex-col gap-1.5">
          {lines.map((line) => (
            <li key={line} className="flex items-start gap-2 text-[10px] leading-4 text-muted-foreground">
              <Check className="mt-0.5 size-3 shrink-0 text-foreground" />
              <span className="min-w-0">{line}</span>
            </li>
          ))}
        </motion.ul>
      ) : null}

      {!compact ? (
        <p className="mt-3 flex items-center gap-1.5 text-[10px] leading-4 text-muted-foreground">
          <HardDrive className="size-3 shrink-0" />
          The full editions — web, local, and both in one — are on the{" "}
          <a href="/offline-brain" className="text-foreground underline underline-offset-2">
            Offline Brain
          </a>{" "}
          page.
        </p>
      ) : null}
    </Panel>
  );
}

/** A one-line variant for tight spots: state + the two counts. */
export function BrowserBrainBadge({ className }: { className?: string }) {
  const [caps, setCaps] = useState<BrowserCapabilities | null>(null);
  useEffect(() => {
    void browserCapabilities().then(setCaps);
  }, []);
  const store = loadStore();

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-border/70 px-2.5 py-1 text-[10px] text-muted-foreground",
        className,
      )}
    >
      <span className="size-1.5 rounded-full bg-emerald-500" />
      browser brain: {store.memory.length} memories · {listBrowserFiles().length} files ·{" "}
      {caps?.network === "offline" ? "offline" : "online"}
    </span>
  );
}
