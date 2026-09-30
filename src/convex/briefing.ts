import { v } from "convex/values";
import { internal } from "./_generated/api";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  query,
} from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { isUnlocked } from "./guard";
import {
  ELSEWHERE,
  RANCH_STORES,
  aqiWord,
  compassWord,
  kpWord,
  skyWord,
} from "./live_data";

/**
 * The [LIVE] page's mission-control briefing, gathered on the server.
 *
 * The old page put somebody else's website in a box and waited for it to load.
 * This file does the opposite: it calls the real feeds itself — every one free
 * and keyless — and writes the answers into a single cached row. The page then
 * draws its own numbers instead of hosting a stranger's.
 *
 * The board covers Colorado and everything that moves it: weather and mountain
 * snow, watches and warnings, air, drought and rivers, fire, federal disaster
 * declarations, the energy, metals and farm markets the state sells into, the
 * wider economy, the markets, power's inputs, aircraft overhead, earthquakes,
 * the station and the space weather, and the headlines — Colorado, roads,
 * avalanche country, and the world. Each source is fetched independently and
 * may fail on its own: one dead feed leaves one tile saying so, and never blanks
 * the page. It is refreshed on a timer by `crons.ts` and on demand from the
 * page's Refresh.
 *
 * Some things genuinely cannot be fetched by anything but a browser — the AAA
 * pump price, the COtrip road colours, the CAIC danger rose, the WECC grid.
 * Those are named honestly on the page and left one click away rather than
 * faked.
 */

/** Colorado's centre — every Colorado reading is taken here. */
const CO = { lat: 39.0, lon: -105.5, label: "Colorado" };

/** Sent to the National Weather Service, which asks callers to identify. */
const UA =
  "private-hub/1.0 (+https://github.com/ranchfarmco-lang/private-hub)";

const TIMEOUT_MS = 12_000;
/** The one feed that is genuinely heavy and deserves longer. */
const SLOW_TIMEOUT_MS = 15_000;

/** The one row the cron writes and the page reads. */
const KEY = "live-v3";

/* ------------------------------------------------------------------ shapes */

export type Source<T> =
  | { ok: true; at: number; data: T }
  | { ok: false; at: number; error: string };

export type MarketReading = {
  symbol: string;
  label: string;
  unit: string;
  price: number | null;
  previous: number | null;
  change: number | null;
  changePct: number | null;
  currency: string;
  at: number | null;
};

export type WeatherNow = {
  at: number;
  timezone: string;
  temperature: number | null;
  humidity: number | null;
  precipitation: number | null;
  windSpeed: number | null;
  windGust: number | null;
  windDirection: number | null;
  soilTemperature: number | null;
  soilMoisture: number | null;
  pressure: number | null;
  code: number | null;
  units: { temperature: string; wind: string; precipitation: string };
  daily: Array<{
    date: string;
    high: number | null;
    low: number | null;
    precipitation: number | null;
    gust: number | null;
    snow: number | null;
    code: number | null;
  }>;
};

export type SnowPoint = {
  name: string;
  elevationFt: number | null;
  temperatureF: number | null;
  snowDepthIn: number | null;
  newSnow24hIn: number | null;
  newSnow7dIn: number | null;
  code: number | null;
};

export type SnowReport = { at: number; points: SnowPoint[] };

export type AlertItem = {
  event: string;
  severity: string;
  headline: string;
  area: string;
  ends: string | null;
};

export type AirNow = {
  at: number;
  aqi: number | null;
  pm25: number | null;
  pm10: number | null;
};

export type Orbit = {
  at: number;
  lat: number | null;
  lon: number | null;
  altitudeKm: number | null;
  velocityKmh: number | null;
  visibility: string | null;
  footprintKm: number | null;
};

export type SpaceWeather = {
  at: number;
  kp: number | null;
  timeTag: string | null;
  /** The aurora percentage overhead at Colorado's latitude, if the sky allows. */
  aurora: number | null;
};

export type Quake = {
  mag: number | null;
  place: string;
  time: number | null;
  url: string | null;
};

export type WaterGauge = {
  site: string;
  name: string;
  discharge: number | null;
  unit: string;
  at: number | null;
};

export type Drought = {
  at: number;
  week: string | null;
  none: number | null;
  d0: number | null;
  d1: number | null;
  d2: number | null;
  d3: number | null;
  d4: number | null;
};

export type FireItem = {
  name: string;
  acres: number | null;
  contained: number | null;
  type: string | null;
  state: string | null;
};

export type DisasterItem = {
  number: number | null;
  title: string;
  type: string;
  date: string;
  incident: string;
};

export type Economy = {
  at: number;
  coUnemployment: number | null;
  coUnemploymentPeriod: string | null;
  cpi: number | null;
  cpiPeriod: string | null;
  cpiYoYPct: number | null;
  debt: number | null;
  debtDate: string | null;
};

export type Aircraft = {
  callsign: string;
  type: string | null;
  altitudeFt: number | null;
  speedKt: number | null;
};

export type Airspace = {
  at: number;
  count: number;
  high: number;
  emergency: number;
  notable: Aircraft[];
};

export type NewsItem = {
  title: string;
  source: string;
  link: string;
  at: number | null;
};

export type HayPrice = {
  region: string;
  commodity: string;
  quality: string;
  baleType: string;
  low: number | null;
  high: number | null;
  avg: number | null;
  unit: string;
  estimated: boolean;
  source: string;
  date: string | null;
};

export type HayReport = {
  at: number;
  week: string | null;
  rows: HayPrice[];
};

export type AuctionEvent = {
  date: string;
  title: string;
  where: string | null;
  href: string;
};

export type AuctionReport = {
  label: string;
  href: string;
};

/**
 * The moon as the almanac keeps it: how lit it is, when it is up, and which
 * named phases are next. Times are the local wall clock over Colorado, as the
 * Naval Observatory writes them (`HH:MM`).
 */
export type MoonSky = {
  /** The phase in words — "Waning Gibbous". */
  phase: string | null;
  /** How much of the disc is lit, 0–100. */
  illumination: number | null;
  rise: string | null;
  set: string | null;
  /** When the moon is highest overhead — the almanac's own "major" hour. */
  transit: string | null;
  /** The nearest named phase, and the day it lands. */
  closestPhase: string | null;
  closestDay: string | null;
  /** The next four primary phases, soonest first. */
  upcoming: Array<{ phase: string; day: string | null; time: string | null }>;
};

/**
 * The sun as the almanac keeps it: the day's light from first to last, and
 * whether the days are gaining or closing in. A Colorado day runs about two and
 * a half minutes shorter each day in late September, and that number is the
 * whole reason a rancher watches it.
 */
export type SunSky = {
  rise: string | null;
  set: string | null;
  /** Solar noon — the sun at its highest. */
  noon: string | null;
  civilBegin: string | null;
  civilEnd: string | null;
  dayLengthMinutes: number | null;
  /** Today's day length less yesterday's; negative means the days are shortening. */
  dayLengthDeltaMinutes: number | null;
};

/** Sun and moon over Colorado — the almanac, in one reading. */
export type Almanac = { at: number; moon: MoonSky; sun: SunSky };

export type Briefing = {
  at: number;
  center: { lat: number; lon: number; label: string };
  weather: Source<WeatherNow>;
  snow: Source<SnowReport>;
  alerts: Source<AlertItem[]>;
  air: Source<AirNow>;
  energy: Source<MarketReading[]>;
  farm: Source<MarketReading[]>;
  markets: Source<MarketReading[]>;
  economy: Source<Economy>;
  water: Source<WaterGauge[]>;
  drought: Source<Drought>;
  fire: Source<FireItem[]>;
  emergency: Source<DisasterItem[]>;
  seismic: Source<Quake[]>;
  orbit: Source<Orbit>;
  space: Source<SpaceWeather>;
  almanac: Source<Almanac>;
  airspace: Source<Airspace>;
  news: Source<NewsItem[]>;
  roads: Source<NewsItem[]>;
  avalanche: Source<NewsItem[]>;
  wildfire: Source<NewsItem[]>;
  world: Source<NewsItem[]>;
  hay: Source<HayReport>;
  horseAuctions: Source<AuctionEvent[]>;
  equipmentAuctions: Source<AuctionEvent[]>;
  cattleAuctions: Source<AuctionReport[]>;
};

/* ----------------------------------------------------------------- fetching */

function describe(error: unknown): string {
  if (error instanceof Error) {
    if (/abort/i.test(error.message)) return "It did not answer in time.";
    return error.message.slice(0, 200);
  }
  return "It did not answer.";
}

/**
 * Every network call is capped, so one slow host cannot hold up the briefing,
 * and a busy host gets a second and third try. A public feed answering `503`
 * because twenty other calls landed at the same instant is normal; the answer
 * is to wait a moment and ask again, not to give up on the day.
 */
async function request(
  url: string,
  accept: string,
  timeoutMs: number,
): Promise<Response> {
  let lastError: unknown = new Error("It did not answer.");

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response | null = null;
    let failure: unknown = null;

    try {
      response = await fetch(url, {
        headers: { "User-Agent": UA, Accept: accept },
        signal: controller.signal,
      });
    } catch (error) {
      failure = error;
    } finally {
      clearTimeout(timer);
    }

    if (response) {
      if (response.ok) return response;
      const status = response.status;
      // A 4xx that is not a rate limit is a real answer; do not hammer it.
      if (status !== 429 && status < 500) {
        throw new Error(`The source answered ${status}.`);
      }
      lastError = new Error(`The source answered ${status}.`);
    } else {
      lastError = failure;
      // Waiting will not make a timeout finish; give up on it now.
      if (failure instanceof Error && /abort/i.test(failure.message)) {
        throw failure;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
  }

  throw lastError;
}

async function getJson<T>(
  url: string,
  accept = "application/json",
  timeoutMs = TIMEOUT_MS,
): Promise<T> {
  const response = await request(url, accept, timeoutMs);
  return (await response.json()) as T;
}

async function getText(
  url: string,
  accept = "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
): Promise<string> {
  const response = await request(url, accept, TIMEOUT_MS);
  return await response.text();
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** Fetch a batch of things a few at a time, so a host does not refuse us. */
async function mapLimited<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    const slice = items.slice(i, i + limit);
    out.push(...(await Promise.all(slice.map(fn))));
  }
  return out;
}

