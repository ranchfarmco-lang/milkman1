import { BackupPanel } from "@/components/BackupPanel";
import { Button } from "@/components/ui/button";
import { api } from "@/convex/_generated/api";
import {
  backupZip,
  offlineBrainZip,
  stampOf,
  type HubBackup,
  type SourceMap,
} from "@/lib/backup";
import { downloadBlob, readableSize } from "@/lib/download";
import {
  buildSelfInstaller,
  bytesToBase64,
  type BinaryBundleFile,
  type BundleFile,
} from "@/lib/offline-bundle";
import {
  BRAIN_BASE,
  BRAIN_GROUPS,
  BRAIN_STATS,
  FULL_PACKAGE,
  FULL_PACKAGE_SIZE,
  MODEL_SETS,
  REQUIREMENTS_BY_PLACE,
  EMAIL_NAME,
  EMAIL_URL,
  SIZE_SUMMARY,
  VPN_NAME,
  VPN_URL,
  itemScript,
  sizeOf,
  type BrainGroup,
  type BrainItem,
} from "@/lib/offline-brain";
import {
  groupBundleFileCount,
  groupBundleName,
  groupBundleZip,
} from "@/lib/brain-bundles";
import { PACKAGE_ALL_FILES, PACKAGE_BINARY_FILES, PACKAGE_FILES } from "@/lib/offline-brain-files";
import {
  PLATFORMS,
  PLATFORM_BY_ID,
  guessPlatform,
  platformBundleName,
  platformBundleZip,
  type PlatformId,
} from "@/lib/platform-downloads";
import { useConvex } from "convex/react";
import { cn } from "@/lib/utils";
import { motion } from "framer-motion";
import { EDITIONS } from "@/lib/offline-brain";
import {
  Apple,
  Archive,
  Bot,
  Boxes,
  Braces,
  BrainCircuit,
  Check,
  Chrome,
  CircuitBoard,
  Code2,
  Copy,
  Cpu,
  Database,
  Download,
  FolderTree,
  Globe,
  Globe2,
  HardDriveDownload,
  Laptop,
  Layers,
  Lightbulb,
  Loader2,
  Mail,
  Monitor,
  Network,
  Package,
  Rocket,
  Search,
  ShieldCheck,
  Smartphone,
  Terminal,
  Usb,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

const RISE = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
};

/** The icon each group's `icon` key points at. */
const ICONS: Record<string, LucideIcon> = {
  rocket: Rocket,
  brain: BrainCircuit,
  circuit: CircuitBoard,
  cpu: Cpu,
  lightbulb: Lightbulb,
  bot: Bot,
  package: Package,
  network: Network,
  code: Code2,
  terminal: Terminal,
  folder: FolderTree,
  globe: Globe,
  search: Search,
  layers: Layers,
  archive: Archive,
  braces: Braces,
  database: Database,
};

/** The icon each platform's `icon` key points at. */
const PLATFORM_ICONS: Record<string, LucideIcon> = {
  laptop: Laptop,
  apple: Apple,
  chrome: Chrome,
  terminal: Terminal,
  smartphone: Smartphone,
  boxes: Boxes,
};

/** A safe file name for a generated script. */
function slug(name: string) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 50) || "component"
  );
}

/** What the snapshot sources hand back, live or bundled. */
type SourceResult = { at: string; files: SourceMap; patched?: string[] };

/** Chrome's "save as" dialog, not yet in the TypeScript DOM types. */
type SaveFileHandle = {
  createWritable: () => Promise<{
    write: (data: Blob) => Promise<void>;
    close: () => Promise<void>;
  }>;
};
type SavePickerWindow = Window & {
  showSaveFilePicker?: (options?: {
    suggestedName?: string;
  }) => Promise<SaveFileHandle>;
};

/**
 * Write one file to the device. Three ways, best first:
 *   1. the browser's own "save as" dialog, so you can pick the exact folder
 *      (your external drive);
 *   2. a normal download into the browser's download folder;
 *   3. open it in a new tab, a top-level download a preview frame cannot block.
 */
async function writeBlob(
  blob: Blob,
  filename: string,
  toastId: string | number,
): Promise<boolean> {
  const size = readableSize(blob.size);

  const picker = (window as SavePickerWindow).showSaveFilePicker;
  if (typeof picker === "function") {
    try {
      const handle = await picker.call(window, { suggestedName: filename });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      toast.success(`Saved ${filename} (${size}) to the folder you chose.`, {
        id: toastId,
      });
      return true;
    } catch (error) {
      if ((error as DOMException)?.name === "AbortError") {
        toast.dismiss(toastId);
        return true;
      }
    }
  }

  if (downloadBlob(filename, blob)) {
    toast.success(`Saving ${filename} (${size}) to your Downloads.`, {
      id: toastId,
    });
    return true;
  }
  return false;
}

/** A Blob from fetched bytes, without the ArrayBuffer/SharedArrayBuffer wrinkle. */
function bytesToBlob(bytes: Uint8Array): Blob {
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return new Blob([buffer]);
}

/**
 * Fetch a packaged file, rejecting the dev server's single-page fallback (an
 * HTML page returned for a file it is not serving).
 */
async function fetchPackagedBytes(path: string): Promise<Uint8Array | null> {
  try {
    const response = await fetch(`${BRAIN_BASE}/${path}`);
    const type = response.headers.get("content-type") ?? "";
    if (!response.ok || type.includes("text/html")) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.length > 0 ? bytes : null;
  } catch {
    return null;
  }
}

