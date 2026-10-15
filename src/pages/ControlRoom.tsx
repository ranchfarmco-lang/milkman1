import { BackupPanel } from "@/components/BackupPanel";
import {
  ControlRoomNav,
  type ControlRoomSection,
} from "@/components/ControlRoomNav";
import { ControlForgeSection } from "@/components/forge/ControlForgeSection";
import { HubAddressPanel } from "@/components/HubAddressPanel";
import { SecurityPanel } from "@/components/SecurityPanel";
import { SignInsPanel } from "@/components/SignInsPanel";
import { TraceFeed, type FeedStep } from "@/components/TraceFeed";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { CREW } from "@/convex/ai_crew";
import { api } from "@/convex/_generated/api";
import type { BuildReport } from "@/convex/sandbox";
import {
  useDeviceStatus,
  type PermissionState,
} from "@/hooks/use-device-status";
import {
  useForgeAgents,
  useForgeConfig,
  usePendingRequests,
} from "@/hooks/use-forge";
import { useHubReachable } from "@/hooks/use-hub-reachable";
import { useSettings } from "@/hooks/use-settings";
import { useStudioVoice } from "@/hooks/use-studio-voice";
import { useVoice } from "@/hooks/use-voice";
import { AssistantIcon } from "@/lib/assistant-mark";
import {
  allowCamera,
  allowClipboard,
  allowMicrophone,
  allowNotifications,
  pickFile,
  setFullscreen,
  setScreenRotation,
  setWakeLock,
  type ActionResult,
} from "@/lib/device-actions";
import {
  DEVICE_GROUPS,
  sectionsOf,
  type DeviceItem,
} from "@/lib/device-settings";
import { downloadBlob, readableSize } from "@/lib/download";
import { pushToGithub } from "@/lib/github-export";
import { zipBlob } from "@/lib/zip";
import { VPN_URL } from "@/lib/offline-brain";
import { detectDevice, type DeviceInfo } from "@/lib/pwa";
import {
  addressesOf,
  bestRoute,
  BROWSER_NAME,
  locationFor,
  type SettingLocation,
} from "@/lib/settings-locations";
import {
  ORANGE_BUTTON,
  ORANGE_GHOST,
  scrollToSection,
  slug,
} from "@/lib/control-room-sections";
import { cn } from "@/lib/utils";
import {
  DEFAULT_VOICE_ID,
  DELIVERY_LIMITS,
  profileById,
  type VoiceDelivery,
} from "@/lib/voices";
import { OfflineBrainSection } from "@/pages/OfflineBrain";
import { WebPortalSection } from "@/pages/WebPortal";
import { useAction, useMutation, useQuery } from "convex/react";
import {
  Activity,
  BookOpen,
  Boxes,
  Brain,
  BrainCircuit,
  CalendarDays,
  Check,
  CircuitBoard,
  Compass,
  Copy,
  Download,
  ExternalLink,
  Globe,
  GitBranch,
  Hammer,
  HardDriveDownload,
  History,
  Loader2,
  MapPin,
  MessageCircle,
  Mic,
  Radio,
  RefreshCw,
  RotateCcw,
  ScrollText,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  X,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router";
import { toast } from "sonner";

const ACTIONS: Record<string, () => Promise<ActionResult>> = {
  camera: allowCamera,
  microphone: allowMicrophone,
  notifications: allowNotifications,
  clipboard: allowClipboard,
  photos: pickFile,
};

const PERMISSION_LABEL: Record<PermissionState, string> = {
  granted: "Allowed",
  denied: "Blocked",
  prompt: "Not asked yet",
  unsupported: "Cannot tell",
  unknown: "Unknown",
};

/**
 * The four delivery sliders, in the order they are shown, each one naming the
 * real field it moves on the spoken utterance rather than gesturing at a vibe.
 */
const VOICE_SLIDERS: {
  key: keyof VoiceDelivery;
  label: string;
  about: string;
  show: (value: number) => string;
}[] = [
  {
    key: "speed",
    label: "Speed",
    about:
      "Words per second, against the engine's own 1.00. She starts a little under it, because her register wants the room.",
    show: (value) => `${value.toFixed(2)}×`,
  },
  {
    key: "warmth",
    label: "Warmth",
    about:
      "Pitch. Lower is deeper and smokier, higher is brighter. She starts below the engine's own note.",
    show: (value) =>
      value < 0 ? `−${Math.abs(value).toFixed(2)}` : `+${value.toFixed(2)}`,
  },
  {
    key: "volume",
    label: "Volume",
    about:
      "Hers alone — it never touches the chimes, the calls or anything else the hub plays. Silence still mutes her entirely.",
    show: (value) => `${Math.round(value * 100)}%`,
  },
  {
    key: "expressiveness",
    label: "Expressiveness",
    about:
      "How much she moves inside a reply: the lift on a question, the quicker step on a joke, the small drop before something serious. At zero every line lands flat.",
    show: (value) => `${Math.round(value * 100)}%`,
  },
];

/** One slider, with its live value and what it really does underneath. */
function VoiceSlider({
  label,
  about,
  value,
  min,
  max,
  step,
  show,
  onChange,
  onCommit,
}: {
  label: string;
  about: string;
  value: number;
  min: number;
  max: number;
  step: number;
  show: (value: number) => string;
  onChange: (value: number) => void;
  /** Called when the thumb is let go — the moment the number is worth saving. */
  onCommit: (value: number) => void;
}) {
  return (
    <div className="rounded-xl border border-border/60 px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[10px] font-medium">{label}</p>
        <span className="text-[10px] tabular-nums text-muted-foreground">
          {show(value)}
        </span>
      </div>

      <Slider
        aria-label={label}
        className="mt-2"
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={([next]) => {
          if (typeof next === "number") onChange(next);
        }}
        onValueCommit={([next]) => {
          if (typeof next === "number") onCommit(next);
        }}
      />

      <p className="mt-2 text-[9px] leading-4 text-muted-foreground">
        {about}
      </p>
    </div>
  );
}

/** Every switch on the page, so they can all be put back at once. */
const TOGGLES = DEVICE_GROUPS.flatMap((group) => group.items).filter(
  (item): item is Extract<DeviceItem, { kind: "toggle" }> =>
    item.kind === "toggle",
);

/** The section headings of the settings, in the order they appear — the jump list. */
const SECTION_TITLES = [
  ...new Set(
    DEVICE_GROUPS.flatMap((group) =>
      sectionsOf(group.items).map((section) => section.title),
    ),
  ),
];

/**
 * The beginner's tour: what every page in the hub does, in plain words, so a
 * brand-new user can read one card and know whether that page is the one they
 * want. Only what each page does — no steps to follow. Every card carries a
 * button that really opens the page; the Control Room's own card carries
 * buttons that jump to the categories below it.
 */
const GUIDE: {
  id: string;
  name: string;
  icon: LucideIcon;
  blurb: string;
  points: string[];
  to?: string;
  jumps?: { label: string; id: string }[];
}[] = [
  {
    id: "browser",
    name: "Browser",
    icon: Compass,
    blurb: "Search the web, or open any address, without leaving the hub.",
    points: [
      "Type words to search — or a web address to open it. Choose what to search (All, Images, Shopping, Short videos, Videos, News, Maps, More, Tools) and how to list it: newest, largest, cheapest.",
      "Many pages open at once, each on its own tab. Home starts fresh.",
      "Save a page and it is there on every device; Downloads keeps what you fetched.",
      "If a site will not open inside the app, Live view and the media view give another way in — and Read the page as text shows just the words.",
      "Right-click (or press and hold) for copy, paste, select all, save or delete.",
    ],
    to: "/browser",
  },
  {
    id: "assistant",
    name: "AI Assistant",
    icon: AssistantIcon,
    blurb: "Talk or type. It answers, and it can do things.",
    points: [
      "Ask anything, out loud or typed — the microphone is hands-free.",
      "It can do everything, including everything the AI Builder can: look things up, run code, read and write the bench of files, build the copy, open things, set timers, and ask the AI Builder for help.",
      "It speaks its answer when the device can talk, and the Preview side shows its thinking and what it looked at.",
      "Ask “what's on the live board” and it reads the [LIVE] page back; say “brief me” for the calendar and the board together.",
    ],
    to: "/ai-assistant",
  },
  {
    id: "builder",
    name: "AI Builder",
    icon: Hammer,
    blurb: "Say what you want made, and it makes it — then run and keep it.",
    points: [
      "Three panels: the conversation on the left, with every step of the working under the reply it belongs to; the files in the middle; and the result running on the right.",
      "Your apps sits at the top: every app the crew finishes, kept whole with its own files, its own name and its own build report, so the next build cannot overwrite it.",
      "Launch one on the spot: the runner draws it in a frame that has no way back into the hub, so an app the family built cannot reach its session, its storage or its database.",
      "Save an app as one .html file or as a .zip, copy its code, open it in a tab of its own, rename it, duplicate it, or take it away for good.",
      "Send one back for work and it returns here as a request you can read before anything runs — the crew then changes that app rather than starting a new one.",
      "The middle panel is the builder's bench — a file tree and an editor. Open any file it wrote and type over it; Save puts your version straight back.",
      "It works as a crew of six — @Director, @Planner, @Files, @Research, @Implement and @Review — and every step in the chat is badged with the one who took it.",
      "It builds in its own sandbox, a copy of the hub: the app in front of you is never touched. Typecheck and build output lands in the Build log under the preview.",
      "The same sandbox has a switch, because the page has two jobs: Apps it made, and This app — its mirror. The mirror is a copy of this whole hub on a machine of its own, and Build the copy seeds it, installs what it needs, typechecks it and runs this project's real build — so a change that breaks the project fails in the copy, never in the hub you are using.",
      "Pointed at the mirror, the same AI Builder changes this app instead of making a new one: ask in your own words, it reads its own source and changes the real files, and the changed files wait beside the request, each with its diff, to be pushed, saved or carried in by a backup.",
      "Push writes one commit holding exactly those files, on top of the branch as it stands, so nothing else in the repository moves; Save writes a zip with the paths as they belong, and Copy the whole patch gives one unified diff per file.",
      "A backup carries a change while it is newer than the app's own copy: the copies the Control Room and Offline Brain hand back are this app as it stands, so an older file left on the bench can never take newer code's place.",
      "Its switches, its bench and the exports are all in this page's workshop section below.",
    ],
    to: "/ai-builder",
    jumps: [{ label: "The builder's controls", id: "the-workshop" }],
  },
  {
    id: "messenger",
    name: "Messenger",
    icon: MessageCircle,
    blurb: "The family's own chat — only your family can read it.",
    points: [
      "Message your family; the whole conversation stays in the family's room.",
      "The dot reads Online when someone else is around, Offline when it is just you.",
      "Call from the top of the room: a video call fills the room's four portals, a voice call opens in a box of its own, and either one comes out of the page with you when you move to another tab — nothing is dropped until you hang up.",
      "Ring somebody with the bell on their box — their hub rings, buzzes and notifies them — and once a call is up the header's Ring button brings the others into the call that is already going on instead of starting a second one that would drop the first.",
      "Put your screen on the call from your own seat, or watch somebody else's in a portal of its own without disturbing the call; run the call test when you set up a new device.",
      "Invite a family member with the add button.",
    ],
    to: "/messenger",
  },
  {
    id: "calendar",
    name: "Calendar",
    icon: CalendarDays,
    blurb: "The family's days, alarms, lists and outside feeds.",
    points: [
      "Add an entry and set an alarm before it; choose a layer for the kind of entry it is.",
      "See the month grid or the mini month, and move through the months.",
      "A shared shopping list you can add to, and plan straight from the list.",
      "Follow outside calendars as feeds, sync them now, upload a .ics file, or download the whole calendar as one.",
      "Reply to an entry to say you are coming — or offer a hand.",
    ],
    to: "/calendar",
  },
  {
    id: "control-room",
    name: "Control Room",
    icon: SlidersHorizontal,
    blurb: "This page. Everything the hub owns, in one long scroll.",
    points: [
      "The bar at the top jumps to any category below — nothing is hidden behind another page, and every button stays on display.",
      "System status, security and devices, sign-ins and people, the hub's address, settings and permissions, the calendar, the AI systems, the workshop, the activity log, the [LIVE] board, connectivity, the Web Portal, the Offline Brain, downloads, what it remembers, the voice, and Reset.",
      "Green and red dots are connection readings only; the orange buttons are the refresh and reset controls.",
    ],
    jumps: [
      { label: "Security & access", id: "security" },
      { label: "Sign-ins & people", id: "people" },
      { label: "Settings", id: "settings" },
      { label: "Reset", id: "reset" },
    ],
  },
  {
    id: "live",
    name: "[LIVE]",
    icon: Radio,
    blurb: "A wall of boxes the hub fetches for you — Colorado and the family.",
    points: [
      "Local watch for Grand Junction, Rifle and Cañon City, then Today over Colorado.",
      "Sun, moon and the almanac; mountains, snow and roads; water, drought and fire; ranch and farm; energy, metals and the markets; the economy; sky, space and airspace; and the headlines.",
      "Boxes you asked for: ask the assistant to put a feed, a sale board or an events page on the board and it installs one.",
      "The family calendar sits on the board too — and the assistant can read the whole board out loud.",
    ],
    to: "/live",
  },
  {
    id: "web-portal",
    name: "Web Portal",
    icon: Server,
    blurb: "The hub as a service: install it, reach it, read its API.",
    points: [
      "The live server report, the hub's HTTP API and the docs — with the app, the installer and the data ready to download.",
      "Remote access: your VPN link, and the address that opens the hub on anything.",
      "Opens without signing in when you are on a brand-new device, which is what makes it the way in.",
    ],
    to: "/web-portal",
  },
  {
    id: "offline-brain",
    name: "Offline Brain",
    icon: BrainCircuit,
    blurb:
      "The whole AI coding system, kept for the day the internet is not there.",
    points: [
      "Your VPN link, the hub's own backup, and every model, agent and tool in the offline stack.",
      "Pick a model set, then save one install script onto an external drive — it installs the tools and downloads the models there.",
      "Two editions to save: local (the brain and its tools) or everything.",
    ],
    to: "/offline-brain",
  },
  {
    id: "local-brain",
    name: "Local Brain",
    icon: CircuitBoard,
    blurb:
      "The brain on the machine in front of you — even when the hub's database is down.",
    points: [
      "Pairs this device with the offline brain and shows everything in it: Overview, Ask, Tools, Tasks, Memory, Connectors, Models, Packages and Diagnostics.",
      "Save the connection, ask it directly, run its tools and tasks, read and prune what it remembers, and check its own diagnostics.",
      "A public page on purpose: it opens even when the hub itself cannot.",
    ],
    to: "/local-brain",
  },
];

/** What a system costs, in the one phrase a row has room for. */
function tierLabel(tier: "free" | "free-tier" | "paid" | "own") {
  if (tier === "free") return "No key needed";
  if (tier === "free-tier") return "Free tier";
  if (tier === "paid") return "Paid per token";
  return "Your own endpoint";
}

/** A moment as a person would say it. */
function timeAgo(at: number): string {
  const diff = Date.now() - at;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} h ago`;
  return new Date(at).toLocaleDateString();
}

/** One copyable address, with a button that tells the truth when it cannot copy. */
function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success("Address copied — paste it into the address bar.");
    } catch {
      toast.error("This browser will not let me copy it — select it yourself.");
    }
  };

  return (
    <div className="flex items-center gap-2">
      <code className="min-w-0 flex-1 truncate rounded-lg border border-border/60 bg-background/40 px-2 py-1.5 text-[10px]">
        {value}
      </code>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => void copy()}
        aria-label={label}
        className="h-7 shrink-0 cursor-pointer rounded-lg text-[9px]"
      >
        {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

/**
 * One switch with its plain-words explanation, for the builder's two.
 *
 * The device switches below are generated from the settings table; these two
 * belong to a section rather than to the Settings list, so they are drawn here
 * in the same shape the generated ones get — label, description, switch on the
 * right.
 */
function SwitchRow({
  label,
  hint,
  checked,
  onCheckedChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-border/70 bg-background/30 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="text-[10px] font-medium">{label}</p>
        <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
          {hint}
        </p>
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onCheckedChange}
        aria-label={label}
        className="mt-0.5 shrink-0"
      />
    </div>
  );
}

/**
 * Where a setting lives, and the taps or pastes that reach it — for the device
 * actually in front of the person, so the note never names someone else's
 * phone or a browser they are not using.
 */
function WherePanel({
  location,
  device,
}: {
  location: SettingLocation;
  device: DeviceInfo;
}) {
  const route = bestRoute(location, device);
  const addresses = addressesOf(location, device);
  // `detectDevice` already answers "this device" when it cannot tell, and
  // "on this this device" is not a sentence.
  const here =
    device.name === "this device" ? "this device" : `this ${device.name}`;

  return (
    <div className="mt-1.5 rounded-lg border border-dashed border-border/70 px-2.5 py-2">
      <p className="text-[9px] text-muted-foreground">
        On {here} · {BROWSER_NAME[device.browser]}
      </p>

      <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
        {location.where}
      </p>

      {route && route.steps.length > 0 ? (
        <ol className="mt-1.5 flex flex-col gap-1">
          {route.steps.map((step, index) => (
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
      ) : null}

      {(route?.quick ?? location.quick) ? (
        <p className="mt-1.5 text-[9px] leading-4 text-muted-foreground">
          Fastest way in: {route?.quick ?? location.quick}
        </p>
      ) : null}

      {addresses.length > 0 ? (
        <div className="mt-1.5 flex flex-col gap-1">
          {addresses.map((address) => (
            <CopyRow
              key={address.value}
              label={address.label}
              value={address.value}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** One live reading, with the light that goes beside it. */
function Light({
  label,
  value,
  tone,
  note,
}: {
  label: string;
  value: string;
  tone: "good" | "warn" | "bad" | "muted";
  note?: string;
}) {
  const dot =
    tone === "good"
      ? "bg-emerald-500"
      : tone === "warn"
        ? "bg-amber-400"
        : tone === "bad"
          ? "bg-red-500"
          : "bg-white/25";
  const text =
    tone === "good"
      ? "text-emerald-400"
      : tone === "warn"
        ? "text-amber-400"
        : tone === "bad"
          ? "text-destructive"
          : "text-muted-foreground";

  return (
    <div className="rounded-xl border border-border/60 bg-background/30 px-3 py-2">
      <p className="text-[9px] uppercase tracking-[0.1em] text-muted-foreground">
        {label}
      </p>
      <p
        className={cn(
          "mt-0.5 flex items-center gap-1.5 text-[12px] font-semibold tracking-tight",
          text,
        )}
      >
        <span className={cn("size-1.5 shrink-0 rounded-full", dot)} />
        {value}
      </p>
      {note ? (
        <p className="mt-0.5 text-[9px] leading-4 text-muted-foreground">
          {note}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The window a download covers: the last month and the year ahead, so a family
 * can pull the whole calendar into Google, Outlook or Apple.
 *
 * Worked out once, when this file loads, rather than inside a render: it is a
 * query argument, so the query must not be handed a fresh object on every pass,
 * and `Date.now()` is not something a render is allowed to call.
 */
const DOWNLOAD_WINDOW = (() => {
  const now = Date.now();
  return {
    from: now - 30 * 24 * 60 * 60 * 1000,
    to: now + 365 * 24 * 60 * 60 * 1000,
  };
})();

function ControlRoom() {
  const { values, update } = useSettings();
  // The category named in the address — `#web-portal`, `#offline-brain` — is
  // where the page scrolls to when it opens, so the two addresses that used to
  // be pages of their own still arrive somewhere real.
  const location = useLocation();
  const status = useDeviceStatus();
  // Whether the hub's own database is answering at all. This is the honest
  // half of "online": a page can be online while the hub behind it is not.
  const { unreachable, retries } = useHubReachable();
  // The device in front of the person, so the notes say "Settings → Safari"
  // rather than listing every platform at once.
  const device = useMemo(() => detectDevice(), []);
  // Every AI system the backend can currently reach, best first. The list is
  // built from the deployment's own keys, so it says nothing secret.
  const aiSystems = useQuery(api.ai.systems);
  // Everything this hub knows how to reach, connected or not — the list that
  // turns "add a key" into an exact variable to paste. Names only: the query
  // says which variable switches a system on and never what is in it.
  const aiCatalog = useQuery(api.ai.catalog);
  // Whether each of them actually answers, which the presence of a key never
  // proves — a revoked key and a retired model look identical otherwise.
  const checkSystems = useAction(api.ai.checkSystems);
  // What the assistant has been told to remember, kept for this account alone.
  const memories = useQuery(api.memories.list);
  const forgetOne = useMutation(api.memories.remove);
  const forgetEverything = useMutation(api.memories.forgetAll);
  // Who may use this hub and on what, for the reading beside the Security
  // section. The panel below reads the same query, so the two cannot disagree.
  const security = useQuery(api.security.summary);
  // The [LIVE] board's shelf: when it was last gathered, and the boxes of their
  // own the assistant has installed on it. Same query the [LIVE] page reads.
  const liveBoard = useQuery(api.briefing.read);
  const refreshBoard = useAction(api.briefing.refresh);
  const liveBoxes = useQuery(api.live_boxes.list);
  // What the hub has been doing on its own: the board gathering, the calendar
  // syncing, the assistant speaking up.
  const behind = useQuery(api.ai_behind.recent);
  const {
    id: voiceId,
    profiles: voiceProfiles,
    choose: chooseVoice,
    preview: previewVoice,
    delivery: voiceDelivery,
    deliveryIsDefault: voiceDeliveryIsDefault,
    defaults: voiceDefaults,
    setDelivery: setVoiceDelivery,
    resetDelivery: resetVoiceDelivery,
    resolveById: resolveVoiceById,
    engineReady: voiceEngineReady,
    voicesReady: voiceListReady,
    voiceCount,
  } = useVoice();

  // The studio voice: the neural speaker this hub can reach with a key it
  // already has, and the switch that says whether to use it.
  const studio = useStudioVoice();

  // While a slider is being dragged, the number under the thumb is the draft,
  // not the stored one: the four numbers are written to the account when the
  // thumb is let go, so one drag is one write rather than one per pixel — and
  // the thumb never lags behind the finger. The draft clears itself as soon as
  // the account agrees with it, so a write that failed snaps back to the truth
  // instead of leaving a number on screen that was never saved.
  const [voiceDraft, setVoiceDraft] = useState<VoiceDelivery | null>(null);
  const shownDelivery = voiceDraft ?? voiceDelivery;

  useEffect(() => {
    if (!voiceDraft) return;
    const saved = (Object.keys(voiceDraft) as (keyof VoiceDelivery)[]).every(
      (key) => Math.abs(voiceDraft[key] - voiceDelivery[key]) < 0.0005,
    );
    if (saved) setVoiceDraft(null);
  }, [voiceDelivery, voiceDraft]);

  const [results, setResults] = useState<Record<string, ActionResult>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [whereOpen, setWhereOpen] = useState<string | null>(null);
  const [readAt, setReadAt] = useState<string | null>(null);
  const [health, setHealth] = useState<
    Record<string, { ok: boolean; ms: number; detail: string }>
  >({});
  const [checking, setChecking] = useState(false);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [boardBusy, setBoardBusy] = useState(false);
  // The calendar's server side: what is waiting to ring, the outside feeds it
  // reads, and a copy of the whole thing to download.
  const reminders = useQuery(api.reminders.pending);
  const clearReminders = useMutation(api.reminders.clear);
  const syncFeeds = useAction(api.calendar.syncFeeds);
  const [syncing, setSyncing] = useState(false);
  const exported = useQuery(api.calendar.exportIcs, DOWNLOAD_WINDOW);
  // The sandbox the AI Builder works in, and the last time it was built there.
  const workshop = useQuery(api.sandbox.state);
  const buildReplica = useAction(api.sandbox.buildNow);
  const [building, setBuilding] = useState(false);
  const [buildReport, setBuildReport] = useState<BuildReport | null>(null);
  // The builder's bench: what is on it, and the hands that reach it from here.
  const bench = useQuery(api.workspace.listOwn);
  const exportBench = useAction(api.workspace.exportNow);
  const clearBench = useMutation(api.workspace.clearOwn);
  const [typechecking, setTypechecking] = useState(false);
  // GitHub export. The token lives in this component's state and nowhere else:
  // not in the database, not in local storage, not in a log.
  const [ghOpen, setGhOpen] = useState(false);
  const [ghToken, setGhToken] = useState("");
  const [ghRepo, setGhRepo] = useState("");
  const [ghBranch, setGhBranch] = useState("main");
  const [ghPushing, setGhPushing] = useState(false);
  const [ghCommit, setGhCommit] = useState<string | null>(null);
  // What is left to connect. Kept out of the render so the filter runs once
  // per answer rather than on every keystroke on the page.
  const catalogRest = useMemo(
    () => (aiCatalog ?? []).filter((system) => !system.connected),
    [aiCatalog],
  );

  // Everything happens inside this box, so a chosen category can be brought up
  // clear of the bar that stays at the top of it.
  const scrollRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLElement>(null);

  const note = (id: string, result: ActionResult) =>
    setResults((previous) => ({ ...previous, [id]: result }));

  /** Re-read the browser's permissions and connection, and say so. */
  const refresh = () => {
    status.refresh();
    setReadAt(new Date().toLocaleTimeString());
    toast.success("Re-read this device.");
  };

  /** Read every outside calendar feed now, rather than when that page is open. */
  const syncCalendar = async () => {
    setSyncing(true);
    try {
      const results = await syncFeeds({});
      const total = results.reduce((sum, one) => sum + one.imported, 0);
      const failed = results.filter((one) => !one.ok);
      if (failed.length) {
        toast.error(failed[0].error ?? "A feed did not answer.");
      } else if (!results.length) {
        toast("No outside calendars are linked yet.");
      } else {
        toast.success(`${total} entries up to date.`);
      }
    } catch {
      toast.error("Could not reach the server to sync the calendar.");
    } finally {
      setSyncing(false);
    }
  };

  /** Save the calendar as one .ics file, ready for Google or Outlook. */
  const downloadCalendar = () => {
    if (!exported) return;
    const blob = new Blob([exported.text], { type: "text/calendar" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = exported.filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    toast.success("Saved. Import it into Google Calendar.");
  };

  /** Ask the [LIVE] board for a fresh gathering now, from this page. */
  const refreshLiveBoard = async () => {
    setBoardBusy(true);
    try {
      await refreshBoard();
      toast.success("The [LIVE] board has been read again.");
    } catch {
      toast.error("Could not refresh the [LIVE] board just now.");
    } finally {
      setBoardBusy(false);
    }
  };

  /**
   * Build the copy of this app that the AI Builder works on — in the sandbox,
   * never here. There is no path from this button to the app in front of you:
   * the replica is another tree on another machine, and the worst a bad change
   * can do is make the copy stop compiling.
   */
  const runBuild = async () => {
    setBuilding(true);
    try {
      const report = await buildReplica({ quick: false });
      setBuildReport(report);
      if (report.ok)
        toast.success("The copy builds. This app was not touched.");
      else
        toast.error(
          report.error ?? "The copy did not build — the output is below.",
        );
    } catch {
      toast.error("Could not reach the server to build the copy.");
    } finally {
      setBuilding(false);
    }
  };

  /**
   * The fast one: typecheck the copy and put the machine's words on screen.
   * Same sandbox, same safety, a fraction of the time — this is the button for
   * while the builder is still changing things.
   */
  const runTypecheck = async () => {
    setTypechecking(true);
    try {
      const report = await buildReplica({ quick: true });
      setBuildReport(report);
      if (report.ok) toast.success("The copy typechecks.");
      else
        toast.error(
          report.error ?? "The copy does not typecheck — the output is below.",
        );
    } catch {
      toast.error("Could not reach the server to run the typecheck.");
    } finally {
      setTypechecking(false);
    }
  };

  /** Save the whole bench as one ZIP, on this device. Nothing is uploaded. */
  const downloadBenchZip = async () => {
    try {
      const dump = await exportBench({});
      if (!dump?.files.length) {
        toast.error("There is nothing on the bench yet.");
        return;
      }
      const at = new Date(dump.at);
      const blob = zipBlob(
        dump.files.map((file) => ({ path: file.path, data: file.content })),
        at,
      );
      const stamp = at.toISOString().slice(0, 10);
      downloadBlob(`ai-builder-project-${stamp}.zip`, blob);
      toast.success(`${dump.files.length} files saved as one ZIP.`);
    } catch {
      toast.error("Could not read the bench for the export.");
    }
  };

  /** Empty the bench — an orange control, because it is a reset. */
  const emptyBench = async () => {
    try {
      const result = await clearBench({});
      toast.success(
        result.removed
          ? `${result.removed} files cleared off the bench.`
          : "The bench was already empty.",
      );
    } catch {
      toast.error("Could not clear the bench just now.");
    }
  };

  /**
   * One commit, straight from this browser to GitHub. The token is in the
   * form above and travels only as far as api.github.com; the files travel
   * with it, and nothing of any of it is kept here.
   */
  const pushBench = async () => {
    setGhPushing(true);
    try {
      const dump = await exportBench({});
      if (!dump?.files.length) {
        throw new Error("There is nothing on the bench to push.");
      }
      const result = await pushToGithub({
        token: ghToken,
        repo: ghRepo,
        branch: ghBranch || "main",
        files: dump.files,
        message: `Export from the AI Builder — ${new Date().toLocaleString("en-GB")}`,
      });
      setGhCommit(result.url);
      toast.success(`${result.files} files pushed to ${result.branch}.`);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "The push to GitHub failed.",
      );
    } finally {
      setGhPushing(false);
    }
  };

  /** Ask every AI system whether it is still answering. */
  const checkAi = useCallback(async () => {
    setChecking(true);
    try {
      const rows = await checkSystems({});
      setHealth(
        Object.fromEntries(
          rows.map((row) => [
            row.id,
            { ok: row.ok, ms: row.ms, detail: row.detail },
          ]),
        ),
      );
      setCheckedAt(Date.now());
    } catch {
      toast.error("Could not reach the server to check the AI systems.");
    } finally {
      setChecking(false);
    }
  }, [checkSystems]);

  // The systems re-check themselves while this page is open, unless the
  // Assistant switch turns that off. A hidden tab is left alone, so nothing is
  // asked of a provider while nobody is looking at the answer.
  const autoRefreshAi = values.ai_auto_refresh ?? true;
  const aiSystemCount = aiSystems?.length ?? 0;
  useEffect(() => {
    if (!autoRefreshAi || aiSystemCount === 0) return;

    // The first pass is left to the timer rather than run in the effect body:
    // the timer fires once straight away, so the systems are still checked the
    // moment the page opens, without a render being set off from inside an
    // effect.
    const timer = window.setInterval(() => {
      if (!document.hidden) void checkAi();
    }, 5 * 60_000);
    return () => window.clearInterval(timer);
  }, [autoRefreshAi, aiSystemCount, checkAi]);

  const runAction = async (id: string) => {
    const action = ACTIONS[id];
    if (!action) return;

    setBusy(id);
    const result = await action();
    setBusy(null);
    note(id, result);
    // Chrome and Safari never report the camera or the microphone, so a
    // permission that just worked is written down for this device.
    if (result.ok) status.remember(id);
    // Any permission the browser just changed should show up right away.
    status.refresh();
    setReadAt(new Date().toLocaleTimeString());
  };

  /**
   * A permission is a switch with one honest direction. On asks the browser;
   * off would have to take it back, which no page is ever allowed to do — so
   * the switch stays where it is and opens the note that says where on this
   * device you really can change it.
   */
  const handlePermission = async (item: DeviceItem, next: boolean) => {
    if (next) {
      await runAction(item.id);
      return;
    }

    setWhereOpen(item.id);
    note(item.id, {
      ok: false,
      message:
        "Only you can take a permission back — the note below says where.",
    });
    toast("A page cannot take a permission back. Here is where you can.");
  };

  const handleToggle = async (item: DeviceItem, next: boolean) => {
    update(item.id, next);

    if (item.id === "fullscreen") {
      note(item.id, await setFullscreen(next));
    }
    if (item.id === "keep_screen_awake") {
      note(item.id, await setWakeLock(next));
    }
    if (item.id === "screen_rotation") {
      // Turning it off asks to be held in portrait, which the browser only
      // grants in fullscreen — the note says so when it is refused.
      note(item.id, await setScreenRotation(next));
    }
    if (item.id === "vpn") {
      // A web page cannot build a tunnel, so this switch remembers the choice
      // and hands over the link. Opening it from this tap is what keeps the
      // browser from treating it as a pop-up.
      if (next) {
        window.open(VPN_URL, "_blank", "noopener,noreferrer");
      }
      note(item.id, {
        ok: true,
        message: next
          ? "VPN on. Finish connecting in the Proton VPN app — the link is at the top of the Offline Brain too."
          : "VPN off.",
      });
    }
  };

  const changed = TOGGLES.filter(
    (item) => (values[item.id] ?? item.default) !== item.default,
  );

  /** Put every switch back where it started, device effects included. */
  const resetSwitches = async () => {
    if (changed.length === 0) {
      toast("Every switch is already at its default.");
      return;
    }
    for (const item of changed) {
      await handleToggle(item, item.default);
    }
    toast.success(
      changed.length === 1
        ? "One switch back to its default."
        : `${changed.length} switches back to their defaults.`,
    );
  };

  const statusValue = (id: string) => {
    if (id === "wifi") {
      if (!status.online) return "Offline";
      const kind = status.connection
        ? status.connection.toUpperCase()
        : "Connected";
      return status.downlink ? `${kind} · ${status.downlink} Mbps` : kind;
    }
    if (id === "cell_data") {
      if (!status.online) return "Offline";
      const kind = status.connection ?? "";
      return /^(slow-)?[234]g$/.test(kind)
        ? `In use · ${kind.toUpperCase()}`
        : "Not in use";
    }
    if (id === "video_calls") {
      if (!status.online) return "Offline";
      // WebRTC only exists on a secure origin, which is why a call cannot be
      // placed over plain http on a phone on the network.
      return window.isSecureContext ? "Ready" : "Needs https";
    }
    return "Read-only";
  };

  /* --------------------------------------------------- live readings, once */

  const connectedAi = (aiSystems ?? []).length;
  const answering = Object.values(health).filter((one) => one.ok).length;
  const boardAt = liveBoard?.updatedAt ?? null;
  const boxCount = liveBoxes?.length ?? 0;
  const memoryCount = memories?.length ?? 0;
  const reminderCount = reminders?.length ?? 0;

  // The forge's own readings, for its place in Quick Reference: what is
  // running, whether the emergency stop is engaged, and what is waiting.
  const forgeConfig = useForgeConfig();
  const forgeAgents = useForgeAgents();
  const forgeRequests = usePendingRequests();
  const forgeRunning = forgeAgents.filter(
    (agent) => agent.status === "running",
  ).length;

  /**
   * The activity feed: everything the hub has been doing on its own, newest
   * first, drawn with the same feed the AI boxes use. A row that failed keeps
   * its failure — that is the diagnostic, not something to hide.
   */
  const activity: FeedStep[] = useMemo(
    () =>
      (behind ?? []).map((row) => ({
        kind: row.status === "failed" ? "error" : "step",
        text: `${row.label}${row.detail ? ` — ${row.detail}` : ""}${
          row.endedAt
            ? ` (finished in ${Math.max(1, Math.round((row.endedAt - row.at) / 1000))}s)`
            : " (running)"
        }`,
        at: row.at,
      })),
    [behind],
  );

  /** What Quick Reference shows beside each section, from the same sources. */
  const sections: ControlRoomSection[] = useMemo(
    () => [
      {
        id: "start-here",
        label: "What each page does",
        icon: BookOpen,
        hint: "For someone new: every page in the hub and everything it can do, in plain words.",
      },
      {
        id: "system-status",
        label: "System status",
        icon: Activity,
        hint: "The hub's own lights, read live: its database, the AI systems, the builder's sandbox, the reminders waiting and the [LIVE] board.",
        reading: unreachable ? "hub offline" : "hub online",
        tone: unreachable ? "bad" : "good",
      },
      {
        id: "security",
        label: "Security & access",
        icon: ShieldCheck,
        hint: "The private half: who may use this hub, the devices that are authorised, and the log of what has happened.",
        reading: security?.devices.authorized
          ? `${security.devices.authorized} devices`
          : security
            ? "no devices yet"
            : null,
        tone: security?.devices.authorized ? "good" : "muted",
      },
      {
        id: "people",
        label: "Sign-ins & people",
        icon: History,
        hint: "Everyone who has come in — who, on what, what happened and when — with a clear-all, a delete for each sign-in, and a save or delete for what each person has written here. Open to everyone who is in, not just the owner.",
        reading: security?.signIns
          ? `${security.signIns} sign-ins`
          : "none yet",
        tone: "muted",
      },
      {
        id: "hub-address",
        label: "The hub's address",
        icon: Globe,
        hint: "The one link that opens this hub on anything, shown and copied, and the one place to change it.",
      },
      {
        id: "settings",
        label: "Settings",
        icon: SlidersHorizontal,
        hint: "Every switch the hub owns, the permissions it needs from this device, and a note on where each one really lives.",
        reading: changed.length ? `${changed.length} changed` : "all default",
        tone: changed.length ? "warn" : "muted",
      },
      {
        id: "calendar",
        label: "Calendar",
        icon: CalendarDays,
        hint: "What is waiting to ring, the outside feeds read now, and the whole calendar as one file.",
        reading: reminderCount ? `${reminderCount} waiting` : "nothing waiting",
        tone: reminderCount ? "warn" : "muted",
      },
      {
        id: "ai-systems",
        label: "AI systems",
        icon: Brain,
        hint: "Which system answers, whether each one is still answering, and the exact variable that switches a new one on.",
        reading: connectedAi ? `${connectedAi} connected` : "none",
        tone: connectedAi ? "good" : "warn",
      },
      {
        id: "the-workshop",
        label: "The workshop",
        icon: Hammer,
        hint: "The sandbox the AI Builder works in, its two switches and its bench of files, a real build of the copy, and the exports — the app in front of you is never touched.",
        reading: bench?.files.length
          ? `${bench.files.length} file${bench.files.length === 1 ? "" : "s"} on the bench`
          : workshop?.connected
            ? "sandbox ready"
            : "no sandbox",
        tone: bench?.files.length
          ? "muted"
          : workshop?.connected
            ? "good"
            : "muted",
      },
      {
        id: "forge",
        label: "ControlForge",
        icon: Boxes,
        hint: "The AI app builder's own controls: model keys, the six agents, the sandbox, projects and files, GitHub, deploys, research, diagnostics and the emergency stop — ten boxes, every light a real reading.",
        reading: forgeConfig.emergencyStopped
          ? "stopped"
          : forgeRunning
            ? `${forgeRunning} running`
            : forgeRequests.length
              ? `${forgeRequests.length} request${forgeRequests.length === 1 ? "" : "s"} waiting`
              : "idle",
        tone: forgeConfig.emergencyStopped
          ? "bad"
          : forgeRunning
            ? "good"
            : forgeRequests.length
              ? "warn"
              : "muted",
      },
      {
        id: "activity",
        label: "Activity & logs",
        icon: ScrollText,
        hint: "What the hub has been doing behind the scenes — the board gathering, the calendar syncing, the assistant speaking up.",
        reading: behind?.length ? `${behind.length} recent` : "quiet",
        tone: "muted",
      },
      {
        id: "live-board",
        label: "The [LIVE] board",
        icon: Radio,
        hint: "The wall of boxes the hub fetches itself, the boxes you asked for, and every link the board names.",
        reading: boardAt ? timeAgo(boardAt) : "never gathered",
        tone: boardAt ? "good" : "warn",
      },
      {
        id: "connectivity",
        label: "Web & connectivity",
        icon: Globe,
        hint: "The network in front of you — the link, its throughput, a secure origin — and the button that reads this device again.",
        reading: status.online ? "online" : "offline",
        tone: status.online ? "good" : "bad",
      },
      {
        id: "web-portal",
        label: "Web Portal",
        icon: Server,
        hint: "The hub's control surface: the live server report, the HTTP API, downloads, remote access and the docs.",
      },
      {
        id: "offline-brain",
        label: "Offline Brain",
        icon: BrainCircuit,
        hint: "Your VPN link, the hub's own backup, and the whole offline AI coding system with every model and tool.",
      },
      {
        id: "tools",
        label: "Tools & downloads",
        icon: HardDriveDownload,
        hint: "Taking the hub with you: the app and its data, the code as one file, the Linux steps, and the data alone.",
      },
      {
        id: "what-it-remembers",
        label: "What it remembers",
        icon: Brain,
        hint: "What the assistant has been told to keep, for this account alone — and how to forget one thing or all of it.",
        reading: memoryCount ? `${memoryCount} kept` : "nothing yet",
        tone: "muted",
      },
      {
        id: "voice",
        label: "Voice",
        icon: Mic,
        hint: "The voice the assistant speaks with, on this account. Hear one before you choose it.",
        reading: voiceId === DEFAULT_VOICE_ID ? "default" : "chosen",
        tone: "muted",
      },
      {
        id: "reset",
        label: "Reset",
        icon: RotateCcw,
        hint: "Put the switches, the permissions' readings and the voice back where they started.",
        reading: changed.length
          ? `${changed.length} to reset`
          : "nothing to reset",
        tone: "muted",
      },
    ],
    [
      unreachable,
      security,
      changed.length,
      reminderCount,
      connectedAi,
      workshop?.connected,
      bench?.files.length,
      behind?.length,
      boardAt,
      status.online,
      memoryCount,
      voiceId,
      forgeConfig.emergencyStopped,
      forgeRunning,
      forgeRequests.length,
    ],
  );

  /**
   * Take the reader to one whole category. The page is one long scroll holding
   * everything, so this moves the page rather than swapping it: the heading, the
   * readings, the buttons and the links of that category all come up together,
   * clear of the bar that stays at the top.
   */
  const jump = useCallback((id: string) => {
    const box = scrollRef.current;
    const target = document.getElementById(`section-${id}`);
    if (!box || !target) return;
    const bar = barRef.current?.offsetHeight ?? 0;
    const top =
      box.scrollTop +
      target.getBoundingClientRect().top -
      box.getBoundingClientRect().top -
      bar -
      8;
    box.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  }, []);

  // A category named in the address — the way in from `/web-portal` and
  // `/offline-brain` — is scrolled to as soon as the page has been laid out.
  useEffect(() => {
    const id = location.hash.replace(/^#/, "");
    if (!id) return;
    const timer = window.setTimeout(() => jump(id), 80);
    return () => window.clearTimeout(timer);
  }, [location.hash, jump]);

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto px-1 py-1">
      {/* The bar, at the top of the page and staying there. Everything the page
          holds is one button on it, with its own live reading beside it, and
          every button is on display at once. */}
      <ControlRoomNav sections={sections} onJump={jump} barRef={barRef} />

      <div className="mt-3 flex flex-col gap-3">
        {/* ----------------------------------------------- what each page does */}
        <section
          id="section-start-here"
          className="rounded-2xl border border-white/25 bg-card/70 p-4 backdrop-blur-sm"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              <BookOpen className="size-3" />
              What each page does — start here
            </h3>
            <span className="text-[9px] text-muted-foreground">
              For someone new: every page, and everything it can do
            </span>
          </div>

          <p className="mt-2 text-[11px] leading-5 text-muted-foreground">
            New here? This is the whole hub in plain words. Nothing has to be
            done in order — press a button and it takes you there. Everything is
            private: only you and your family, on the devices you have approved.
          </p>

          <div className="mt-3 grid gap-2 lg:grid-cols-2">
            {GUIDE.map(({ id, name, icon: Icon, blurb, points, to, jumps }) => (
              <article
                key={id}
                className="flex flex-col rounded-xl border border-border/70 bg-background/40 p-3"
              >
                <div className="flex items-center gap-2">
                  <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-white/10 text-white">
                    <Icon className="size-3.5" />
                  </span>
                  <p className="text-[11px] font-semibold">{name}</p>
                </div>

                <p className="mt-1.5 text-[10px] leading-4 text-muted-foreground">
                  {blurb}
                </p>

                <ul className="mt-1.5 flex flex-col gap-1">
                  {points.map((point) => (
                    <li
                      key={point}
                      className="flex items-start gap-1.5 text-[10px] leading-4 text-muted-foreground"
                    >
                      <Check className="mt-0.5 size-2.5 shrink-0 text-foreground/70" />
                      <span>{point}</span>
                    </li>
                  ))}
                </ul>

                <div className="mt-2 flex flex-wrap gap-1.5">
                  {to ? (
                    <Button
                      asChild
                      size="sm"
                      variant="outline"
                      className="h-7 cursor-pointer rounded-lg text-[9px]"
                    >
                      <Link to={to}>
                        Open it
                        <ExternalLink className="size-3" />
                      </Link>
                    </Button>
                  ) : null}
                  {jumps?.map((jumpTo) => (
                    <Button
                      key={jumpTo.id}
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => jump(jumpTo.id)}
                      className="h-7 cursor-pointer rounded-lg text-[9px]"
                    >
                      {jumpTo.label}
                    </Button>
                  ))}
                </div>
              </article>
            ))}
          </div>
        </section>

        {/* ---------------------------------------------------- system status */}
        <section
          id="section-system-status"
          className="rounded-2xl border border-white/25 bg-card/70 p-4 backdrop-blur-sm"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              <Activity className="size-3" />
              System status
            </h3>

            {/* Nothing to press here on purpose: every light is a live
                subscription, not a reading taken once and kept. The device's
                own network — the other half of "online" — is read, and
                re-read, in Web & connectivity, where its lights live. */}
            <span className="text-[9px] text-muted-foreground">
              Live, straight from each source
            </span>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            <Light
              label="Hub database"
              value={unreachable ? "OFFLINE" : "CONNECTED"}
              tone={unreachable ? "bad" : "good"}
              note={
                unreachable
                  ? `Never answered${retries ? ` after ${retries} tries` : ""} — the messenger and the calendar need it.`
                  : "Convex, live and subscribed."
              }
            />
            <Light
              label="The [LIVE] board"
              value={boardAt ? "GATHERED" : "EMPTY"}
              tone={boardAt ? "good" : "warn"}
              note={
                boardAt
                  ? `Read ${timeAgo(boardAt)}.`
                  : "Nothing on the shelf yet."
              }
            />
            <Light
              label="AI systems"
              value={connectedAi ? `${connectedAi} CONNECTED` : "NONE"}
              tone={connectedAi ? "good" : "warn"}
              note={
                checkedAt
                  ? `${answering} answered when checked ${new Date(checkedAt).toLocaleTimeString()}.`
                  : "Not checked yet — press Refresh in AI systems."
              }
            />
            <Light
              label="The workshop"
              value={workshop?.connected ? "READY" : "NO SANDBOX"}
              tone={workshop?.connected ? "good" : "muted"}
              note={
                workshop?.connected
                  ? "The AI Builder has a machine of its own."
                  : "Set DAYTONA_API_KEY to give the Builder a machine."
              }
            />
            <Light
              label="Reminders"
              value={reminderCount ? `${reminderCount} WAITING` : "NONE"}
              tone={reminderCount ? "warn" : "muted"}
              note="Server-side: whichever device has the hub open rings."
            />
            <Light
              label="Boxes on [LIVE]"
              value={String(boxCount)}
              tone="muted"
              note="The ones the assistant installed for you."
            />
          </div>

          <p className="mt-2 text-[9px] leading-4 text-muted-foreground">
            Every light here is read from the thing it names — the database from
            the client's own connection state, the AI systems by asking them,
            the board from its last gathering. Nothing is hard-coded, and a
            light that cannot be read says so rather than showing green. This
            device's own network has its own category, Web & connectivity.
          </p>
        </section>

        {/* --------------------------------------------- security and access */}
        <div id="section-security">
          <SecurityPanel />
        </div>

        {/* ---------------------------------------------- sign-ins and people */}
        <div id="section-people">
          <SignInsPanel />
        </div>

        {/* ------------------------------------------------------- the address */}
        <div id="section-hub-address">
          <HubAddressPanel />
        </div>

        {/* ------------------------------------------------- the device rows */}
        <section
          id="section-settings"
          className="rounded-2xl border border-border/70 bg-card/70 p-4 backdrop-blur-sm"
        >
          <h3 className="flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            <SlidersHorizontal className="size-3" />
            Settings — every switch the hub owns
          </h3>

          {/* One group of switches at a time, without leaving the category.
              This is the only place these jumps are listed. */}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {SECTION_TITLES.map((title) => (
              <button
                key={title}
                type="button"
                onClick={() => scrollToSection(slug(title))}
                className="cursor-pointer rounded-full border border-border/60 px-2.5 py-1 text-[9px] text-muted-foreground transition-colors hover:border-white/30 hover:text-foreground"
              >
                {title}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[9px] leading-4 text-muted-foreground">
            Every row below has a{" "}
            <span className="text-foreground">Where this lives</span> note, and
            it is written for the device you are holding: the exact screen to
            change it on, with any address worth pasting. Everything the hub
            truly owns is an on/off switch beside the row.
          </p>

          {DEVICE_GROUPS.map((group) => (
            <div key={group.id} className="mt-3">
              <p className="text-[10px] leading-4 text-muted-foreground">
                {group.description}
              </p>

              {sectionsOf(group.items).map((section) => (
                <div
                  key={section.title}
                  id={`section-${slug(section.title)}`}
                  // scroll-mt clears the Quick Reference bar, which is pinned
                  // over the top of the page while this scrolls.
                  className="mt-3 scroll-mt-28"
                >
                  <h4 className="text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                    {section.title}
                  </h4>

                  <ul className="mt-1.5 divide-y divide-border/60">
                    {section.items.map((item) => {
                      const result = results[item.id];
                      const state = status.permissions[item.id];
                      const available = status.supports[item.id] !== false;
                      const location = locationFor(item.id);
                      const isToggle = item.kind === "toggle";
                      const changedFromDefault =
                        isToggle &&
                        (values[item.id] ?? item.default) !== item.default;

                      return (
                        <li
                          key={item.id}
                          id={`setting-${item.id}`}
                          className="flex items-start gap-4 py-3 scroll-mt-2"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <p className="text-[11px] font-medium">
                                {item.label}
                              </p>

                              {item.kind === "permission" ? (
                                <span
                                  className={cn(
                                    "rounded-full border px-1.5 py-px text-[8px]",
                                    state === "granted"
                                      ? "border-white/40 text-foreground"
                                      : "border-border/60 text-muted-foreground",
                                  )}
                                >
                                  {available
                                    ? PERMISSION_LABEL[state ?? "unknown"]
                                    : "Not available here"}
                                </span>
                              ) : null}

                              {item.kind === "status" ? (
                                <span className="rounded-full border border-border/60 px-1.5 py-px text-[8px] text-muted-foreground">
                                  {statusValue(item.id)}
                                </span>
                              ) : null}

                              {changedFromDefault && isToggle ? (
                                <span className="rounded-full border border-border/60 px-1.5 py-px text-[8px] text-muted-foreground">
                                  Changed
                                </span>
                              ) : null}
                            </div>

                            <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
                              {item.description}
                            </p>

                            {/* ----------------------------------- where it lives */}
                            <button
                              type="button"
                              onClick={() =>
                                setWhereOpen((open) =>
                                  open === item.id ? null : item.id,
                                )
                              }
                              aria-expanded={whereOpen === item.id}
                              className="mt-1 inline-flex cursor-pointer items-center gap-1 text-[9px] text-muted-foreground transition-colors hover:text-foreground"
                            >
                              <MapPin className="size-2.5" />
                              {whereOpen === item.id
                                ? "Hide where this lives"
                                : "Where this lives"}
                            </button>

                            {whereOpen === item.id ? (
                              <WherePanel location={location} device={device} />
                            ) : null}

                            {result ? (
                              <p
                                className={cn(
                                  "mt-1 flex items-center gap-1 text-[9px] leading-4",
                                  result.ok
                                    ? "text-foreground/80"
                                    : "text-muted-foreground",
                                )}
                              >
                                {result.ok ? (
                                  <Check className="size-2.5" />
                                ) : (
                                  <X className="size-2.5" />
                                )}
                                {result.message}
                              </p>
                            ) : null}
                          </div>

                          <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
                            {isToggle && changedFromDefault ? (
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                onClick={() =>
                                  void handleToggle(item, item.default)
                                }
                                aria-label={`Reset ${item.label}`}
                                className={cn(
                                  "h-8 cursor-pointer rounded-lg px-1.5 text-[9px]",
                                  ORANGE_GHOST,
                                )}
                              >
                                <RotateCcw className="size-3" />
                                Reset
                              </Button>
                            ) : null}

                            {isToggle ? (
                              <Switch
                                checked={values[item.id] ?? item.default}
                                onCheckedChange={(next) =>
                                  void handleToggle(item, next)
                                }
                                aria-label={item.label}
                              />
                            ) : null}

                            {item.kind === "status" ? (
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                onClick={refresh}
                                aria-label={`Read ${item.label} again`}
                                className={cn(
                                  "h-8 cursor-pointer rounded-lg px-1.5",
                                  ORANGE_GHOST,
                                )}
                              >
                                <RefreshCw className="size-3" />
                              </Button>
                            ) : null}

                            {item.kind === "permission" ? (
                              <Switch
                                checked={state === "granted"}
                                disabled={busy === item.id || !available}
                                onCheckedChange={(next) =>
                                  void handlePermission(item, next)
                                }
                                aria-label={item.label}
                              />
                            ) : null}

                            {item.kind === "action" ? (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={busy === item.id || !available}
                                onClick={() => void runAction(item.id)}
                                className="h-8 cursor-pointer rounded-lg text-[10px]"
                              >
                                {busy === item.id ? (
                                  <Loader2 className="size-3 animate-spin" />
                                ) : (
                                  item.actionLabel
                                )}
                              </Button>
                            ) : null}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          ))}
        </section>

        {/* --------------------------------------------------------- calendar */}
        <section
          id="section-calendar"
          className="rounded-2xl border border-border/70 bg-card/70 p-4 backdrop-blur-sm"
        >
          <h3 className="flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            <CalendarDays className="size-3" />
            Calendar
          </h3>

          <ul className="mt-1.5 divide-y divide-border/60">
            <li className="flex items-start gap-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-medium">Reminders</p>
                <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
                  {reminders?.length
                    ? `${reminders.length} waiting. The soonest is “${reminders[0].text}”.`
                    : "Nothing waiting. An alarm set on an entry puts one here."}
                </p>
              </div>

              <div className="shrink-0 pt-0.5">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!reminders?.length}
                  onClick={() => {
                    void clearReminders();
                    toast.success("Every reminder is cleared.");
                  }}
                  className={cn(
                    "h-8 cursor-pointer rounded-lg text-[10px]",
                    ORANGE_BUTTON,
                  )}
                >
                  <X className="size-3" />
                  Clear all
                </Button>
              </div>
            </li>

            <li className="flex items-start gap-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-medium">Outside calendars</p>
                <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
                  Reads every Google, Outlook or .ics address linked on the
                  calendar page — now, instead of when that page is open.
                </p>
              </div>

              <div className="shrink-0 pt-0.5">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={syncing}
                  onClick={() => void syncCalendar()}
                  className={cn(
                    "h-8 cursor-pointer rounded-lg text-[10px]",
                    ORANGE_BUTTON,
                  )}
                >
                  {syncing ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <RefreshCw className="size-3" />
                  )}
                  Sync now
                </Button>
              </div>
            </li>

            <li className="flex items-start gap-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-medium">Download the calendar</p>
                <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
                  The last month and the year ahead as one .ics file, alarms
                  included, ready to import into Google, Outlook or Apple.
                </p>
              </div>

              <div className="shrink-0 pt-0.5">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!exported}
                  onClick={downloadCalendar}
                  className="h-8 cursor-pointer rounded-lg text-[10px]"
                >
                  <Download className="size-3" />
                  Download .ics
                </Button>
              </div>
            </li>
          </ul>

          <p className="mt-2 text-[9px] leading-4 text-muted-foreground">
            AI access: the assistant reads this calendar and writes to it — see
            the AI systems below. Reminders live on the server, so whichever
            device you have open is the one that rings.{" "}
            <Link
              to="/calendar"
              className="text-foreground underline underline-offset-2"
            >
              Open the calendar
            </Link>{" "}
            to add an entry, an alarm, a layer or a shared shopping list.
          </p>
        </section>

        {/* ------------------------------------------------------- AI systems */}
        <section
          id="section-ai-systems"
          className="rounded-2xl border border-border/70 bg-card/70 p-4 backdrop-blur-sm"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              AI systems
            </h3>

            <div className="flex items-center gap-2">
              {/* The models on this machine are the only systems nobody has to
                  connect — they are already on the machine — so asking for them
                  to lead is a choice rather than a key, and it belongs beside
                  the check that proves they are there. */}
              {aiSystems?.some((system) => system.local) ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  aria-pressed={values.local_ai_first === true}
                  title={
                    values.local_ai_first === true
                      ? "The models on this machine are asked before anything on the internet. Press again to put them back in their place in the list."
                      : "Ask the models running on this machine first — free, private, and in the house. This page carries the question to them; the hub's own server never tries."
                  }
                  onClick={() =>
                    update("local_ai_first", values.local_ai_first !== true)
                  }
                  className={cn(
                    "h-8 cursor-pointer rounded-lg text-[10px]",
                    values.local_ai_first === true
                      ? "border-white/50 bg-white/10 text-foreground"
                      : "text-muted-foreground",
                  )}
                >
                  <Server className="size-3" />
                  {values.local_ai_first === true
                    ? "Local AI answers first"
                    : "Ask local AI first"}
                </Button>
              ) : null}

              <span className="text-[9px] text-muted-foreground">
                {checking
                  ? "Checking…"
                  : checkedAt
                    ? `Checked ${new Date(checkedAt).toLocaleTimeString()}`
                    : "Not checked yet"}
              </span>

              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={checking || !(aiSystems?.length ?? 0)}
                onClick={() => void checkAi()}
                className={cn(
                  "h-8 cursor-pointer rounded-lg text-[10px]",
                  ORANGE_BUTTON,
                )}
              >
                <RefreshCw
                  className={cn("size-3", checking && "animate-spin")}
                />
                Refresh
              </Button>
            </div>
          </div>

          <ul className="mt-1.5 divide-y divide-border/60">
            {(aiSystems ?? []).map((system, index) => {
              const state = health[system.id];

              return (
                <li key={system.id} className="flex items-start gap-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <p className="text-[11px] font-medium">{system.label}</p>

                      {index === 0 ? (
                        <span className="rounded-full border border-white/40 px-1.5 py-px text-[8px] text-foreground">
                          Leads
                        </span>
                      ) : null}

                      <span className="rounded-full border border-border/60 px-1.5 py-px text-[8px] text-muted-foreground">
                        {tierLabel(system.tier)}
                      </span>

                      {state ? (
                        <span
                          title={state.detail}
                          className={cn(
                            "flex items-center gap-1 rounded-full border px-1.5 py-px text-[8px]",
                            state.ok
                              ? "border-white/40 text-foreground"
                              : "border-dashed border-border/70 text-muted-foreground",
                          )}
                        >
                          <span
                            className={cn(
                              "size-1.5 rounded-full",
                              state.ok ? "bg-emerald-500" : "bg-red-500",
                            )}
                          />
                          {state.ok
                            ? `Answered in ${state.ms} ms`
                            : "Not answering"}
                        </span>
                      ) : null}
                    </div>

                    <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
                      {system.note}
                    </p>

                    {state && !state.ok ? (
                      <p className="mt-0.5 break-words text-[9px] leading-4 text-muted-foreground">
                        {state.detail}
                      </p>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>

          <p className="mt-3 text-[10px] leading-4 text-muted-foreground">
            The first one leads. If it stops answering, the question moves down
            the list on its own. Every key you add in the Keys tab joins the
            list, and none of them reaches the browser. The models on this
            machine are reached through a page of the hub open over there — a
            server in a data centre has no `127.0.0.1` of yours to ask.
          </p>

          <p className="mt-2 text-[9px] leading-4 text-muted-foreground">
            {autoRefreshAi
              ? "Checked again every five minutes while this page is open."
              : "Auto refresh is off, so this list is checked only when you press Refresh."}
          </p>

          <div className="mt-4 border-t border-border/60 pt-3">
            <h4 className="text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Not connected yet
            </h4>
            <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
              {`${catalogRest.length} of ${aiCatalog?.length ?? 0} systems are waiting for a key. Follow "Get a key" to the page that issues one, then paste the variable beside it into the Keys tab — it joins the list above on the next question, with no code and no restart. Anything marked free of charge costs nothing to switch on.`}
            </p>

            {catalogRest.length ? (
              <ul className="mt-2 flex flex-col gap-1.5">
                {catalogRest.map((system) => (
                  <li
                    key={system.id}
                    className="rounded-xl border border-border/70 bg-background/30 px-2.5 py-2"
                  >
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[10px] font-medium">
                        {system.label}
                      </span>

                      <span className="rounded-full border border-border/60 px-1.5 py-px text-[8px] text-muted-foreground">
                        {tierLabel(system.tier)}
                      </span>

                      {system.envVars.map((name) => (
                        <code
                          key={name}
                          className="rounded-full border border-border/60 px-1.5 py-px text-[8px] text-foreground"
                        >
                          {name}
                        </code>
                      ))}

                      {system.signup ? (
                        <a
                          href={system.signup}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-0.5 rounded-full border border-border/60 px-1.5 py-px text-[8px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                        >
                          Get a key
                          <ExternalLink className="size-2.5" />
                        </a>
                      ) : null}
                    </div>

                    <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
                      {system.note}
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1.5 text-[10px] leading-4 text-muted-foreground">
                Everything on the list is connected.
              </p>
            )}
          </div>
        </section>

        {/* -------------------------------------------------------- workshop */}
        <section
          id="section-the-workshop"
          className="rounded-2xl border border-border/70 bg-card/70 p-4 backdrop-blur-sm"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              <Hammer className="size-3" />
              The workshop
            </h3>

            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={building || !workshop?.connected}
              onClick={() => void runBuild()}
              className="h-8 cursor-pointer rounded-lg text-[10px]"
            >
              {building ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Hammer className="size-3" />
              )}
              {building ? "Building…" : "Build the copy"}
            </Button>
          </div>

          <p className="mt-1.5 text-[10px] leading-4 text-muted-foreground">
            {workshop === undefined ? (
              "Looking for the sandbox…"
            ) : workshop.connected ? (
              `The AI Builder works on a copy of this app in a sandbox of its own, at ${workshop.replica} — every file of it, on another machine. A change that breaks the copy cannot reach this hub, which is the whole reason it works there instead of here.`
            ) : (
              // A dead end is only a dead end if it does not say which door to
              // open. The variable is named here rather than left to a doc,
              // because this paragraph is where somebody finds out.
              <>
                No sandbox machine is configured, so the AI Builder has nowhere
                of its own to build in and says so plainly. One key —{" "}
                <code className="text-foreground">DAYTONA_API_KEY</code> — and
                the copy gets a machine of its own. Nothing else about this hub
                needs one, and everything above works without it.
              </>
            )}
          </p>

          {/* ------------------------------------ the builder's two switches */}
          <div className="mt-3 grid gap-2 border-t border-border/60 pt-3 sm:grid-cols-2">
            <SwitchRow
              label="Work as a crew of six"
              hint="Six hats, and every step in the chat is badged with the one who took it. Off, and the builder works as one voice with no badges."
              checked={values.builder_crew ?? true}
              onCheckedChange={(next) => update("builder_crew", next)}
            />
            <SwitchRow
              label="May look outside"
              hint="Web search, reading pages, and asking the other AI systems. Off, and it works only from its bench and this app's own source — and says so when something needed looking up."
              checked={values.builder_research ?? true}
              onCheckedChange={(next) => update("builder_research", next)}
            />
          </div>

          {/* The roster, in plain words: who each badge belongs to. */}
          {(values.builder_crew ?? true) ? (
            <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
              {CREW.map((member) => (
                <li
                  key={member.id}
                  className="flex items-start gap-1.5 rounded-lg border border-border/60 bg-background/30 px-2 py-1.5"
                >
                  <code className="shrink-0 rounded border border-border/70 bg-background/50 px-1 py-px font-mono text-[9px] text-foreground/85">
                    {member.handle}
                  </code>
                  <span className="min-w-0 text-[9px] leading-4 text-muted-foreground">
                    {member.role}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          {buildReport ? (
            <div className="mt-3 border-t border-border/60 pt-3">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={cn(
                    "rounded-full border px-1.5 py-px text-[8px]",
                    buildReport.ok
                      ? "border-white/40 text-foreground"
                      : "border-dashed border-border/70 text-muted-foreground",
                  )}
                >
                  {buildReport.ok
                    ? "The copy builds"
                    : "The copy does not build"}
                </span>

                {buildReport.seededFiles > 0 ? (
                  <span className="text-[9px] text-muted-foreground">
                    {buildReport.seededFiles} files copied from the running app
                  </span>
                ) : null}
              </div>

              {buildReport.error ? (
                <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
                  {buildReport.error}
                </p>
              ) : null}

              <ul className="mt-2 flex flex-col gap-1.5">
                {buildReport.steps.map((step) => (
                  <li
                    key={step.name}
                    className="rounded-xl border border-border/70 bg-background/30 px-2.5 py-2"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[10px] font-medium">
                        {step.name}
                      </span>
                      <span className="text-[9px] text-muted-foreground">
                        {step.ok ? "passed" : "failed"} in {step.seconds}s
                      </span>
                    </div>

                    {!step.ok ? (
                      <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-[9px] leading-4 text-muted-foreground">
                        {step.detail}
                      </pre>
                    ) : null}
                  </li>
                ))}
              </ul>

              <p className="mt-2 text-[10px] leading-4 text-muted-foreground">
                {buildReport.changed === null
                  ? "Could not compare the copy against this app's own files, so there is no list of what it changed."
                  : buildReport.changed.length === 0
                    ? "Nothing in the copy differs from this app's own files."
                    : `Different from this app (${buildReport.changed.length}): ${buildReport.changed.join(", ")}`}
              </p>
            </div>
          ) : null}

          {/* ---------------------------------------- the bench, and exports */}
          <div className="mt-3 border-t border-border/60 pt-3">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="rounded-full border border-border/60 bg-background/40 px-2 py-0.5 text-[9px] font-medium text-muted-foreground">
                {bench === undefined
                  ? "Reading the bench…"
                  : bench === null
                    ? "Locked — unlock the hub to read the bench"
                    : `${bench.files.length} file${bench.files.length === 1 ? "" : "s"} · ${readableSize(bench.totalChars)}`}
              </span>
              <span className="rounded-full border border-border/60 bg-background/40 px-2 py-0.5 text-[9px] font-medium text-muted-foreground">
                This account only
              </span>
            </div>

            <p className="mt-1.5 text-[10px] leading-4 text-muted-foreground">
              The bench is the project itself: every file the builder wrote,
              open in the Files panel of the AI Builder page and overridable by
              hand. It is kept in this hub's own database for this account —
              local to your workspace, and nowhere else. A file here only rides
              into a download while it is newer than the app's own copy, so an
              older working copy can never replace newer code; Export saves the
              whole bench onto this device regardless, and the GitHub push runs
              from this browser straight to GitHub and is never stored here.
            </p>

            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!bench?.files.length}
                onClick={() => void downloadBenchZip()}
                className="h-8 cursor-pointer rounded-lg text-[10px]"
              >
                <Download className="size-3" />
                Export project ZIP
              </Button>

              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={typechecking || building || !workshop?.connected}
                onClick={() => void runTypecheck()}
                className="h-8 cursor-pointer rounded-lg text-[10px]"
              >
                {typechecking ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Zap className="size-3" />
                )}
                {typechecking ? "Typechecking…" : "Typecheck the copy"}
              </Button>

              <Button
                type="button"
                size="sm"
                variant="outline"
                asChild
                className="h-8 cursor-pointer rounded-lg text-[10px]"
              >
                <Link to="/builder">
                  <Hammer className="size-3" />
                  Open the AI Builder
                </Link>
              </Button>

              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!bench?.files.length}
                onClick={() => void emptyBench()}
                className={cn(
                  "h-8 cursor-pointer rounded-lg text-[10px]",
                  ORANGE_BUTTON,
                )}
              >
                <RotateCcw className="size-3" />
                Clear the bench
              </Button>
            </div>

            {/* ------------------------------------------- GitHub export */}
            <div className="mt-2">
              <button
                type="button"
                onClick={() => setGhOpen((open) => !open)}
                aria-expanded={ghOpen}
                className="inline-flex cursor-pointer items-center gap-1 text-[9px] text-muted-foreground transition-colors hover:text-foreground"
              >
                <GitBranch className="size-2.5" />
                {ghOpen
                  ? "Hide the GitHub export"
                  : "GitHub export — push the bench into a repository"}
              </button>

              {ghOpen ? (
                <div className="mt-1.5 rounded-xl border border-border/70 bg-background/30 p-3">
                  <p className="text-[10px] leading-4 text-muted-foreground">
                    One commit, from this browser to GitHub. The token is a
                    personal access token from GitHub's own Developer settings,
                    scoped to the repository — it stays in these fields, is
                    never saved here, and is only ever sent to api.github.com.
                    The repository has to exist already; the branch is made for
                    you if it does not.
                  </p>

                  <div className="mt-2 grid gap-2 sm:grid-cols-3">
                    <Input
                      type="password"
                      value={ghToken}
                      onChange={(event) => setGhToken(event.target.value)}
                      placeholder="ghp_…"
                      autoComplete="off"
                      data-spell="off"
                      spellCheck={false}
                      aria-label="GitHub personal access token"
                      className="h-8 rounded-lg text-[10px]"
                    />
                    <Input
                      value={ghRepo}
                      onChange={(event) => setGhRepo(event.target.value)}
                      placeholder="owner/repo"
                      autoComplete="off"
                      data-spell="off"
                      spellCheck={false}
                      aria-label="Repository, as owner/repo"
                      className="h-8 rounded-lg text-[10px]"
                    />
                    <Input
                      value={ghBranch}
                      onChange={(event) => setGhBranch(event.target.value)}
                      placeholder="main"
                      autoComplete="off"
                      data-spell="off"
                      spellCheck={false}
                      aria-label="Branch"
                      className="h-8 rounded-lg text-[10px]"
                    />
                  </div>

                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      disabled={
                        ghPushing ||
                        !ghToken.trim() ||
                        !ghRepo.trim() ||
                        !bench?.files.length
                      }
                      onClick={() => void pushBench()}
                      className="h-8 cursor-pointer rounded-lg text-[10px]"
                    >
                      {ghPushing ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        <GitBranch className="size-3" />
                      )}
                      {ghPushing
                        ? "Pushing…"
                        : `Push ${bench?.files.length ?? 0} files`}
                    </Button>

                    {ghCommit ? (
                      <a
                        href={ghCommit}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-0.5 text-[9px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                      >
                        Last commit
                        <ExternalLink className="size-2.5" />
                      </a>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          <p className="mt-2 text-[9px] leading-4 text-muted-foreground">
            Building here proves the copy still compiles and runs. It never
            changes the app you are using: carrying a change across is a
            separate, deliberate step a person takes.
          </p>
        </section>

        {/* ------------------------------------------------- controlforge */}
        <ControlForgeSection />

        {/* ------------------------------------------------- activity & logs */}
        <section
          id="section-activity"
          className="rounded-2xl border border-border/70 bg-card/70 p-4 backdrop-blur-sm"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              <ScrollText className="size-3" />
              Activity &amp; logs
            </h3>
            <span className="text-[9px] text-muted-foreground">
              {behind === undefined
                ? "Reading…"
                : behind.length
                  ? `Newest first · ${behind.length} shown`
                  : "Nothing recorded yet"}
            </span>
          </div>

          <p className="mt-1.5 text-[10px] leading-4 text-muted-foreground">
            What the hub has been doing on its own — the [LIVE] board gathering,
            the calendar syncing, the assistant deciding to speak up. Each row
            is written while it happens, so a failure is visible rather than
            swallowed; the security log, for who came in and on what device, is
            in Security above.
          </p>

          <div className="mt-2">
            {behind === undefined ? (
              <p className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <Loader2 className="size-3 animate-spin" />
                Reading what has been running…
              </p>
            ) : activity.length ? (
              <TraceFeed steps={activity} defaultOpen />
            ) : (
              <p className="rounded-md border border-border/60 px-2.5 py-2 text-[11px] text-muted-foreground">
                Nothing has run behind the scenes yet. The board gathers on its
                own twice a day, and the calendar syncs on its timer.
              </p>
            )}
          </div>
        </section>

        {/* ------------------------------------------------------ LIVE board */}
        <section
          id="section-live-board"
          className="rounded-2xl border border-border/70 bg-card/70 p-4 backdrop-blur-sm"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              <Radio className="size-3" />
              The [LIVE] board
            </h3>

            <div className="flex items-center gap-2">
              <span className="text-[9px] text-muted-foreground">
                {boardAt ? `Read ${timeAgo(boardAt)}` : "Never gathered"}
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={boardBusy}
                onClick={() => void refreshLiveBoard()}
                className={cn(
                  "h-8 cursor-pointer rounded-lg text-[10px]",
                  ORANGE_BUTTON,
                )}
              >
                <RefreshCw
                  className={cn("size-3", boardBusy && "animate-spin")}
                />
                Refresh
              </Button>
            </div>
          </div>

          <ul className="mt-1.5 divide-y divide-border/60">
            <li className="flex items-start gap-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-medium">The wall of boxes</p>
                <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
                  {boardAt
                    ? `Last gathered ${timeAgo(boardAt)}. Weather, snow, alerts, air, drought and rivers, fire, the markets, hay and alfalfa prices, livestock and equipment auctions, aircraft, earthquakes, space weather and the headlines — refreshed on the server, and readable out loud by the assistant.`
                    : "Nothing is on the shelf yet. Press Refresh and the server will gather the whole wall now."}
                </p>
              </div>

              <div className="shrink-0 pt-0.5">
                <Button
                  asChild
                  size="sm"
                  variant="outline"
                  className="h-8 cursor-pointer rounded-lg text-[10px]"
                >
                  <Link to="/live">
                    Open the board
                    <Radio className="size-3" />
                  </Link>
                </Button>
              </div>
            </li>

            <li className="flex items-start gap-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-medium">Boxes you asked for</p>
                <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
                  {boxCount
                    ? `${boxCount} installed by the assistant. Each one is read again every hour on the server, and taken down when you ask.`
                    : "None yet. Ask the AI Assistant to put a feed, a sale board or an events page on the [LIVE] page and it installs one."}
                </p>
              </div>

              <div className="shrink-0 pt-0.5">
                <Button
                  asChild
                  size="sm"
                  variant="outline"
                  className="h-8 cursor-pointer rounded-lg text-[10px]"
                >
                  <Link to="/live">
                    See them
                    <ExternalLink className="size-3" />
                  </Link>
                </Button>
              </div>
            </li>

            <li className="flex items-start gap-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-medium">Ask it to read</p>
                <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
                  Say “what's on the live board” and the assistant reads it
                  back, links included — or “brief me” for the calendar and the
                  board together.
                </p>
              </div>

              <div className="shrink-0 pt-0.5">
                <Button
                  asChild
                  size="sm"
                  variant="outline"
                  className="h-8 cursor-pointer rounded-lg text-[10px]"
                >
                  <Link to="/assistant">
                    Ask the assistant
                    <Brain className="size-3" />
                  </Link>
                </Button>
              </div>
            </li>
          </ul>
        </section>

        {/* ------------------------------------------------ web & connectivity */}
        <section
          id="section-connectivity"
          className="rounded-2xl border border-border/70 bg-card/70 p-4 backdrop-blur-sm"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              <Globe className="size-3" />
              Web &amp; connectivity
            </h3>

            <div className="flex items-center gap-2">
              {readAt ? (
                <span className="text-[9px] text-muted-foreground">
                  Read at {readAt}
                </span>
              ) : null}
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={refresh}
                className={cn(
                  "h-8 cursor-pointer rounded-lg text-[10px]",
                  ORANGE_BUTTON,
                )}
              >
                <RefreshCw className="size-3" />
                Re-read this device
              </Button>
            </div>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            <Light
              label="Network"
              value={status.online ? "ONLINE" : "OFFLINE"}
              tone={status.online ? "good" : "bad"}
            />
            <Light
              label="Link"
              value={
                status.connection
                  ? status.connection.toUpperCase()
                  : status.online
                    ? "CONNECTED"
                    : "NONE"
              }
              tone={status.online ? "good" : "bad"}
            />
            <Light
              label="Throughput"
              value={
                status.downlink ? `${status.downlink} Mbps` : "NOT REPORTED"
              }
              tone={status.downlink ? "good" : "muted"}
            />
            <Light
              label="Secure origin"
              value={window.isSecureContext ? "HTTPS" : "NOT SECURE"}
              tone={window.isSecureContext ? "good" : "bad"}
            />
          </div>

          <p className="mt-2 text-[10px] leading-4 text-muted-foreground">
            These four are read from this device's own network interface, which
            is what decides whether a call has the bandwidth for it. Re-read
            this device takes the reading again. The machine the hub runs on is
            a different question and a different category — the Web Portal holds
            a real diagnostic run against the server, not this browser — and the
            hub's own address, the link an invite hands out, is its own category
            too. This page is the hub's network half; the AI systems, the [LIVE]
            board and the rest each have theirs.
          </p>
        </section>

        {/* ------------------------------------------------------ web portal */}
        <div>
          <WebPortalSection />
        </div>

        {/* ---------------------------------------------------- offline brain */}
        <div>
          <OfflineBrainSection />
        </div>

        {/* ------------------------------------------------ tools & downloads */}
        <section
          id="section-tools"
          className="rounded-2xl border border-border/70 bg-card/70 p-4 backdrop-blur-sm"
        >
          <div className="flex items-start gap-3">
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-white/10 text-white">
              <HardDriveDownload className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <h3 className="text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                Tools &amp; downloads — taking the hub with you
              </h3>
              <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
                Every file below is the app as it now stands: one zip holding it
                with a JSON copy of everything the hub has written down, the app
                alone with its Dockerfile, the code as one readable file, the
                Linux steps, and the data by itself. Each is built here in the
                browser from what the hub already holds — nothing is uploaded to
                make a backup, an older working copy on the AI Builder&apos;s
                bench can never take newer code&apos;s place in one, and the hub
                keeps running exactly as it was. The Offline Brain section above
                carries it too: the brain's package now holds this application,
                whole, as <span className="text-foreground">source/this-app-source.zip</span>,
                so every platform build and every edition there is the app as
                well as the tools it was built with.
              </p>
            </div>
          </div>

          <div className="mt-3">
            <BackupPanel />
          </div>
        </section>

        {/* ----------------------------------------------------- remembering */}
        <section
          id="section-what-it-remembers"
          className="rounded-2xl border border-border/70 bg-card/70 p-4 backdrop-blur-sm"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              <Brain className="size-3" />
              What it remembers
            </h3>

            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!(memories?.length ?? 0)}
              onClick={() => {
                void forgetEverything();
                toast.success("Everything it remembered is gone.");
              }}
              className={cn(
                "h-8 cursor-pointer rounded-lg text-[10px]",
                ORANGE_BUTTON,
              )}
            >
              <RotateCcw className="size-3" />
              Forget everything
            </Button>
          </div>

          {memories?.length ? (
            <ul className="mt-1.5 divide-y divide-border/60">
              {memories.map((memory) => (
                <li key={memory._id} className="flex items-start gap-3 py-2.5">
                  <p className="min-w-0 flex-1 text-[10px] leading-4 text-muted-foreground">
                    {memory.text}
                  </p>

                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Forget: ${memory.text}`}
                    onClick={() => void forgetOne({ id: memory._id })}
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                  >
                    <X className="size-3" />
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1.5 text-[10px] leading-4 text-muted-foreground">
              Nothing yet. Tell it something worth keeping — a birthday, an
              allergy, how you like to be helped — and it saves it by itself,
              without being asked.
            </p>
          )}

          <p className="mt-3 text-[9px] leading-4 text-muted-foreground">
            Where this lives: your account alone — not this device, and never
            the rest of the family. The brain on your own machine keeps its own
            memory beside this one; the{" "}
            <a
              href="/local-brain"
              className="text-foreground underline underline-offset-2"
            >
              Local Brain
            </a>{" "}
            page pairs with it and shows everything in it.
          </p>
        </section>

        {/* ------------------------------------------------------------- voice */}
        <section
          id="section-voice"
          className="rounded-2xl border border-border/70 bg-card/70 p-4 backdrop-blur-sm"
        >
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <h3 className="flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                <Mic className="size-3" />
                Voice
              </h3>
              <p className="mt-1.5 text-[10px] leading-4 text-muted-foreground">
                Eight women, eight accents, and not one of them British —
                American, Southern, French, Italian, Spanish, Brazilian,
                Australian, Indian. Every voice the British Isles gives a device
                is refused by name and by language, so nothing here sounds like
                the news being read at you. Hear one before you choose it:
                nothing changes until you press Use, and whoever you are on now
                stays on this list — she is always the way back.
              </p>
            </div>
          </div>

          {/* ------------------------------------------------- studio voice */}
          <div className="mt-3 rounded-xl border border-white/20 bg-background/40 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-1.5 text-[11px] font-medium">
                  Studio voice
                  <span
                    className={cn(
                      "rounded-full border px-1.5 py-px text-[8px]",
                      studio.ready
                        ? "border-emerald-400/50 text-emerald-300"
                        : "border-border/60 text-muted-foreground",
                    )}
                  >
                    {unreachable
                      ? "hub offline"
                      : studio.ready
                        ? `${studio.provider?.label} · speaking`
                        : studio.switchedOn
                          ? "not connected"
                          : "switched off"}
                  </span>
                </p>
                <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
                  {unreachable
                    ? "The hub's own backend is not answering, so no speech model can be reached from this page — she is speaking with this device's own voice meanwhile. That is a connection problem rather than a key one, and it is worth fixing first: the database and every AI system live behind the same door, and this row is only the part of it you can hear."
                    : studio.ready
                      ? `A real text-to-speech model, not this device's own engine — that is the difference between a personality and a satnav. The words she is about to say are sent to ${studio.provider?.label} to be spoken and nothing about them is stored, here or there. The provider bills by the character.`
                      : studio.switchedOn
                        ? "No speech model is connected yet, so she is speaking with this device's own voice — which on many machines is a decade-old engine. Add a key for one of the systems below and she will use it from the next reply, with no other change."
                        : "Switched off: she speaks with this device's own engine. The switch is here and in the Assistant section of the settings list."}
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!studio.ready || studio.speaking}
                  onClick={() => {
                    // The whole point of this button: one line, out loud, now.
                    // It goes through the same call a reply goes through and the
                    // same audio element a reply plays through, so a failure here
                    // is the same failure a reply would have.
                    void studio.test();
                  }}
                  className="h-8 cursor-pointer rounded-lg text-[10px]"
                >
                  <Mic className="size-3" />
                  {studio.speaking ? "Speaking…" : "Test it"}
                </Button>

                <Button
                  type="button"
                  size="sm"
                  variant={studio.switchedOn ? "default" : "outline"}
                  onClick={() => studio.setSwitchedOn(!studio.switchedOn)}
                  className="h-8 cursor-pointer rounded-lg text-[10px]"
                >
                  {studio.switchedOn ? "On" : "Off"}
                </Button>
              </div>
            </div>

            {studio.trouble ? (
              <p className="mt-2 rounded-lg border border-dashed border-white/25 px-2.5 py-2 text-[10px] leading-4 text-foreground/80">
                {studio.trouble}
                {studio.heard ? ` (Last heard: ${studio.heard}.)` : ""}
              </p>
            ) : null}

            {/* The voices this provider really has, one press each to hear. */}
            {studio.providers.map((provider) => (
              <div key={provider.id} className="mt-2">
                <p className="text-[9px] uppercase tracking-[0.1em] text-muted-foreground">
                  {provider.label}
                  {studio.keyed.includes(provider.id)
                    ? " — connected"
                    : ` — needs ${provider.keyEnv}`}
                </p>
                <ul className="mt-1 flex flex-wrap gap-1.5">
                  {provider.voices.map((voice) => {
                    const chosen =
                      studio.choice === `${provider.id}:${voice.id}`;
                    return (
                      <li key={voice.id}>
                        <button
                          type="button"
                          title={voice.about}
                          onClick={() => studio.chooseVoice(`${provider.id}:${voice.id}`)}
                          className={cn(
                            "cursor-pointer rounded-full border px-2 py-0.5 text-[9px] transition-colors",
                            chosen
                              ? "border-white/40 bg-white/15 text-foreground"
                              : "border-border/60 text-muted-foreground hover:bg-white/10 hover:text-foreground",
                          )}
                        >
                          {voice.label}
                        </button>
                      </li>
                    );
                  })}
                </ul>
                <p className="mt-1 text-[9px] leading-4 text-muted-foreground">
                  {provider.models[0]}
                  {provider.instructions
                    ? " — the model takes a delivery instruction, and she is described to it in full: mature, warm, smoky, quick rather than sweet."
                    : " — this model takes the words and the voice only, so the character is carried by which voice you pick."}{" "}
                  {provider.note}{" "}
                  <a
                    href={provider.docs}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex items-center gap-0.5 text-foreground underline underline-offset-2"
                  >
                    Docs
                    <ExternalLink className="size-2.5" />
                  </a>
                </p>
              </div>
            ))}

            {!studio.available && !unreachable ? (
              <p className="mt-2 text-[9px] leading-4 text-muted-foreground">
                OpenRouter and Groq are the two systems here that can speak, and
                both are already used for the AI itself — a key for either is all
                that is missing. The links are in the AI systems list below.{" "}
                <a
                  href="https://openrouter.ai/keys"
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-foreground underline underline-offset-2"
                >
                  OpenRouter keys
                </a>{" "}
                or{" "}
                <a
                  href="https://console.groq.com/keys"
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-foreground underline underline-offset-2"
                >
                  Groq keys
                </a>
                .
              </p>
            ) : null}
          </div>

          <p className="mt-3 text-[10px] leading-4 text-muted-foreground">
            Eight accents, when she is speaking with the engine this device
            already has. Each one takes the voice that really is her accent, or —
            if this machine has none — a different voice of its own, so the list
            is eight women rather than one woman eight times.
          </p>

          <ul className="mt-1.5 divide-y divide-border/60">
            {voiceProfiles.map((profile) => {
              const active = profile.id === voiceId;
              const one = resolveVoiceById(profile.id);

              return (
                <li key={profile.id} className="flex items-start gap-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <p className="text-[11px] font-medium">{profile.name}</p>
                      <span className="rounded-full border border-border/60 px-1.5 py-px text-[8px] text-muted-foreground">
                        {profile.accent}
                      </span>
                      {active ? (
                        <span className="rounded-full border border-white/40 px-1.5 py-px text-[8px] text-foreground">
                          In use
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
                      {profile.about}
                    </p>
                    <p className="mt-1 text-[10px] leading-4 text-foreground/80">
                      {one.note}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => previewVoice(profile.id)}
                      className="h-8 cursor-pointer rounded-lg text-[10px]"
                    >
                      Hear it
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant={active ? "default" : "outline"}
                      disabled={active}
                      onClick={() => chooseVoice(profile.id)}
                      className="h-8 cursor-pointer rounded-lg text-[10px]"
                    >
                      {active ? "Chosen" : "Use"}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>

          <div className="mt-3 rounded-xl border border-border/60 bg-background/40 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-medium">How she says it</p>
                <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
                  These four move the real speaker, everywhere she talks: the
                  answers on the Assistant page, the little box in the corner,
                  and the alerts she says out loud on her own. Press Hear it
                  above to judge them — the sample goes through exactly this
                  delivery. Volume and speed reach both engines; warmth and
                  expressiveness are the device engine's own phrasing, because
                  shifting the pitch of a recorded voice is what makes one sound
                  cheap — with a studio model, the voice you pick is the warmth,
                  and the delivery instruction is the expressiveness.
                </p>
              </div>

              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={voiceDeliveryIsDefault}
                onClick={() => resetVoiceDelivery()}
                className="h-8 cursor-pointer rounded-lg text-[10px]"
              >
                <RotateCcw className="size-3" />
                {voiceDeliveryIsDefault
                  ? "Her own defaults"
                  : "Back to her defaults"}
              </Button>
            </div>

            <div className="mt-2.5 grid gap-2 sm:grid-cols-2">
              {VOICE_SLIDERS.map((slider) => (
                <VoiceSlider
                  key={slider.key}
                  label={slider.label}
                  about={slider.about}
                  value={shownDelivery[slider.key]}
                  min={DELIVERY_LIMITS[slider.key].min}
                  max={DELIVERY_LIMITS[slider.key].max}
                  step={DELIVERY_LIMITS[slider.key].step}
                  show={slider.show}
                  onChange={(next) =>
                    setVoiceDraft({ ...shownDelivery, [slider.key]: next })
                  }
                  onCommit={(next) => setVoiceDelivery({ [slider.key]: next })}
                />
              ))}
            </div>

            <p className="mt-2 text-[9px] leading-4 text-muted-foreground">
              Defaults: {voiceDefaults.speed.toFixed(2)}× speed ·{" "}
              {voiceDefaults.warmth < 0
                ? `−${Math.abs(voiceDefaults.warmth).toFixed(2)}`
                : `+${voiceDefaults.warmth.toFixed(2)}`}{" "}
              warmth · {Math.round(voiceDefaults.volume * 100)}% volume ·{" "}
              {Math.round(voiceDefaults.expressiveness * 100)}%
              expressiveness — the same for every one of the eight, so a voice
              chosen tomorrow still speaks the way you set today.
            </p>
          </div>

          <p className="mt-3 text-[9px] leading-4 text-muted-foreground">
            Where this lives: the voice and the four numbers are saved with
            your account, so every device you sign in on is the same person.
            Which voice she actually gets is the device's own business — the
            hub can only choose from what this phone or computer offers — and
            so is the truth above: each row says whether this device really has
            that accent, is standing in for it, or has nothing to offer.{" "}
            {voiceEngineReady ? null : (
              <>
                This browser has no speech engine at all, so nothing here can
                be heard — the choice is still remembered for a device that can
                speak.
              </>
            )}{" "}
            {voiceEngineReady && !voiceListReady
              ? "This device has not named its voices yet — the list arrives a moment after the first page that asks for it."
              : null}
            {voiceEngineReady && voiceListReady
              ? `This device offers ${voiceCount} ${voiceCount === 1 ? "voice" : "voices"}, and every one of them is measured against the eight above.`
              : null}
          </p>
        </section>

        {/* ------------------------------------------------------------- reset */}
        <section
          id="section-reset"
          className="rounded-2xl border border-border/70 bg-card/70 p-4 backdrop-blur-sm"
        >
          <h3 className="text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Reset
          </h3>

          <ul className="mt-1.5 divide-y divide-border/60">
            <li className="flex items-start gap-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-medium">All switches</p>
                <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
                  {changed.length === 0
                    ? "Every switch is already at its default."
                    : `${changed.length} switch${changed.length === 1 ? "" : "es"} changed from the default: ${changed
                        .map((item) => item.label)
                        .join(", ")}.`}
                </p>
              </div>

              <div className="shrink-0 pt-0.5">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={changed.length === 0}
                  onClick={() => void resetSwitches()}
                  className={cn(
                    "h-8 cursor-pointer rounded-lg text-[10px]",
                    ORANGE_BUTTON,
                  )}
                >
                  <RotateCcw className="size-3" />
                  Reset
                </Button>
              </div>
            </li>

            <li className="flex items-start gap-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-medium">Permissions</p>
                <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
                  A page is never allowed to take a permission back — only you
                  can, in your browser's own site settings. So switching one off
                  here cannot work: the switch stays on and the row's{" "}
                  <span className="text-foreground">Where this lives</span> note
                  opens with the address to paste.
                </p>
              </div>

              <div className="shrink-0 pt-0.5">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => jump("settings")}
                  className="h-8 cursor-pointer rounded-lg text-[10px]"
                >
                  <SlidersHorizontal className="size-3" />
                  Open Settings
                </Button>
              </div>
            </li>

            <li className="flex items-start gap-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-medium">Voice</p>
                <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
                  {voiceId === DEFAULT_VOICE_ID && voiceDeliveryIsDefault
                    ? `${profileById(DEFAULT_VOICE_ID).name} is already in use, speaking at her own defaults.`
                    : `Back to ${profileById(DEFAULT_VOICE_ID).name} — her accent, and her own delivery — on every device.`}
                </p>
              </div>

              <div className="shrink-0 pt-0.5">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={voiceId === DEFAULT_VOICE_ID && voiceDeliveryIsDefault}
                  onClick={() => {
                    chooseVoice(DEFAULT_VOICE_ID);
                    if (!voiceDeliveryIsDefault) resetVoiceDelivery();
                  }}
                  className={cn(
                    "h-8 cursor-pointer rounded-lg text-[10px]",
                    ORANGE_BUTTON,
                  )}
                >
                  <RotateCcw className="size-3" />
                  Reset
                </Button>
              </div>
            </li>
          </ul>

          <p className="mt-2 text-[9px] leading-4 text-muted-foreground">
            Nothing here touches your messages, your family or the AIs.
            Resetting switches only puts the app's own behaviour back where it
            started.
          </p>
        </section>
      </div>
    </div>
  );
}

export default ControlRoom;
