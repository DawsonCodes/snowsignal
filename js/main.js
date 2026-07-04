// main.js
// Thin orchestrator: wires DOM events → geocode/weather/alerts → engine → ui.
// Holds the small amount of app state; all business logic lives in the modules.

import { predictSnowDay } from "./engine.js";
import { searchPlaces, findPlace, isUnitedStates, reverseGeocode } from "./geocode.js";
import { fetchForecast, mapForecastToEngineInput, buildHourlyTimeline } from "./weather.js";
import { fetchWinterAlerts, EMPTY_ALERTS } from "./alerts.js";
import { getCurrentPosition } from "./geolocation.js";
import { formatPlaceLabel, formatTemp, formatInches, formatLocalDate, formatUpdatedAt } from "./format.js";
import {
  getSettings,
  saveSettings,
  resetSchoolSettings,
  resetPreferences,
  getSavedLocations,
  saveLocation,
  removeLocation,
  clearSavedLocations,
  getRecentSearches,
  addRecentSearch,
  clearRecentSearches,
  getCachedForecast,
  setCachedForecast,
  getEstimateCount,
  incrementEstimateCount,
  resetEstimateCount,
} from "./storage.js";
import { readUrlState, buildShareUrl } from "./urlState.js";
import {
  getCalendarNotices,
  describeForecastWindow,
  forecastTargetDate,
} from "./calendarContext.js";
import { applyAtmosphere } from "./atmosphere.js";
import { resolvePaletteSeason, resolvePaletteHue, daypartFromHour } from "./palette.js";
import * as ui from "./ui.js";

const { $ } = ui;

const APP_VERSION = "1.0.0-beta.4";

// The last user action, so the error-state Retry button can re-run it.
let lastAction = null;

/** Map raw/unknown errors to a friendly, non-technical message. */
function friendlyError(err, fallback) {
  const msg = err && err.message ? String(err.message) : "";
  // Our own modules already throw friendly text; only mask low-level network noise.
  if (/failed to fetch|networkerror|load failed|fetch/i.test(msg)) {
    return "We couldn’t reach the weather service. Check your connection and try again.";
  }
  return msg || fallback;
}

// --- App state -----------------------------------------------------------
const state = {
  settings: getSettings(),
  place: null, // { name, admin1, country_code, latitude, longitude }
  forecast: null, // raw Open-Meteo payload
  alert: EMPTY_ALERTS,
  fetchedAt: null,
  fromCache: false,
  result: null,
};

let searchAbort = null;
let suggestionPlaces = [];
let activeSuggestion = -1;

// --- Settings <-> controls ----------------------------------------------

function applySettings() {
  ui.applyTheme(state.settings.theme);
  ui.applyMotion(state.settings.reducedMotion);

  // School context controls
  $("school-type").value = state.settings.schoolType;
  $("area-type").value = state.settings.areaType;
  $("sensitivity").value = String(state.settings.districtSensitivity);
  $("days-used").value = String(state.settings.snowDaysUsed);
  $("days-allowed").value = String(state.settings.snowDaysAllowed);
  updateSensitivityOutput();
  validateDays();

  // Settings dialog controls
  setRadio("theme", state.settings.theme);
  setRadio("palette", state.settings.seasonalPalette);
  setRadio("atmosphere", state.settings.atmosphere);
  setRadio("temp-unit", state.settings.tempUnit);
  setRadio("reduced-motion", state.settings.reducedMotion);

  applyPaletteNow(); // resolves the accent hue, daypart, badge, slider, empty icon
  applyAtmosphereNow();
}

/**
 * Resolve and apply the seasonal palette: accent hue (via the Custom slider or a
 * season preset), the time-of-day ambient intensity (Auto only), the read-only
 * Auto badge, the hue-slider reflection, and the empty-state seasonal icon.
 */
