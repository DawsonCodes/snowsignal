// Unit tests for the pure prediction engine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { predictSnowDay, hasMeaningfulWinterHazard } from "../js/engine.js";

// A neutral baseline scenario; helpers tweak one dimension at a time.
function baseInput(overrides = {}) {
  return {
    overnightSnowIn: 2,
    morningSnowIn: 0,
    snowDepthIn: 0,
    precipProbability: 0.6,
    iceRisk: 0,
    lowTempF: 28,
    windChillF: 22,
    windGustMph: 10,
    visibilityMi: 5,
    stormTiming: "overnight",
    hasWinterAlert: false,
    alertSeverity: null,
    districtSensitivity: 0.5,
    areaType: "suburban",
    schoolType: "high",
    snowDaysUsed: 0,
    snowDaysAllowed: 5,
    ...overrides,
  };
}

test("output is always within 0..100 and well-formed", () => {
  for (const ice of [0, 0.5, 1]) {
    for (const snow of [0, 5, 30]) {
      const r = predictSnowDay(baseInput({ iceRisk: ice, overnightSnowIn: snow }));
      assert.ok(r.closurePct >= 0 && r.closurePct <= 100);
      assert.ok(r.delayPct >= 0 && r.delayPct <= 100);
      assert.ok(["low", "medium", "high"].includes(r.confidence));
      assert.ok(Array.isArray(r.factors) && r.factors.length > 0);
      assert.equal(typeof r.recommendation, "string");
    }
  }
});

test("determinism: identical input yields identical output", () => {
  const a = predictSnowDay(baseInput({ iceRisk: 0.4, morningSnowIn: 2 }));
  const b = predictSnowDay(baseInput({ iceRisk: 0.4, morningSnowIn: 2 }));
  assert.deepEqual(a, b);
});

test("monotonic: more ice never lowers closure", () => {
  let prev = -1;
  for (const ice of [0, 0.25, 0.5, 0.75, 1]) {
    const pct = predictSnowDay(baseInput({ iceRisk: ice })).closurePct;
    assert.ok(pct >= prev, `ice=${ice} produced ${pct} < ${prev}`);
    prev = pct;
  }
});

test("monotonic: more morning-commute snow never lowers closure", () => {
  let prev = -1;
  for (const s of [0, 1, 2, 4, 8]) {
    const pct = predictSnowDay(baseInput({ morningSnowIn: s })).closurePct;
    assert.ok(pct >= prev, `morningSnow=${s} produced ${pct} < ${prev}`);
    prev = pct;
  }
});

test("ice is weighted more heavily than raw temperature", () => {
  const icy = predictSnowDay(baseInput({ iceRisk: 1, lowTempF: 30 }));
  const cold = predictSnowDay(baseInput({ iceRisk: 0, lowTempF: -10 }));
  assert.ok(
    icy.closurePct > cold.closurePct,
    `ice ${icy.closurePct}% should beat cold-only ${cold.closurePct}%`
  );
});

test("morning-commute snow outweighs the same snow at midday", () => {
  const morning = predictSnowDay(
    baseInput({ morningSnowIn: 3, overnightSnowIn: 0, stormTiming: "morning" })
  );
  const midday = predictSnowDay(
    baseInput({ morningSnowIn: 0, overnightSnowIn: 3, stormTiming: "daytime" })
  );
  assert.ok(morning.closurePct > midday.closurePct);
});

test("clear, calm day predicts a very low closure chance", () => {
  const r = predictSnowDay(
    baseInput({
      overnightSnowIn: 0,
      morningSnowIn: 0,
      precipProbability: 0.05,
      iceRisk: 0,
      lowTempF: 36,
      windChillF: 34,
    })
  );
  assert.ok(r.closurePct < 20, `expected low closure, got ${r.closurePct}`);
});

