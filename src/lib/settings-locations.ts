/**
 * Where each Control Room row actually lives — on the device you are holding.
 *
 * The Control Room can only change what a web page is allowed to change.
 * Everything else is controlled somewhere else on the device, and "somewhere
 * else" is useless to a person unless it is named *for the phone or computer
 * they are reading this on*. A Chromebook being told to open "the Settings app
 * on this iPhone" is worse than saying nothing, so every route below declares
 * the platforms — and, where it matters, the browsers — it is true for, and the
 * page picks the one that matches.
 *
 * Addresses such as `chrome://settings/content/camera` cannot be opened by a
 * link from inside a page — every browser refuses that — so they are shown to
 * copy and paste instead. They are only ever shown where they exist: no
 * chrome:// address is offered to Safari or Firefox, and none is offered on
 * Android, where the padlock is the documented way in.
 */

import type { BrowserId, PlatformId } from "./pwa";

/** The device in front of the person, as far as it can be told apart. */
export type DeviceTarget = {
  platform: PlatformId;
  browser: BrowserId;
};

export type SettingsRoute = {
  /** The platforms this route is for. */
  when: PlatformId[];
  /**
   * Narrows the route to particular browsers. A route with no `browsers` is
   * the platform-wide answer, used whenever nothing more specific matched.
   */
  browsers?: BrowserId[];
  /** What to tap, in order. */
  steps: string[];
  /** The fastest way in, when one sentence is enough on this device. */
  quick?: string;
  /** An address worth pasting, when this browser has one. */
  address?: { label: string; value: string };
};

export type SettingLocation = {
  /** Where it really lives, in one line — the same on every device. */
  where: string;
  /** The fastest way in wherever you are, for rows with no routes. */
  quick?: string;
  routes: SettingsRoute[];
};

type Address = { label: string; value: string };

const ALL: PlatformId[] = [
  "ios",
  "android",
  "windows",
  "macos",
  "chromeos",
  "linux",
  "other",
];

const DESKTOP: PlatformId[] = [
  "windows",
  "macos",
  "chromeos",
  "linux",
  "other",
];

/** What to call each browser back to the person. */
export const BROWSER_NAME: Record<BrowserId, string> = {
  safari: "Safari",
  chrome: "Chrome",
  edge: "Edge",
  firefox: "Firefox",
  samsung: "Samsung Internet",
  opera: "Opera",
  other: "your browser",
};

/**
 * A permission that lives in the browser's own site settings.
 *
 * Every one of these is the same story with different menus, so the routes are
 * built once and the permission's name is dropped into the steps. `slug` is the
 * site-settings page this browser really has: camera, microphone and
 * notifications each have one, and the addresses below are the pages that
 * exist. The clipboard is not built here, because no browser has a Clipboard
 * page — it has its own routes further down.
 */
function permissionRoutes(
  name: string,
  slug: string,
  iosSteps?: string[],
): SettingsRoute[] {
  const chromeAddress: Address = {
    label: "Chrome — paste into the address bar",
    value: `chrome://settings/content/${slug}`,
  };
  const edgeAddress: Address = {
    label: "Edge — paste into the address bar",
    value: `edge://settings/content/${slug}`,
  };

  const desktopSteps = (menuPath: string): string[] => [
    `Paste the address below into a new tab, or open ${menuPath} → ${name}.`,
    "Find this hub in the list and choose Ask or Allow.",
  ];

  return [
    {
      when: ["ios"],
      quick:
        "There is no padlock in Safari on iPhone — this one lives in the Settings app, not in the browser window.",
      steps: iosSteps ?? [
        "Open the Settings app on this iPhone or iPad.",
        "Scroll down and tap Safari — on iPhone and iPad every browser runs on Safari underneath, so the permission sits there whichever one you are reading this in.",
        `Tap ${name} and choose Ask or Allow.`,
      ],
    },
    {
      when: ["android"],
      quick:
        "Tap the padlock to the left of the address bar — that opens this device's own controls for this site.",
      steps: [
        "Tap the padlock to the left of the address bar, then Permissions.",
        `Set ${name} to Allow.`,
        `Or open ⋮ → Settings → Site settings → ${name}.`,
      ],
    },
    {
      when: DESKTOP,
      browsers: ["chrome", "opera", "samsung"],
      quick: "Click the padlock at the left of the address bar, then Site settings.",
      steps: desktopSteps("⋮ → Settings → Privacy and security → Site settings"),
      address: chromeAddress,
    },
    {
      when: DESKTOP,
      browsers: ["edge"],
      quick: "Click the padlock at the left of the address bar, then Site settings.",
      steps: desktopSteps(
        "⋯ → Settings → Cookies and site permissions → Site permissions",
      ),
      address: edgeAddress,
    },
    {
      when: DESKTOP,
      browsers: ["firefox"],
      quick: "Open ☰ → Settings → Privacy & Security → Permissions.",
      steps: [
        `Next to ${name}, press Settings…`,
        "Paste this hub's address into the box and press Allow.",
      ],
      address: {
        label: "Firefox — paste into the address bar",
        value: "about:preferences#privacy",
      },
    },
    {
      when: ["macos"],
      browsers: ["safari"],
      quick: "In Safari: Settings… (⌘,) → Websites.",
      steps: [
        "With Safari in front, choose Settings… from the Safari menu, or press ⌘ and comma.",
        `Click Websites, then ${name} in the left column.`,
        "Find this hub in the list and set it to Allow.",
      ],
    },
    {
      when: DESKTOP,
      steps: [
        "Click the padlock — or the sliders icon — at the left of the address bar, then Site settings.",
        `Find ${name} and choose Ask or Allow.`,
      ],
    },
  ];
}

