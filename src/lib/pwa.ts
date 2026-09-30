/**
 * Installing the hub as an app, and telling the truth about how.
 *
 * Every browser hides installation somewhere different, so this file is the
 * knowledge: what device you are on, and the exact taps that turn this page into
 * an icon on that device. Nothing here pretends — where a browser cannot install
 * at all, the guide says so.
 */

export type DeviceKind = "phone" | "tablet" | "computer";

export type PlatformId =
  | "ios"
  | "android"
  | "windows"
  | "macos"
  | "chromeos"
  | "linux"
  | "other";

export type BrowserId =
  | "safari"
  | "chrome"
  | "edge"
  | "firefox"
  | "samsung"
  | "opera"
  | "other";

export type DeviceInfo = {
  kind: DeviceKind;
  platform: PlatformId;
  browser: BrowserId;
  /** What to call this device back to the person. */
  name: string;
};

export type InstallGuide = {
  id: string;
  /** What the button on the guide says. */
  label: string;
  device: DeviceKind;
  browser: string;
  /** One line under the label. */
  summary: string;
  steps: string[];
  /** A caveat worth knowing before starting. */
  note?: string;
  /** True when the in-app Install button can finish this in one tap. */
  oneTap: boolean;
};

/* ------------------------------------------------------------- detection */

function ua() {
  return typeof navigator === "undefined" ? "" : navigator.userAgent;
}

/** iPadOS reports itself as a Mac with a touch screen, so ask about touch too. */
function isIpadOs() {
  return (
    /Macintosh/.test(ua()) &&
    typeof navigator !== "undefined" &&
    navigator.maxTouchPoints > 1
  );
}

export function isIos() {
  return /iPhone|iPad|iPod/.test(ua()) || isIpadOs();
}