async function source<T>(fn: () => Promise<T>): Promise<Source<T>> {
  const at = Date.now();
  try {
    return { ok: true, at, data: await fn() };
  } catch (error) {
    return { ok: false, at, error: describe(error) };
  }
}

/* ----------------------------------------------------------------- markets */

type SymbolSpec = { symbol: string; label: string; unit: string };

/**
 * The futures Colorado energy, metals, farms and ranches actually sell into.
 * These are the real contracts — WTI and natural gas, gold and copper, corn and
 * cattle. Yield-style local prices (hay, alfalfa, chicken, lamb) have no public
 * ticker at all; those stay an honest link to the USDA reports.
 */
const ENERGY_SYMBOLS: SymbolSpec[] = [
  { symbol: "CL=F", label: "WTI Crude Oil", unit: "USD / barrel" },
  { symbol: "BZ=F", label: "Brent Crude Oil", unit: "USD / barrel" },
  { symbol: "NG=F", label: "Natural Gas", unit: "USD / MMBtu" },
  { symbol: "RB=F", label: "RBOB Gasoline", unit: "USD / gallon" },
  { symbol: "HO=F", label: "Heating Oil", unit: "USD / gallon" },
  { symbol: "GC=F", label: "Gold", unit: "USD / ounce" },
  { symbol: "SI=F", label: "Silver", unit: "USD / ounce" },
  { symbol: "HG=F", label: "Copper", unit: "USD / pound" },
  { symbol: "PL=F", label: "Platinum", unit: "USD / ounce" },
];

const FARM_SYMBOLS: SymbolSpec[] = [
  { symbol: "ZC=F", label: "Corn", unit: "US cents / bushel" },
  { symbol: "ZS=F", label: "Soybeans", unit: "US cents / bushel" },
  { symbol: "ZW=F", label: "Wheat (Chicago)", unit: "US cents / bushel" },
  { symbol: "KE=F", label: "Wheat (Kansas City)", unit: "US cents / bushel" },
  { symbol: "ZO=F", label: "Oats", unit: "US cents / bushel" },
  { symbol: "ZM=F", label: "Soybean Meal", unit: "USD / short ton" },
  { symbol: "LE=F", label: "Live Cattle", unit: "US cents / pound" },
  { symbol: "GF=F", label: "Feeder Cattle", unit: "US cents / pound" },
  { symbol: "HE=F", label: "Lean Hogs", unit: "US cents / pound" },
  { symbol: "LBR=F", label: "Lumber", unit: "USD / 1,000 board ft" },
];

/** The wider economy the ranch buys, borrows and saves in. */
const MARKET_SYMBOLS: SymbolSpec[] = [
  { symbol: "^GSPC", label: "S&P 500", unit: "index points" },
  { symbol: "^DJI", label: "Dow Jones", unit: "index points" },
  { symbol: "^IXIC", label: "Nasdaq", unit: "index points" },
  { symbol: "^RUT", label: "Russell 2000", unit: "index points" },
  { symbol: "^VIX", label: "Volatility (VIX)", unit: "index points" },
  { symbol: "^TNX", label: "US 10-year yield", unit: "percent" },
  { symbol: "DX-Y.NYB", label: "US Dollar index", unit: "index points" },
  { symbol: "BTC-USD", label: "Bitcoin", unit: "USD" },
];

type YahooChart = {
  chart?: {
    result?: Array<{
      meta?: {
        currency?: string;
        regularMarketPrice?: number;
        chartPreviousClose?: number;
        regularMarketChangePercent?: number;
        regularMarketTime?: number;
      };
    }>;
  };
};

async function quote(spec: SymbolSpec): Promise<MarketReading> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    spec.symbol,
  )}?interval=1d&range=1d`;
  const body = await getJson<YahooChart>(url);
  const meta = body.chart?.result?.[0]?.meta;
  if (!meta) throw new Error("No quote came back.");

  const price = num(meta.regularMarketPrice);
  const previous = num(meta.chartPreviousClose);
  const change = price !== null && previous !== null ? price - previous : null;
  const fromMeta = num(meta.regularMarketChangePercent);
  const changePct =
    fromMeta ??
    (change !== null && previous ? (change / previous) * 100 : null);

  return {
    symbol: spec.symbol,
    label: spec.label,
    unit: spec.unit,
    price,
    previous,
    change,
    changePct,
    currency: meta.currency ?? "USD",
    at: meta.regularMarketTime ? meta.regularMarketTime * 1000 : null,
  };
}

async function marketGroup(specs: SymbolSpec[]): Promise<Source<MarketReading[]>> {
  const at = Date.now();
  try {
    const rows = await mapLimited(specs, 6, async (spec) => {
      try {
        return await quote(spec);
      } catch {
        return null;
      }
    });
    const good = rows.filter((row): row is MarketReading => row !== null);
    if (!good.length) throw new Error("The market feed answered nothing.");
    return { ok: true, at, data: good };
  } catch (error) {
    return { ok: false, at, error: describe(error) };
  }
}

/* ------------------------------------------------------------------ weather */

type OpenMeteoForecast = {
  timezone?: string;
  current_units?: Record<string, string>;
  current?: Record<string, number>;
  daily?: Record<string, Array<number | string>>;
};

async function weather(): Promise<WeatherNow> {
  const params = new URLSearchParams({
    latitude: String(CO.lat),
    longitude: String(CO.lon),
    current: [
      "temperature_2m",
      "relative_humidity_2m",
      "precipitation",
      "wind_speed_10m",
      "wind_gusts_10m",
      "wind_direction_10m",
      "surface_pressure",
      "weather_code",
      "soil_temperature_6cm",
      "soil_moisture_3_to_9cm",
    ].join(","),
    daily: [
      "weather_code",
      "temperature_2m_max",
      "temperature_2m_min",
      "precipitation_sum",
      "wind_gusts_10m_max",
      "snowfall_sum",
    ].join(","),
    temperature_unit: "fahrenheit",
    wind_speed_unit: "mph",
    precipitation_unit: "inch",
    timezone: "America/Denver",
    forecast_days: "5",
  });

  const body = await getJson<OpenMeteoForecast>(
    `https://api.open-meteo.com/v1/forecast?${params.toString()}`,
  );
  const current = body.current ?? {};
  const units = body.current_units ?? {};
  const daily = body.daily ?? {};
  const dates = (daily.time ?? []) as string[];

  return {
    at: Date.now(),
    timezone: body.timezone ?? "America/Denver",
    temperature: num(current.temperature_2m),
    humidity: num(current.relative_humidity_2m),
    precipitation: num(current.precipitation),
    windSpeed: num(current.wind_speed_10m),
    windGust: num(current.wind_gusts_10m),
    windDirection: num(current.wind_direction_10m),
    soilTemperature: num(current.soil_temperature_6cm),
    soilMoisture: num(current.soil_moisture_3_to_9cm),
    pressure: num(current.surface_pressure),
    code: num(current.weather_code),
    units: {
      temperature: units.temperature_2m ?? "°F",
      wind: units.wind_speed_10m ?? "mph",
      precipitation: units.precipitation ?? "in",
    },
    daily: dates.map((date, index) => ({
      date,
      high: num((daily.temperature_2m_max ?? [])[index]),
      low: num((daily.temperature_2m_min ?? [])[index]),
      precipitation: num((daily.precipitation_sum ?? [])[index]),
      gust: num((daily.wind_gusts_10m_max ?? [])[index]),
      snow: num((daily.snowfall_sum ?? [])[index]),
      code: num((daily.weather_code ?? [])[index]),
    })),
  };
}

/* ------------------------------------------------------- mountain snowpack */

/**
 * The ranges, named here so the board reads like a Colorado ski report rather
 * than a lat/long. Open-Meteo is a model, not a stake in the snow, so it is
 * named as such on the page — but it is real, it is keyless, and it moves with
 * the storm the same way the stake does.
 */
const MOUNTAINS: { name: string; lat: number; lon: number }[] = [
  { name: "Steamboat", lat: 40.485, lon: -106.831 },
  { name: "Rocky Mtn NP", lat: 40.342, lon: -105.683 },
  { name: "Vail", lat: 39.64, lon: -106.374 },
  { name: "Breckenridge", lat: 39.481, lon: -106.049 },
  { name: "Aspen", lat: 39.191, lon: -106.817 },
  { name: "Monarch Pass", lat: 38.496, lon: -106.325 },
  { name: "Telluride", lat: 37.937, lon: -107.813 },
  { name: "Wolf Creek Pass", lat: 37.483, lon: -106.802 },
];

type OpenMeteoPoint = {
  elevation?: number;
  current?: Record<string, number>;
  daily?: Record<string, Array<number | string>>;
};

