import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { useInstall } from "@/hooks/use-install";
import type { InstallGuide } from "@/lib/pwa";
import { cn } from "@/lib/utils";
import { motion } from "framer-motion";
import {
  Brain,
  BrainCircuit,
  CalendarDays,
  Check,
  Church,
  Copy,
  Download,
  Globe,
  Hammer,
  HardDriveDownload,
  Loader2,
  MessageCircle,
  MonitorSmartphone,
  Radio,
  SlidersHorizontal,
  Smartphone,
} from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";

const RISE = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
};

/** What is behind each page, in one line, for someone opening this for the first time. */
const PAGES = [
  {
    to: "/assistant",
    label: "AI Assistant",
    icon: Church,
    line: "Ask it anything, or just talk. It looks things up, runs code, sets timers, passes messages on, reads the [LIVE] board back to you, gives you a rundown of the day and everything coming up, and speaks up on its own when a timer or reminder needs you.",
  },
  {
    to: "/builder",
    label: "AI Builder",
    icon: Hammer,
    line: "Turns an idea into a plan and the code for it, and can read and repair this app's own source.",
  },
  {
    to: "/messenger",
    label: "Messenger",
    icon: MessageCircle,
    line: "The family room: who is around right now, the group video room, and peer-to-peer encrypted voice and video calls — all in one page.",
  },
  {
    to: "/calendar",
    label: "Calendar",
    icon: CalendarDays,
    line: "The family's month in one grid — events on their own layers, meals, the shopping list, and anything streamed in from another calendar. Everything the AI Assistant or the [LIVE] board adds lands on its own Assistant & LIVE layer, hideable in one tap.",
  },
  {
    to: "/control-room",
    label: "Control Room",
    icon: SlidersHorizontal,
    line: "All the settings, and only the settings: the switches the hub owns, a note on where each one really lives, the AI systems answering you, what the assistant remembers, the voice it speaks with, and the calendar's reminders and feeds.",
  },
  {
    to: "/live",
    label: "[LIVE]",
    icon: Radio,
    line: "Mission control: one wall of same-size boxes the hub fetches itself — weather, mountain snow, NWS alerts, air, drought and rivers, Colorado hay and alfalfa prices by region, cattle, horse, tack and equipment auctions across the state, ranch and farm store sales, mapped wildfires, FEMA declarations, energy, metals, farm, market and economic prices, the grid's inputs, aircraft overhead, the ISS and space weather, earthquakes, Colorado and world headlines, and a real 24/7 HFGCS rebroadcast that starts muted — refreshed on the server every half hour. A box carries your own calendar's next entries. Ask the AI Assistant to read any of it back, links included — or ask for a rundown of the day and everything coming up. Each morning it also writes its dated sales onto the calendar and leaves the day's watch card there.",
  },
  {
    to: "/offline-brain",
    label: "Offline Brain",
    icon: BrainCircuit,
    line: "Your Proton VPN link at the top, the hub's own backup, and the whole AI coding system: every model, runtime, reasoning framework, coding agent and tool, each with its own download button, plus one file with all of it. Everything there is open source and runs on your own machine — no cloud, no account.",
  },
];

