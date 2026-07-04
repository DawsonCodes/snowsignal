// Tests for the Open-Meteo -> engine-input mapping and the NWS alert summarizer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mapForecastToEngineInput, buildHourlyTimeline } from "../js/weather.js";
import { summarizeWinterAlerts, EMPTY_ALERTS } from "../js/alerts.js";
import { predictSnowDay } from "../js/engine.js";

const load = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

const snowstorm = load("openmeteo-snowstorm.json");
const icestorm = load("openmeteo-icestorm.json");
const clear = load("openmeteo-clear.json");
const nwsAlert = load("nws-alert-winter.json");

// A fixed clock on the evening of 2026-01-09, so the target morning is 2026-01-10.
const EVENING = new Date("2026-01-09T20:00:00");

test("snowstorm fixture: snow buckets into overnight + morning windows", () => {
  const input = mapForecastToEngineInput(snowstorm, { now: EVENING });
  assert.ok(input.overnightSnowIn > 3, `overnight snow ${input.overnightSnowIn}`);
  assert.ok(input.morningSnowIn > 3, `morning snow ${input.morningSnowIn}`);
  assert.equal(input.stormTiming, "overnight"); // heaviest precip is overnight
});

test("snowstorm fixture: units converted (snow inch, visibility miles, depth inch)", () => {
  const input = mapForecastToEngineInput(snowstorm, { now: EVENING });
  // visibility 400m -> ~0.25mi (well under a mile)
  assert.ok(input.visibilityMi !== null && input.visibilityMi < 1);
  // snow_depth 0.15m -> ~5.9in
  assert.ok(input.snowDepthIn > 4 && input.snowDepthIn < 8);
  // gusts read straight through (mph)
  assert.ok(input.windGustMph >= 30);
  // low temp stays in Fahrenheit range
  assert.ok(input.lowTempF < 20);
});

test("snowstorm maps to a high closure probability end-to-end", () => {
  const input = mapForecastToEngineInput(snowstorm, {
    now: EVENING,
    schoolContext: { schoolType: "elementary", areaType: "rural" },
  });
  const result = predictSnowDay(input);
  assert.ok(result.closurePct >= 70, `closure ${result.closurePct}`);
});

test("icestorm fixture: ice risk detected and timing is morning", () => {
  const input = mapForecastToEngineInput(icestorm, { now: EVENING });
  assert.ok(input.iceRisk >= 0.8, `ice risk ${input.iceRisk}`); // weathercode 66
  assert.equal(input.stormTiming, "morning");
  assert.ok(input.morningSnowIn < 0.1); // freezing rain, not snow
});

test("clear fixture: near-zero closure", () => {
  const input = mapForecastToEngineInput(clear, { now: EVENING });
  const result = predictSnowDay(input);
  assert.ok(result.closurePct < 15, `closure ${result.closurePct}`);
});

test("missing visibility maps to null (not zero)", () => {
  const noVis = JSON.parse(JSON.stringify(clear));
  noVis.hourly.visibility = noVis.hourly.visibility.map(() => null);
  const input = mapForecastToEngineInput(noVis, { now: EVENING });
  assert.equal(input.visibilityMi, null);
});

test("timezone/date mismatch falls back to first morning without throwing", () => {
  // A 'now' far outside the fixture's date range.
  const input = mapForecastToEngineInput(snowstorm, { now: new Date("2030-03-03T20:00:00") });
  assert.ok(Number.isFinite(input.overnightSnowIn));
  assert.ok(Number.isFinite(input.morningSnowIn));
});

test("determinism: same forecast + same now => identical mapping", () => {
  const a = mapForecastToEngineInput(snowstorm, { now: EVENING });
  const b = mapForecastToEngineInput(snowstorm, { now: EVENING });
  assert.deepEqual(a, b);
});

test("hourly timeline returns capped, well-formed entries", () => {
  const timeline = buildHourlyTimeline(snowstorm, { now: EVENING, hours: 12 });
  assert.ok(timeline.length > 0 && timeline.length <= 12);
  for (const h of timeline) {
    assert.equal(typeof h.time, "string");
    assert.ok(h.tempF === null || Number.isFinite(h.tempF));
    assert.ok(Number.isFinite(h.snowIn));
  }
});

// --- v1 mapping refinements -------------------------------------------------