async function snow(): Promise<SnowReport> {
  const params = new URLSearchParams({
    latitude: MOUNTAINS.map((peak) => peak.lat).join(","),
    longitude: MOUNTAINS.map((peak) => peak.lon).join(","),
    current: ["temperature_2m", "snow_depth", "snowfall", "weather_code"].join(
      ",",
    ),
    daily: ["snowfall_sum", "weather_code"].join(","),
    past_days: "7",
    forecast_days: "1",
    temperature_unit: "fahrenheit",
    precipitation_unit: "inch",
    timezone: "America/Denver",
  });

  const raw = await getJson<OpenMeteoPoint | OpenMeteoPoint[]>(
    `https://api.open-meteo.com/v1/forecast?${params.toString()}`,
  );
  const points = Array.isArray(raw) ? raw : [raw];

  return {
    at: Date.now(),
    points: points.map((point, index) => {
      const daily = point.daily ?? {};
      const sums = (daily.snowfall_sum ?? []).map((value) => num(value));
      const current = point.current ?? {};
      // past_days puts today last, so the last entry is the current day.
      const last = sums.length - 1;
      const week = sums
        .slice(-7)
        .reduce<number>((total, value) => total + (value ?? 0), 0);

      return {
        name: MOUNTAINS[index]?.name ?? `Peak ${index + 1}`,
        elevationFt:
          num(point.elevation) !== null
            ? Math.round((num(point.elevation) as number) * 3.28084)
            : null,
        temperatureF: num(current.temperature_2m),
        // snow_depth comes back in feet because precipitation is in inches.
        snowDepthIn:
          num(current.snow_depth) !== null
            ? (num(current.snow_depth) as number) * 12
            : null,
        newSnow24hIn: sums[last] ?? null,
        newSnow7dIn: week > 0 ? week : 0,
        code: num(current.weather_code),
      };
    }),
  };
}

/* ------------------------------------------------------------------- alerts */

type NwsAlerts = {
  features?: Array<{
    properties?: {
      event?: string;
      severity?: string;
      headline?: string;
      areaDesc?: string;
      ends?: string;
    };
  }>;
};

async function alerts(): Promise<AlertItem[]> {
  const body = await getJson<NwsAlerts>(
    "https://api.weather.gov/alerts/active?area=CO",
    "application/geo+json",
  );
  const items = (body.features ?? []).map((feature) => {
    const properties = feature.properties ?? {};
    return {
      event: properties.event ?? "Weather alert",
      severity: properties.severity ?? "Unknown",
      headline: properties.headline ?? "",
      area: properties.areaDesc ?? "Colorado",
      ends: properties.ends ?? null,
    };
  });

  const rank: Record<string, number> = {
    Extreme: 4,
    Severe: 3,
    Moderate: 2,
    Minor: 1,
    Unknown: 0,
  };
  items.sort((a, b) => (rank[b.severity] ?? 0) - (rank[a.severity] ?? 0));
  return items.slice(0, 8);
}

/* ---------------------------------------------------------------------- air */

type OpenMeteoAir = {
  current?: { us_aqi?: number; pm2_5?: number; pm10?: number };
};

async function air(): Promise<AirNow> {
  const body = await getJson<OpenMeteoAir>(
    `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${CO.lat}&longitude=${CO.lon}&current=us_aqi,pm2_5,pm10`,
  );
  const current = body.current ?? {};
  return {
    at: Date.now(),
    aqi: num(current.us_aqi),
    pm25: num(current.pm2_5),
    pm10: num(current.pm10),
  };
}

/* -------------------------------------------------------------------- water */

type UsgsResponse = {
  value?: {
    timeSeries?: Array<{
      sourceInfo?: {
        siteName?: string;
        siteCode?: Array<{ value?: string }>;
      };
      values?: Array<{
        value?: Array<{ value?: string; dateTime?: string }>;
      }>;
    }>;
  };
};

/** Real gauges on the rivers a Colorado ranch actually watches. */
const USGS_SITES = [
  "06701500",
  "06719505",
  "09070500",
  "09085100",
  "09112500",
  "09352900",
  "07103970",
];

async function water(): Promise<WaterGauge[]> {
  const body = await getJson<UsgsResponse>(
    `https://waterservices.usgs.gov/nwis/iv/?format=json&sites=${USGS_SITES.join(
      ",",
    )}&parameterCd=00060&period=PT12H`,
  );
  const series = body.value?.timeSeries ?? [];

  const gauges: WaterGauge[] = series.map((row) => {
    const latest = row.values?.[0]?.value?.slice(-1)[0];
    return {
      site: row.sourceInfo?.siteCode?.[0]?.value ?? "",
      name: (row.sourceInfo?.siteName ?? "Unknown gauge")
        .toLowerCase()
        .replace(/\b\w/g, (letter) => letter.toUpperCase()),
      discharge: num(latest?.value),
      unit: "ft³/s",
      at: latest?.dateTime ? Date.parse(latest.dateTime) : null,
    };
  });

  if (!gauges.length) throw new Error("The river gauges answered nothing.");
  return gauges;
}

/* ------------------------------------------------------------------- drought */

function monthDayYear(date: Date): string {
  return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;
}

async function drought(): Promise<Drought> {
  const end = new Date();
  const start = new Date(end.getTime() - 60 * 24 * 60 * 60 * 1000);
  const url =
    "https://usdmdataservices.unl.edu/api/StateStatistics/GetDroughtSeverityStatisticsByAreaPercent" +
    `?aoi=08&startdate=${encodeURIComponent(monthDayYear(start))}` +
    `&enddate=${encodeURIComponent(monthDayYear(end))}&statisticsType=1`;

  // The answer is CSV, one week per row, newest first.
  const body = await getText(url, "text/csv, text/plain;q=0.9, */*;q=0.8");
  const rows = body.trim().split(/\r?\n/);
  if (rows.length < 2) throw new Error("The drought feed answered nothing.");

  const cells = rows[1].split(",");
  const week = cells[0] ?? null;
  return {
    at: Date.now(),
    week: week
      ? `${week.slice(0, 4)}-${week.slice(4, 6)}-${week.slice(6, 8)}`
      : null,
    none: num(cells[2]),
    d0: num(cells[3]),
    d1: num(cells[4]),
    d2: num(cells[5]),
    d3: num(cells[6]),
    d4: num(cells[7]),
  };
}

/* ---------------------------------------------------------------------- fire */

type ArcGisResponse = {
  features?: Array<{ attributes?: Record<string, unknown> }>;
};

async function fire(): Promise<FireItem[]> {
  // Every field is asked for: naming a field this layer does not carry makes
  // ArcGIS answer with an error and no features at all, which would read as a
  // quiet day rather than a broken question.
  const url =
    "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/" +
    "WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query" +
    "?where=1%3D1&geometry=-109.5,36.5,-101.5,41.5&geometryType=esriGeometryEnvelope" +
    "&inSR=4326&spatialRel=esriSpatialRelIntersects" +
    "&outFields=*&returnGeometry=false&resultRecordCount=60&f=json";

  const body = await getJson<ArcGisResponse>(url);
  if (!body.features) {
    throw new Error("The fire map refused the question.");
  }
  const items: FireItem[] = [];

  for (const feature of body.features ?? []) {
    const attrs = feature.attributes ?? {};
    const state = String(
      attrs.attr_POOState ?? attrs.poly_POOState ?? "",
    ).toUpperCase();
    // The box reaches into Wyoming, Utah and New Mexico; keep Colorado's own.
    if (!state.includes("CO")) continue;

    const name = String(
      attrs.poly_IncidentName ?? attrs.attr_IncidentName ?? "Unnamed incident",
    );
    items.push({
      name,
      acres: num(attrs.poly_GISAcres ?? attrs.attr_IncidentSize),
      contained: num(attrs.attr_PercentContained),
      type: attrs.attr_IncidentTypeCategory
        ? String(attrs.attr_IncidentTypeCategory)
        : null,
      state: state || null,
    });
  }

  // Biggest first — the one that matters is the one with the most ground.
  items.sort((a, b) => (b.acres ?? 0) - (a.acres ?? 0));
  // Deduplicate on name, since a fire can be mapped in several pieces.
  const seen = new Set<string>();
  const unique = items.filter((item) => {
    if (seen.has(item.name)) return false;
    seen.add(item.name);
    return true;
  });

  return unique.slice(0, 8);
}

/* ---------------------------------------------------------------- emergency */

type FemaResponse = {
  DisasterDeclarationsSummaries?: Array<{
    disasterNumber?: number;
    declarationTitle?: string;
    declarationType?: string;
    declarationDate?: string;
    incidentType?: string;
  }>;
};

async function emergency(): Promise<DisasterItem[]> {
  const url =
    "https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries" +
    "?$top=8&$filter=state%20eq%20%27CO%27&$orderby=declarationDate%20desc" +
    "&$select=disasterNumber,declarationTitle,declarationType,declarationDate,incidentType";

  const body = await getJson<FemaResponse>(url);
  const rows = body.DisasterDeclarationsSummaries ?? [];

  const seen = new Set<number>();
  const items: DisasterItem[] = [];
  for (const row of rows) {
    const number = num(row.disasterNumber);
    if (number !== null) {
      if (seen.has(number)) continue;
      seen.add(number);
    }
    items.push({
      number,
      title: (row.declarationTitle ?? "Declaration").trim(),
      type: row.declarationType ?? "—",
      date: (row.declarationDate ?? "").slice(0, 10),
      incident: row.incidentType ?? "—",
    });
  }
  return items.slice(0, 6);
}

/* ------------------------------------------------------------------ economy */

type BlsResponse = {
  Results?: {
    series?: Array<{
      data?: Array<{
        year?: string;
        period?: string;
        periodName?: string;
        value?: string;
      }>;
    }>;
  };
};

async function bls(url: string): Promise<BlsResponse> {
  return await getJson<BlsResponse>(url);
}

