/**
 * The [LIVE] board's shared furniture: the source links it names, and the plain
 * words it reads its weather codes in.
 *
 * It lives on the server side of the wall because two callers need the same
 * lists — the page that draws them (`pages/LivePage.tsx`) and the assistant
 * that reads the board aloud (`convex/briefing.ts`). One definition means the
 * links can never drift apart.
 */

export type LiveLink = { label: string; href: string; why: string };
export type LiveStore = { name: string; href: string; note: string };

/**
 * The handful of Colorado numbers that refuse to be read by anything but a
 * browser, and the reports that are published weekly rather than hourly. They
 * are named rather than faked.
 */
export const ELSEWHERE: LiveLink[] = [
  {
    label: "AAA — Colorado pump price",
    href: "https://gasprices.aaa.com/?state=CO",
    why: "Cloudflare blocks every server, so it is one click away.",
  },
  {
    label: "COtrip — road conditions",
    href: "https://www.cotrip.org/list/roadConditions",
    why: "CDOT's feed answers a browser only.",
  },
  {
    label: "COtrip — cameras",
    href: "https://www.cotrip.org/list/cameras",
    why: "The scenic passes and the ski cams, live.",
  },
  {
    label: "CAIC — avalanche danger",
    href: "https://avalanche.state.co.us/forecasts",
    why: "The official danger rose for every zone.",
  },
  {
    label: "Drought monitor — Colorado",
    href: "https://droughtmonitor.unl.edu/CurrentMap/StateDroughtMonitor.aspx?CO",
    why: "Released every Thursday; the weekly board.",
  },
  {
    label: "CoCoRaHS — daily reports",
    href: "https://www.cocorahs.org/state.aspx?state=CO",
    why: "Ranchers' own rain, hail and snow reports.",
  },
  {
    label: "EIA — Colorado electricity",
    href: "https://www.eia.gov/electricity/state/colorado/",
    why: "WECC publishes no open keyless grid feed.",
  },
  {
    label: "USDA NASS — Colorado",
    href: "https://www.nass.usda.gov/Statistics_by_State/Colorado/",
    why: "Hay, alfalfa, chicken and lamb prices live here.",
  },
  {
    label: "ADS-B Exchange — airspace",
    href: "https://globe.adsbexchange.com/?lat=39&lon=-105.5&zoom=7",
    why: "Every aircraft, unfiltered, on a map.",
  },
  {
    label: "KeepTrack — satellites",
    href: "https://keeptrack.space/",
    why: "The whole catalog in 3D.",
  },
  {
    label: "Colorado Horse Sale — results",
    href: "https://coloradohorsesale.com/sale-results",
    why: "Lot-by-lot sale prices; its host refuses servers, so it is a click away.",
  },
  {
    label: "USDA AMS — hay reports",
    href: "https://www.ams.usda.gov/market-news/hay-reports",
    why: "The Colorado hay and forage reports, as published.",
  },
];

/** The Colorado ranch and farm stores, and where their sales live. */
export const RANCH_STORES: LiveStore[] = [
  {
    name: "Murdoch's Ranch & Home Supply",
    href: "https://www.murdochs.com/",
    note: "Dozens of Colorado stores — weekly ad, clearance and events.",
  },
  {
    name: "Big R Stores",
    href: "https://bigr.com/",
    note: "Colorado ranch and farm stores — seasonal sales and clearances.",
  },
  {
    name: "IFA Country Stores",
    href: "https://www.ifa.coop/",
    note: "Feed, seed and livestock gear — sale and clearance shelves.",
  },
  {
    name: "Tractor Supply Co.",
    href: "https://www.tractorsupply.com/",
    note: "Weekly ad, clearance and store events by location.",
  },
  {
    name: "Atwoods Ranch & Home",
    href: "https://www.atwoods.com/",
    note: "Farm, ranch and home — rollbacks and clearance.",
  },
  {
    name: "JAX Mercantile",
    href: "https://jaxmerc.com/",
    note: "Colorado farm and ranch stores — sales and events.",
  },
];

/** World Meteorological Organization sky codes, in plain words. */
const SKY: Record<number, string> = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Freezing fog",
  51: "Light drizzle",
  53: "Drizzle",
  55: "Heavy drizzle",
  56: "Freezing drizzle",
  57: "Freezing drizzle",
  61: "Light rain",
  63: "Rain",
  65: "Heavy rain",
  66: "Freezing rain",
  67: "Freezing rain",
  71: "Light snow",
  73: "Snow",
  75: "Heavy snow",
  77: "Snow grains",
  80: "Rain showers",
  81: "Rain showers",
  82: "Violent rain showers",
  85: "Snow showers",
  86: "Heavy snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm, hail",
  99: "Severe thunderstorm",
};

export function skyWord(code: number | null): string {
  if (code === null) return "Conditions unread";
  return SKY[code] ?? "Cloudy";
}

const COMPASS = [
  "north",
  "north-northeast",
  "northeast",
  "east-northeast",
  "east",
  "east-southeast",
  "southeast",
  "south-southeast",
  "south",
  "south-southwest",
  "southwest",
  "west-southwest",
  "west",
  "west-northwest",
  "northwest",
  "north-northwest",
];

export function compassWord(deg: number | null): string {
  if (deg === null) return "unknown direction";
  return COMPASS[Math.round(deg / 22.5) % 16];
}

export function aqiWord(aqi: number | null): string {
  if (aqi === null) return "unreported";
  if (aqi <= 50) return "Good";
  if (aqi <= 100) return "Moderate";
  if (aqi <= 150) return "Unhealthy for some";
  if (aqi <= 200) return "Unhealthy";
  if (aqi <= 300) return "Very unhealthy";
  return "Hazardous";
}

export function kpWord(kp: number | null): string {
  if (kp === null) return "unreported";
  if (kp < 4) return "Quiet";
  if (kp < 5) return "Active";
  if (kp < 6) return "Minor storm (G1)";
  if (kp < 7) return "Moderate storm (G2)";
  if (kp < 8) return "Strong storm (G3)";
  if (kp < 9) return "Severe storm (G4)";
  return "Extreme storm (G5)";
}