function applyPaletteNow() {
  const palette = state.settings.seasonalPalette;
  const lat = state.place ? state.place.latitude : null;
  const now = locationNow(state.forecast); // browser clock until a forecast loads
  const season = resolvePaletteSeason({ palette, lat, date: now });
  const hue = resolvePaletteHue({ palette, accentHue: state.settings.accentHue, lat, date: now });

  ui.applyAccent(hue);
  $("accent-hue").value = String(Math.round(hue)); // reflect resolved hue on the slider

  // Subtle time-of-day ambient intensity, only under the Auto palette.
  const root = document.documentElement;
  if (palette === "auto") root.setAttribute("data-daypart", daypartFromHour(now.getHours()));
  else root.removeAttribute("data-daypart");

  ui.updatePaletteBadge(palette, season);
  // Decorative empty-state icon: use the resolved season, or the location/date
  // season when on a Custom palette.
  ui.setEmptyIcon(season || resolvePaletteSeason({ palette: "auto", lat, date: now }));
}

function setRadio(name, value) {
  const el = document.querySelector(`input[name="${name}"][value="${value}"]`);
  if (el) el.checked = true;
}

function updateSensitivityOutput() {
  const v = Number($("sensitivity").value);
  const label = v >= 0.66 ? "Closes readily" : v <= 0.34 ? "Rarely closes" : "Average";
  $("sensitivity-out").textContent = label;
}

/**
 * Validate the snow-day number inputs: no negatives, capped at a sane maximum.
 * "Used" is allowed to exceed "allowed" (it happens in real districts) — we just
 * surface an explanatory note. Returns the cleaned values.
 */
function validateDays() {
  const clampInt = (id, max) => {
    const el = $(id);
    let v = Math.round(Number(el.value));
    if (!Number.isFinite(v)) v = 0;
    v = Math.max(0, Math.min(max, v));
    el.value = String(v);
    return v;
  };
  const used = clampInt("days-used", 60);
  const allowed = clampInt("days-allowed", 60);
  const note = $("days-note");
  if (used > allowed) {
    note.textContent =
      "Used snow days exceed the district allowance. This may make the district more reluctant to close.";
    note.hidden = false;
  } else {
    note.hidden = true;
  }
  return { used, allowed };
}

function gatherSchoolContext() {
  return {
    schoolType: $("school-type").value,
    areaType: $("area-type").value,
    districtSensitivity: Number($("sensitivity").value),
    snowDaysUsed: Number($("days-used").value) || 0,
    snowDaysAllowed: Number($("days-allowed").value) || 0,
    hasWinterAlert: state.alert.hasWinterAlert,
    alertSeverity: state.alert.alertSeverity,
  };
}

function persistSchoolContext() {
  state.settings = saveSettings({
    schoolType: $("school-type").value,
    areaType: $("area-type").value,
    districtSensitivity: Number($("sensitivity").value),
    snowDaysUsed: Number($("days-used").value) || 0,
    snowDaysAllowed: Number($("days-allowed").value) || 0,
  });
}

// --- Seasonal atmosphere + calendar notices ------------------------------

function applyAtmosphereNow() {
  applyAtmosphere({
    pref: state.settings.atmosphere,
    theme: ui.resolvedTheme(),
    lat: state.place ? state.place.latitude : null,
    date: new Date(),
    motionAllowed: ui.motionAllowed(state.settings.reducedMotion),
  });
}

function refreshScheduleContext() {
  // Schedule reminders stay hidden until a location/result exists.
  if (!state.place) {
    ui.renderCalendarNotices([]);
    return;
  }
  const now = locationNow(state.forecast);
  ui.renderCalendarNotices(
    getCalendarNotices({
      date: forecastTargetDate(now),
      lat: state.place.latitude,
    })
  );
}

/**
 * A Date whose browser-local fields read as the *location's* wall-clock time,
 * using the forecast's reported UTC offset. Falls back to the browser clock.
 */