async function economy(): Promise<Economy> {
  const at = Date.now();
  const result: Economy = {
    at,
    coUnemployment: null,
    coUnemploymentPeriod: null,
    cpi: null,
    cpiPeriod: null,
    cpiYoYPct: null,
    debt: null,
    debtDate: null,
  };

  try {
    // Colorado's own unemployment rate, month by month.
    const body = await bls(
      "https://api.bls.gov/publicAPI/v2/timeseries/data/LASST080000000000003" +
        "?startyear=2026&endyear=2026",
    );
    const latest = body.Results?.series?.[0]?.data?.[0];
    result.coUnemployment = num(latest?.value);
    result.coUnemploymentPeriod = latest?.periodName ?? null;
  } catch {
    // One dead indicator does not take the economy tile down.
  }

  try {
    // The national consumer price index, two years of it, so the year-over-year
    // can be worked out rather than guessed.
    const body = await bls(
      "https://api.bls.gov/publicAPI/v2/timeseries/data/CUUR0000SA0" +
        "?startyear=2025&endyear=2026",
    );
    const rows = body.Results?.series?.[0]?.data ?? [];
    const latest = rows[0];
    result.cpi = num(latest?.value);
    result.cpiPeriod = latest?.periodName
      ? `${latest.periodName} ${latest.year}`
      : null;

    if (latest) {
      const targetPeriod = latest.period;
      const targetYear = String(Number(latest.year) - 1);
      const prior = rows.find(
        (row) => row.period === targetPeriod && row.year === targetYear,
      );
      const base = num(prior?.value);
      const now = num(latest.value);
      if (base && now) {
        result.cpiYoYPct = ((now - base) / base) * 100;
      }
    }
  } catch {
    // As above.
  }

  try {
    const body = await getJson<{
      data?: Array<{ record_date?: string; tot_pub_debt_out_amt?: string }>;
    }>(
      "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/debt_to_penny" +
        "?sort=-record_date&page%5Bsize%5D=1",
    );
    const row = body.data?.[0];
    result.debt = num(row?.tot_pub_debt_out_amt);
    result.debtDate = row?.record_date ?? null;
  } catch {
    // As above.
  }

  if (
    result.coUnemployment === null &&
    result.cpi === null &&
    result.debt === null
  ) {
    throw new Error("The economic feeds answered nothing.");
  }

  return result;
}

/* -------------------------------------------------------------------- orbit */

type IssPosition = {
  latitude?: number;
  longitude?: number;
  altitude?: number;
  velocity?: number;
  visibility?: string;
  footprint?: number;
};

async function orbit(): Promise<Orbit> {
  const body = await getJson<IssPosition>(
    "https://api.wheretheiss.at/v1/satellites/25544",
  );
  return {
    at: Date.now(),
    lat: num(body.latitude),
    lon: num(body.longitude),
    altitudeKm: num(body.altitude),
    velocityKmh: num(body.velocity),
    visibility: body.visibility ?? null,
    footprintKm: num(body.footprint),
  };
}

/* ------------------------------------------------------------ space weather */

type KpRow = { time_tag?: string; kp_index?: number };

type AuroraGrid = {
  coordinates?: Array<[number, number, number]>;
};

async function spaceWeather(): Promise<SpaceWeather> {
  const rows = await getJson<KpRow[]>(
    "https://services.swpc.noaa.gov/json/planetary_k_index_1m.json",
  );
  const last = rows[rows.length - 1];

  let aurora: number | null = null;
  try {
    // The aurora grid is every half degree of the planet. Only Colorado's
    // corner matters here, so the biggest number over the state is the reading.
    const grid = await getJson<AuroraGrid>(
      "https://services.swpc.noaa.gov/json/ovation_aurora_latest.json",
      "application/json",
      SLOW_TIMEOUT_MS,
    );
    for (const point of grid.coordinates ?? []) {
      const [lon, lat, value] = point;
      // The grid runs 0–360° east, so Colorado is 250–259 here, not −105.
      const east = lon < 0 ? lon + 360 : lon;
      if (
        lat >= 37 &&
        lat <= 41.5 &&
        east >= 250.5 &&
        east <= 258.5 &&
        (aurora === null || value > aurora)
      ) {
        aurora = value;
      }
    }
  } catch {
    // The K-index alone is still a useful tile.
  }

  return {
    at: Date.now(),
    kp: num(last?.kp_index),
    timeTag: last?.time_tag ?? null,
    aurora,
  };
}/* ------------------------------------------------------------------ almanac */

type UsnoPhenomenon = { phen?: string; time?: string };

type UsnoDay = {
  properties?: {
    data?: {
      curphase?: string;
      fracillum?: string;
      closestphase?: { phase?: string; day?: number; month?: number; year?: number };
      moondata?: UsnoPhenomenon[];
      sundata?: UsnoPhenomenon[];
    };
  };
};

type UsnoPhaseEvent = {
  phase?: string;
  day?: number;
  month?: number;
  year?: number;
  time?: string;
};

type UsnoPhases = { phasedata?: UsnoPhaseEvent[] };

const USNO_BASE = "https://aa.usno.navy.mil/api";

/**
 * Denver's offset from UTC right now, in whole hours — −6 in summer, −7 under
 * standard time. The Observatory wants the offset rather than a zone name, so
 * it is worked out here rather than guessed at; if the zone will not answer,
 * standard time is a harmless hour either side of a sunrise.
 */
function denverOffsetHours(): number {
  try {
    const name = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Denver",
      timeZoneName: "shortOffset",
    })
      .formatToParts(new Date())
      .find((part) => part.type === "timeZoneName")?.value;
    const match = name?.match(/(?:GMT|UTC)([+-]?\d{1,2})/);
    if (match) return Number(match[1]);
  } catch {
    // Fall through to standard time.
  }
  return -7;
}

/** The local calendar date, shifted by whole days, as the Observatory wants it. */
function denverDate(offsetHours: number, dayShift = 0): string {
  const shifted = new Date(
    Date.now() + dayShift * 86_400_000 + offsetHours * 3_600_000,
  );
  return shifted.toISOString().slice(0, 10);
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** A month/day/year triple as an ISO date, or null if a part is missing. */
function isoDate(
  part: { day?: number; month?: number; year?: number } | undefined,
): string | null {
  if (!part?.day || !part?.month || !part?.year) return null;
  return `${part.year}-${pad2(part.month)}-${pad2(part.day)}`;
}

/** The time a named phenomenon happens, as the Observatory writes it. */
function phenTime(
  list: UsnoPhenomenon[] | undefined,
  name: string,
): string | null {
  return list?.find((row) => row.phen === name)?.time ?? null;
}

/** `HH:MM` to minutes past midnight, for measuring a day. */
function clockMinutes(value: string | null): number | null {
  if (!value) return null;
  const match = value.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * The sun and the moon over Colorado, from the U.S. Naval Observatory — the
 * body that keeps the official almanac, and the tracker the rest of the world's
 * almanacs are checked against. One request gives the day's moon and sun rise,
 * set and transit times for the state's centre; a second gives the next four
 * primary moon phases; a third, yesterday's, is what turns "the days are
 * getting shorter" into a real number of minutes rather than a rule of thumb.
 */
async function almanac(): Promise<Almanac> {
  const tz = denverOffsetHours();
  const today = denverDate(tz);
  const yesterday = denverDate(tz, -1);
  const coords = `${CO.lat},${CO.lon}`;
  const dayUrl = (date: string) =>
    `${USNO_BASE}/rstt/oneday?date=${date}&coords=${coords}&tz=${tz}`;

  const day = await getJson<UsnoDay>(dayUrl(today));
  const data = day.properties?.data;
  if (!data) throw new Error("The almanac answered nothing.");

  // Yesterday and the phase table are nice to have, never required.
  const [past, phases] = await Promise.all([
    getJson<UsnoDay>(dayUrl(yesterday)).catch(() => null),
    getJson<UsnoPhases>(`${USNO_BASE}/moon/phases/date?date=${today}&nump=4`).catch(
      () => null,
    ),
  ]);

  /** How long the daylight lasts, in minutes, on a given day's reading. */
  const length = (reading: UsnoDay | null): number | null => {
    const rows = reading?.properties?.data?.sundata;
    const rise = clockMinutes(phenTime(rows, "Rise"));
    const set = clockMinutes(phenTime(rows, "Set"));
    if (rise === null || set === null) return null;
    // A sunset earlier than its sunrise belongs to the day after.
    return set >= rise ? set - rise : set + 1440 - rise;
  };

  const todayLength = length(day);
  const pastLength = length(past);

  return {
    at: Date.now(),
    moon: {
      phase: data.curphase ?? null,
      illumination: data.fracillum ? num(data.fracillum.replace("%", "")) : null,
      rise: phenTime(data.moondata, "Rise"),
      set: phenTime(data.moondata, "Set"),
      transit: phenTime(data.moondata, "Upper Transit"),
      closestPhase: data.closestphase?.phase ?? null,
      closestDay: isoDate(data.closestphase),
      upcoming: (phases?.phasedata ?? [])
        .filter((row) => row.phase)
        .slice(0, 4)
        .map((row) => ({
          phase: row.phase ?? "",
          day: isoDate(row),
          time: row.time ?? null,
        })),
    },
    sun: {
      rise: phenTime(data.sundata, "Rise"),
      set: phenTime(data.sundata, "Set"),
      noon: phenTime(data.sundata, "Upper Transit"),
      civilBegin: phenTime(data.sundata, "Begin Civil Twilight"),
      civilEnd: phenTime(data.sundata, "End Civil Twilight"),
      dayLengthMinutes: todayLength,
      dayLengthDeltaMinutes:
        todayLength !== null && pastLength !== null
          ? todayLength - pastLength
          : null,
    },
  };
}

/* ------------------------------------------------------------------ seismic */
type QuakeFeed = {
  features?: Array<{
    properties?: { mag?: number; place?: string; time?: number; url?: string };
    geometry?: { coordinates?: number[] };
  }>;
};

async function seismic(): Promise<Quake[]> {
  const body = await getJson<QuakeFeed>(
    "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson",
  );

  const all = (body.features ?? []).map((feature) => {
    const properties = feature.properties ?? {};
    const coordinates = feature.geometry?.coordinates ?? [];
    return {
      quake: {
        mag: num(properties.mag),
        place: properties.place ?? "Unknown location",
        time: num(properties.time),
        url: properties.url ?? null,
      },
      lon: num(coordinates[0]),
      lat: num(coordinates[1]),
    };
  });

  const region = all.filter(
    (row) =>
      row.lat !== null &&
      row.lon !== null &&
      row.lat >= 35.5 &&
      row.lat <= 42.5 &&
      row.lon >= -110.5 &&
      row.lon <= -101.5,
  );
  if (region.length) {
    return region.slice(0, 6).map((row) => row.quake);
  }

  return all
    .sort((a, b) => (b.quake.mag ?? 0) - (a.quake.mag ?? 0))
    .slice(0, 4)
    .map((row) => row.quake);
}

/* ----------------------------------------------------------------- airspace */

type AdsbCraft = {
  flight?: string;
  r?: string;
  t?: string;
  alt_baro?: number | string;
  gs?: number;
  squawk?: string;
  emergency?: string;
};

type AdsbResponse = { ac?: AdsbCraft[] };

async function airspace(): Promise<Airspace> {
  const body = await getJson<AdsbResponse>(
    `https://api.adsb.lol/v2/lat/${CO.lat}/lon/${CO.lon}/dist/120`,
  );
  const craft = body.ac ?? [];
  const altitude = (row: AdsbCraft) => num(row.alt_baro);

  const notable = craft
    .map((row) => ({
      callsign: (row.flight ?? row.r ?? "—").trim(),
      type: row.t ? String(row.t).trim() : null,
      altitudeFt: altitude(row),
      speedKt: num(row.gs),
    }))
    .filter((row) => row.callsign !== "—")
    .sort((a, b) => (b.altitudeFt ?? 0) - (a.altitudeFt ?? 0))
    .slice(0, 5);

  return {
    at: Date.now(),
    count: craft.length,
    high: craft.filter((row) => (altitude(row) ?? 0) >= 30_000).length,
    emergency: craft.filter(
      (row) => row.emergency && row.emergency !== "none",
    ).length,
    notable,
  };
}

/* -------------------------------------------------------------------- news */

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCodePoint(Number(code)),
    )
    .replace(/&amp;/g, "&")
    .trim();
}