/** Every button worth pressing, grouped, so nothing in the hub is a mystery. */
const CONTROLS = [
  {
    group: "The address",
    icon: Globe,
    items: [
      {
        label: "Address",
        what: "The one link that opens this hub. The same on every phone and computer.",
      },
      {
        label: "Copy",
        what: "Copies the address so you can send it or open it elsewhere. This is the only thing anyone needs to get in.",
      },
      {
        label: "Install on this device",
        what: "Adds the hub's own icon and opens it full screen. It is the same app either way — this only hides the browser bars.",
      },
    ],
  },
  {
    group: "Calendar",
    icon: CalendarDays,
    items: [
      {
        label: "New entry",
        what: "Adds one thing to a day: pick the kind, the layer, a time, an alarm, a cost and a note.",
      },
      {
        label: "Alarm / reminder",
        what: "Set on an entry. It rings on whichever device has the hub open — a chime, a buzz and a system notification.",
      },
      {
        label: "Sync now",
        what: "Reads every outside calendar linked here and pulls the new entries in straight away.",
      },
      {
        label: "Add an address",
        what: "Links a Google, Outlook or other .ics calendar by its private link, so its entries appear on their own.",
      },
      {
        label: "Upload a .ics file",
        what: "Reads a calendar file you were sent or downloaded, once.",
      },
      {
        label: "Download .ics",
        what: "Saves the whole calendar — alarms included — as one file for Google, Outlook or Apple.",
      },
      {
        label: "Search",
        what: "Narrows the month to the entries that match a word — title, place, person, cost or note.",
      },
      {
        label: "AI access",
        what: "The assistant reads this calendar and writes to it — ask it to add, move or cancel something.",
      },
      {
        label: "Layers",
        what: "Each kind of entry sits on a layer: personal, community, meals, bulletin, and Assistant & LIVE. Switch one off to hide it without deleting anything — and the [LIVE] board's calendar box honours the same switches.",
      },
      {
        label: "From the board, daily",
        what: "Every morning the [LIVE] board writes itself onto the Assistant & LIVE layer: the dated horse and equipment sales as all-day entries, one \"Colorado & national watch\" card for the day's weather alerts, road reports, drought and hay trade, and a reminder for each person. A sale that has passed is cleared away on its own.",
      },
      {
        label: "Shopping list",
        what: "The shared list, with a tick for each item and a Clear when the shop is done.",
      },
    ],
  },
  {
    group: "The AIs",
    icon: Brain,
    items: [
      {
        label: "Which one answers",
        what: "Nothing to press. The first system in the Control Room leads; if it stops answering, the question moves down the list.",
      },
      {
        label: "Read the [LIVE] board",
        what: "Say \"what's on the live board\" and the assistant reads it back — the weather, snow, alerts, drought, fire, the markets, hay and cattle prices, the auctions, aircraft overhead, space weather and the headlines, with every link it names.",
      },
      {
        label: "Rundown",
        what: "Say \"brief me\" or \"what's coming up\" and the assistant reads the calendar and the board together: today first, then everything on the way.",
      },
      {
        label: "Keys",
        what: "Where you paste a provider's key. It stays on the server and never reaches the browser.",
      },
      {
        label: "Auto refresh",
        what: "The Control Room switch that re-checks every system every five minutes while that page is open.",
      },
      {
        label: "Forget everything",
        what: "Wipes what the assistant has been told to remember about you.",
      },
      {
        label: "Voice",
        what: "The voice the assistant speaks with, on this account. Hear one before you choose it.",
      },
    ],
  },
  {
    group: "Family and Messenger",
    icon: MessageCircle,
    items: [
      {
        label: "The roster",
        what: "Who is here right now, in the Messenger beside the chat — with one tap to call or video.",
      },
      {
        label: "Call / Video",
        what: "Peer-to-peer and encrypted. Both people need the hub open.",
      },
      {
        label: "The room",
        what: "The shared family chat, seen by everyone who signs in.",
      },
    ],
  },
  {
    group: "Control Room — the settings",
    icon: SlidersHorizontal,
    items: [
      {
        label: "Switches",
        what: "Every setting this hub owns, and a note on where each one really lives when the change has to happen elsewhere.",
      },
      {
        label: "VPN",
        what: "The switch that remembers you want the VPN on and opens your Proton VPN link when you turn it on. The tunnel itself is made by the Proton VPN app, never by a web page.",
      },
      {
        label: "Where this lives",
        what: "Opens the exact screen to change a setting on, and any address worth pasting.",
      },
      {
        label: "Reset",
        what: "Puts one switch, or every switch, back to its default.",
      },
      {
        label: "Refresh",
        what: "Re-reads the browser's permissions and network, in case you changed one in its own settings.",
      },
    ],
  },
  {
    group: "Offline Brain — the downloads",
    icon: BrainCircuit,
    items: [
      {
        label: "Your VPN link",
        what: "Your Proton VPN link, at the very top of the Offline Brain. Open it to connect on this device.",
      },
      {
        label: "Download the installer",
        what: "One file onto your drive that fetches the whole offline AI coding system — every model, agent and tool.",
      },
      {
        label: "This page's address",
        what: "Downloads are far more reliable from a normal tab than inside a preview frame — copy the address and open it directly.",
      },
    ],
  },
  {
    group: "Backup — now on the Offline Brain",
    icon: HardDriveDownload,
    items: [
      {
        label: "Everything — the app and its data",
        what: "One zip holding the whole app, a Dockerfile that runs it on your own computer, and a JSON copy of everything the hub has written down. This is the one to keep.",
      },
      {
        label: "The app, ready to run",
        what: "The same zip without the data. On a Linux laptop, unzip it and run docker compose up --build, then open localhost:8080.",
      },
      {
        label: "The code, readable",
        what: "Every file the hub is made of, one after another in a single text file. Nothing to install to read it.",
      },
      {
        label: "The data alone",
        what: "Messages, calendar, shopping list, memories, reminders, the Builder's files and links to attachments, as plain JSON.",
      },
      {
        label: "The Linux steps",
        what: "The install guide with the Dockerfile, compose file and nginx config it refers to, saved as text.",
      },
      {
        label: "Where the files go",
        what: "Straight to the device in front of you. Nothing is uploaded to make a backup, and the hub keeps running exactly as it was.",
      },
    ],
  },
] as const;