/** A setting that belongs to the phone or computer, under the browser. */
function systemRoutes(steps: {
  ios?: string[];
  android?: string[];
  windows?: string[];
  macos?: string[];
  chromeos?: string[];
  linux?: string[];
  other?: string[];
}, addresses?: Partial<Record<PlatformId, Address>>): SettingsRoute[] {
  const routes: SettingsRoute[] = [];
  const push = (when: PlatformId[], stepsHere?: string[]) => {
    if (!stepsHere?.length) return;
    routes.push({ when, steps: stepsHere, address: addresses?.[when[0]] });
  };

  push(["ios"], steps.ios);
  push(["android"], steps.android);
  push(["windows"], steps.windows);
  push(["macos"], steps.macos);
  push(["chromeos"], steps.chromeos);
  push(["linux"], steps.linux);
  push(["other"], steps.other);
  return routes;
}

export const SETTING_LOCATIONS: Record<string, SettingLocation> = {
  /* --------------------------------------------------------- permissions */
  camera: {
    where:
      "Your browser's own site settings for this hub — not the app, and not the phone's camera app.",
    routes: permissionRoutes("Camera", "camera"),
  },
  microphone: {
    where: "Your browser's own site settings for this hub.",
    routes: permissionRoutes("Microphone", "microphone"),
  },
  notifications: {
    where:
      "Your browser's own site settings for this hub — and on an iPhone or iPad, the Home Screen app's own notification settings.",
    routes: permissionRoutes("Notifications", "notifications", [
      "On iPhone and iPad a website can only notify you once it is on the Home Screen: open this page in Safari, tap the Share button, then Add to Home Screen.",
      "Open the hub from its new icon and sign in.",
      "The first alert then asks for permission — choose Allow.",
      "To change it later: the Settings app → Notifications → Family Hub.",
    ]),
  },
  clipboard: {
    where:
      "Your browser's own site settings for this hub. Chrome and Edge ask once and remember; Safari and Firefox have no setting at all and ask again at the moment of the paste.",
    routes: [
      {
        when: ["ios"],
        quick: "Safari asks every time, so there is nothing to switch on in advance.",
        steps: [
          "Nothing to pre-approve: Safari asks again each time the hub reads the clipboard.",
          "The Copy button needs no permission at all and works straight away — it is only reading that Safari asks about.",
        ],
      },
      {
        when: ["android"],
        quick: "Android Chrome asks the first time and remembers your answer.",
        steps: [
          "There is no Clipboard entry in Site settings on Android.",
          "Tap the padlock → Permissions the first time you press Paste, and allow it there.",
        ],
      },
      {
        when: DESKTOP,
        browsers: ["chrome", "edge", "opera", "samsung"],
        quick: "Click the padlock at the left of the address bar, then Site settings.",
        steps: [
          "Chrome and Edge ask once, at the moment a box first copies or pastes, and remember your answer.",
          "To change it: click the padlock at the left of the address bar, then Site settings → Clipboard.",
        ],
      },
      {
        when: DESKTOP,
        browsers: ["firefox"],
        quick: "Firefox has no Clipboard setting — it asks at the moment of the paste.",
        steps: [
          "There is no Clipboard entry in Firefox's Privacy & Security settings.",
          "Firefox asks at the moment of the paste instead, so the first Paste you press is the permission.",
        ],
      },
      {
        when: ["macos"],
        browsers: ["safari"],
        quick: "Safari has no Clipboard setting — it asks at the moment of the paste.",
        steps: [
          "Safari's Websites list has no Clipboard entry: nothing to switch on in advance.",
          "It asks each time the hub reads the clipboard, so the first Paste you press is the permission. Copying never asks.",
        ],
      },
      {
        when: DESKTOP,
        steps: [
          "Click the padlock at the left of the address bar, then Site settings.",
          "If there is no Clipboard entry there, this browser asks at the moment of the paste instead.",
        ],
      },
    ],
  },
  photos: {
    where:
      "Nowhere that can be switched on in advance. The picker belongs to the operating system and hands over only the one file you choose.",
    quick:
      "Press Open the picker and choose a file — that is the whole permission.",
    routes: [
      {
        when: ALL,
        steps: [
          "Press Open the picker on this row.",
          "The phone or computer shows its own file chooser.",
          "Choose a file. The hub receives that file's name and nothing more — it cannot see the rest of the library.",
        ],
      },
    ],
  },

  /* ------------------------------------------------------- the app itself */
  fullscreen: {
    where:
      "Here in this app. The browser grants fullscreen to the page you are looking at, and takes it back when you leave the tab.",
    quick:
      "If it is refused, the row says so underneath — a phone browser may refuse it outright.",
    routes: [
      {
        when: ["ios"],
        quick:
          "Safari on iPhone and iPad will not do this at all — the row says so rather than pretending.",
        steps: [],
      },
    ],
  },
  keep_screen_awake: {
    where:
      "Here in this app, holding the phone's own screen lock off for as long as this tab is open.",
    quick:
      "The browser drops the hold whenever you switch away from the tab, so it re-applies itself when you come back.",
    routes: [
      {
        when: ["ios"],
        steps: [
          "This needs Safari 16.4 or newer on an iPhone or iPad — on anything older the switch refuses and says so.",
          "The phone's own Auto-Lock still wins: Settings → Display & Brightness → Auto-Lock.",
        ],
      },
      {
        when: ["android"],
        steps: [
          "Chrome on Android holds the screen awake only while this tab is the one on screen.",
          "A phone in Battery Saver may refuse outright — the row says so rather than pretending.",
        ],
      },
      {
        when: DESKTOP,
        steps: [
          "Nothing here to change: a computer dims and locks on its own power settings, and the hub never overrides them.",
          "Windows: Settings → System → Power & battery. Mac: System Settings → Lock Screen. Chromebook: Settings → Device → Power.",
        ],
      },
    ],
  },
  screen_rotation: {
    where:
      "Here in this app, and only while it is fullscreen — a page may ask to be held upright, never to turn the screen itself.",
    routes: [
      {
        when: ["ios"],
        quick:
          "Safari on iPhone and iPad never allows it, so the switch refuses on purpose.",
        steps: [
          "Safari on iPhone and iPad never allows this — nothing the hub can switch will hold the screen upright there.",
          "Use Control Centre instead: the rotation lock button in the top-right group.",
        ],
      },
      {
        when: ["android"],
        quick: "Turn Fullscreen on first, then try this switch again.",
        steps: [
          "Android Chrome only holds an orientation while the app fills the screen, so Fullscreen has to be on first.",
          "To lock the whole phone instead, pull down the quick settings and tap Auto-rotate.",
        ],
      },
      {
        when: DESKTOP,
        quick:
          "This one belongs to the system on a computer — the switch can do nothing here.",
        steps: [
          "A computer's screen rotation belongs to the system, not to this page.",
          "Windows: Settings → System → Display. Mac: System Settings → Displays. Chromebook: Settings → Device → Display.",
        ],
      },
    ],
  },

  /* ---------------------------------------------------------- connections */
  vpn: {
    where:
      "The Proton VPN app on this device — not the browser, and not the hub. A web page cannot build a tunnel itself, so the Control Room can only remember the choice and hand you the link.",
    routes: systemRoutes({
      ios: [
        "Install Proton VPN from the App Store if it is not there yet.",
        "Open the app, sign in, and tap the switch to connect.",
      ],
      android: [
        "Install Proton VPN from the Play Store if it is not there yet.",
        "Open the app, sign in, and tap the switch to connect.",
      ],
      windows: [
        "Install the Proton VPN app for Windows if it is not there yet.",
        "Sign in and connect from the app's own window — it covers the whole computer, not just this tab.",
      ],
      macos: [
        "Install the Proton VPN app for the Mac if it is not there yet.",
        "Sign in, then connect from the menu-bar icon.",
      ],
      chromeos: [
        "Open the Play Store and install Proton VPN.",
        "Sign in and connect from the app's own window.",
      ],
      linux: [
        "Install the Proton VPN app for your distribution, or use its official CLI.",
        "Sign in and connect from there — it covers the whole computer, not just this tab.",
      ],
      other: [
        "Install the Proton VPN app on this device if it has one.",
        "If it has no app store, the hub cannot make the tunnel — the link at the top of the Offline Brain is still the right one to open.",
      ],
    }),
  },
  wifi: {
    where:
      "The phone's or computer's own settings, underneath the browser. The hub can see which kind of connection you are on and nothing more.",
    routes: systemRoutes(
      {
        ios: [
          "Open the Settings app.",
          "Tap Wi-Fi.",
          "Choose a network, or use Control Centre for the quick way.",
        ],
        android: [
          "Open Settings.",
          "Tap Network & internet → Internet.",
          "Choose a network.",
        ],
        windows: [
          "Click the network icon in the bottom-right corner of the taskbar.",
          "Or press the Windows key and R and paste the address below.",
        ],
        macos: [
          "Click the Wi-Fi menu in the top bar.",
          "Or open System Settings → Wi-Fi.",
        ],
        chromeos: [
          "Click the network menu in the bottom-right corner.",
          "Choose a network, or press the Wi-Fi button to switch it off.",
        ],
        linux: [
          "Open the system menu in the top-right corner, then Wi-Fi.",
          "Or open Settings → Wi-Fi.",
        ],
        other: ["Open this device's own network settings."],
      },
      {
        windows: {
          label: "Windows — paste into Run (Windows key + R)",
          value: "ms-settings:network-wifi",
        },
      },
    ),
  },
  cell_data: {
    where:
      "The phone's own settings. The browser can tell that you are on mobile data, never whose network it is or what it costs.",
    routes: systemRoutes({
      ios: [
        "Open Settings.",
        "Tap Cellular.",
        "Switch Cellular Data on or off.",
      ],
      android: [
        "Open Settings.",
        "Tap Network & internet → SIMs.",
        "Switch Mobile data on or off.",
      ],
      windows: ["A computer is not on mobile data, so there is nothing here."],
      macos: ["A computer is not on mobile data, so there is nothing here."],
      chromeos: [
        "A Chromebook with a SIM keeps this in Settings → Network → Mobile data.",
        "Nothing else on a computer is on mobile data.",
      ],
      linux: ["A computer is not on mobile data, so there is nothing here."],
      other: [
        "If this device is on a mobile network, its own settings hold the switch.",
        "If it is not, there is nothing here.",
      ],
    }),
  },

  /* ---------------------------------------------------------------- calls */
  video_calls: {
    where:
      "Here in this app. Calls go straight between your family's devices and use the Camera and Microphone permissions above.",
    quick:
      "Get on from the Messenger. There is no switch anywhere else.",
    routes: [],
  },
};

