import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { api } from "@/convex/_generated/api";
import type { BuildReport } from "@/convex/sandbox";
import { useDeviceStatus, type PermissionState } from "@/hooks/use-device-status";
import { useSettings } from "@/hooks/use-settings";
import { useVoice } from "@/hooks/use-voice";
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
import { detectDevice, type DeviceInfo } from "@/lib/pwa";
import {
  addressesOf,
  bestRoute,
  BROWSER_NAME,
  locationFor,
  type SettingLocation,
} from "@/lib/settings-locations";
import { cn } from "@/lib/utils";
import { VPN_URL } from "@/lib/offline-brain";
import { DEFAULT_VOICE_ID } from "@/lib/voices";
import { useAction, useMutation, useQuery } from "convex/react";
import {
  Brain,
  CalendarDays,
  Check,
  Copy,
  Download,
  Globe,
  Hammer,
  Loader2,
  MapPin,
  RefreshCw,
  RotateCcw,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
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

/** Every switch on the page, so they can all be put back at once. */
const TOGGLES = DEVICE_GROUPS.flatMap((group) => group.items).filter(
  (item): item is Extract<DeviceItem, { kind: "toggle" }> =>
    item.kind === "toggle",
);

/** The section headings, in the order they appear — used by the jump list. */
const SECTION_TITLES = [
  ...new Set(
    DEVICE_GROUPS.flatMap((group) =>
      sectionsOf(group.items).map((section) => section.title),
    ),
  ),
];

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-");

/** What a system costs, in the one phrase a row has room for. */
function tierLabel(tier: "free" | "free-tier" | "paid" | "own") {
  if (tier === "free") return "No key needed";
  if (tier === "free-tier") return "Free tier";
  if (tier === "paid") return "Paid per token";
  return "Your own endpoint";
}

function scrollToSection(title: string) {
  document
    .getElementById(`section-${slug(title)}`)
    ?.scrollIntoView({ behavior: "smooth", block: "start" });
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

      {route?.quick ?? location.quick ? (
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
  const status = useDeviceStatus();
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
  const {
    id: voiceId,
    profiles: voiceProfiles,
    choose: chooseVoice,
    preview: previewVoice,
    deviceVoiceName,
  } = useVoice();

  const [results, setResults] = useState<Record<string, ActionResult>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [whereOpen, setWhereOpen] = useState<string | null>(null);
  const [readAt, setReadAt] = useState<string | null>(null);
  const [health, setHealth] = useState<
    Record<string, { ok: boolean; ms: number; detail: string }>
  >({});
  const [checking, setChecking] = useState(false);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
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
  // What is left to connect. Kept out of the render so the filter runs once
  // per answer rather than on every keystroke on the page.
  const catalogRest = useMemo(
    () => (aiCatalog ?? []).filter((system) => !system.connected),
    [aiCatalog],
  );

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
      if (report.ok) toast.success("The copy builds. This app was not touched.");
      else toast.error(report.error ?? "The copy did not build — the output is below.");
    } catch {
      toast.error("Could not reach the server to build the copy.");
    } finally {
      setBuilding(false);
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
  useEffect(() => {
    if (!autoRefreshAi || !aiSystems?.length) return;

    void checkAi();
    const timer = window.setInterval(() => {
      if (!document.hidden) void checkAi();
    }, 5 * 60_000);
    return () => window.clearInterval(timer);
  }, [autoRefreshAi, aiSystems?.length, checkAi]);

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

  return (
    <div className="h-full overflow-y-auto px-1 py-1">
      <header className="mb-4 flex items-start gap-3 px-1">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-white/10 text-white">
          <SlidersHorizontal className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-[12px] font-semibold tracking-tight">
            Control Room
          </h1>
          <p className="text-[10px] text-muted-foreground">
            The switches the hub owns, what it can honestly read, and the AI
            systems behind it.
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2 pt-0.5">
          {readAt ? (
            <span className="hidden text-[9px] text-muted-foreground sm:inline">
              Read at {readAt}
            </span>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={refresh}
            className="h-8 cursor-pointer rounded-lg text-[10px]"
          >
            <RefreshCw className="size-3" />
            Refresh
          </Button>
        </div>
      </header>

      <div className="flex flex-col gap-3">
        {/* -------------------------------------------------- what this page is */}
        <section className="rounded-2xl border border-border/70 bg-card/70 p-4 backdrop-blur-sm">
          <h3 className="text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Every setting, in one place
          </h3>

          <p className="mt-1.5 text-[10px] leading-4 text-muted-foreground">
            This page is only the hub's settings: the switches it truly owns, the
            ones that live on your device with a note saying exactly where, the AI
            systems behind it, what the assistant remembers, and the calendar's
            reminders and feeds. The address, installing the hub and what every
            button does are on the Web Portal; the software and tools you can
            download are on the Offline Brain. Nothing is repeated here.
          </p>

          <div className="mt-3 border-t border-border/60 pt-2.5">
            <p className="text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Jump to a setting
            </p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {[
                ...SECTION_TITLES,
                "Calendar",
                "AI systems",
                "What it remembers",
              ].map((title) => (
                <button
                  key={title}
                  type="button"
                  onClick={() => scrollToSection(title)}
                  className="cursor-pointer rounded-full border border-border/60 px-2.5 py-1 text-[9px] text-muted-foreground transition-colors hover:border-white/30 hover:text-foreground"
                >
                  {title}
                </button>
              ))}
            </div>
            <p className="mt-2 text-[9px] leading-4 text-muted-foreground">
              Every row has a{" "}
              <span className="text-foreground">Where this lives</span> note, and
              it is written for the device you are holding: the exact screen to
              change it on, with any address worth pasting. Everything the hub
              truly owns is an on/off switch beside the row.
            </p>
          </div>
        </section>

        {/* ------------------------------------------------- the device rows */}
        {DEVICE_GROUPS.map((group) => (
          <section
            key={group.id}
            className="rounded-2xl border border-border/70 bg-card/70 p-4 backdrop-blur-sm"
          >
            <p className="text-[10px] leading-4 text-muted-foreground">
              {group.description}
            </p>

            {sectionsOf(group.items).map((section) => (
              <div
                key={section.title}
                id={`section-${slug(section.title)}`}
                className="mt-3 scroll-mt-2"
              >
                <h3 className="text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  {section.title}
                </h3>

                <ul className="mt-1.5 divide-y divide-border/60">
                  {section.items.map((item) => {
                    const result = results[item.id];
                    const state = status.permissions[item.id];
                    const available = status.supports[item.id] !== false;
                    const location = locationFor(item.id);
                    const isToggle = item.kind === "toggle";
                    const changedFromDefault =
                      isToggle && (values[item.id] ?? item.default) !== item.default;

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
                              onClick={() => void handleToggle(item, item.default)}
                              aria-label={`Reset ${item.label}`}
                              className="h-8 cursor-pointer rounded-lg px-1.5 text-[9px] text-muted-foreground hover:text-foreground"
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
                              className="h-8 cursor-pointer rounded-lg px-1.5 text-muted-foreground hover:text-foreground"
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
          </section>
        ))}

        {/* --------------------------------------------------------- calendar */}
        <section
          id="section-calendar"
          className="scroll-mt-2 rounded-2xl border border-border/70 bg-card/70 p-4 backdrop-blur-sm"
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
                  className="h-8 cursor-pointer rounded-lg text-[10px]"
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
                  className="h-8 cursor-pointer rounded-lg text-[10px]"
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
                <p className="text-[11px] font-medium">
                  Download the calendar
                </p>
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
            device you have open is the one that rings.
          </p>
        </section>

        {/* ------------------------------------------------------- AI systems */}
        <section
          id="section-ai-systems"
          className="scroll-mt-2 rounded-2xl border border-border/70 bg-card/70 p-4 backdrop-blur-sm"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              AI systems
            </h3>

            <div className="flex items-center gap-2">
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
                className="h-8 cursor-pointer rounded-lg text-[10px]"
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
                              state.ok ? "bg-white" : "bg-white/25",
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
            list, and none of them reaches the browser.
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
              {`${catalogRest.length} of ${aiCatalog?.length ?? 0} systems are waiting for a key. Paste the variable beside one into the Keys tab and it joins the list above on the next question — nothing here needs code, and nothing needs a restart. Anything marked free of charge costs nothing to switch on.`}
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
          className="scroll-mt-2 rounded-2xl border border-border/70 bg-card/70 p-4 backdrop-blur-sm"
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
                  {buildReport.ok ? "The copy builds" : "The copy does not build"}
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
                      <span className="text-[10px] font-medium">{step.name}</span>
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

          <p className="mt-2 text-[9px] leading-4 text-muted-foreground">
            Building here proves the copy still compiles and runs. It never
            changes the app you are using: carrying a change across is a
            separate, deliberate step a person takes.
          </p>
        </section>

        {/* ----------------------------------------------------- remembering */}
        <section
          id="section-what-it-remembers"
          className="scroll-mt-2 rounded-2xl border border-border/70 bg-card/70 p-4 backdrop-blur-sm"
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
              className="h-8 cursor-pointer rounded-lg text-[10px]"
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
            Where this lives: your account alone — not this device, and never the
            rest of the family.
          </p>
        </section>

        {/* --------------------------------------------------- the other pages */}
        <section className="rounded-2xl border border-border/70 bg-card/70 p-4 backdrop-blur-sm">
          <h3 className="text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Not here — on their own pages
          </h3>

          <p className="mt-1.5 text-[10px] leading-4 text-muted-foreground">
            The hub keeps its information and its downloads on their own pages, so
            this one stays a settings page and nothing is written twice.
          </p>

          <ul className="mt-1.5 divide-y divide-border/60">
            <li className="flex items-start gap-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-medium">Web Portal</p>
                <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
                  All the information: the address, how to put the hub on a phone
                  or computer, what is inside, and what every button does.
                </p>
              </div>

              <div className="shrink-0 pt-0.5">
                <Button
                  asChild
                  size="sm"
                  variant="outline"
                  className="h-8 cursor-pointer rounded-lg text-[10px]"
                >
                  <Link to="/web-portal">
                    Open
                    <Globe className="size-3" />
                  </Link>
                </Button>
              </div>
            </li>

            <li className="flex items-start gap-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-medium">Offline Brain</p>
                <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
                  Your Proton VPN link, the hub's own backup, and the whole
                  offline AI coding system with each model, agent and tool.
                </p>
              </div>

              <div className="shrink-0 pt-0.5">
                <Button
                  asChild
                  size="sm"
                  variant="outline"
                  className="h-8 cursor-pointer rounded-lg text-[10px]"
                >
                  <Link to="/offline-brain">
                    Open
                    <Download className="size-3" />
                  </Link>
                </Button>
              </div>
            </li>
          </ul>
        </section>

        {/* ------------------------------------------------------------- voice */}
        <section className="rounded-2xl border border-border/70 bg-card/70 p-4 backdrop-blur-sm">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <h3 className="text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                Voice
              </h3>
              <p className="mt-1.5 text-[10px] leading-4 text-muted-foreground">
                The voice the assistant speaks with. Hear it before you choose —
                nothing changes until you press Use.
              </p>
            </div>

            {voiceId !== DEFAULT_VOICE_ID ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => chooseVoice(DEFAULT_VOICE_ID)}
                className="h-8 shrink-0 cursor-pointer rounded-lg px-1.5 text-[9px] text-muted-foreground hover:text-foreground"
              >
                <RotateCcw className="size-3" />
                Reset
              </Button>
            ) : null}
          </div>

          <ul className="mt-1.5 divide-y divide-border/60">
            {voiceProfiles.map((profile) => {
              const active = profile.id === voiceId;
              const deviceVoice = deviceVoiceName(profile.id);

              return (
                <li key={profile.id} className="flex items-start gap-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <p className="text-[11px] font-medium">{profile.label}</p>
                      {active ? (
                        <span className="rounded-full border border-white/40 px-1.5 py-px text-[8px] text-foreground">
                          In use
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
                      {deviceVoice
                        ? `Sounds like ${deviceVoice} on this device.`
                        : "This device has not offered its voice list yet."}
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

          <p className="mt-2 text-[9px] leading-4 text-muted-foreground">
            Where this lives: here, saved with your account. The list of voices
            itself belongs to the device — the hub can only choose from what this
            phone or computer offers.
          </p>
        </section>

        {/* ------------------------------------------------------------- reset */}
        <section className="rounded-2xl border border-border/70 bg-card/70 p-4 backdrop-blur-sm">
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
                  className="h-8 cursor-pointer rounded-lg text-[10px]"
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
                  onClick={refresh}
                  className="h-8 cursor-pointer rounded-lg text-[10px]"
                >
                  <RefreshCw className="size-3" />
                  Re-read
                </Button>
              </div>
            </li>

            <li className="flex items-start gap-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-medium">Voice</p>
                <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
                  Back to the default voice, on every device.
                </p>
              </div>

              <div className="shrink-0 pt-0.5">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={voiceId === DEFAULT_VOICE_ID}
                  onClick={() => chooseVoice(DEFAULT_VOICE_ID)}
                  className="h-8 cursor-pointer rounded-lg text-[10px]"
                >
                  <RotateCcw className="size-3" />
                  Reset
                </Button>
              </div>
            </li>
          </ul>

          <p className="mt-2 text-[9px] leading-4 text-muted-foreground">
            Nothing here touches your messages, your family or the AIs. Resetting
            switches only puts the app's own behaviour back where it started.
          </p>
        </section>
      </div>

    </div>
  );
}

export default ControlRoom;