test("full-blown blizzard saturates near (but not over) 100", () => {
  const r = predictSnowDay(
    baseInput({
      overnightSnowIn: 18,
      morningSnowIn: 8,
      iceRisk: 0.9,
      windGustMph: 50,
      visibilityMi: 0.1,
      snowDepthIn: 14,
      precipProbability: 1,
      lowTempF: 5,
      windChillF: -20,
      hasWinterAlert: true,
      alertSeverity: "warning",
      areaType: "rural",
      schoolType: "elementary",
    })
  );
  assert.ok(r.closurePct >= 90 && r.closurePct <= 100);
});

test("colleges close far less readily than elementary schools", () => {
  const elem = predictSnowDay(baseInput({ overnightSnowIn: 6, schoolType: "elementary" }));
  const college = predictSnowDay(baseInput({ overnightSnowIn: 6, schoolType: "college" }));
  assert.ok(elem.closurePct > college.closurePct);
});

test("delay vs closure separation: morning storm favors a delay", () => {
  // Moderate snow that lands in the commute window and then eases.
  const r = predictSnowDay(
    baseInput({ overnightSnowIn: 1, morningSnowIn: 2, stormTiming: "morning" })
  );
  assert.ok(r.delayPct > r.closurePct, `delay ${r.delayPct} should exceed closure ${r.closurePct}`);
});

test("delay falls when closure is near-certain", () => {
  const huge = predictSnowDay(
    baseInput({ overnightSnowIn: 20, morningSnowIn: 8, iceRisk: 1, stormTiming: "overnight" })
  );
  assert.ok(huge.closurePct >= 90);
  assert.ok(huge.delayPct < 40, `delay should drop when closure is near-certain, got ${huge.delayPct}`);
});

test("confidence drops in the mushy middle", () => {
  // Tune to land mid-range, then confirm confidence is not 'high'.
  const r = predictSnowDay(baseInput({ overnightSnowIn: 4, morningSnowIn: 1, iceRisk: 0.15 }));
  if (r.closurePct >= 40 && r.closurePct <= 60) {
    assert.notEqual(r.confidence, "high");
  }
});

test("an alert agreeing with a high reading raises confidence", () => {
  const withAlert = predictSnowDay(
    baseInput({ overnightSnowIn: 10, iceRisk: 0.6, hasWinterAlert: true, alertSeverity: "warning" })
  );
  const without = predictSnowDay(
    baseInput({ overnightSnowIn: 10, iceRisk: 0.6, hasWinterAlert: false, alertSeverity: null })
  );
  assert.ok(withAlert.confidenceScore >= without.confidenceScore);
});

test("missing visibility lowers confidence, not the score to zero", () => {
  const known = predictSnowDay(baseInput({ visibilityMi: 5 }));
  const unknown = predictSnowDay(baseInput({ visibilityMi: null }));
  // Visibility of 5mi contributes 0 points anyway, so closure should match,
  // but the unknown case should not be MORE confident.
  assert.ok(unknown.confidenceScore <= known.confidenceScore);
  const visFactor = unknown.factors.find((f) => f.key === "visibility");
  assert.equal(visFactor.points, 0);
});

test("guards against NaN / missing fields without throwing", () => {
  assert.doesNotThrow(() => predictSnowDay({}));
  const r = predictSnowDay({ overnightSnowIn: "not a number", iceRisk: undefined });
  assert.ok(r.closurePct >= 0 && r.closurePct <= 100);
});

// --- Winter-weather plausibility gate ------------------------------------

// A genuinely warm, calm summer day: no snow, no ice, no alert, warm wind chill.
function warmDay(overrides = {}) {
  return baseInput({
    overnightSnowIn: 0,
    morningSnowIn: 0,
    snowDepthIn: 0,
    precipProbability: 0.1,
    iceRisk: 0,
    lowTempF: 68,
    windChillF: 70,
    windGustMph: 5,
    visibilityMi: 10,
    ...overrides,
  });
}