function tag(block: string, name: string): string {
  const match = block.match(
    new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"),
  );
  return match ? decodeXml(match[1]) : "";
}

/**
 * A newsroom publishes ordinary RSS; this reads it into plain rows.
 *
 * The outlets are named rather than searched: Google News refuses to answer the
 * hub's server at all, while Colorado's own newsrooms serve their feeds freely.
 * Each row keeps the outlet, the headline, the link and the time.
 */
async function news(
  url: string,
  outlet: string,
  limit: number,
): Promise<NewsItem[]> {
  const xml = await getText(url);

  const items: NewsItem[] = [];
  for (const block of xml.split("<item>").slice(1)) {
    const raw = tag(block, "title");
    if (!raw) continue;
    const published = tag(block, "pubDate");
    items.push({
      title: raw,
      source: outlet,
      link: tag(block, "link"),
      at: published ? Date.parse(published) || null : null,
    });
  }

  if (!items.length) throw new Error("The news feed answered nothing.");
  return items.sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, limit);
}

/* --------------------------------------------------------------- the ranch */

/*
 * Colorado's ranch and farm board. The hay and the horse sale are read
 * straight from the numbers those operations publish — a region-by-region
 * hay report and a lot-by-lot sale sheet — rather than estimated here. The
 * auction calendars and the USDA market reports for every Colorado barn are
 * listed and linked, since those live as PDFs a browser reads.
 */

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** The readable text of a page, with scripts and styles thrown away. */
function pageText(html: string): string {
  return decodeXml(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

/** A month-name passage, turned into a timestamp so the next sale sorts first. */
function monthStamp(text: string): number | null {
  const match = text.match(
    /([A-Z][a-z]{2})[a-z]*\.?\s*(\d{1,2})?(?:\s*&\s*\d{1,2})?,?\s*(20\d\d)/,
  );
  if (!match) return null;
  const index = MONTHS.findIndex((month) =>
    month.toLowerCase().startsWith(match[1].toLowerCase()),
  );
  if (index < 0) return null;
  return Date.UTC(Number(match[3]), index, Number(match[2] ?? "1"));
}

type HayWireRow = {
  state_code?: string;
  region?: string;
  commodity?: string;
  quality?: string;
  bale_type?: string;
  price_low?: number;
  price_high?: number;
  price_avg?: number;
  unit?: string;
  report_date?: string;
  estimated?: boolean;
  source?: string;
};

type HayWire = {
  report_week?: string;
  scraped_date?: string;
  prices?: HayWireRow[];
};

/**
 * Colorado hay and alfalfa, per ton, by the region it traded in — the week's
 * actual sales, gathered from the USDA report and the Fort Collins and
 * Greeley auctions by HayWire Ag.
 */
async function hayPrices(): Promise<HayReport> {
  const body = await getJson<HayWire>("https://haywireag.com/api/prices.json");
  const rows: HayPrice[] = (body.prices ?? [])
    .filter((row) => row.state_code === "CO")
    .map((row) => ({
      region: (row.region ?? "Colorado").replace(/^Colorado\s*[-\u2013]\s*/, ""),
      commodity: row.commodity ?? "Hay",
      quality: row.quality ?? "",
      baleType: row.bale_type ?? "",
      low: num(row.price_low),
      high: num(row.price_high),
      avg: num(row.price_avg),
      unit: row.unit === "per_ton" ? "per ton" : (row.unit ?? ""),
      estimated: row.estimated === true,
      source: row.source ?? "",
      date: row.report_date ?? null,
    }));

  if (!rows.length) {
    throw new Error("The hay feed answered nothing for Colorado.");
  }
  rows.sort(
    (a, b) =>
      a.region.localeCompare(b.region) || a.commodity.localeCompare(b.commodity),
  );
  return { at: Date.now(), week: body.report_week ?? null, rows };
}

/** The place a Colorado horse event names, if the listing gives one. */
function horseEvents(html: string): AuctionEvent[] {
  const events: AuctionEvent[] = [];

  for (const block of html.split('class="search_result row-fluid').slice(1)) {
    const title = decodeXml(
      block.match(/class="h3[^"]*"\s+title="([^"]*)"/)?.[1] ?? "",
    );
    const date = block.match(/<b>(\d{1,2}\/\d{1,2}\/20\d\d)<\/b>/)?.[1];
    if (!title || !date) continue;
    // Only the sales and auctions, not every show and clinic.
    if (!/auction|sale|tack|consignment/i.test(title)) continue;

    const place = block.match(
      /fa fa-calendar[\s\S]{0,200}?<\/b>([\s\S]{0,200}?)<\/span>/,
    )?.[1];
    const where = decodeXml(place ?? "").replace(/\s+/g, " ").trim();
    const href =
      block.match(/class="h3[^"]*"\s+title="[^"]*"\s+href="([^"]*)"/)?.[1] ??
      "https://www.hometownhorses.com/events";

    const [month, day, year] = date.split("/");
    events.push({
      date: `${MONTHS[Number(month) - 1] ?? ""} ${Number(day)}, ${year}`.trim(),
      title,
      where: where && where !== "N/A" ? where : null,
      href: href.startsWith("http")
        ? href
        : `https://www.hometownhorses.com${href}`,
    });
  }

  return events;
}

/**
 * Upcoming Colorado horse sales and auctions, from the state's own horse
 * community calendar — the tack sales and consignment auctions a buyer here
 * actually watches.
 */
async function horseAuctions(): Promise<AuctionEvent[]> {
  const page = await getText(
    "https://www.hometownhorses.com/events",
    "text/html",
  );
  const events = horseEvents(page);
  const floor = Date.now() - 24 * 60 * 60 * 1000;
  return events
    .filter((event) => {
      const stamp = monthStamp(event.date);
      return stamp === null || stamp >= floor;
    })
    .slice(0, 14);
}

/** Colorado's draft-horse and farm-equipment auction calendar. */
async function equipmentAuctions(): Promise<AuctionEvent[]> {
  const page = await getText(
    "https://www.joshwhiteauctions.com/consignment.php",
    "text/html",
  );
  const text = pageText(page);
  const events: AuctionEvent[] = [];
  const re =
    /((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:\s*&\s*\d{1,2})?,?\s+20\d\d|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+20\d\d)\s*[-\u2013\u2014]\s*/g;

  const dates: RegExpExecArray[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) dates.push(match);

  for (let i = 0; i < dates.length; i += 1) {
    const current = dates[i];
    const end = dates[i + 1]?.index ?? Math.min(text.length, current.index + 120);
    const title = text
      .slice(current.index + current[0].length, end)
      .split(/ONLINE BIDDING|CONSIGNORS|HIGHLIGHTS|QUESTIONS/i)[0]
      .replace(/[|•]+$/, "")
      .trim();
    if (!title || !/auction|sale/i.test(title)) continue;
    events.push({
      date: current[1].trim(),
      title: title.slice(0, 80),
      where: null,
      href: "https://www.joshwhiteauctions.com/consignment.php",
    });
  }

  if (!events.length) throw new Error("The auction calendar answered nothing.");

  const floor = Date.now() - 45 * 24 * 60 * 60 * 1000;
  return events
    .filter((event) => {
      const stamp = monthStamp(event.date);
      return stamp === null || stamp >= floor;
    })
    .slice(0, 6);
}

/** The USDA market reports for every Colorado livestock barn. */
async function cattleAuctions(): Promise<AuctionReport[]> {
  const page = await getText(
    "https://www.thefencepost.com/news/market-reports/",
    "text/html",
  );
  const out: AuctionReport[] = [];
  const seen = new Set<string>();
  const re =
    /href="(https?:\/\/www\.ams\.usda\.gov\/mnreports\/[^"]+\.pdf)"[^>]*>([\s\S]*?)<\/a>/gi;

  let match: RegExpExecArray | null;
  while ((match = re.exec(page)) !== null) {
    const label = decodeXml(match[2]).replace(/\s+/g, " ").trim();
    if (!/, CO\b/.test(label) && !/\bColorado\b/.test(label)) continue;
    if (seen.has(match[1])) continue;
    seen.add(match[1]);
    out.push({ label, href: match[1] });
  }

  if (!out.length) throw new Error("The report list answered nothing.");
  return out.slice(0, 14);
}