function locationNow(forecast) {
  const off = forecast && Number.isFinite(forecast.utc_offset_seconds)
    ? forecast.utc_offset_seconds
    : null;
  if (off === null) return new Date();
  return new Date(Date.now() + off * 1000 + new Date().getTimezoneOffset() * 60000);
}

/** Build the compact Weather details rows from data already fetched (no invented values). */
function buildWeatherRows(forecast, input, timeline, unit, now) {
  const rows = [];
  const cur = timeline[0] ? timeline[0].tempF : null;
  if (Number.isFinite(cur)) rows.push({ label: "Now", value: formatTemp(cur, unit) });
  rows.push({ label: "Overnight low", value: formatTemp(input.lowTempF, unit) });
  const daily = forecast && forecast.daily ? forecast.daily : {};
  const idx = now.getHours() >= 11 ? 1 : 0;
  const highs = daily.temperature_2m_max;
  if (Array.isArray(highs) && Number.isFinite(highs[Math.min(idx, highs.length - 1)])) {
    rows.push({ label: "Daytime high", value: formatTemp(highs[Math.min(idx, highs.length - 1)], unit) });
  }
  rows.push({ label: "Window snowfall", value: formatInches(input.overnightSnowIn + input.morningSnowIn) });
  if (input.windGustMph > 0) rows.push({ label: "Wind gusts", value: `${Math.round(input.windGustMph)} mph` });
  if (Number.isFinite(input.snowDepthIn) && input.snowDepthIn >= 0.1) {
    rows.push({ label: "Snow on ground", value: formatInches(input.snowDepthIn) });
  }
  rows.push({
    label: "Winter alert",
    value: state.alert.hasWinterAlert ? state.alert.event || "Active" : "None active",
  });
  return rows;
}

// --- Core: load a place and predict -------------------------------------

async function loadPlace(place) {
  lastAction = () => loadPlace(place);
  state.place = place;
  ui.closeSuggestions();
  $("location").value = formatPlaceLabel(place);
  ui.showSkeleton();
  applyAtmosphereNow(); // hemisphere may flip the auto season
  applyPaletteNow(); // auto palette/season follows the new location

  const lat = place.latitude;
  const lon = place.longitude;

  try {
    // Forecast: use a fresh fetch, fall back to cache (also enables offline).
    const cached = getCachedForecast(lat, lon);
    let forecast;
    let fromCache = false;
    let fetchedAt = Date.now();

    // Kick off alerts in parallel (US only); never blocks or throws.
    const alertsPromise = isUnitedStates(place)
      ? fetchWinterAlerts(lat, lon, { signal: timeoutSignal(4000) })
      : Promise.resolve(EMPTY_ALERTS);

    try {
      forecast = await fetchForecast(lat, lon);
      setCachedForecast(lat, lon, forecast);
    } catch (netErr) {
      if (cached) {
        forecast = cached.payload;
        fromCache = true;
        fetchedAt = cached.fetchedAt;
      } else {
        throw netErr;
      }
    }

    state.forecast = forecast;
    state.fetchedAt = fetchedAt;
    state.fromCache = fromCache;
    state.alert = await alertsPromise;

    ui.renderAlertBanner(state.alert);
    applyPaletteNow(); // daypart can now use the location's local time
    refreshScheduleContext(); // now that a location exists
    recompute({ entrance: true }); // fresh forecast → full entrance animation

    // Count only successful forecast results, on this device.
    incrementEstimateCount();
    ui.setEstimateCounter(getEstimateCount());

    addRecentSearch({
      query: $("location").value,
      name: formatPlaceLabel(place),
      lat,
      lon,
    });
    refreshQuickLists();
  } catch (err) {
    ui.showError(friendlyError(err, "Something went wrong. Please try again."));
  }
}

/**
 * Recompute the prediction from the cached forecast.
 * @param {{entrance?:boolean}} [opts]  entrance:true only after a NEW forecast,
 *   so settings/scoring tweaks update values in place without replaying animations.
 */
