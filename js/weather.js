// weather.js
// Fetches an Open-Meteo forecast and maps the raw hourly arrays into the clean,
// flat input object the prediction engine expects.
//
// `mapForecastToEngineInput` is PURE: it takes the forecast JSON plus an injected
// `now` timestamp, so window-bucketing is fully deterministic and unit-testable.
// It reads the response's own `hourly_units` to convert values, instead of assuming
// a unit (the original app.js assumed millimeters and was wrong for snowfall).

import { clamp, mToMi, mToIn } from "./format.js";

const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

const HOURLY_FIELDS = [
  "snowfall",
  "precipitation",
  "precipitation_probability",
  "temperature_2m",
  "apparent_temperature",
  "windspeed_10m",
  "windgusts_10m",
  "visibility",
  "snow_depth",
  "weathercode",
].join(",");

/**
 * Fetch a 2-day forecast for a coordinate.
 * @param {number} lat
 * @param {number} lon
 * @param {{signal?:AbortSignal}} [opts]
 */
export async function fetchForecast(lat, lon, { signal } = {}) {
  const url =
    `${FORECAST_URL}?latitude=${lat}&longitude=${lon}` +
    `&hourly=${HOURLY_FIELDS}` +
    `&daily=temperature_2m_min,temperature_2m_max,snowfall_sum` +
    `&forecast_days=2&temperature_unit=fahrenheit&windspeed_unit=mph` +
    `&precipitation_unit=inch&timezone=auto`;

  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error("Could not load the weather forecast.");
  return res.json();
}

// --- unit-aware converters (read the API's reported unit string) ---------

function toInchesSnow(value, unit) {
  if (!Number.isFinite(value)) return 0;
  const u = String(unit || "").toLowerCase();
  if (u.includes("inch")) return value;
  if (u.includes("cm")) return value * 0.393701;
  if (u.includes("mm")) return value / 25.4;
  if (u.includes("m")) return mToIn(value); // bare "m"
  return value; // assume already inches
}

function depthToInches(value, unit) {
  if (!Number.isFinite(value)) return 0;
  const u = String(unit || "").toLowerCase();
  if (u.includes("cm")) return value * 0.393701;
  if (u.includes("ft")) return value * 12;
  if (u.includes("inch")) return value;
  if (u.includes("m")) return mToIn(value);
  return value;
}

function visToMiles(value, unit) {
  if (!Number.isFinite(value)) return null;
  const u = String(unit || "").toLowerCase();
  if (u.includes("mi")) return value;
  if (u.includes("ft")) return value / 5280;
  if (u.includes("km")) return value / 1.609344;
  if (u.includes("m")) return mToMi(value); // bare "m"
  return value;
}

function tempToF(value, unit) {
  if (!Number.isFinite(value)) return null;
  const u = String(unit || "");
  if (u.includes("C") || u.toLowerCase().includes("celsius")) return (value * 9) / 5 + 32;
  return value; // assume °F (we request fahrenheit)
}

// --- date helpers (operate on YYYY-MM-DD strings via UTC to dodge DST) ---

function parseEntry(iso, i) {
  const [date, time = ""] = String(iso).split("T");
  const hour = parseInt(time.slice(0, 2), 10);
  return { i, date, hour: Number.isNaN(hour) ? 0 : hour };
}

