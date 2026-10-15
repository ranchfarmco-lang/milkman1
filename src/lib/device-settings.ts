/**
 * The settings the hub owns, and the few device readings it can honestly take.
 *
 * Four kinds are here: `toggle` changes how the app behaves, `permission` asks
 * the browser for access, `action` does something on the device through a real
 * browser API, and `status` is read-only truth. Anything the hub cannot touch,
 * and anything no part of the app uses, is deliberately absent — a row about a
 * phone radio the page can never reach is not information, it is filler.
 *
 * Items are grouped into `section`s, the same way a phone's Settings app is.
 */

export type DeviceItem =
  | {
      id: string;
      kind: "toggle";
      section: string;
      label: string;
      description: string;
      default: boolean;
    }
  | {
      id: string;
      kind: "permission";
      section: string;
      label: string;
      description: string;
    }
  | {
      id: string;
      kind: "action";
      section: string;
      label: string;
      description: string;
      actionLabel: string;
    }
  | {
      id: string;
      kind: "status";
      section: string;
      label: string;
      description: string;
    };

export type DeviceGroup = {
  id: string;
  title: string;
  description: string;
  items: DeviceItem[];
};

export const DEVICE_GROUPS: DeviceGroup[] = [
  {
    id: "messenger",
    title: "Messenger",
    description:
      "The switches the hub owns — the same on every device you sign in on — and the permissions it needs from this one. Every row here changes something that actually happens in the app.",
    items: [
      /* ---------------------------------------------------- sound & alerts */
      {
        id: "silence",
        kind: "toggle",
        section: "Sound & alerts",
        label: "Silence",
        description:
          "Mute every sound the app makes, including the assistant reading its answers out loud.",
        default: false,
      },
      {
        id: "vibrate_messages",
        kind: "toggle",
        section: "Sound & alerts",
        label: "Vibrate",
        description:
          "Buzz the device when a new message arrives from your family.",
        default: true,
      },
      {
        id: "alert_tone",
        kind: "toggle",
        section: "Sound & alerts",
        label: "Message tone",
        description:
          "Play a short chime when a new message arrives. Silence overrides this.",
        default: true,
      },
      {
        id: "notify_messages",
        kind: "toggle",
        section: "Sound & alerts",
        label: "Notifications",
        description:
          "Show a system notification for a new message, so it reaches you when this tab is in the background.",
        default: true,
      },
      {
        id: "notification_preview",
        kind: "toggle",
        section: "Sound & alerts",
        label: "Show message preview",
        description:
          "Include the message text in the notification. Turn it off and alerts just say a new message arrived.",
        default: true,
      },
      {
        id: "do_not_disturb",
        kind: "toggle",
        section: "Sound & alerts",
        label: "Do not disturb",
        description:
          "Hold every alert — no chime, no buzz, no notification — until you switch it back off.",
        default: false,
      },

      /* ------------------------------------------------------------ screen */
      {
        id: "fullscreen",
        kind: "toggle",
        section: "Screen",
        label: "Fullscreen",
        description:
          "Fill the whole screen, the way a phone app does, with no browser bars.",
        default: false,
      },
      {
        id: "screen_rotation",
        kind: "toggle",
        section: "Screen",
        label: "Allow screen rotation",
        description:
          "Let the app turn side-on when you turn the phone. Switch it off and it asks to be held upright in portrait, which needs Fullscreen above.",
        default: true,
      },
      {
        id: "keep_screen_awake",
        kind: "toggle",
        section: "Screen",
        label: "Keep the screen awake",
        description:
          "Stop the screen dimming and locking while the messenger is open.",
        default: false,
      },

      /* --------------------------------------------------------- assistant */
      {
        id: "assistant_speak_up",
        kind: "toggle",
        section: "Assistant",
        label: "Speak up on real alerts",
        description:
          "When a timer you set finishes or a reminder comes due, the assistant says it out loud in its own voice, from any screen. Switch it off and it only speaks when you ask it something.",
        default: true,
      },
      {
        id: "voice_studio",
        kind: "toggle",
        section: "Assistant",
        label: "Studio voice",
        description:
          "Speak with a real text-to-speech model instead of this device's own engine — the voice the Control Room's Voice section describes, warm and low with a person's phrasing. It needs one of the speech providers connected (OpenRouter or Groq, both already used for the AI systems here), and the words being spoken are sent to that provider, so an answer said aloud leaves the hub while a silent one does not. With no key, or with this switched off, or with the connection gone, she speaks with the voice on this device instead — and the change happens mid-reply rather than dropping it.",
        default: true,
      },
      {
        id: "ai_auto_refresh",
        kind: "toggle",
        section: "Assistant",
        label: "Auto refresh the AI systems",
        description:
          "While the Control Room is open, quietly ask every AI system whether it is still answering, every few minutes. Switch it off to check only when you press Refresh.",
        default: true,
      },

      /* -------------------------------------------------------- companion */
      // The little box in the corner, which follows them from page to page.
      // These three are the parts of it a person would want to change: how it
      // hears them, whether it offers anything unasked, and whether it talks.
      {
        id: "companion_hands_free",
        kind: "toggle",
        section: "Companion",
        label: "Hands-free microphone",
        description:
          "Leave the microphone open wherever you go inside the hub, so the little box in the corner hears you without anything being pressed first. It shuts itself while the AI is thinking or talking, so it never answers its own voice. Off until you switch it on here or press the microphone in the box.",
        default: false,
      },
      {
        id: "companion_hints",
        kind: "toggle",
        section: "Companion",
        label: "Offer hints as I work",
        description:
          "Let the box in the corner speak up unprompted: a line about a page you have just opened, and a word about what you are doing. It is never unprompted while Do not disturb is on, and never twice about the same thing. Spelling is not one of its jobs — the field you are typing in does that itself, through the browser's own checker.",
        default: true,
      },
      {
        id: "companion_speak",
        kind: "toggle",
        section: "Companion",
        label: "Read the little box out loud",
        description:
          "Say what the box in the corner answers, as well as showing it — which is what makes hands-free a conversation rather than a transcript. Silence mutes this too, exactly as it does the assistant's own voice.",
        default: true,
      },

      /* ------------------------------------------------------- permissions */
      {
        id: "camera",
        kind: "permission",
        section: "Permissions",
        label: "Camera",
        description:
          "Used by video calls. The hub asks the first time you get on one, and you can take it back at any time in your browser's site settings.",
      },
      {
        id: "microphone",
        kind: "permission",
        section: "Permissions",
        label: "Microphone",
        description:
          "Used for talking to the assistant hands-free and for voice and video calls.",
      },
      {
        id: "notifications",
        kind: "permission",
        section: "Permissions",
        label: "Notifications",
        description:
          "Lets message alerts, timers and reminders reach you even when this tab is in the background.",
      },
      {
        id: "clipboard",
        kind: "permission",
        section: "Permissions",
        label: "Clipboard",
        description:
          "Lets the copy and paste buttons in a box move text in and out of the hub.",
      },
      {
        id: "photos",
        kind: "action",
        section: "Permissions",
        label: "Photos & files",
        description:
          "A web app cannot browse your library on its own, but it can open the picker and use only the file you choose.",
        actionLabel: "Open the picker",
      },

      /* ------------------------------------------------------- connections */
      {
        id: "vpn",
        kind: "toggle",
        section: "Connections",
        label: "VPN",
        description:
          "Remembers that you want the VPN on, and opens your Proton VPN link when you switch it on. The tunnel itself is made by the Proton VPN app on this device — a web page can never build one, so the same link sits at the top of the Offline Brain.",
        default: false,
      },
      {
        id: "wifi",
        kind: "status",
        section: "Connections",
        label: "Wi-Fi",
        description:
          "Read-only. A page can see what kind of connection you are on — which is what tells you a call has the bandwidth for it — but switching networks is the device's job.",
      },
      {
        id: "cell_data",
        kind: "status",
        section: "Connections",
        label: "Mobile data",
        description:
          "Read-only, for the same reason as Wi-Fi. Useful before a call, since video uses more of it.",
      },

      /* ------------------------------------------------------------- calls */
      {
        id: "video_calls",
        kind: "status",
        section: "Calls",
        label: "Voice & video calls",
        description:
          "Calls go between your family's devices, peer to peer or through your own media server, encrypted end to end. The bell on anybody's box rings their hub and notifies them; a screen anybody shares opens in a portal of its own. Get on from the Messenger: the call then follows you across the hub. There is no switch to flip here.",
      },
    ],
  },
];

/** The sections of a group, in the order they first appear. */
export function sectionsOf(items: DeviceItem[]) {
  const seen = new Set<string>();
  const sections: { title: string; items: DeviceItem[] }[] = [];

  for (const item of items) {
    if (!seen.has(item.section)) {
      seen.add(item.section);
      sections.push({ title: item.section, items: [] });
    }
    sections[sections.length - 1].items.push(item);
  }

  return sections;
}

/** Flat fallback values, so the app behaves sensibly before anything is saved. */
export const DEFAULT_DEVICE_SETTINGS: Record<string, boolean> =
  Object.fromEntries(
    DEVICE_GROUPS.flatMap((group) =>
      group.items
        .filter((item) => item.kind === "toggle")
        .map((item) => [
          item.id,
          item.kind === "toggle" ? item.default : false,
        ]),
    ),
  );