function recompute({ entrance = false } = {}) {
  if (!state.forecast) return;
  const now = locationNow(state.forecast);
  const tz = state.forecast.timezone;
  const input = mapForecastToEngineInput(state.forecast, {
    now,
    schoolContext: gatherSchoolContext(),
  });
  const result = predictSnowDay(input);
  state.result = result;

  const unit = state.settings.tempUnit;
  const timeline = buildHourlyTimeline(state.forecast, { now, hours: 18 });
  const targetDate = forecastTargetDate(now);

  ui.renderResult(result, {
    placeLabel: formatPlaceLabel(state.place),
    unit,
    timeline,
    weatherRows: buildWeatherRows(state.forecast, input, timeline, unit, now),
    fetchedAt: state.fetchedAt,
    fromCache: state.fromCache,
    forecastWindow: describeForecastWindow(now),
    dateLabel: `Forecast for ${formatLocalDate(targetDate)}`,
    updatedLabel: formatUpdatedAt(state.fetchedAt, tz),
    entrance,
    animate: ui.motionAllowed(state.settings.reducedMotion),
  });
  updateSaveButton();

  // On a fresh forecast, collapse Weather details on small screens, expand on wide.
  if (entrance) {
    const wd = $("weather-details");
    if (wd && window.matchMedia) wd.open = window.matchMedia("(min-width: 900px)").matches;
  }

  if (entrance && result.closurePct >= 85 && ui.motionAllowed(state.settings.reducedMotion)) {
    ui.launchConfetti();
  }
}

// --- Search / suggestions -----------------------------------------------

let searchTimer = null;
function onSearchInput() {
  const query = $("location").value.trim();
  if (searchTimer) clearTimeout(searchTimer);
  if (query.length < 2) {
    ui.closeSuggestions();
    return;
  }
  searchTimer = setTimeout(async () => {
    if (searchAbort) searchAbort.abort();
    searchAbort = new AbortController();
    try {
      suggestionPlaces = await searchPlaces(query, { signal: searchAbort.signal });
      activeSuggestion = -1;
      ui.renderSuggestions(suggestionPlaces, {
        onSelect: loadPlace,
        formatLabel: formatPlaceLabel,
      });
    } catch (err) {
      if (err.name !== "AbortError") ui.closeSuggestions();
    }
  }, 350);
}

function onSearchKeydown(e) {
  if ($("suggestions").hidden) {
    if (e.key === "Enter") {
      e.preventDefault();
      submitSearch();
    }
    return;
  }
  const items = $("suggestions").querySelectorAll("li");
  if (e.key === "ArrowDown") {
    e.preventDefault();
    activeSuggestion = Math.min(activeSuggestion + 1, items.length - 1);
    highlightSuggestion(items);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    activeSuggestion = Math.max(activeSuggestion - 1, 0);
    highlightSuggestion(items);
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (activeSuggestion >= 0 && suggestionPlaces[activeSuggestion]) {
      loadPlace(suggestionPlaces[activeSuggestion]);
    } else {
      submitSearch();
    }
  } else if (e.key === "Escape") {
    ui.closeSuggestions();
  }
}

function highlightSuggestion(items) {
  items.forEach((li, i) => li.setAttribute("aria-selected", String(i === activeSuggestion)));
  const input = $("location");
  if (activeSuggestion >= 0) input.setAttribute("aria-activedescendant", `suggestion-${activeSuggestion}`);
}

async function submitSearch() {
  const query = $("location").value.trim();
  if (!query) return;
  lastAction = submitSearch;
  ui.closeSuggestions();
  ui.showSkeleton();
  try {
    const place = await findPlace(query);
    await loadPlace(place);
  } catch (err) {
    ui.showError(friendlyError(err, "No matching location found."));
  }
}

// --- Geolocation ---------------------------------------------------------