function shiftDate(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const ms = Date.UTC(y, m - 1, d) + days * 86400000;
  const dt = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

function nowParts(now) {
  const d = now instanceof Date ? now : new Date(now);
  const p = (n) => String(n).padStart(2, "0");
  return {
    dateStr: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    hour: d.getHours(),
  };
}

/**
 * Pick the overnight / morning-commute / daytime index buckets for the next
 * school morning, relative to `now`.
 */
function pickWindows(entries, now) {
  const { dateStr, hour } = nowParts(now);
  // Before ~11am we still care about *today*; later we look to tomorrow morning.
  let targetDate = hour < 11 ? dateStr : shiftDate(dateStr, 1);

  const available = new Set(entries.map((e) => e.date));
  // Fall back gracefully if the user's clock/date doesn't line up with the
  // forecast's local dates (different timezone, edge of range).
  if (!available.has(targetDate)) {
    const firstMorning = entries.find((e) => e.hour >= 5 && e.hour <= 9);
    targetDate = firstMorning ? firstMorning.date : entries[0]?.date;
  }
  const prevDate = shiftDate(targetDate, -1);

  // Disjoint buckets so boundary hours are never double-counted:
  //   overnight = 6 PM prior evening through 4:59 AM, morning commute = 5–8:59 AM,
  //   daytime = 9 AM–5 PM. (Pre-v1 the 5 AM and 9 AM hours landed in two buckets.)
  const morning = entries.filter((e) => e.date === targetDate && e.hour >= 5 && e.hour < 9);
  const overnight = entries.filter(
    (e) =>
      (e.date === prevDate && e.hour >= 18) || (e.date === targetDate && e.hour < 5)
  );
  const daytime = entries.filter((e) => e.date === targetDate && e.hour >= 9 && e.hour <= 17);
  // Prior evening (~3–11 PM), used for the wet-then-freezing refreeze signal.
  const evening = entries.filter((e) => e.date === prevDate && e.hour >= 15);

  return { morning, overnight, daytime, evening, targetDate };
}

function iceFromWeatherCode(code) {
  switch (code) {
    case 67: return 1.0; // heavy freezing rain
    case 66: return 0.8; // freezing rain
    case 57: return 0.6; // dense freezing drizzle
    case 56: return 0.45; // freezing drizzle
    default: return 0;
  }
}

/**
 * Map a raw Open-Meteo forecast into a `SnowDayInput`.
 * @param {object} forecast  parsed Open-Meteo JSON
 * @param {object} ctx
 * @param {Date|number|string} ctx.now  injected clock (keeps this pure/testable)
 * @param {object} [ctx.schoolContext]  user-set fields merged into the result
 */
export function mapForecastToEngineInput(forecast, { now, schoolContext = {} } = {}) {
  const hourly = forecast?.hourly || {};
  const units = forecast?.hourly_units || {};
  const daily = forecast?.daily || {};
  const times = hourly.time || [];

  const entries = times.map(parseEntry);
  const { morning, overnight, daytime, evening } = pickWindows(entries, now ?? new Date());

  const get = (arr, i) => (Array.isArray(arr) && Number.isFinite(arr[i]) ? arr[i] : null);

  const sumSnow = (idxs) =>
    idxs.reduce((s, e) => s + toInchesSnow(get(hourly.snowfall, e.i) ?? 0, units.snowfall), 0);
  const sumPrecip = (idxs) =>
    idxs.reduce((s, e) => s + (get(hourly.precipitation, e.i) ?? 0), 0);

  const overnightSnowIn = sumSnow(overnight);
  const morningSnowIn = sumSnow(morning);

  // The full event window we read conditions from = overnight + morning.
  const eventIdxs = [...overnight, ...morning];

  // Aggregate helpers over the event window.
  const minOf = (arr, conv) => {
    let m = Infinity;
    for (const e of eventIdxs) {
      const v = get(arr, e.i);
      if (v !== null) m = Math.min(m, conv ? conv(v) : v);
    }
    return Number.isFinite(m) ? m : null;
  };
  const maxOf = (arr, conv) => {
    let m = -Infinity;
    for (const e of eventIdxs) {
      const v = get(arr, e.i);
      if (v !== null) m = Math.max(m, conv ? conv(v) : v);
    }
    return Number.isFinite(m) ? m : null;
  };

  let lowTempF = minOf(hourly.temperature_2m, (v) => tempToF(v, units.temperature_2m));
  if (lowTempF === null) {
    const dmin = daily.temperature_2m_min;
    lowTempF = Array.isArray(dmin) && Number.isFinite(dmin[0]) ? dmin[0] : 30;
  }

  const windChillF = minOf(hourly.apparent_temperature, (v) =>
    tempToF(v, units.apparent_temperature)
  );
  const windGustMph = maxOf(hourly.windgusts_10m) ?? 0;
  const visibilityMi = minOf(hourly.visibility, (v) => visToMiles(v, units.visibility));
  const snowDepthIn = maxOf(hourly.snow_depth, (v) => depthToInches(v, units.snow_depth)) ?? 0;
  const precipProbRaw = maxOf(hourly.precipitation_probability);
  const precipProbability = precipProbRaw === null ? 0.5 : clamp(precipProbRaw / 100, 0, 1);

  // Ice risk: max of weather-code signal and a wintry-mix heuristic over the window.
  let iceRisk = 0;
  for (const e of eventIdxs) {
    const code = get(hourly.weathercode, e.i);
    if (code !== null) iceRisk = Math.max(iceRisk, iceFromWeatherCode(code));
    const precip = get(hourly.precipitation, e.i) ?? 0;
    const snow = toInchesSnow(get(hourly.snowfall, e.i) ?? 0, units.snowfall);
    const tF = tempToF(get(hourly.temperature_2m, e.i) ?? 32, units.temperature_2m);
    // Liquid-ish precip near freezing → potential ice.
    if (precip > 0.01 && snow < precip * 0.5 && tF >= 28 && tF <= 34) {
      iceRisk = Math.max(iceRisk, 0.6);
    }
  }

  // Storm timing = which window holds the heaviest precipitation.
  const buckets = {
    overnight: sumPrecip(overnight) + sumSnow(overnight),
    morning: sumPrecip(morning) + sumSnow(morning),
    daytime: sumPrecip(daytime) + sumSnow(daytime),
  };
  let stormTiming = "overnight";
  let best = -1;
  for (const k of ["overnight", "morning", "daytime"]) {
    if (buckets[k] > best) {
      best = buckets[k];
      stormTiming = k;
    }
  }

  // Peak hourly snow rate over the event window — a 1"/hr burst is far more
  // disruptive than the same total spread thinly, and plows can't keep up.
  let peakSnowRateInHr = 0;
  for (const e of eventIdxs) {
    peakSnowRateInHr = Math.max(
      peakSnowRateInHr,
      toInchesSnow(get(hourly.snowfall, e.i) ?? 0, units.snowfall)
    );
  }

  // Morning trend: is the snow ending before buses roll, or ramping up into the
  // commute? Compare average rates (overnight ≈ 11 h, commute = 4 h).
  const overnightRate = overnightSnowIn / Math.max(1, overnight.length);
  const morningRate = morningSnowIn / Math.max(1, morning.length);
  let morningTrend = "steady";
  if (overnightSnowIn >= 0.5 && morningRate < overnightRate * 0.25) {
    morningTrend = "improving"; // storm winding down before school start
  } else if (morningSnowIn >= 0.3 && morningRate > overnightRate * 1.5) {
    morningTrend = "worsening"; // ramping up right into the commute
  }

  // Refreeze risk: a wet prior evening followed by a below-freezing commute
  // leaves untreated black ice even with little or no new precipitation.
  let refreezeRisk = 0;
  const eveningWet = evening.reduce((s, e) => {
    const precip = get(hourly.precipitation, e.i) ?? 0;
    const snow = toInchesSnow(get(hourly.snowfall, e.i) ?? 0, units.snowfall);
    const tF = tempToF(get(hourly.temperature_2m, e.i) ?? 32, units.temperature_2m);
    // Count liquid-ish precipitation that fell above freezing (wet roads).
    return s + (tF > 33 && precip > snow * 0.5 ? precip : 0);
  }, 0);
  let morningMinF = Infinity;
  for (const e of morning) {
    const tF = tempToF(get(hourly.temperature_2m, e.i), units.temperature_2m);
    if (tF !== null) morningMinF = Math.min(morningMinF, tF);
  }
  if (Number.isFinite(morningMinF)) {
    if (eveningWet >= 0.15 && morningMinF <= 28) refreezeRisk = 0.8;
    else if (eveningWet >= 0.05 && morningMinF <= 30) refreezeRisk = 0.6;
  }

  return {
    overnightSnowIn,
    morningSnowIn,
    snowDepthIn,
    precipProbability,
    iceRisk: clamp(iceRisk, 0, 1),
    lowTempF,
    windChillF: windChillF === null ? lowTempF : windChillF,
    windGustMph,
    visibilityMi, // may be null → engine flags lower confidence
    stormTiming,
    morningTrend,
    peakSnowRateInHr,
    refreezeRisk: clamp(refreezeRisk, 0, 1),
    // user-controlled context (alerts merged in by the caller):
    hasWinterAlert: Boolean(schoolContext.hasWinterAlert),
    alertSeverity: schoolContext.alertSeverity ?? null,
    districtSensitivity: schoolContext.districtSensitivity ?? 0.5,
    areaType: schoolContext.areaType ?? "suburban",
    schoolType: schoolContext.schoolType ?? "high",
    snowDaysUsed: schoolContext.snowDaysUsed ?? 0,
    snowDaysAllowed: schoolContext.snowDaysAllowed ?? 5,
  };
}

/** Build the compact hourly timeline the UI renders (next ~18 hours). */
export function buildHourlyTimeline(forecast, { now, hours = 18 } = {}) {
  const hourly = forecast?.hourly || {};
  const units = forecast?.hourly_units || {};
  const times = hourly.time || [];
  const entries = times.map(parseEntry);
  const { dateStr, hour } = nowParts(now ?? new Date());

  // Start at the first entry at/after "now" (matched loosely by date+hour), else 0.
  let start = entries.findIndex((e) => e.date === dateStr && e.hour >= hour);
  if (start < 0) start = 0;

  const out = [];
  for (let k = start; k < Math.min(start + hours, entries.length); k++) {
    const i = entries[k].i;
    out.push({
      time: times[i],
      tempF: tempToF(hourly.temperature_2m?.[i], units.temperature_2m),
      snowIn: toInchesSnow(hourly.snowfall?.[i] ?? 0, units.snowfall),
      precipProb: hourly.precipitation_probability?.[i] ?? null,
      code: hourly.weathercode?.[i] ?? null,
    });
  }
  return out;
}