/* --------------------------------------------------------------- assembling */

export async function gather(): Promise<Briefing> {
  const [
    weatherNow,
    snowNow,
    alertsNow,
    airNow,
    energyNow,
    farmNow,
    marketsNow,
    economyNow,
    waterNow,
    droughtNow,
    fireNow,
    emergencyNow,
    seismicNow,
    orbitNow,
    spaceNow,
    airspaceNow,
    almanacNow,
  ] = await Promise.all([
    source(weather),
    source(snow),
    source(alerts),
    source(air),
    marketGroup(ENERGY_SYMBOLS),
    marketGroup(FARM_SYMBOLS),
    marketGroup(MARKET_SYMBOLS),
    source(economy),
    source(water),
    source(drought),
    source(fire),
    source(emergency),
    source(seismic),
    source(orbit),
    source(spaceWeather),
    source(airspace),
    source(almanac),
  ]);

  // The headline feeds are newsroom sites, not APIs, and they would rather not
  // be hammered. They are asked one after another.
  const newsNow = await source(() =>
    news("https://coloradosun.com/feed/", "Colorado Sun", 6),
  );
  const roadsNow = await source(() =>
    news("https://coloradosun.com/?s=road+closure&feed=rss2", "Colorado Sun", 5),
  );
  const avalancheNow = await source(() =>
    news("https://coloradosun.com/tag/avalanche/feed/", "Colorado Sun", 5),
  );
  const wildfireNow = await source(() =>
    news("https://coloradosun.com/tag/wildfire/feed/", "Colorado Sun", 5),
  );
  const worldNow = await source(() =>
    news("https://feeds.bbci.co.uk/news/world/rss.xml", "BBC", 6),
  );

  // The ranch and farm board, read from the operations that publish it.
  const hayNow = await source(hayPrices);
  const horseAuctionsNow = await source(horseAuctions);
  const equipmentAuctionsNow = await source(equipmentAuctions);
  const cattleAuctionsNow = await source(cattleAuctions);

  return {
    at: Date.now(),
    center: CO,
    weather: weatherNow,
    snow: snowNow,
    alerts: alertsNow,
    air: airNow,
    energy: energyNow,
    farm: farmNow,
    markets: marketsNow,
    economy: economyNow,
    water: waterNow,
    drought: droughtNow,
    fire: fireNow,
    emergency: emergencyNow,
    seismic: seismicNow,
    orbit: orbitNow,
    space: spaceNow,
    almanac: almanacNow,
    airspace: airspaceNow,
    news: newsNow,
    roads: roadsNow,
    avalanche: avalancheNow,
    wildfire: wildfireNow,
    world: worldNow,
    hay: hayNow,
    horseAuctions: horseAuctionsNow,
    equipmentAuctions: equipmentAuctionsNow,
    cattleAuctions: cattleAuctionsNow,
  };
}

/* -------------------------------------------------------- the spoken board */

/**
 * The [LIVE] board, said out loud.
 *
 * `gather()` leaves raw numbers whose shape only the page that drew them
 * knows. This turns the same board into plain sentences: every reading named,
 * every feed that failed named as failed rather than guessed at, and every
 * link the page shows — so the assistant can read the board back to somebody
 * instead of inventing it. It asks for one section, or for the lot.
 */

const SECTION_ORDER = [
  "summary",
  "weather",
  "snow",
  "alerts",
  "air",
  "water",
  "drought",
  "fire",
  "disasters",
  "markets",
  "farm",
  "hay",
  "auctions",
  "news",
  "sky",
  "airspace",
  "links",
] as const;

const SECTION_TITLES: Record<string, string> = {
  summary: "Right now",
  weather: "Weather",
  snow: "Mountain snow",
  alerts: "Watches and warnings",
  air: "Air quality",
  water: "Rivers",
  drought: "Drought",
  fire: "Wildfires",
  disasters: "Federal disaster declarations",
  markets: "Energy, metals and the markets",
  farm: "Farm economy",
  hay: "Hay and alfalfa prices",
  auctions: "Livestock, horse and equipment auctions",
  news: "Headlines",
  sky: "Space, satellites and the ground",
  airspace: "Aircraft overhead",
  links: "Every link on the board",
};

/** The section names the assistant may ask for, in the order they appear. */
export function briefingSections(): { id: string; title: string }[] {
  return SECTION_ORDER.map((id) => ({ id, title: SECTION_TITLES[id] }));
}

function sayNum(value: number | null, digits = 0): string {
  if (value === null) return "no reading";
  return value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function sayMarket(rows: MarketReading[]): string[] {
  return rows.map((row) => {
    const price =
      row.price === null
        ? "no reading"
        : `${sayNum(row.price, row.price >= 1000 ? 0 : 2)} ${row.unit}`;
    if (row.changePct === null && row.change === null) return `${row.label}: ${price}`;
    const pct = row.changePct ?? 0;
    if (pct === 0) return `${row.label}: ${price} (flat today)`;
    return `${row.label}: ${price} (${pct > 0 ? "up" : "down"} ${sayNum(
      Math.abs(pct),
      2,
    )} percent today)`;
  });
}

function sayDay(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function sayWhen(ms: number | null): string {
  if (ms === null) return "time unknown";
  return new Date(ms).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Denver",
  });
}

function ageWords(updatedAt: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - updatedAt) / 1000));
  if (seconds < 90) return "refreshed just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `refreshed ${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `refreshed ${hours} hours ago`;
  return `refreshed ${Math.round(hours / 24)} days ago`;
}