async function useMyLocation() {
  lastAction = useMyLocation;
  ui.showSkeleton();
  try {
    const { lat, lon } = await getCurrentPosition();
    // Reverse-geocode to a friendly label; keep exact coords for the forecast.
    let place;
    try {
      place = await reverseGeocode(lat, lon, { signal: timeoutSignal(4000) });
    } catch {
      place = { name: `${lat.toFixed(2)}, ${lon.toFixed(2)}`, latitude: lat, longitude: lon };
    }
    await loadPlace(place);
  } catch (err) {
    ui.showError(friendlyError(err, "Couldn’t get your location."));
  }
}

// --- Quick lists (saved + recent) ---------------------------------------

function refreshQuickLists() {
  ui.renderSavedLocations(getSavedLocations(), {
    onSelect: (loc) => loadPlace(toPlace(loc)),
    onRemove: (id) => {
      removeLocation(id);
      refreshQuickLists();
      updateSaveButton();
    },
  });
  ui.renderRecentSearches(getRecentSearches(), {
    onSelect: (item) => loadPlace(toPlace(item)),
  });
}

const toPlace = (o) => ({
  name: o.name || o.label,
  latitude: o.lat ?? o.latitude,
  longitude: o.lon ?? o.longitude,
  admin1: o.admin1,
  country_code: o.country_code,
});

function updateSaveButton() {
  if (!state.place) return;
  const id = `${state.place.latitude.toFixed(3)},${state.place.longitude.toFixed(3)}`;
  const saved = getSavedLocations().some((l) => l.id === id);
  $("save-btn-label").textContent = saved ? "Saved" : "Save location";
}

function onSaveLocation() {
  if (!state.place) return;
  saveLocation({
    label: formatPlaceLabel(state.place),
    name: state.place.name,
    lat: state.place.latitude,
    lon: state.place.longitude,
    admin1: state.place.admin1,
    country_code: state.place.country_code,
  });
  refreshQuickLists();
  updateSaveButton();
  ui.toast("Location saved");
}

// --- Copy summary + share link ------------------------------------------

function buildSummary() {
  const r = state.result;
  const place = formatPlaceLabel(state.place);
  const lines = [
    `SnowSignal — snow day & delay estimate${place ? ` for ${place}` : ""}:`,
    `• Chance school is closed: ${r.closurePct}%`,
    `• Chance of a 2-hour delay: ${r.delayPct}%`,
    `• Confidence: ${r.confidence}`,
    `• ${r.recommendation}`,
  ];
  return `${lines.join("\n")}\n\nKnow before the bell · ${buildShareUrl(currentShareState())}`;
}

async function copyText(text, okMsg) {
  try {
    await navigator.clipboard.writeText(text);
    ui.toast(okMsg);
  } catch {
    ui.toast("Copy failed — select and copy manually");
  }
}

async function onCopySummary() {
  if (!state.result) return;
  await copyText(buildSummary(), "Summary copied to clipboard");
}

async function onCopyShareLink() {
  if (!state.place) return;
  await copyText(buildShareUrl(currentShareState()), "Share link copied to clipboard");
}

// --- Share-state assembly (used ONLY for explicit share actions) ---------

function currentShareState() {
  const s = {
    school: state.settings.schoolType,
    area: state.settings.areaType,
    sens: Number($("sensitivity").value),
    used: Number($("days-used").value) || 0,
    allowed: Number($("days-allowed").value) || 0,
    unit: state.settings.tempUnit,
  };
  if (state.place) {
    s.lat = state.place.latitude;
    s.lon = state.place.longitude;
    s.loc = state.place.name;
  }
  return s;
}

// --- Settings dialog -----------------------------------------------------