function detectBrowser(): BrowserId {
  const agent = ua();
  if (/SamsungBrowser/.test(agent)) return "samsung";
  if (/Edg\//.test(agent) || /EdgA\//.test(agent)) return "edge";
  if (/OPR\/|Opera/.test(agent)) return "opera";
  if (/FxiOS\/|Firefox\//.test(agent)) return "firefox";
  if (/CriOS\//.test(agent) || (/Chrome\//.test(agent) && !/Chromium/.test(agent))) {
    return "chrome";
  }
  if (/Safari\//.test(agent)) return "safari";
  return "other";
}

function detectPlatform(): PlatformId {
  const agent = ua();
  if (isIos()) return "ios";
  if (/Android/.test(agent)) return "android";
  if (/CrOS/.test(agent)) return "chromeos";
  if (/Windows/.test(agent)) return "windows";
  if (/Macintosh|Mac OS X/.test(agent)) return "macos";
  if (/Linux|X11/.test(agent)) return "linux";
  return "other";
}

export function detectDevice(): DeviceInfo {
  const platform = detectPlatform();
  const browser = detectBrowser();
  const touch = typeof navigator !== "undefined" ? navigator.maxTouchPoints : 0;

  // A phone is the only one we can be sure about from a user agent; tablets are
  // told apart by touch points, everything left over is treated as a computer.
  let kind: DeviceKind = "computer";
  if (platform === "ios") {
    kind = isIpadOs() ? "tablet" : "phone";
  } else if (platform === "android") {
    kind = /Mobile/.test(ua()) ? "phone" : "tablet";
  } else if (touch > 1 && /Windows|Linux|CrOS/.test(ua())) {
    kind = "tablet";
  }

  const name =
    platform === "ios"
      ? isIpadOs()
        ? "iPad"
        : "iPhone"
      : platform === "android"
        ? kind === "tablet"
          ? "Android tablet"
          : "Android phone"
        : platform === "windows"
          ? "Windows computer"
          : platform === "macos"
            ? "Mac"
            : platform === "chromeos"
              ? "Chromebook"
              : platform === "linux"
                ? "Linux computer"
                : "this device";

  return { kind, platform, browser, name };
}

/** True when the app is already running as an installed app, not a tab. */
export function isStandalone() {
  if (typeof window === "undefined") return false;
  const iosStandalone = (navigator as Navigator & { standalone?: boolean })
    .standalone;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    window.matchMedia?.("(display-mode: minimal-ui)").matches === true ||
    iosStandalone === true
  );
}

/* --------------------------------------------------------------- guides */

export const INSTALL_GUIDES: InstallGuide[] = [
  {
    id: "ios-safari",
    label: "iPhone or iPad",
    device: "phone",
    browser: "Safari",
    summary: "Add it to the Home Screen from Safari.",
    oneTap: false,
    steps: [
      "Open this page in Safari.",
      "Tap the Share button — the square with an arrow coming out of the top.",
      "Scroll the list down and tap Add to Home Screen.",
      "Tap Add. Family Hub appears alongside your other apps.",
    ],
    note: "On iPhone and iPad only Safari can add an app to the Home Screen. If you are reading this in Chrome or Firefox, open the same address in Safari first.",
  },
  {
    id: "android-chrome",
    label: "Android phone or tablet",
    device: "phone",
    browser: "Chrome or Edge",
    summary: "Install it from the menu, or in one tap above.",
    oneTap: true,
    steps: [
      "Tap Install above if the button is offered.",
      "If it is not, open the ⋮ menu in the top right.",
      "Tap Install app — on older versions it is called Add to Home screen.",
      "Confirm Install. Family Hub gets its own icon in your app drawer.",
    ],
  },
  {
    id: "android-samsung",
    label: "Android on Samsung Internet",
    device: "phone",
    browser: "Samsung Internet",
    summary: "Add the page to the Home screen.",
    oneTap: false,
    steps: [
      "Tap the ≡ menu at the bottom right.",
      "Tap Add page to, then Home screen.",
      "Tap Add.",
    ],
  },
  {
    id: "desktop-chromium",
    label: "Windows, Linux or ChromeOS",
    device: "computer",
    browser: "Chrome, Edge or Brave",
    summary: "Install from the address bar — it opens in its own window.",
    oneTap: true,
    steps: [
      "Click Install above if the button is offered.",
      "If it is not, look for the install icon at the right end of the address bar — a small screen with a downward arrow.",
      "Or open the ⋮ menu, then Cast, save and share → Install page as app.",
      "Confirm Install. Family Hub opens without browser bars and gets a Start menu icon.",
    ],
  },
  {
    id: "macos-chromium",
    label: "Mac",
    device: "computer",
    browser: "Chrome, Edge or Brave",
    summary: "Install it and it lands in your Applications folder and Dock.",
    oneTap: true,
    steps: [
      "Click Install above if the button is offered.",
      "If it is not, click the install icon at the right end of the address bar, or use ⋮ → Cast, save and share → Install page as app.",
      "Confirm Install. Family Hub appears in Launchpad and the Dock.",
    ],
  },
  {
    id: "macos-safari",
    label: "Mac",
    device: "computer",
    browser: "Safari",
    summary: "Add it to the Dock.",
    oneTap: false,
    steps: [
      "Open the File menu.",
      "Choose Add to Dock.",
      "Confirm. Family Hub opens in its own window from the Dock.",
    ],
    note: "Needs Safari 17 on macOS Sonoma or later.",
  },
  {
    id: "firefox",
    label: "Firefox on a computer",
    device: "computer",
    browser: "Firefox",
    summary: "Firefox cannot install web apps — use another browser, or a bookmark.",
    oneTap: false,
    steps: [
      "Open the same address in Chrome, Edge or Safari and follow that guide.",
      "Firefox on Android can install it from its ⋮ menu instead.",
    ],
    note: "This is a Firefox limitation, not something the hub can work around.",
  },
];

/** The guides that match the device in front of the person, best match first. */
export function guidesFor(info: DeviceInfo): InstallGuide[] {
  const scored = INSTALL_GUIDES.map((guide) => {
    let score = 0;
    if (guide.device === info.kind) score += 4;
    if (guide.device === "phone" && info.kind === "tablet") score += 2;
    if (guide.device === "computer" && info.kind === "tablet") score += 1;

    const browserMatch =
      (info.browser === "chrome" && /Chrome|Edge|Brave/.test(guide.browser)) ||
      (info.browser === "edge" && /Edge/.test(guide.browser)) ||
      (info.browser === "safari" && /Safari/.test(guide.browser)) ||
      (info.browser === "samsung" && /Samsung/.test(guide.browser)) ||
      (info.browser === "firefox" && /Firefox/.test(guide.browser)) ||
      (info.browser === "opera" && /Chrome|Edge/.test(guide.browser));
    if (browserMatch) score += 6;
    if (/Android/.test(guide.browser) && info.platform === "android") score += 3;
    if (/Safari/.test(guide.label) && info.platform === "macos") score += 1;

    return { guide, score };
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.guide);
}

/* ----------------------------------------------------------------- worker */

/**
 * Registers the service worker, which is what makes the app installable in
 * Chrome and gives the icons a cache. A failure here is never fatal: without it
 * the hub still runs, it just cannot be installed from Chrome.
 */
export function registerServiceWorker() {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;

  const { protocol, hostname } = window.location;
  const secure =
    protocol === "https:" ||
    hostname === "localhost" ||
    hostname === "127.0.0.1";
  if (!secure) return;

  const start = () => {
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`)
      .catch((error: unknown) => {
        console.warn("[pwa] The app cannot be installed from here:", error);
      });
  };

  // Waiting for load keeps the worker off the critical path, but it must not
  // be missed if the page was already finished by the time this runs.
  if (document.readyState === "complete") start();
  else window.addEventListener("load", start, { once: true });
}