test("gate: warm summer weather with no winter hazard resolves to 0%", () => {
  const r = predictSnowDay(warmDay());
  assert.equal(r.closurePct, 0);
  assert.equal(r.delayPct, 0);
  assert.equal(r.gated, true);
  assert.match(r.gateReason, /winter-weather hazard/i);
});

test("gate: maxed-out district sensitivity alone cannot create risk", () => {
  const r = predictSnowDay(warmDay({ districtSensitivity: 1, schoolType: "elementary", areaType: "rural" }));
  assert.equal(r.closurePct, 0);
  assert.equal(r.delayPct, 0);
});

test("gate: warm-weather wind alone cannot create a snow-day risk", () => {
  const r = predictSnowDay(warmDay({ windGustMph: 60, windChillF: 65 }));
  assert.equal(r.closurePct, 0);
  assert.equal(r.delayPct, 0);
});

test("gate: real winter hazards still pass through", () => {
  assert.equal(hasMeaningfulWinterHazard(warmDay({ morningSnowIn: 1 })), true); // snow
  assert.equal(hasMeaningfulWinterHazard(warmDay({ iceRisk: 0.5 })), true); // ice
  assert.equal(
    hasMeaningfulWinterHazard(warmDay({ hasWinterAlert: true, alertSeverity: "warning" })),
    true
  ); // official alert
  assert.equal(hasMeaningfulWinterHazard(warmDay({ windChillF: -15 })), true); // dangerous cold
  const snowy = predictSnowDay(warmDay({ overnightSnowIn: 4, morningSnowIn: 3, lowTempF: 25 }));
  assert.equal(snowy.gated, false);
  assert.ok(snowy.closurePct > 0);
});

test("gate: an unusual out-of-season snow/ice event is NOT blocked by the month", () => {
  // The engine has no notion of the calendar — only the weather signals decide.
  const freakSnow = predictSnowDay(warmDay({ lowTempF: 30, overnightSnowIn: 3, morningSnowIn: 1 }));
  assert.equal(freakSnow.gated, false);
  assert.ok(freakSnow.closurePct > 0);
  const freakIce = predictSnowDay(warmDay({ lowTempF: 31, iceRisk: 0.7 }));
  assert.equal(freakIce.gated, false);
  assert.ok(freakIce.closurePct > 0);
});

test("factor breakdown exposes proportional bar data with categories", () => {
  const r = predictSnowDay(baseInput({ iceRisk: 0.5 }));
  const CATEGORIES = ["snow", "ice", "cold", "wind", "visibility", "alerts", "timing", "school"];
  for (const f of r.factors) {
    assert.equal(typeof f.key, "string");
    assert.equal(typeof f.label, "string");
    assert.equal(typeof f.points, "number");
    assert.ok(f.maxPoints > 0);
    assert.ok(["positive", "negative", "neutral"].includes(f.direction));
    assert.equal(typeof f.detail, "string");
    assert.ok(CATEGORIES.includes(f.category), `unknown category ${f.category}`);
  }
});

// --- v1 engine refinements -------------------------------------------------

test("refreeze risk raises closure, feeds delay, and passes the hazard gate", () => {
  const dry = predictSnowDay(baseInput({ overnightSnowIn: 0, morningSnowIn: 0, precipProbability: 0.2 }));
  const refreeze = predictSnowDay(
    baseInput({ overnightSnowIn: 0, morningSnowIn: 0, precipProbability: 0.2, refreezeRisk: 0.8 })
  );
  assert.ok(refreeze.closurePct > dry.closurePct, "refreeze adds closure risk");
  assert.ok(refreeze.delayPct > dry.delayPct, "black ice is a classic delay driver");
  // Wet-then-freezing roads alone are a real winter hazard (not gated to zero).
  assert.equal(hasMeaningfulWinterHazard({ lowTempF: 30, refreezeRisk: 0.6 }), true);
  assert.equal(hasMeaningfulWinterHazard({ lowTempF: 40, refreezeRisk: 0.2 }), false);
});