function wireSettings() {
  $("settings-toggle").addEventListener("click", ui.openSettings);
  $("settings-close").addEventListener("click", ui.closeSettings);
  $("settings-panel").addEventListener("click", (e) => {
    if (e.target === $("settings-panel")) ui.closeSettings();
  });

  // Presentation-only changes (theme/atmosphere/accent/motion) never replay the
  // result entrance — they apply directly without calling recompute().
  document.querySelectorAll('input[name="theme"]').forEach((r) =>
    r.addEventListener("change", () => {
      if (r.checked) {
        state.settings = saveSettings({ theme: r.value });
        ui.applyTheme(r.value); // also refreshes the System-detected badge
        applyAtmosphereNow(); // atmosphere tints adapt to the new theme
      }
    })
  );
  document.querySelectorAll('input[name="atmosphere"]').forEach((r) =>
    r.addEventListener("change", () => {
      if (r.checked) {
        state.settings = saveSettings({ atmosphere: r.value });
        applyAtmosphereNow();
      }
    })
  );
  document.querySelectorAll('input[name="temp-unit"]').forEach((r) =>
    r.addEventListener("change", () => {
      if (r.checked) {
        state.settings = saveSettings({ tempUnit: r.value });
        recompute({ entrance: false }); // re-format values, no animation replay
      }
    })
  );
  document.querySelectorAll('input[name="reduced-motion"]').forEach((r) =>
    r.addEventListener("change", () => {
      if (r.checked) {
        state.settings = saveSettings({ reducedMotion: r.value });
        ui.applyMotion(r.value);
        applyAtmosphereNow(); // particles are gated by motion
      }
    })
  );

  // Seasonal palette pills.
  document.querySelectorAll('input[name="palette"]').forEach((r) =>
    r.addEventListener("change", () => {
      if (r.checked) {
        state.settings = saveSettings({ seasonalPalette: r.value });
        applyPaletteNow(); // presentation only — no result re-render
      }
    })
  );

  // Accent hue: live preview on input; adjusting it switches the palette to Custom.
  $("accent-hue").addEventListener("input", () => ui.applyAccent(Number($("accent-hue").value)));
  $("accent-hue").addEventListener("change", () => {
    const hue = Number($("accent-hue").value);
    state.settings = saveSettings({ seasonalPalette: "custom", accentHue: hue });
    setRadio("palette", "custom");
    applyPaletteNow();
  });
  $("accent-reset").addEventListener("click", () => {
    // Reset restores the Auto seasonal palette and the brand hue.
    state.settings = saveSettings({ seasonalPalette: "auto", accentHue: null });
    setRadio("palette", "auto");
    applyPaletteNow();
    ui.toast("Palette reset to Auto");
  });

  // Data actions (destructive → confirm, then toast).
  $("clear-recent").addEventListener("click", () => {
    if (!confirm("Clear your recent locations?")) return;
    clearRecentSearches();
    refreshQuickLists();
    ui.toast("Recent locations cleared");
  });
  $("clear-saved").addEventListener("click", () => {
    if (!confirm("Clear your saved locations?")) return;
    clearSavedLocations();
    refreshQuickLists();
    updateSaveButton();
    ui.toast("Saved locations cleared");
  });
  $("reset-school").addEventListener("click", () => {
    if (!confirm("Reset school settings to their defaults?")) return;
    state.settings = resetSchoolSettings();
    applySettings();
    recompute({ entrance: false });
    ui.toast("School settings reset");
  });
  $("reset-counter").addEventListener("click", () => {
    if (!confirm("Reset the local estimate counter?")) return;
    resetEstimateCount();
    ui.setEstimateCounter(0);
    ui.toast("Estimate counter reset");
  });
  $("reset-prefs").addEventListener("click", () => {
    if (!confirm("Reset all preferences to defaults? Your saved and recent locations are kept.")) return;
    state.settings = resetPreferences();
    applySettings();
    recompute({ entrance: false });
    ui.toast("Preferences reset");
  });

  // Quick header toggle switches between rendered Light and Dark modes only.
  $("theme-toggle").addEventListener("click", () => {
    const next = ui.resolvedTheme() === "dark" ? "light" : "dark";
    state.settings = saveSettings({ theme: next });
    ui.applyTheme(next);
    setRadio("theme", next);
    applyAtmosphereNow();
  });

  ui.initSettingsTabs();
}