/** The same, as text — every packaged file is text. */
async function fetchPackagedText(path: string): Promise<string | null> {
  try {
    const response = await fetch(`${BRAIN_BASE}/${path}`);
    const type = response.headers.get("content-type") ?? "";
    if (!response.ok || type.includes("text/html")) return null;
    const text = await response.text();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/** Download one packaged file. */
async function savePackaged(
  path: string,
  filename: string,
  label: string,
): Promise<boolean> {
  const toastId = toast.loading(`Preparing ${label}…`);
  const bytes = await fetchPackagedBytes(path);
  if (!bytes) {
    toast.error(`${label} is not being served right now. Try again shortly.`, {
      id: toastId,
    });
    return false;
  }
  if (await writeBlob(bytesToBlob(bytes), filename, toastId)) return true;

  const opened = window.open(`${BRAIN_BASE}/${path}`, "_blank");
  if (opened) {
    toast(`Opened ${filename} in a new tab — it saves from there.`, { id: toastId });
    return true;
  }
  toast.error(
    "This preview blocked the download. Open the hub at its own address in a normal browser tab and press Download again.",
    { id: toastId },
  );
  return false;
}

/** Save a generated shell script. */
async function saveScript(
  filename: string,
  body: string,
  label: string,
): Promise<boolean> {
  const toastId = toast.loading(`Preparing ${label}…`);
  const blob = new Blob([body], { type: "text/x-shellscript" });
  if (await writeBlob(blob, filename, toastId)) return true;
  toast.error(
    "This preview blocked the download. Open the hub at its own address in a normal browser tab and press Download again.",
    { id: toastId },
  );
  return false;
}

/** The size to print beside a button: the catalog's, or the script's own. */
function displaySize(item: BrainItem): string {
  const known = sizeOf(item);
  if (known) return known;
  const body = itemScript(item);
  if (!body) return "";
  return readableSize(new Blob([body]).size);
}

function OfflineBrain() {
  const convex = useConvex();
  const [query, setQuery] = useState("");
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [modelSet, setModelSet] = useState("recommended");
  // Which machine this is for. Guessed from the browser, then yours to change.
  const [platformId, setPlatformId] = useState<PlatformId>(() => guessPlatform());
  const chosenPlatform = PLATFORM_BY_ID[platformId];
  const ChosenPlatformIcon = PLATFORM_ICONS[chosenPlatform.icon] ?? Package;

  const address =
    typeof window === "undefined"
      ? ""
      : `${window.location.origin}/offline-brain`;

  /**
   * The app snapshot for the web and everything editions: the live database's
   * copy first (with any Builder fixes), and the copy bundled into this page
   * when the database will not answer — the same fallback the Control Room's
   * backup panel uses.
   */
  const getSource = async (): Promise<SourceResult> => {
    try {
      return (await convex.query(api.backup.source, {})) as SourceResult;
    } catch {
      const bundled = await import("@/convex/self_source");
      return {
        at: bundled.SELF_SNAPSHOT_AT,
        files: bundled.SELF_SOURCE as SourceMap,
        patched: [],
      };
    }
  };

  /** The hub's data, or null when the database is not answering. */
  const getData = async (): Promise<HubBackup | null> => {
    try {
      return (await convex.query(api.backup.data, {})) as HubBackup;
    } catch {
      return null;
    }
  };

  const hubUrl = (import.meta.env.VITE_CONVEX_URL as string | undefined) ?? "";

  const chosenSet = MODEL_SETS.find((set) => set.id === modelSet) ?? MODEL_SETS[2];

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return BRAIN_GROUPS;
    return BRAIN_GROUPS.map((group) => ({
      ...group,
      items: group.items.filter((item) =>
        `${item.name} ${item.blurb} ${item.meta ?? ""}`
          .toLowerCase()
          .includes(needle),
      ),
    })).filter((group) => group.items.length > 0);
  }, [query]);

  const shown = filtered.reduce((total, group) => total + group.items.length, 0);

  const copyAddress = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      toast.success("Address copied — open it in a normal tab so downloads work.");
    } catch {
      toast.error("This browser would not let me copy it — select it instead.");
    }
  };

  const downloadEverything = async () => {
    setSaving(FULL_PACKAGE);
    const toastId = toast.loading(
      `Packing the installer for the ${chosenSet.label} set…`,
    );
    try {
      const files: BundleFile[] = [];
      const archives: BinaryBundleFile[] = [];
      const missing: string[] = [];
      for (const path of PACKAGE_FILES) {
        const text = await fetchPackagedText(path);
        if (text === null) missing.push(path);
        else files.push({ path, text });
      }
      // The reference source archive is not text, so it goes in as its bytes.
      for (const path of PACKAGE_BINARY_FILES) {
        const bytes = await fetchPackagedBytes(path);
        if (bytes === null) missing.push(path);
        else archives.push({ path, base64: bytesToBase64(bytes) });
      }
      if (files.length === 0) {
        toast.error("Could not read the package files. Try again shortly.", {
          id: toastId,
        });
        return;
      }

      const scriptText = buildSelfInstaller(
        files,
        modelSet,
        address,
        chosenSet.gb,
        archives,
      );
      const saved = await writeBlob(
        new Blob([scriptText], { type: "text/x-shellscript" }),
        FULL_PACKAGE,
        toastId,
      );
      if (saved) {
        const note = missing.length ? ` (${missing.length} files unavailable)` : "";
        const carried = files.length + archives.length;
        toast.success(
          `${FULL_PACKAGE}: ${carried} files — including the Freebuff source archive — ${chosenSet.label} set (${chosenSet.size})${note}. Put it on the drive and run it there.`,
          { id: toastId, duration: 9000 },
        );
      } else {
        toast.error(
          "This preview blocked the save. Open the hub at its own address in a normal browser tab, then press Download again.",
          { id: toastId, duration: 9000 },
        );
      }
    } catch {
      toast.error("Could not build the installer.", { id: toastId });
    } finally {
      setSaving(null);
    }
  };

  /**
   * The three editions. Each is built here in the browser from what the hub
   * already serves or holds — nothing is uploaded to make any of them.
   */
  const buildBrainFiles = async (): Promise<SourceMap | null> => {
    const files: SourceMap = {};
    const missing: string[] = [];
    for (const path of PACKAGE_FILES) {
      const text = await fetchPackagedText(path);
      if (text === null) missing.push(path);
      else files[path] = text;
    }
    if (Object.keys(files).length === 0) {
      toast.error("Could not read the package files. Try again shortly.");
      return null;
    }
    if (missing.length) {
      toast.warning(`${missing.length} package file(s) unavailable — they are named in the README.`);
    }
    return files;
  };

  /**
   * The packaged files that are not text: the archive of the Freebuff reference
   * source. Fetched as bytes, so an edition that carries the package carries all
   * of it and nothing has to be downloaded while it installs.
   */
  const buildBrainArchive = async (): Promise<Record<string, Uint8Array>> => {
    const archives: Record<string, Uint8Array> = {};
    for (const path of PACKAGE_BINARY_FILES) {
      const bytes = await fetchPackagedBytes(path);
      if (bytes === null) {
        toast.warning(
          `${path} is not being served right now — it is named in the archive's README.`,
        );
        continue;
      }
      archives[path] = bytes;
    }
    return archives;
  };

  const downloadWebEdition = async () => {
    setSaving("web");
    const toastId = toast.loading("Packing the web edition…");
    try {
      const snapshot = await getSource();
      const [brainFiles, brainArchive] = await Promise.all([
        buildBrainFiles(),
        buildBrainArchive(),
      ]);
      if (!brainFiles) return;
      const stamp = stampOf(snapshot.at);
      const brainMissing = PACKAGE_ALL_FILES.filter(
        (path) => !(path in brainFiles) && !(path in brainArchive),
      );
      const blob = backupZip({
        at: snapshot.at,
        files: snapshot.files,
        data: null,
        convexUrl: hubUrl,
        includeSource: true,
        includeData: false,
        brain: { files: brainFiles, binary: brainArchive, missing: brainMissing },
        edition: "web",
      });
      const saved = await writeBlob(
        blob,
        `private-hub-web-${stamp}.zip`,
        toastId,
      );
      if (saved) {
        toast.success(
          `Web edition saved: the whole app (${Object.keys(snapshot.files).length} files) with its Docker kit, the PWA shell and the offline brain package — the Freebuff source archive included. Run it with docker compose up --build.`,
          { id: toastId, duration: 9000 },
        );
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not build the web edition.", { id: toastId });
    } finally {
      setSaving(null);
    }
  };

  const downloadLocalEdition = async () => {
    setSaving("local");
    const toastId = toast.loading("Packing the local edition…");
    try {
      const files = await buildBrainFiles();
      if (!files) return;
      const { blob, fetched, missing } = await offlineBrainZip(
        async (path) => (path in files ? files[path] : null),
        new Date().toISOString(),
        (path) => fetchPackagedBytes(path),
      );
      const saved = await writeBlob(blob, `offline-ai-coding-brain-${stampOf(new Date().toISOString())}.zip`, toastId);
      if (saved) {
        toast.success(
          `Local edition saved: ${fetched} files — the Python brain, every installer and the Freebuff source archive${missing.length ? ` (${missing.length} unavailable, named in START-HERE.md)` : ""}. Unzip it and run GET-EVERYTHING.sh; nothing in it is fetched.`,
          { id: toastId, duration: 9000 },
        );
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not build the local edition.", { id: toastId });
    } finally {
      setSaving(null);
    }
  };

  const downloadEverythingEdition = async () => {
    setSaving("everything");
    const toastId = toast.loading("Packing everything — the app, the data and the brain…");
    try {
      const [snapshot, exportData, brainFiles, brainArchive] = await Promise.all([
        getSource(),
        getData(),
        buildBrainFiles(),
        buildBrainArchive(),
      ]);
      if (!brainFiles) return;
      const stamp = stampOf(snapshot.at);
      const missing = PACKAGE_ALL_FILES.filter(
        (path) => !(path in brainFiles) && !(path in brainArchive),
      );
      const blob = backupZip({
        at: snapshot.at,
        files: snapshot.files,
        data: exportData,
        convexUrl: hubUrl,
        includeSource: true,
        includeData: exportData !== null,
        brain: { files: brainFiles, binary: brainArchive, missing },
        edition: "everything",
      });
      const saved = await writeBlob(blob, `private-hub-everything-${stamp}.zip`, toastId);
      if (saved) {
        toast.success(
          `Everything saved: the app (${Object.keys(snapshot.files).length} files)${exportData ? ", the data" : ""}, and the offline brain package (${Object.keys(brainFiles).length + Object.keys(brainArchive).length} files, the Freebuff source archive included) in one zip.`,
          { id: toastId, duration: 9000 },
        );
      }
    } catch (error) { 
      toast.error(error instanceof Error ? error.message : "Could not build the everything edition.", { id: toastId });
    } finally {
      setSaving(null);
    }
  };

  /**
   * One platform's complete download: the package, plus the installer written
   * in that platform's own language that puts the real software on the machine.
   * The open-source build has no bootstrap of its own — it is the app's whole
   * source with its Docker kit, which is what the web edition already is.
   */
  const downloadPlatform = async () => {
    if (!chosenPlatform.boot) {
      await downloadWebEdition();
      return;
    }

    setSaving(`platform:${chosenPlatform.id}`);
    const toastId = toast.loading(
      `Packing the complete ${chosenPlatform.short} download…`,
    );
    try {
      const at = new Date().toISOString();
      const { blob, fetched, missing } = await platformBundleZip(
        chosenPlatform,
        (path) => fetchPackagedText(path),
        at,
        address,
        (path) => fetchPackagedBytes(path),
      );
      if (fetched === 0) {
        toast.error("Could not read the package files. Try again shortly.", {
          id: toastId,
        });
        return;
      }
      const name = platformBundleName(chosenPlatform, at);
      const saved = await writeBlob(blob, name, toastId);
      if (saved) {
        const note = missing.length
          ? ` (${missing.length} unavailable, named in START-HERE.md)`
          : "";
        toast.success(
          `${name}: ${fetched} package files and the ${chosenPlatform.kind} installer${note}. Unzip it, then run: ${chosenPlatform.start}`,
          { id: toastId, duration: 12000 },
        );
      }
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : `Could not build the ${chosenPlatform.short} download.`,
        { id: toastId },
      );
    } finally {
      setSaving(null);
    }
  };

  const handleItem = async (item: BrainItem) => {
    setSaving(item.name);
    try {
      if (item.file) {
        await savePackaged(
          item.file,
          item.file.split("/").pop() ?? "download",
          item.name,
        );
        return;
      }
      const body = itemScript(item);
      if (!body) {
        toast.error("Nothing to download for this one.");
        return;
      }
      await saveScript(`${slug(item.name)}.sh`, body, item.name);
    } finally {
      setSaving(null);
    }
  };

  /**
   * One category, everything in it: every packaged file the category names and
   * a ready installer for every component that installs itself — in one zip,
   * built here in the browser and saved the same way as every other download.
   */
  const handleGroup = async (group: BrainGroup) => {
    setSaving(group.id);
    const toastId = toast.loading(`Packing everything in “${group.title}”…`);
    try {
      const at = new Date().toISOString();
      const { blob, files, carried, missing, archives, installer } =
        await groupBundleZip(
          group,
          (path) => fetchPackagedText(path),
          at,
          address,
          (path) => fetchPackagedBytes(path),
        );
      // A category with no installer of its own is only its files, so if not
      // one of them could be read there is nothing worth saving. A category
      // with installers still has every script, and the toast names the gap.
      if (!installer && carried === 0) {
        toast.error("Could not read the package files. Try again shortly.", {
          id: toastId,
        });
        return;
      }
      const name = groupBundleName(group, at);
      const saved = await writeBlob(blob, name, toastId);
      if (!saved) {
        toast.error(
          "This preview blocked the save. Open the hub at its own address in a normal browser tab, then press Download again.",
          { id: toastId, duration: 9000 },
        );
        return;
      }
      const note = missing.length
        ? ` (${missing.length} unavailable, named in START-HERE.md)`
        : "";
      toast.success(
        `Everything in “${group.title}”: ${files} files in one zip${
          archives.length ? ", the Freebuff source archive included" : ""
        }${note}. ${
          installer
            ? `Unzip it and run ${installer}.`
            : "Unzip it onto the drive — every file this category ships is inside."
        }`,
        { id: toastId, duration: 10000 },
      );
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : `Could not build the ${group.title} download.`,
        { id: toastId },
      );
    } finally {
      setSaving(null);
    }
  };

  /** The count beside a category's button: every file its archive will hold. */
  const groupFiles = (group: BrainGroup) => groupBundleFileCount(group);

  return (
    <div className="h-full overflow-y-auto px-1 py-1">
      {/* --------------------------------------------------------------- header */}
      <motion.header
        {...RISE}
        transition={{ duration: 0.25 }}
        className="mb-4 flex items-start gap-3 px-1"
      >
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-white/10 text-white">
          <BrainCircuit className="size-4" />
        </span>
        <div className="min-w-0">
          <h1 className="text-[12px] font-semibold tracking-tight">
            Offline Brain
          </h1>
          <p className="text-[10px] text-muted-foreground">
            Your VPN link, the hub's own backup, and the whole offline AI coding
            system — with a complete download for each platform (Windows, macOS,
            ChromeOS, Linux, Android, iPhone and the open-source build), and
            every model, agent and tool listed below.
          </p>
        </div>
      </motion.header>

      {/* ---------------------------------------------------------- proton vpn */}
      <motion.section
        {...RISE}
        transition={{ duration: 0.25, delay: 0.02 }}
        className="rounded-2xl border border-border/70 bg-card/70 p-4 backdrop-blur-sm"
      >
        <div className="flex flex-wrap items-center gap-3">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-white/10 text-white">
            <ShieldCheck className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[12px] font-semibold tracking-tight">
              {VPN_NAME}
            </h2>
            <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
              Your VPN — connect through it to keep your family's traffic
              private.
            </p>
          </div>
          <Button
            asChild
            className="h-9 shrink-0 cursor-pointer rounded-lg text-[11px]"
          >
            <a href={VPN_URL} target="_blank" rel="noreferrer">
              <ShieldCheck className="size-3.5" />
              Open link
            </a>
          </Button>
        </div>
      </motion.section>

      {/* ------------------------------------------------------------- email */}
      <motion.section
        {...RISE}
        transition={{ duration: 0.25, delay: 0.03 }}
        className="mt-3 rounded-2xl border border-border/70 bg-card/70 p-4 backdrop-blur-sm"
      >
        <div className="flex flex-wrap items-center gap-3">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-white/10 text-white">
            <Mail className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[12px] font-semibold tracking-tight">
              {EMAIL_NAME}
            </h2>
            <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
              Create your email account — open the link to sign up or sign in.
            </p>
          </div>
          <Button
            asChild
            className="h-9 shrink-0 cursor-pointer rounded-lg text-[11px]"
          >
            <a href={EMAIL_URL} target="_blank" rel="noreferrer">
              <Mail className="size-3.5" />
              Open link
            </a>
          </Button>
        </div>
      </motion.section>

      {/* ------------------------------------------------------- the installer */}
      <motion.section
        {...RISE}
        transition={{ duration: 0.25, delay: 0.04 }}
        className="rounded-2xl border border-white/25 bg-card/70 p-4 backdrop-blur-sm"
      >
        <div className="flex flex-wrap items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-white/10 text-white">
            <HardDriveDownload className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[12px] font-semibold tracking-tight">
              Download everything
            </h2>
            <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
              One file,{" "}
              <span className="text-foreground">
                {FULL_PACKAGE} · {FULL_PACKAGE_SIZE}
              </span>
              . It carries the whole package ({PACKAGE_ALL_FILES.length} files,
              the Freebuff source archive included),
              installs every prerequisite it needs, then installs the software
              and downloads the models. You pick the model set below; that is how
              much it then puts onto the drive.
            </p>
          </div>
        </div>

        {/* model set */}
        <h3 className="mt-3 text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          How much to download
        </h3>
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {MODEL_SETS.map((set) => {
            const active = set.id === modelSet;
            return (
              <button
                key={set.id}
                type="button"
                onClick={() => setModelSet(set.id)}
                className={cn(
                  "cursor-pointer rounded-xl border px-3 py-2 text-left transition-colors",
                  active
                    ? "border-white/50 bg-white/10"
                    : "border-border/70 bg-background/30 hover:bg-white/5",
                )}
              >
                <p className="flex items-center gap-1.5 text-[10px] font-medium">
                  {active ? <Check className="size-3" /> : null}
                  {set.label}
                </p>
                <p className="mt-0.5 text-[13px] font-semibold tabular-nums">
                  {set.size}
                </p>
                <p className="text-[9px] leading-4 text-muted-foreground">
                  {set.note}
                </p>
              </button>
            );
          })}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-border/70 px-3 py-2.5">
          <Usb className="size-3.5 shrink-0 text-muted-foreground" />
          <p className="min-w-0 flex-1 text-[10px] leading-4 text-muted-foreground">
            Straight to your hard drive: press the button and pick the drive in
            your browser's <span className="text-foreground">Save as</span>{" "}
            dialog.
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <span className="rounded-full border border-border/60 px-2 py-1 text-[9px] tabular-nums text-muted-foreground">
              {FULL_PACKAGE_SIZE} + {chosenSet.size}
            </span>
            <Button
              type="button"
              disabled={saving !== null}
              onClick={() => void downloadEverything()}
              className="h-9 cursor-pointer rounded-lg text-[11px]"
            >
              {saving === FULL_PACKAGE ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Download className="size-3.5" />
              )}
              Download the installer
            </Button>
          </div>
        </div>

        {/* the steps */}
        <h3 className="mt-3 text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Then, on the drive
        </h3>
        <ol className="mt-2 flex flex-col gap-1.5">
          {[
            `Save install-offline-brain.sh onto the external drive (Save as → the drive).`,
            `Plug the drive into a computer and open a terminal in that folder.`,
            `Run it:  bash install-offline-brain.sh`,
            `It installs the base tools and system packages the stack needs, then unpacks the package and downloads the software and the ${chosenSet.label.toLowerCase()} models (${chosenSet.size}) onto the same drive.`,
            `It checks the drive has room first (about ${chosenSet.gb} GB for this set) and warns you if it does not.`,
          ].map((step, index) => (
            <li
              key={step}
              className="flex items-start gap-2 text-[10px] leading-4 text-muted-foreground"
            >
              <span className="mt-px grid size-4 shrink-0 place-items-center rounded-full border border-border/60 text-[8px] text-foreground">
                {index + 1}
              </span>
              <span className="min-w-0">{step}</span>
            </li>
          ))}
        </ol>

        <p className="mt-2 text-[10px] leading-4 text-muted-foreground">
          A drive holds files; it cannot run them on its own, so the computer must
          have the drive attached while the script works. Python environments and
          the model weights land on the drive; system packages install on the
          computer itself. To change the set without re-downloading, run{" "}
          <span className="text-foreground">
            MODEL_SET=small bash install-offline-brain.sh
          </span>
          .
        </p>

        {/* the three editions */}
        <h3 className="mt-4 border-t border-border/50 pt-3 text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          The three editions — web, local, and both in one
        </h3>
        <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
          Each edition is complete in itself. The web edition is the app; the
          local edition is the brain and its tools; the everything edition is
          both together, plus your data — the one to keep.
        </p>
        <div className="mt-2 grid gap-2 md:grid-cols-3">
          {EDITIONS.map((edition) => {
            const busy =
              (edition.id === "web" && saving === "web") ||
              (edition.id === "local" && saving === "local") ||
              (edition.id === "both" && saving === "everything");
            const starter =
              edition.id === "web"
                ? { label: "Save the web edition (.zip)", action: () => void downloadWebEdition() }
                : edition.id === "local"
                  ? { label: "Save the local edition (.zip)", action: () => void downloadLocalEdition() }
                  : { label: "Save everything (.zip)", action: () => void downloadEverythingEdition() };
            return (
              <div
                key={edition.id}
                className={cn(
                  "flex flex-col rounded-xl border p-3",
                  edition.id === "both"
                    ? "border-white/50 bg-white/10"
                    : "border-border/60 bg-background/30",
                )}
              >
                <p className="flex items-center gap-1.5 text-[10px] font-semibold">
                  {edition.id === "web" ? <Globe2 className="size-3" /> : null}
                  {edition.id === "local" ? <Usb className="size-3" /> : null}
                  {edition.id === "both" ? <Layers className="size-3" /> : null}
                  {edition.label}
                </p>
                <p className="mt-1 flex-1 text-[9px] leading-4 text-muted-foreground">{edition.what}</p>
                <p className="mt-2 flex flex-wrap gap-1">
                  {edition.includes.map((item) => (
                    <span
                      key={item}
                      className="rounded-full border border-border/60 px-1.5 py-px text-[8px] text-muted-foreground"
                    >
                      {item}
                    </span>
                  ))}
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant={edition.id === "both" ? "default" : "outline"}
                  disabled={saving !== null}
                  onClick={starter.action}
                  className="mt-2 h-8 cursor-pointer rounded-lg text-[10px]"
                >
                  {busy ? <Loader2 className="size-3 animate-spin" /> : <Download className="size-3" />}
                  {starter.label}
                </Button>
              </div>
            );
          })}
        </div>

        {/* everything it needs to run */}
        <h3 className="mt-3 text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Everything it needs to run — and where it lands
        </h3>
        <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
          The installer sets up every row below on its own. Python environments
          and model weights are written onto the drive you run it from; system
          packages, base tools and language runtimes install on the computer.
        </p>
        <div className="mt-2 grid gap-2 md:grid-cols-2">
          {(
            [
              {
                key: "drive" as const,
                title: "On the drive",
                icon: Usb,
                note: "travels with the external disk",
              },
              {
                key: "host" as const,
                title: "On the computer",
                icon: Monitor,
                note: "installed by the package manager",
              },
            ]
          ).map(({ key, title, icon: Icon, note }) => (
            <div
              key={key}
              className="rounded-xl border border-border/60 bg-background/30 p-3"
            >
              <p className="flex items-center gap-1.5 text-[10px] font-medium">
                <Icon className="size-3 text-muted-foreground" />
                {title}
                <span className="text-muted-foreground">· {note}</span>
              </p>
              <ul className="mt-2 divide-y divide-border/50">
                {REQUIREMENTS_BY_PLACE[key].map((req) => (
                  <li
                    key={req.name}
                    className="flex items-start gap-2 py-1.5"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-1.5 text-[10px] font-medium">
                        {req.name}
                        {req.required ? (
                          <span className="rounded-full border border-white/30 px-1.5 py-px text-[8px]">
                            required
                          </span>
                        ) : (
                          <span className="rounded-full border border-border/60 px-1.5 py-px text-[8px] text-muted-foreground">
                            optional
                          </span>
                        )}
                      </p>
                      <p className="mt-0.5 text-[9px] leading-4 text-muted-foreground">
                        {req.blurb}
                      </p>
                    </div>
                    <span className="shrink-0 rounded-full border border-border/60 px-2 py-1 text-[9px] tabular-nums text-muted-foreground">
                      {req.size}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* what it weighs */}
        <h3 className="mt-3 text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          What everything weighs
        </h3>
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {SIZE_SUMMARY.map(({ label, value, note }) => (
            <div
              key={label}
              className="rounded-xl border border-border/60 bg-background/30 px-3 py-2"
            >
              <p className="text-[9px] uppercase tracking-[0.1em] text-muted-foreground">
                {label}
              </p>
              <p className="mt-0.5 text-[13px] font-semibold tabular-nums">{value}</p>
              <p className="text-[9px] leading-4 text-muted-foreground">{note}</p>
            </div>
          ))}
        </div>
      </motion.section>

      {/* --------------------------------- complete download, per platform */}
      <motion.section
        {...RISE}
        transition={{ duration: 0.25, delay: 0.05 }}
        className="mt-3 rounded-2xl border border-white/25 bg-card/70 p-4 backdrop-blur-sm"
      >
        <div className="flex flex-wrap items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-white/10 text-white">
            <Laptop className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[12px] font-semibold tracking-tight">
              Complete download, for every platform
            </h2>
            <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
              Pick the machine you are on. Every build is the whole package —
              the Python brain and every installer — beside an installer written
              in{" "}
              <span className="text-foreground">
                that platform's own language
              </span>
              , which puts the real software on the machine (git, Python 3,
              Node, the runtimes and compilers) before it installs the brain.
            </p>
          </div>
        </div>

        <h3 className="mt-3 text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Which machine is this for
        </h3>
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {PLATFORMS.map((platform) => {
            const active = platform.id === platformId;
            const Icon = PLATFORM_ICONS[platform.icon] ?? Package;
            return (
              <button
                key={platform.id}
                type="button"
                onClick={() => setPlatformId(platform.id)}
                className={cn(
                  "cursor-pointer rounded-xl border px-3 py-2 text-left transition-colors",
                  active
                    ? "border-white/50 bg-white/10"
                    : "border-border/70 bg-background/30 hover:bg-white/5",
                )}
              >
                <p className="flex items-center gap-1.5 text-[10px] font-medium">
                  {active ? (
                    <Check className="size-3" />
                  ) : (
                    <Icon className="size-3 text-muted-foreground" />
                  )}
                  {platform.short}
                </p>
                <p className="mt-0.5 text-[9px] leading-4 text-muted-foreground">
                  {platform.runs}
                </p>
              </button>
            );
          })}
        </div>

        {/* the chosen build, and exactly what its installer puts on the machine */}
        <div className="mt-3 rounded-xl border border-dashed border-border/70 px-3 py-3">
          <div className="flex flex-wrap items-start gap-3">
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-white/10 text-white">
              <ChosenPlatformIcon className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-semibold tracking-tight">
                {chosenPlatform.label}
              </p>
              <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
                {chosenPlatform.blurb}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className="rounded-full border border-border/60 px-2 py-1 text-[9px] tabular-nums text-muted-foreground">
                {PACKAGE_ALL_FILES.length} files
                {chosenPlatform.boot ? " + installer" : ""}
              </span>
              <Button
                type="button"
                disabled={saving !== null}
                onClick={() => void downloadPlatform()}
                className="h-9 cursor-pointer rounded-lg text-[11px]"
              >
                {saving === `platform:${chosenPlatform.id}` ||
                (chosenPlatform.id === "source" && saving === "web") ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Download className="size-3.5" />
                )}
                {chosenPlatform.boot
                  ? "Download for this platform"
                  : "Download the source"}
              </Button>
            </div>
          </div>

          <h4 className="mt-3 text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            The software it installs for you
          </h4>
          <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
            {chosenPlatform.software.map((item) => (
              <li key={item.name} className="flex items-start gap-2">
                <Check className="mt-px size-3 shrink-0 text-muted-foreground" />
                <p className="min-w-0 text-[10px] leading-4">
                  <span className="font-medium">{item.name}</span>
                  <span className="text-muted-foreground"> — {item.how}</span>
                </p>
              </li>
            ))}
          </ul>

          <div className="mt-3 flex items-center gap-2 rounded-lg border border-border/60 bg-background/40 px-2.5 py-2">
            <Terminal className="size-3.5 shrink-0 text-muted-foreground" />
            <code className="min-w-0 flex-1 truncate text-[10px]">
              {chosenPlatform.start}
            </code>
          </div>

          <p className="mt-2 text-[10px] leading-4 text-muted-foreground">
            {chosenPlatform.boot
              ? `Unzip the download, open a terminal (${chosenPlatform.kind}) in that folder, and run that line. It installs everything listed above, then the brain and — unless you set SKIP_MODELS=1 — the models.`
              : "That archive is the app's own source with its Dockerfile and compose file. Unzip it and run docker compose up --build to serve it yourself, then open its Offline Brain page for the machine builds."}
          </p>
        </div>
      </motion.section>

      {/* ------------------------------------------------------ the hub itself */}
      <motion.section
        {...RISE}
        transition={{ duration: 0.25, delay: 0.06 }}
        className="mt-3 rounded-2xl border border-border/70 bg-card/70 p-4 backdrop-blur-sm"
      >
        <div className="flex items-start gap-3">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-white/10 text-white">
            <HardDriveDownload className="size-4" />
          </span>
          <div className="min-w-0">
            <h2 className="text-[12px] font-semibold tracking-tight">
              The hub itself — take it with you
            </h2>
            <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
              The hub's own downloads live here now, beside every other download:
              the whole app ready to run with Docker, the code as one readable
              file, and a JSON copy of everything the hub has written down.
            </p>
          </div>
        </div>

        <div className="mt-3">
          <BackupPanel />
        </div>
      </motion.section>

      {/* -------------------------------------------------------------- address */}
      <motion.section
        {...RISE}
        transition={{ duration: 0.25, delay: 0.08 }}
        className="mt-3 rounded-2xl border border-border/70 bg-card/70 p-4 backdrop-blur-sm"
      >
        <h3 className="text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          This page — its own address
        </h3>

        <div className="mt-2 flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-lg border border-border/60 bg-background/40 px-2.5 py-2 text-[10px]">
            {address}
          </code>
          <Button
            type="button"
            variant="outline"
            onClick={() => void copyAddress()}
            className="h-9 shrink-0 cursor-pointer rounded-lg text-[10px]"
          >
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>

        <p className="mt-2 text-[10px] leading-4 text-muted-foreground">
          Downloads are far more reliable from the hub's own tab than inside a
          preview frame — copy this address and open it directly.
        </p>
      </motion.section>

      {/* ---------------------------------------------------------------- stats */}
      <motion.section
        {...RISE}
        transition={{ duration: 0.25, delay: 0.12 }}
        className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4"
      >
        {[
          { label: "Categories", value: String(BRAIN_STATS.groups), icon: Layers },
          { label: "Components", value: String(BRAIN_STATS.items), icon: Package },
          { label: "Installer scripts", value: String(BRAIN_STATS.files), icon: Terminal },
          { label: "Package files", value: String(PACKAGE_ALL_FILES.length), icon: Archive },
        ].map(({ label, value, icon: Icon }) => (
          <div
            key={label}
            className="rounded-xl border border-border/70 bg-card/70 px-3 py-2.5 backdrop-blur-sm"
          >
            <p className="flex items-center gap-1.5 text-[9px] uppercase tracking-[0.12em] text-muted-foreground">
              <Icon className="size-3" />
              {label}
            </p>
            <p className="mt-1 text-[15px] font-semibold tracking-tight">{value}</p>
          </div>
        ))}
      </motion.section>

      {/* --------------------------------------------------------------- search */}
      <motion.div
        {...RISE}
        transition={{ duration: 0.25, delay: 0.16 }}
        className="mt-3 flex items-center gap-2 rounded-xl border border-border/70 bg-card/70 px-3 py-2 backdrop-blur-sm"
      >
        <Search className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Find a model, agent, tool or runtime…"
          className="min-w-0 flex-1 bg-transparent text-[11px] outline-none placeholder:text-muted-foreground"
        />
        {query ? (
          <span className="shrink-0 text-[9px] text-muted-foreground">
            {shown} match{shown === 1 ? "" : "es"}
          </span>
        ) : null}
      </motion.div>

      {/* --------------------------------------------------------------- groups */}
      <div className="mt-3 mb-2 flex flex-col gap-3">
        {filtered.map((group, index) => {
          const Icon = ICONS[group.icon] ?? Package;
          const gFiles = groupFiles(group);
          return (
            <motion.section
              key={group.id}
              {...RISE}
              transition={{ duration: 0.25, delay: Math.min(0.2 + index * 0.03, 0.6) }}
              className="rounded-2xl border border-border/70 bg-card/70 p-4 backdrop-blur-sm"
            >
              <div className="flex items-start gap-3">
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-white/10 text-white">
                  <Icon className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <h2 className="text-[12px] font-semibold tracking-tight">
                    {group.title}
                  </h2>
                  <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
                    {group.summary}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span
                    className="rounded-full border border-border/60 px-2 py-1 text-[9px] tabular-nums text-muted-foreground"
                    title={`Every file in this category — ${gFiles} in one zip`}
                  >
                    {gFiles} files
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={saving !== null}
                    onClick={() => void handleGroup(group)}
                    title={`Download everything in this category — ${gFiles} files in one zip`}
                    className="h-8 cursor-pointer rounded-lg text-[10px]"
                  >
                    {saving === group.id ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <Download className="size-3" />
                    )}
                    Download everything
                  </Button>
                </div>
              </div>

              <ul className="mt-3 divide-y divide-border/60">
                {group.items.map((item) => {
                  const size = displaySize(item);
                  const busy = saving === item.name;
                  return (
                    <li
                      key={`${group.id}-${item.name}`}
                      className="flex items-center gap-3 py-2"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-[11px] font-medium">{item.name}</span>
                          {item.meta ? (
                            <span className="rounded-full border border-border/60 px-1.5 py-px text-[8px] text-muted-foreground">
                              {item.meta}
                            </span>
                          ) : null}
                          {item.file ? (
                            <span className="rounded-full border border-white/30 px-1.5 py-px text-[8px]">
                              file
                            </span>
                          ) : null}
                        </div>
                        <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
                          {item.blurb}
                          {item.repo ? (
                            <>
                              {" "}
                              <a
                                href={item.repo}
                                target="_blank"
                                rel="noreferrer"
                                className="underline underline-offset-2 hover:text-foreground"
                              >
                                source
                              </a>
                            </>
                          ) : null}
                        </p>
                      </div>

                      <span className="shrink-0 rounded-full border border-border/60 px-2 py-1 text-[9px] tabular-nums text-muted-foreground">
                        {size}
                      </span>
                      <Button
                        type="button"
                        variant="outline"
                        disabled={saving !== null}
                        onClick={() => void handleItem(item)}
                        className="h-8 shrink-0 cursor-pointer rounded-lg text-[10px]"
                      >
                        {busy ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : (
                          <Download className="size-3" />
                        )}
                        Download
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </motion.section>
          );
        })}

        {filtered.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-border/70 px-4 py-6 text-center text-[10px] text-muted-foreground">
            Nothing matches “{query}”.
          </p>
        ) : null}
      </div>
    </div>
  );
}

export default OfflineBrain;