/**
 * What to say about a row whose setting lives in the hub itself — the honest
 * answer for every switch that no outside system controls.
 */
export const APP_OWNED: SettingLocation = {
  where: "Here, in this app — nowhere else. Nothing outside the hub controls it.",
  quick:
    "It is saved with your account, so the same choice is waiting on every device you sign in on.",
  routes: [],
};

/** The location notes for a row, falling back to "this one is ours". */
export function locationFor(id: string): SettingLocation {
  return SETTING_LOCATIONS[id] ?? APP_OWNED;
}

/** The routes that are true for the device in front of the person. */
function routesFor(
  location: SettingLocation,
  device: DeviceTarget,
): SettingsRoute[] {
  return location.routes.filter(
    (route) =>
      route.when.includes(device.platform) &&
      (!route.browsers || route.browsers.includes(device.browser)),
  );
}

/**
 * The route that fits the device in front of you: the browser's own answer
 * first, then the platform's, and only then a guess — so a Safari reader never
 * gets the Chrome menu.
 */
export function bestRoute(
  location: SettingLocation,
  device: DeviceTarget,
): SettingsRoute | null {
  if (location.routes.length === 0) return null;

  const here = routesFor(location, device);
  return (
    here.find((route) => route.browsers?.includes(device.browser)) ??
    here.find((route) => !route.browsers) ??
    here[0] ??
    // Every location above claims every platform it can be read on, so this is
    // only reached by a device nothing here knows. Saying nothing beats handing
    // a Chromebook the steps for an iPhone.
    null
  );
}

/** Every address worth pasting on this device, without repeats. */
export function addressesOf(
  location: SettingLocation,
  device: DeviceTarget,
): Address[] {
  const seen = new Set<string>();
  const out: Address[] = [];

  for (const route of routesFor(location, device)) {
    if (!route.address || seen.has(route.address.value)) continue;
    seen.add(route.address.value);
    out.push(route.address);
  }

  return out;
}