// --- Wire context controls ----------------------------------------------

function wireContext() {
  // Scoring inputs update the values smoothly (entrance:false) — no full replay.
  ["school-type", "area-type"].forEach((id) =>
    $(id).addEventListener("change", () => {
      persistSchoolContext();
      recompute({ entrance: false });
    })
  );
  $("sensitivity").addEventListener("input", () => {
    updateSensitivityOutput();
    persistSchoolContext();
  });
  $("sensitivity").addEventListener("change", () => recompute({ entrance: false }));
  ["days-used", "days-allowed"].forEach((id) =>
    $(id).addEventListener("change", () => {
      validateDays();
      persistSchoolContext();
      recompute({ entrance: false });
    })
  );
}

// --- Helpers -------------------------------------------------------------

/** AbortSignal that fires after `ms` (for network timeouts). */
function timeoutSignal(ms) {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), ms);
  return ctrl.signal;
}

function applyUrlOverrides() {
  const u = readUrlState();
  const patch = {};
  if (u.school) patch.schoolType = u.school;
  if (u.area) patch.areaType = u.area;
  if (Number.isFinite(u.sens)) patch.districtSensitivity = u.sens;
  if (Number.isFinite(u.used)) patch.snowDaysUsed = u.used;
  if (Number.isFinite(u.allowed)) patch.snowDaysAllowed = u.allowed;
  if (u.unit) patch.tempUnit = u.unit;
  if (u.theme) patch.theme = u.theme;
  if (Object.keys(patch).length) {
    saveSettings(patch);
    state.settings = getSettings(); // re-read so any legacy theme value migrates
  }
  return u;
}

// --- Init ----------------------------------------------------------------

function init() {
  const urlState = applyUrlOverrides();
  applySettings();
  refreshQuickLists();
  refreshScheduleContext(); // hidden until a location exists
  ui.setEstimateCounter(getEstimateCount());
  wireSettings();
  wireContext();

  const versionEl = $("app-version");
  if (versionEl) versionEl.textContent = `SnowSignal v${APP_VERSION}`;

  // Search wiring
  $("location").addEventListener("input", onSearchInput);
  $("location").addEventListener("keydown", onSearchKeydown);
  $("location").addEventListener("blur", () => setTimeout(ui.closeSuggestions, 150));
  $("geo-btn").addEventListener("click", useMyLocation);
  $("copy-btn").addEventListener("click", onCopySummary);
  $("share-btn").addEventListener("click", onCopyShareLink);
  $("save-btn").addEventListener("click", onSaveLocation);
  $("retry-btn").addEventListener("click", () => {
    if (lastAction) lastAction();
    else if (state.place) loadPlace(state.place);
  });

  // "/" focuses the search box from anywhere outside a text field or the modal.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    const typing =
      t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA");
    if (typing || !$("settings-panel").hidden) return;
    e.preventDefault();
    $("location").focus();
  });

  // Desktop-only hourly scroll arrows (touch users swipe; smooth via CSS).
  const scrollTimelineBy = (dx) => {
    const t = $("timeline");
    if (t) t.scrollBy({ left: dx, behavior: "smooth" });
  };
  $("timeline-prev").addEventListener("click", () => scrollTimelineBy(-180));
  $("timeline-next").addEventListener("click", () => scrollTimelineBy(180));

  // React to OS theme changes while on "system".
  if (window.matchMedia) {
    window
      .matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", () => {
        if (state.settings.theme === "system") {
          ui.applyTheme("system");
          applyAtmosphereNow();
        }
      });
  }

  // Auto-load from a shared URL (lat/lon or a place name).
  if (Number.isFinite(urlState.lat) && Number.isFinite(urlState.lon)) {
    loadPlace({
      name: urlState.loc || "Shared location",
      latitude: urlState.lat,
      longitude: urlState.lon,
    });
  } else if (urlState.loc) {
    findPlace(urlState.loc)
      .then(loadPlace)
      .catch(() => {});
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