test("a storm improving before school lowers closure; worsening raises it", () => {
  const steady = predictSnowDay(baseInput({ overnightSnowIn: 4, morningTrend: "steady" }));
  const improving = predictSnowDay(baseInput({ overnightSnowIn: 4, morningTrend: "improving" }));
  const worsening = predictSnowDay(baseInput({ overnightSnowIn: 4, morningTrend: "worsening" }));
  assert.ok(improving.closurePct < steady.closurePct, "improving trend reduces closure");
  assert.ok(worsening.closurePct > steady.closurePct, "worsening trend increases closure");
  // Improving before school start is the textbook 2-hour-delay setup.
  assert.ok(improving.delayPct >= steady.delayPct, "improving trend favors a delay");
});

test("trend has no effect on a clear day (gated by storm presence)", () => {
  const clear = { overnightSnowIn: 0, morningSnowIn: 0, iceRisk: 0, precipProbability: 0.1, lowTempF: 20, windChillF: 12 };
  const a = predictSnowDay(baseInput({ ...clear, morningTrend: "worsening" }));
  const b = predictSnowDay(baseInput({ ...clear, morningTrend: "steady" }));
  assert.equal(a.closurePct, b.closurePct);
});

test("heavy snowfall bursts score higher than the same total spread thin", () => {
  const thin = predictSnowDay(baseInput({ overnightSnowIn: 3, peakSnowRateInHr: 0.2 }));
  const burst = predictSnowDay(baseInput({ overnightSnowIn: 3, peakSnowRateInHr: 1.2 }));
  assert.ok(burst.closurePct > thin.closurePct);
});

test("confidence drops when precip type is ambiguous near freezing", () => {
  // Same partial ice signal, differing ONLY in temperature: unambiguous cold vs
  // hovering right at the freezing line. Inputs are tuned so both land in the
  // same closure band (30–40%), isolating the ambiguity term.
  const scenario = { overnightSnowIn: 0.55, iceRisk: 0.4, windChillF: 26 };
  const coldSnow = predictSnowDay(baseInput({ ...scenario, lowTempF: 20 }));
  const nearFreezing = predictSnowDay(baseInput({ ...scenario, lowTempF: 32 }));
  assert.ok(coldSnow.closurePct >= 30 && coldSnow.closurePct < 40, `cold ${coldSnow.closurePct}`);
  assert.ok(nearFreezing.closurePct >= 30 && nearFreezing.closurePct < 40, `near ${nearFreezing.closurePct}`);
  assert.ok(nearFreezing.confidenceScore < coldSnow.confidenceScore);
});

test("several strong agreeing signals raise confidence", () => {
  const weak = predictSnowDay(baseInput({ overnightSnowIn: 2 }));
  const strong = predictSnowDay(
    baseInput({
      overnightSnowIn: 12,
      morningSnowIn: 3,
      iceRisk: 0.6,
      hasWinterAlert: true,
      alertSeverity: "warning",
      precipProbability: 1,
    })
  );
  assert.ok(strong.confidenceScore > weak.confidenceScore);
});

test("drivers list the top plain-language reasons, empty when gated", () => {
  const storm = predictSnowDay(
    baseInput({ overnightSnowIn: 8, morningSnowIn: 3, iceRisk: 0.5, schoolType: "college" })
  );
  assert.ok(Array.isArray(storm.drivers));
  assert.ok(storm.drivers.length >= 2 && storm.drivers.length <= 4);
  for (const d of storm.drivers) assert.equal(typeof d, "string");
  // The biggest risk-reducer (college) is surfaced too.
  assert.ok(storm.drivers.some((d) => /college/i.test(d)), "includes the top reducer");

  const gated = predictSnowDay(warmDay());
  assert.deepEqual(gated.drivers, []);
});