/** Build a minimal 2-day hourly forecast (inch units) with per-hour overrides. */
function syntheticForecast(overrides = {}) {
  const time = [];
  for (const day of ["2026-01-09", "2026-01-10"]) {
    for (let h = 0; h < 24; h++) time.push(`${day}T${String(h).padStart(2, "0")}:00`);
  }
  const zeros = () => time.map(() => 0);
  const hourly = {
    time,
    snowfall: zeros(),
    precipitation: zeros(),
    precipitation_probability: time.map(() => 50),
    temperature_2m: time.map(() => 30),
    apparent_temperature: time.map(() => 25),
    windspeed_10m: zeros(),
    windgusts_10m: zeros(),
    visibility: time.map(() => 16000),
    snow_depth: zeros(),
    weathercode: time.map(() => 3),
  };
  for (const [field, byTime] of Object.entries(overrides)) {
    for (const [iso, value] of Object.entries(byTime)) {
      const i = time.indexOf(iso);
      if (i >= 0) hourly[field][i] = value;
    }
  }
  return {
    hourly,
    hourly_units: { snowfall: "inch", precipitation: "inch", temperature_2m: "°F", visibility: "m", snow_depth: "m" },
    daily: { temperature_2m_min: [28, 28] },
  };
}

test("boundary hours are not double-counted across windows", () => {
  // Snow ONLY in the 5 AM hour → it belongs to the commute window, not overnight.
  const f = syntheticForecast({ snowfall: { "2026-01-10T05:00": 1.0 } });
  const input = mapForecastToEngineInput(f, { now: EVENING });
  assert.equal(input.morningSnowIn, 1.0);
  assert.equal(input.overnightSnowIn, 0);
});

test("peak snow rate reports the heaviest single hour", () => {
  const f = syntheticForecast({
    snowfall: { "2026-01-10T02:00": 0.3, "2026-01-10T03:00": 1.1, "2026-01-10T06:00": 0.4 },
  });
  const input = mapForecastToEngineInput(f, { now: EVENING });
  assert.equal(input.peakSnowRateInHr, 1.1);
});

test("morning trend: storm ending overnight reads as improving", () => {
  const f = syntheticForecast({
    snowfall: { "2026-01-09T20:00": 1.5, "2026-01-09T22:00": 1.5, "2026-01-10T00:00": 1.0 },
  });
  const input = mapForecastToEngineInput(f, { now: EVENING });
  assert.equal(input.morningTrend, "improving");
});

test("morning trend: snow ramping into the commute reads as worsening", () => {
  const f = syntheticForecast({
    snowfall: { "2026-01-10T02:00": 0.1, "2026-01-10T06:00": 0.8, "2026-01-10T07:00": 0.9 },
  });
  const input = mapForecastToEngineInput(f, { now: EVENING });
  assert.equal(input.morningTrend, "worsening");
});

test("refreeze risk: evening rain then a hard-freezing commute", () => {
  const f = syntheticForecast({
    precipitation: { "2026-01-09T17:00": 0.15, "2026-01-09T18:00": 0.1 },
    temperature_2m: {
      "2026-01-09T17:00": 41,
      "2026-01-09T18:00": 39,
      "2026-01-10T05:00": 26,
      "2026-01-10T06:00": 25,
      "2026-01-10T07:00": 26,
      "2026-01-10T08:00": 27,
    },
  });
  const input = mapForecastToEngineInput(f, { now: EVENING });
  assert.ok(input.refreezeRisk >= 0.6, `refreezeRisk ${input.refreezeRisk}`);
  // A dry evening produces no refreeze risk even with a cold morning.
  const dry = syntheticForecast({ temperature_2m: { "2026-01-10T06:00": 25 } });
  assert.equal(mapForecastToEngineInput(dry, { now: EVENING }).refreezeRisk, 0);
});

test("summarizeWinterAlerts picks the most severe winter event, filters non-winter", () => {
  const summary = summarizeWinterAlerts(nwsAlert);
  assert.equal(summary.hasWinterAlert, true);
  assert.equal(summary.alertSeverity, "warning"); // Winter Storm Warning
  assert.match(summary.headline, /Winter Storm Warning/);
});

test("summarizeWinterAlerts returns EMPTY for no winter alerts", () => {
  assert.deepEqual(summarizeWinterAlerts({ features: [] }), EMPTY_ALERTS);
  assert.deepEqual(summarizeWinterAlerts(null), EMPTY_ALERTS);
});