/** Every section of the board, each with at least one line, so nothing is missing. */
function boardBlocks(data: Briefing): { id: string; lines: string[] }[] {
  const blocks: { id: string; lines: string[] }[] = [];

  /* summary */
  {
    const bits: string[] = [];
    if (data.weather.ok) {
      const w = data.weather.data;
      bits.push(
        `${skyWord(w.code)} and ${sayNum(w.temperature, 0)}° in ${data.center.label}`,
      );
      if (w.windGust !== null && w.windGust >= 20) {
        bits.push(`gusting ${sayNum(w.windGust, 0)} mph`);
      }
    }
    if (data.alerts.ok && data.alerts.data.length) {
      bits.push(
        `${data.alerts.data.length} weather alert${
          data.alerts.data.length === 1 ? "" : "s"
        } up`,
      );
    }
    if (data.fire.ok && data.fire.data.length) {
      const acres = data.fire.data.reduce((total, item) => total + (item.acres ?? 0), 0);
      bits.push(`${data.fire.data.length} wildfires mapped (${sayNum(acres, 0)} acres)`);
    }
    if (data.drought.ok && data.drought.data.d2 !== null) {
      bits.push(`${sayNum(data.drought.data.d2, 0)} percent of Colorado in severe drought`);
    }
    if (data.energy.ok) {
      const oil = data.energy.data.find((row) => row.symbol === "CL=F");
      if (oil?.price != null) {
        bits.push(`WTI oil $${sayNum(oil.price, 2)}`);
      }
    }
    if (data.farm.ok) {
      const corn = data.farm.data.find((row) => row.symbol === "ZC=F");
      if (corn?.price != null) {
        bits.push(`corn ${sayNum(corn.price, 2)} cents`);
      }
    }
    if (data.space.ok && data.space.data.kp !== null) {
      bits.push(`Kp ${sayNum(data.space.data.kp, 0)} (${kpWord(data.space.data.kp)})`);
    }
    if (data.almanac?.ok) {
      const m = data.almanac.data.moon;
      const s = data.almanac.data.sun;
      if (m.phase) {
        bits.push(
          `${m.phase} moon${
            m.illumination !== null ? `, ${sayNum(m.illumination, 0)} percent lit` : ""
          }`,
        );
      }
      if (s.dayLengthDeltaMinutes !== null && Math.abs(s.dayLengthDeltaMinutes) >= 1) {
        bits.push(
          `${s.dayLengthDeltaMinutes >= 0 ? "gaining" : "losing"} ${sayNum(
            Math.abs(s.dayLengthDeltaMinutes),
            0,
          )} minutes of daylight a day`,
        );
      }
    }
    blocks.push({
      id: "summary",
      lines: bits.length ? [`${bits.join("; ")}.`] : ["No readings came back."],
    });
  }

  /* weather */
  {
    const lines: string[] = [];
    if (data.weather.ok) {
      const w = data.weather.data;
      lines.push(
        `${skyWord(w.code)}, ${sayNum(w.temperature, 0)}° right now${w.windSpeed !== null ? `, wind ${sayNum(w.windSpeed, 0)} mph from the ${compassWord(w.windDirection)}` : ""}${w.windGust !== null ? `, gusting ${sayNum(w.windGust, 0)} mph` : ""}.`,
      );
      const rest: string[] = [];
      if (w.humidity !== null) rest.push(`humidity ${sayNum(w.humidity, 0)} percent`);
      if (w.precipitation !== null) rest.push(`precipitation ${sayNum(w.precipitation, 2)}`);
      if (w.pressure !== null) rest.push(`pressure ${sayNum(w.pressure, 0)}`);
      if (w.soilTemperature !== null) rest.push(`soil ${sayNum(w.soilTemperature, 0)}°`);
      if (w.soilMoisture !== null) rest.push(`soil moisture ${sayNum(w.soilMoisture, 2)}`);
      if (rest.length) lines.push(`${rest.join(", ")}.`);
      const days = w.daily.slice(0, 5).map((d) => {
        const parts = [`${sayDay(d.date)} ${skyWord(d.code).toLowerCase()}`];
        if (d.high !== null) parts.push(`high ${sayNum(d.high, 0)}°`);
        if (d.low !== null) parts.push(`low ${sayNum(d.low, 0)}°`);
        if (d.precipitation !== null) parts.push(`precipitation ${sayNum(d.precipitation, 2)}`);
        if (d.snow !== null) parts.push(`snow ${sayNum(d.snow, 1)} inches`);
        if (d.gust !== null) parts.push(`gusts ${sayNum(d.gust, 0)} mph`);
        return parts.join(", ");
      });
      if (days.length) lines.push(`Forecast: ${days.join(". ")}.`);
    } else {
      lines.push("The weather feed could not be read just now.");
    }
    blocks.push({ id: "weather", lines });
  }

  /* snow */
  {
    const lines: string[] = [];
    if (data.snow.ok && data.snow.data.points.length) {
      for (const p of data.snow.data.points) {
        const parts = [`${p.name}${p.elevationFt !== null ? ` (${sayNum(p.elevationFt, 0)} feet)` : ""}: ${skyWord(p.code).toLowerCase()}`];
        if (p.snowDepthIn !== null) parts.push(`${sayNum(p.snowDepthIn, 1)} inches on the ground`);
        if (p.newSnow24hIn !== null) parts.push(`${sayNum(p.newSnow24hIn, 1)} inches new in 24 hours`);
        if (p.newSnow7dIn !== null) parts.push(`${sayNum(p.newSnow7dIn, 1)} inches in the past week`);
        if (p.temperatureF !== null) parts.push(`${sayNum(p.temperatureF, 0)}°`);
        lines.push(`${parts.join(", ")}.`);
      }
    } else {
      lines.push("The mountain snow could not be read just now.");
    }
    blocks.push({ id: "snow", lines });
  }

  /* alerts */
  {
    const lines: string[] = [];
    if (data.alerts.ok && data.alerts.data.length) {
      for (const a of data.alerts.data) {
        lines.push(
          `${a.event} (${a.severity}): ${a.headline}${a.area ? ` — ${a.area}` : ""}${a.ends ? `, ends ${a.ends}` : ""}.`,
        );
      }
    } else {
      lines.push(
        data.alerts.ok
          ? "No watches or warnings are up for Colorado."
          : "The alerts feed could not be read just now.",
      );
    }
    blocks.push({ id: "alerts", lines });
  }

  /* air */
  {
    const lines: string[] = [];
    if (data.air.ok) {
      const a = data.air.data;
      lines.push(
        `Air quality index ${sayNum(a.aqi, 0)} — ${aqiWord(a.aqi)}${a.pm25 !== null ? `, PM2.5 ${sayNum(a.pm25, 1)}` : ""}${a.pm10 !== null ? `, PM10 ${sayNum(a.pm10, 1)}` : ""}.`,
      );
    } else {
      lines.push("Air quality could not be read just now.");
    }
    blocks.push({ id: "air", lines });
  }

  /* water */
  {
    const lines: string[] = [];
    if (data.water.ok && data.water.data.length) {
      for (const g of data.water.data) {
        lines.push(
          `${g.name} (${g.site}): ${g.discharge === null ? "no reading" : `${sayNum(g.discharge, 0)} ${g.unit}`}${g.at !== null ? `, read ${sayWhen(g.at)}` : ""}.`,
        );
      }
    } else {
      lines.push("The river gauges could not be read just now.");
    }
    blocks.push({ id: "water", lines });
  }

  /* drought */
  {
    const lines: string[] = [];
    if (data.drought.ok) {
      const d = data.drought.data;
      const parts: string[] = [];
      if (d.none !== null) parts.push(`${sayNum(d.none, 1)} percent is not dry`);
      if (d.d0 !== null) parts.push(`${sayNum(d.d0, 1)} percent abnormally dry`);
      if (d.d1 !== null) parts.push(`${sayNum(d.d1, 1)} percent in moderate drought`);
      if (d.d2 !== null) parts.push(`${sayNum(d.d2, 1)} percent in severe drought`);
      if (d.d3 !== null) parts.push(`${sayNum(d.d3, 1)} percent extreme`);
      if (d.d4 !== null) parts.push(`${sayNum(d.d4, 1)} percent exceptional`);
      lines.push(`${d.week ? `${d.week}: ` : ""}${parts.join(", ")}.`);
    } else {
      lines.push("The drought monitor could not be read just now.");
    }
    blocks.push({ id: "drought", lines });
  }

  /* fire */
  {
    const lines: string[] = [];
    if (data.fire.ok && data.fire.data.length) {
      for (const f of data.fire.data) {
        lines.push(
          `${f.name}${f.state ? ` (${f.state})` : ""}: ${f.acres === null ? "size unknown" : `${sayNum(f.acres, 0)} acres`}${f.contained !== null ? `, ${sayNum(f.contained, 0)} percent contained` : ""}${f.type ? `, ${f.type}` : ""}.`,
        );
      }
    } else {
      lines.push(
        data.fire.ok
          ? "No wildfires are mapped right now."
          : "The wildfire feed could not be read just now.",
      );
    }
    blocks.push({ id: "fire", lines });
  }

  /* disasters */
  {
    const lines: string[] = [];
    if (data.emergency.ok && data.emergency.data.length) {
      for (const e of data.emergency.data) {
        lines.push(
          `${e.type}${e.number !== null ? ` ${e.number}` : ""}: ${e.title}${e.date ? ` (${e.date})` : ""}.`,
        );
      }
    } else {
      lines.push("No federal disaster declarations came back just now.");
    }
    blocks.push({ id: "disasters", lines });
  }

  /* markets */
  {
    const lines: string[] = [];
    if (data.energy.ok) lines.push(...sayMarket(data.energy.data));
    else lines.push("Energy prices could not be read just now.");
    if (data.markets.ok) lines.push(...sayMarket(data.markets.data));
    else lines.push("The metals could not be read just now.");
    blocks.push({ id: "markets", lines });
  }

  /* farm */
  {
    const lines: string[] = [];
    if (data.farm.ok) lines.push(...sayMarket(data.farm.data));
    else lines.push("The farm markets could not be read just now.");
    if (data.economy.ok) {
      const e = data.economy.data;
      const bits: string[] = [];
      if (e.coUnemployment !== null) {
        bits.push(`Colorado unemployment ${sayNum(e.coUnemployment, 1)} percent${e.coUnemploymentPeriod ? ` (${e.coUnemploymentPeriod})` : ""}`);
      }
      if (e.cpi !== null) {
        bits.push(`CPI ${sayNum(e.cpi, 1)}${e.cpiPeriod ? ` (${e.cpiPeriod})` : ""}${e.cpiYoYPct !== null ? `, up ${sayNum(e.cpiYoYPct, 1)} percent over the year` : ""}`);
      }
      if (e.debt !== null) {
        bits.push(`national debt ${sayNum(e.debt, 0)}${e.debtDate ? ` (${e.debtDate})` : ""}`);
      }
      lines.push(bits.length ? `${bits.join(". ")}.` : "The economy readings came back empty.");
    } else {
      lines.push("The economy readings could not be fetched just now.");
    }
    blocks.push({ id: "farm", lines });
  }

  /* hay */
  {
    const lines: string[] = [];
    if (data.hay.ok && data.hay.data.rows.length) {
      if (data.hay.data.week) lines.push(`Week of ${data.hay.data.week}.`);
      for (const r of data.hay.data.rows) {
        const price =
          r.avg !== null
            ? `averaging $${sayNum(r.avg, 0)}`
            : r.low !== null && r.high !== null
              ? `$${sayNum(r.low, 0)} to $${sayNum(r.high, 0)}`
              : "no price";
        lines.push(
          `${r.commodity}${r.quality ? ` (${r.quality})` : ""}, ${r.baleType}, ${r.region}: ${price} ${r.unit}${r.estimated ? " (estimated)" : ""}${r.date ? `, ${r.date}` : ""} — ${r.source}.`,
        );
      }
    } else {
      lines.push("The hay and alfalfa prices could not be read just now.");
    }
    blocks.push({ id: "hay", lines });
  }

  /* auctions */
  {
    const lines: string[] = [];
    if (data.horseAuctions.ok && data.horseAuctions.data.length) {
      lines.push("Horse sales:");
      for (const e of data.horseAuctions.data) {
        lines.push(
          `  ${e.date} — ${e.title}${e.where ? ` at ${e.where}` : ""} (${e.href})`,
        );
      }
    } else {
      lines.push("The horse sale calendar could not be read just now.");
    }
    if (data.equipmentAuctions.ok && data.equipmentAuctions.data.length) {
      lines.push("Equipment and draft-horse auctions:");
      for (const e of data.equipmentAuctions.data) {
        lines.push(`  ${e.date} — ${e.title} (${e.href})`);
      }
    } else {
      lines.push("The equipment auction calendar could not be read just now.");
    }
    if (data.cattleAuctions.ok && data.cattleAuctions.data.length) {
      lines.push(`Colorado livestock barn reports (${data.cattleAuctions.data.length}):`);
      for (const r of data.cattleAuctions.data) lines.push(`  ${r.label} — ${r.href}`);
    } else {
      lines.push("The livestock barn reports could not be read just now.");
    }
    blocks.push({ id: "auctions", lines });
  }

  /* news */
  {
    const lines: string[] = [];
    const feeds: [string, Source<NewsItem[]>][] = [
      ["Colorado", data.news],
      ["Roads and closures", data.roads],
      ["Avalanche country", data.avalanche],
      ["Wildfire", data.wildfire],
      ["The world", data.world],
    ];
    for (const [label, feed] of feeds) {
      if (feed.ok && feed.data.length) {
        lines.push(`${label}:`);
        for (const item of feed.data) {
          lines.push(
            `  ${item.title} — ${item.source}${item.link ? ` (${item.link})` : ""}`,
          );
        }
      } else {
        lines.push(`${label}: nothing came back just now.`);
      }
    }
    blocks.push({ id: "news", lines });
  }

  /* sky */
  {
    const lines: string[] = [];
    if (data.space.ok) {
      const s = data.space.data;
      lines.push(
        `Space weather: Kp ${sayNum(s.kp, 0)} — ${kpWord(s.kp)}${s.aurora !== null ? `, aurora ${sayNum(s.aurora, 0)} percent overhead` : ""}${s.timeTag ? `, ${s.timeTag}` : ""}.`,
      );
    } else {
      lines.push("Space weather could not be read just now.");
    }
    if (data.orbit.ok) {
      const o = data.orbit.data;
      lines.push(
        `The station: ${o.lat !== null && o.lon !== null ? `${sayNum(o.lat, 2)}, ${sayNum(o.lon, 2)}` : "position unknown"}${o.altitudeKm !== null ? `, ${sayNum(o.altitudeKm, 0)} kilometers up` : ""}${o.velocityKmh !== null ? `, ${sayNum(o.velocityKmh, 0)} kilometers an hour` : ""}${o.visibility !== null ? `, ${o.visibility}` : ""}${o.footprintKm !== null ? `, visible within ${sayNum(o.footprintKm, 0)} kilometers` : ""}.`,
      );
    } else {
      lines.push("The satellite reading could not be read just now.");
    }
    if (data.seismic.ok && data.seismic.data.length) {
      for (const q of data.seismic.data) {
        lines.push(
          `Earthquake magnitude ${sayNum(q.mag, 1)} near ${q.place}${q.time !== null ? `, ${sayWhen(q.time)}` : ""}${q.url ? ` (${q.url})` : ""}.`,
        );
      }
    } else {
      lines.push(
        data.seismic.ok
          ? "No earthquakes are listed right now."
          : "The earthquake feed could not be read just now.",
      );
    }
    blocks.push({ id: "sky", lines });
  }

  /* airspace */
  {
    const lines: string[] = [];
    if (data.airspace.ok) {
      const a = data.airspace.data;
      lines.push(
        `${sayNum(a.count, 0)} aircraft overhead — ${sayNum(a.high, 0)} high, ${sayNum(a.emergency, 0)} with an emergency squawk.`,
      );
      for (const n of a.notable) {
        lines.push(
          `  ${n.callsign}${n.type ? ` (${n.type})` : ""}${n.altitudeFt !== null ? `, ${sayNum(n.altitudeFt, 0)} feet` : ""}${n.speedKt !== null ? `, ${sayNum(n.speedKt, 0)} knots` : ""}`,
        );
      }
    } else {
      lines.push("The airspace could not be read just now.");
    }
    blocks.push({ id: "airspace", lines });
  }

  /* links */
  {
    const lines: string[] = [
      "Sources for everything this board cannot read itself, one click away:",
    ];
    for (const link of ELSEWHERE) {
      lines.push(`  ${link.label} — ${link.href} (${link.why})`);
    }
    lines.push("Colorado ranch and farm stores, and where their sales live:");
    for (const store of RANCH_STORES) {
      lines.push(`  ${store.name} — ${store.href} (${store.note})`);
    }
    blocks.push({ id: "links", lines });
  }

  return blocks;
}