/** One list of tap-by-tap instructions, shared by both download panels. */
function GuideList({
  guides,
  ownGuideId,
}: {
  guides: InstallGuide[];
  ownGuideId: string | undefined;
}) {
  return (
    <Accordion
      type="single"
      collapsible
      defaultValue={ownGuideId}
      className="mt-2"
    >
      {guides.map((guide) => (
        <AccordionItem key={guide.id} value={guide.id} className="border-border/60">
          <AccordionTrigger className="cursor-pointer py-2.5 hover:no-underline">
            <span className="min-w-0">
              <span className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] font-medium">{guide.label}</span>
                <span className="rounded-full border border-border/60 px-1.5 py-px text-[8px] text-muted-foreground">
                  {guide.browser}
                </span>
                {guide.id === ownGuideId ? (
                  <span className="rounded-full border border-white/40 px-1.5 py-px text-[8px] text-foreground">
                    This is you
                  </span>
                ) : null}
              </span>
              <span className="mt-1 block text-[10px] leading-4 font-normal text-muted-foreground">
                {guide.summary}
              </span>
            </span>
          </AccordionTrigger>

          <AccordionContent className="pb-3">
            <ol className="flex flex-col gap-1.5">
              {guide.steps.map((step, index) => (
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

            {guide.note ? (
              <p className="mt-2.5 rounded-lg border border-dashed border-border/70 px-2.5 py-2 text-[10px] leading-4 text-muted-foreground">
                {guide.note}
              </p>
            ) : null}
          </AccordionContent>
        </AccordionItem>
      ))}
    </Accordion>
  );
}

function WebPortal() {
  const { info, guides, ownGuide, canInstall, installed, busy, install } =
    useInstall();
  const [copied, setCopied] = useState(false);

  const address =
    typeof window === "undefined" ? "" : `${window.location.origin}/`;

  const deviceWord =
    info.kind === "computer"
      ? "computer"
      : info.kind === "tablet"
        ? "device"
        : "phone";

  const phoneGuides = guides.filter((guide) => guide.device !== "computer");
  const computerGuides = guides.filter((guide) => guide.device === "computer");

  const handleInstall = async () => {
    const result = await install();
    if (result.ok) toast.success(result.message);
    else toast(result.message);
  };

  const copyAddress = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      toast.success("Address copied — send it to the next device.");
    } catch {
      toast.error("This browser would not let me copy it — select and copy it yourself.");
    }
  };

  return (
    <div className="h-full overflow-y-auto px-1 py-1">
      <motion.header
        {...RISE}
        transition={{ duration: 0.25 }}
        className="mb-4 flex items-start gap-3 px-1"
      >
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-white/10 text-white">
          <Globe className="size-4" />
        </span>
        <div className="min-w-0">
          <h1 className="text-[12px] font-semibold tracking-tight">
            Web Portal
          </h1>
          <p className="text-[10px] text-muted-foreground">
            One address, opened in any browser. Put it on your device, and what
            every button does.
          </p>
        </div>
      </motion.header>

      {/* -------------------------------------------------- the address first */}
      <motion.section
        {...RISE}
        transition={{ duration: 0.25, delay: 0.04 }}
        className="rounded-2xl border border-border/70 bg-card/70 p-4 backdrop-blur-sm"
      >
        <h3 className="text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          The address — the one thing to keep
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
            {copied ? (
              <Check className="size-3.5" />
            ) : (
              <Copy className="size-3.5" />
            )}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>

        <p className="mt-2 text-[10px] leading-4 text-muted-foreground">
          Open that address on any phone or computer, sign in once, and it is the
          same hub. Nothing to download, and nothing to send anyone but this
          link.
        </p>
      </motion.section>

      {/* ----------------------------------------------------- install on this */}
      <motion.section
        {...RISE}
        transition={{ duration: 0.25, delay: 0.08 }}
        className="mt-3 rounded-2xl border border-border/70 bg-card/70 p-4 backdrop-blur-sm"
      >
        <div className="flex flex-wrap items-start gap-4">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-white/10 text-white">
            <MonitorSmartphone className="size-5" />
          </span>

          <div className="min-w-0 flex-1">
            <h2 className="text-[12px] font-semibold tracking-tight">
              {installed
                ? "The hub is already installed here"
                : `Put the hub on ${info.name}`}
            </h2>
            <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
              {installed
                ? "You are using the installed app right now — it opened without browser bars. Open it from your icon from now on."
                : canInstall
                  ? "One tap installs it with its own icon, and it then opens full screen like any other app."
                  : `This browser installs from its own menu rather than a button, and ${ownGuide?.browser ?? "your browser"} is listed below. It takes about ten seconds.`}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {installed ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-white/40 px-2.5 py-1 text-[9px]">
                <Check className="size-3" />
                Installed
              </span>
            ) : canInstall ? (
              <Button
                type="button"
                disabled={busy}
                onClick={() => void handleInstall()}
                className="h-9 cursor-pointer rounded-lg text-[11px]"
              >
                {busy ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Download className="size-3.5" />
                )}
                Install on this {deviceWord}
              </Button>
            ) : null}
          </div>
        </div>
      </motion.section>

      {/* ------------------------------------------- the two download paths */}
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <motion.section
          {...RISE}
          transition={{ duration: 0.25, delay: 0.12 }}
          className={cn(
            "rounded-2xl border bg-card/70 p-4 backdrop-blur-sm",
            info.kind === "computer" ? "border-white/25" : "border-border/70",
          )}
        >
          <div className="flex items-start gap-3">
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-white/10 text-white">
              <MonitorSmartphone className="size-4" />
            </span>
            <div className="min-w-0">
              <h2 className="text-[12px] font-semibold tracking-tight">
                On a computer
              </h2>
              <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
                Windows, Mac, Linux or a Chromebook. It installs from the browser
                you already have — no store, no installer file.
              </p>
            </div>
          </div>

          <GuideList guides={computerGuides} ownGuideId={ownGuide?.id} />
        </motion.section>

        <motion.section
          {...RISE}
          transition={{ duration: 0.25, delay: 0.16 }}
          className={cn(
            "rounded-2xl border bg-card/70 p-4 backdrop-blur-sm",
            info.kind !== "computer" ? "border-white/25" : "border-border/70",
          )}
        >
          <div className="flex items-start gap-3">
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-white/10 text-white">
              <Smartphone className="size-4" />
            </span>
            <div className="min-w-0">
              <h2 className="text-[12px] font-semibold tracking-tight">
                On a phone or tablet
              </h2>
              <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
                iPhone, iPad or Android. It lands on the Home Screen with your
                other apps.
              </p>
            </div>
          </div>

          <GuideList guides={phoneGuides} ownGuideId={ownGuide?.id} />
        </motion.section>
      </div>

      {/* ------------------------------------------------------- what is inside */}
      <motion.section
        {...RISE}
        transition={{ duration: 0.25, delay: 0.2 }}
        className="mt-3 rounded-2xl border border-border/70 bg-card/70 p-4 backdrop-blur-sm"
      >
        <h3 className="text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          What is inside
        </h3>

        <ul className="mt-1.5 divide-y divide-border/60">
          {PAGES.map(({ to, label, icon: Icon, line }) => (
            <li key={to} className="flex items-start gap-3 py-2.5">
              <span className="mt-px grid size-6 shrink-0 place-items-center rounded-lg bg-white/10 text-white">
                <Icon className="size-3" />
              </span>
              <div className="min-w-0 flex-1">
                <Link
                  to={to}
                  className="text-[11px] font-medium underline-offset-2 hover:underline"
                >
                  {label}
                </Link>
                <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
                  {line}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </motion.section>

      {/* ----------------------------------------------------- every button */}
      <motion.section
        {...RISE}
        transition={{ duration: 0.25, delay: 0.24 }}
        className="mt-3 mb-2 rounded-2xl border border-border/70 bg-card/70 p-4 backdrop-blur-sm"
      >
        <h3 className="text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          What every button does
        </h3>

        <div className="mt-2 flex flex-col gap-3.5">
          {CONTROLS.map(({ group, icon: Icon, items }) => (
            <div key={group}>
              <p className="flex items-center gap-1.5 text-[10px] font-medium">
                <Icon className="size-3 text-muted-foreground" />
                {group}
              </p>
              <ul className="mt-1 divide-y divide-border/60">
                {items.map((item) => (
                  <li
                    key={item.label}
                    className="flex flex-col gap-0.5 py-2 sm:flex-row sm:items-baseline sm:gap-2"
                  >
                    <span className="shrink-0 text-[10px] font-medium sm:w-40">
                      {item.label}
                    </span>
                    <span className="min-w-0 flex-1 text-[10px] leading-4 text-muted-foreground">
                      {item.what}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </motion.section>
    </div>
  );
}

export default WebPortal;