/**
 * The board as text: one section, or all of them. `section` is one of the ids
 * from `briefingSections()`; anything else — including an empty string — means
 * the whole board.
 */
export function briefingDigest(
  updatedAt: number,
  data: Briefing,
  section: string | null,
): string {
  const blocks = boardBlocks(data);
  const wanted = (section ?? "").trim().toLowerCase();
  const header = `The [LIVE] board for Colorado, ${ageWords(updatedAt)}.`;

  if (!wanted || wanted === "all" || wanted === "everything" || wanted === "board") {
    return [
      header,
      ...blocks.flatMap((block) => [
        "",
        `## ${SECTION_TITLES[block.id] ?? block.id}`,
        ...block.lines,
      ]),
    ]
      .join("\n")
      .trim();
  }

  const match = blocks.find(
    (block) =>
      block.id === wanted ||
      (SECTION_TITLES[block.id] ?? "").toLowerCase().includes(wanted),
  );

  if (!match) {
    return `${header}\n\nI do not have a section called "${section}". I can read any of these: ${briefingSections()
      .map((entry) => entry.id)
      .join(", ")} — or ask for everything.`;
  }

  return [`${header} Section: ${SECTION_TITLES[match.id]}.`, ...match.lines].join(
    "\n",
  );
}

/* ------------------------------------------------------------- the plumbing */

/**
 * Fetch everything and write it down. No account check: this is the inner half,
 * called by the cron and by the checked action below, and by nothing a browser
 * can reach directly.
 */
/**
 * The hub is a Colorado hub: the board is about Colorado, and its two rebuilds
 * are at Colorado's own hours. One name for it, so the clock and the labels can
 * never drift apart.
 */
const BOARD_ZONE = "America/Denver";

/** The two hours, on Colorado's clock, at which the board is rebuilt. */
const REBUILD_HOURS = [5, 14];

/** What hour it is in Colorado right now, on a 24-hour clock. */
function coloradoHour(now = Date.now()) {
  const hour = new Intl.DateTimeFormat("en-US", {
    timeZone: BOARD_ZONE,
    hour: "numeric",
    hour12: false,
  }).format(new Date(now));

  // Some platforms answer "24" for midnight on a 24-hour clock.
  return Number(hour) % 24;
}

/**
 * A moment, written the way the rest of the hub writes one: 09/28/2026, 4:45 PM
 * in Colorado's time. Never an ISO string and never UTC — a timestamp ending in
 * Z is for machines, and this line is read by a person.
 */
function stamp(at: number | string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: BOARD_ZONE,
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(at));
}

/**
 * The hourly look at the clock: is this one of the two hours?
 *
 * Kept apart from `run` on purpose. `run` rebuilds the board and is what the
 * Refresh button calls, so it must never refuse to work; deciding *when* the
 * timer's rebuild happens belongs here, where the only caller is the timer.
 */
export const tick = internalAction({
  args: {},
  handler: async (ctx) => {
    if (!REBUILD_HOURS.includes(coloradoHour())) return null;

    await ctx.runAction(internal.briefing.run, {});
    return null;
  },
});

export const run = internalAction({
  args: {},
  handler: async (ctx) => {
    // Opened before the work starts, not after it: this run reaches out to
    // every feed the board draws on and takes a while, and the point of the
    // behind-the-scenes feed is that a person can watch it happen.
    const started = await ctx.runMutation(internal.ai_behind.open, {
      source: "board",
      label: "Refreshing the [LIVE] board",
      detail:
        "Going out to every feed the board draws on — the weather and the mountain snow, the watches and warnings, the air and the water, drought and rivers, wildfire, the markets, hay and auctions, the aircraft overhead, and the headlines.",
    });

    try {
      const briefing = await gather();
      await ctx.runMutation(internal.briefing.store, { data: briefing });
      await ctx.runMutation(internal.ai_behind.close, {
        id: started,
        status: "done",
        detail: `Board rebuilt ${stamp(briefing.at)}.`,
      });
      return briefing.at;
    } catch (error) {
      await ctx.runMutation(internal.ai_behind.close, {
        id: started,
        status: "failed",
        detail:
          error instanceof Error
            ? error.message
            : "The feeds could not be read.",
      });
      throw error;
    }
  },
});

/** Put the briefing on the shelf, replacing whatever was there. */
export const store = internalMutation({
  args: { data: v.any() },
  handler: async (ctx, { data }) => {
    const row = await ctx.db
      .query("briefings")
      .withIndex("by_key", (q) => q.eq("key", KEY))
      .unique();

    if (row) await ctx.db.patch(row._id, { data, updatedAt: Date.now() });
    else await ctx.db.insert("briefings", { key: KEY, data, updatedAt: Date.now() });

    return null;
  },
});

/**
 * The same shelf the page reads, handed to the assistant inside the deployment
 * rather than over the wire. It needs no account check because only our own
 * functions can call it, and the assistant has already proved who is asking.
 */
export const snapshot = internalQuery({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db
      .query("briefings")
      .withIndex("by_key", (q) => q.eq("key", KEY))
      .unique();
    if (!row) return null;
    return { updatedAt: row.updatedAt, data: row.data as Briefing };
  },
});

/** The briefing, or null before the first fetch has landed. */
export const read = query({
  args: {},
  handler: async (ctx) => {
    if (!(await isUnlocked(ctx))) return null;
    const row = await ctx.db
      .query("briefings")
      .withIndex("by_key", (q) => q.eq("key", KEY))
      .unique();
    if (!row) return null;
    return { updatedAt: row.updatedAt, data: row.data as Briefing };
  },
});

/** Ask for a fresh briefing now, from the page's Refresh button. */
export const refresh = action({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Sign in to refresh the briefing.");
    if (!(await ctx.runQuery(internal.access.unlocked, {}))) {
      throw new Error("This hub is locked. Enter the family password to continue.");
    }

    await ctx.runAction(internal.briefing.run, {});
    return null;
  },
});
