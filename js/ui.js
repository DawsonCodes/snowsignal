// ui.js
// The ONLY module (besides main.js) that touches the DOM. It renders engine
// output, manages skeletons/errors, the settings dialog (with a focus trap),
// theme/motion application, calendar notices, and restrained motion flourishes
// (animated gauges, staggered cards, toast, confetti).

import { formatTemp, formatInches, formatHourLabel } from "./format.js";

export const $ = (id) => document.getElementById(id);
const show = (elm) => elm && (elm.hidden = false);
const hide = (elm) => elm && (elm.hidden = true);

const DIAL_CIRCUMFERENCE = 326.7; // 2 * pi * r (r = 52)

// --- Theme + motion ------------------------------------------------------

const prefersDark = () =>
  window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
const prefersReducedMotion = () =>
  window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Apply a theme preference, resolving "system" to light/dark at runtime. */
export function applyTheme(pref) {
  const resolved = pref === "system" ? (prefersDark() ? "dark" : "light") : pref;
  document.documentElement.setAttribute("data-theme", resolved);
  const icon = $("theme-toggle-icon");
  if (icon) icon.textContent = resolved === "dark" ? "☀️" : "🌙";
  updateSystemBadge(pref, resolved);
  return resolved;
}

/** Show a read-only "System detected: Dark/Light" badge only while on System. */
export function updateSystemBadge(pref, resolved = resolvedTheme()) {
  const badge = $("theme-system-badge");
  if (!badge) return;
  if (pref === "system") {
    badge.textContent = `System detected: ${resolved === "dark" ? "Dark" : "Light"}`;
    show(badge);
  } else {
    hide(badge);
  }
}

/** Apply an accent hue (0..360); null/undefined restores the brand default. */
export function applyAccent(hue) {
  const root = document.documentElement;
  if (Number.isFinite(hue)) root.style.setProperty("--accent-h", String(Math.round(hue)));
  else root.style.removeProperty("--accent-h");
}

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "");

/** Show the read-only "Auto palette: Season" badge only while the palette is Auto. */
export function updatePaletteBadge(palette, season) {
  const badge = $("palette-auto-badge");
  if (!badge) return;
  if (palette === "auto" && season) {
    badge.textContent = `Auto palette: ${cap(season)}`;
    show(badge);
  } else {
    hide(badge);
  }
}

const SEASON_ICON = { winter: "❄️", spring: "🌸", summer: "☀️", fall: "🍂" };

/** Set the restrained seasonal accent icon shown in the empty state. */
export function setEmptyIcon(season) {
  const el = $("empty-icon");
  if (el) el.textContent = SEASON_ICON[season] || "❄️";
}

/** Resolve a theme preference to the concrete theme currently shown. */
export function resolvedTheme() {
  return document.documentElement.getAttribute("data-theme") || "light";
}

/** Apply a motion preference: "system" yields to the OS media query. */
export function applyMotion(pref) {
  const root = document.documentElement;
  if (pref === "on") root.setAttribute("data-motion", "reduce");
  else if (pref === "off") root.setAttribute("data-motion", "full");
  else root.removeAttribute("data-motion"); // system → CSS media query decides
}

export function motionAllowed(pref) {
  if (pref === "on") return false;
  if (pref === "off") return true;
  return !prefersReducedMotion();
}

// --- States: skeleton / error / empty ------------------------------------

export function showSkeleton() {
  hide($("error-state"));
  hide($("result"));
  hide($("empty-state"));
  show($("skeleton"));
}

export function showError(message) {
  hide($("skeleton"));
  hide($("result"));
  hide($("empty-state"));
  $("error-message").textContent = message;
  show($("error-state"));
}

export function clearStates() {
  hide($("skeleton"));
  hide($("error-state"));
}

// --- Result rendering ----------------------------------------------------

function animateCount(el, to, { entrance }) {
  const target = Math.round(to);
  if (!entrance) {
    // Presentation/scoring update: snap to the new value, no count-up replay.
    el.textContent = `${target}%`;
    return;
  }
  const duration = 700;
  const start = performance.now();
  const tick = (t) => {
    const k = Math.min(1, (t - start) / duration);
    const eased = 1 - Math.pow(1 - k, 3); // ease-out cubic
    el.textContent = `${Math.round(target * eased)}%`;
    if (k < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function setDial(dialId, pct, opts) {
  const dial = $(dialId);
  const fill = dial.querySelector(".dial-fill");
  const offsetFor = (p) => String(DIAL_CIRCUMFERENCE * (1 - p / 100));
  if (opts.entrance) {
    // New forecast: sweep the ring up from empty.
    fill.style.strokeDashoffset = offsetFor(0);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => (fill.style.strokeDashoffset = offsetFor(pct)))
    );
  } else {
    // Update: set directly — the CSS stroke transition smooths the change without
    // replaying the full entrance sweep.
    fill.style.strokeDashoffset = offsetFor(pct);
  }
  // Color the closure dial by severity.
  if (dialId === "dial-closure") {
    const color = pct >= 65 ? "var(--good)" : pct >= 35 ? "var(--warn)" : "var(--muted)";
    fill.style.stroke = color;
  }
  animateCount(dial.querySelector(".dial-pct"), pct, opts);
}

/**
 * Render an engine result. `meta.entrance` (set only after a new successful
 * forecast) gates the loading-style entrance animations; presentation-only and
 * scoring updates pass entrance:false so values change in place without replay.
 */
export function renderResult(result, meta) {
  clearStates();
  hide($("empty-state"));
  const animate = meta.animate !== false;
  const entrance = animate && meta.entrance === true;

  // --- Forecast header: date / window / freshness ---
  const dateEl = $("rh-date");
  if (dateEl) dateEl.textContent = meta.dateLabel || "";
  const fw = $("forecast-window");
  if (fw) {
    if (meta.forecastWindow) {
      fw.textContent = meta.forecastWindow;
      show(fw);
    } else {
      hide(fw);
    }
  }
  const updated = $("rh-updated");
  if (updated) {
    if (meta.updatedLabel) {
      updated.textContent = meta.fromCache
        ? `${meta.updatedLabel} · cached`
        : meta.updatedLabel;
      show(updated);
    } else {
      hide(updated);
    }
  }

  setDial("dial-closure", result.closurePct, { entrance });
  setDial("dial-delay", result.delayPct, { entrance });

  $("chip-location").textContent = meta.placeLabel || "Your location";
  const confChip = $("chip-confidence");
  confChip.textContent = `${result.confidence} confidence`;
  confChip.className = `chip confidence-${result.confidence}`;
  confChip.title = CONFIDENCE_HELP[result.confidence] || "";

  $("recommendation").textContent = result.recommendation;

  renderDrivers(result.drivers || []);

  const gate = $("gate-note");
  if (gate) {
    if (result.gated && result.gateReason) {
      gate.textContent = result.gateReason;
      show(gate);
    } else {
      hide(gate);
    }
  }

  renderFactors(result.factors, { entrance });
  renderWeatherDetails(meta.weatherRows || []);
  renderTimeline(meta.timeline || [], meta.unit, { entrance });

  const note = $("cache-note");
  if (meta.fromCache && meta.fetchedAt) {
    const t = new Date(meta.fetchedAt).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
    note.textContent = `Showing cached forecast from ${t}.`;
    show(note);
  } else {
    hide(note);
  }

  show($("result"));
  // The full-card reveal animation runs only on a fresh forecast entrance.
  const card = $("result");
  card.classList.remove("reveal");
  if (entrance) {
    void card.offsetWidth; // force reflow so the animation restarts
    card.classList.add("reveal");
  }
}

// Plain-language meaning of each confidence label (shown as a tooltip).
const CONFIDENCE_HELP = {
  high: "The signals are clear-cut and agree with each other.",
  medium: "A reasonable read, but some signals are mixed or incomplete.",
  low: "Borderline or incomplete signals — check official sources.",
};

/** Render the plain-language "top drivers" line under the recommendation. */
function renderDrivers(drivers) {
  const wrap = $("drivers");
  if (!wrap) return;
  wrap.innerHTML = "";
  if (!drivers.length) {
    hide(wrap);
    return;
  }
  for (const text of drivers) {
    const li = document.createElement("li");
    li.textContent = text;
    wrap.appendChild(li);
  }
  show(wrap);
}

function renderFactors(factors, { entrance }) {
  const list = $("factors");
  list.innerHTML = "";
  // Split into what pushed the estimate up vs down, biggest movers first, with a
  // small heading over each group so direction never relies on color alone.
  const moving = factors.filter((f) => Math.abs(f.points) >= 0.5);
  const raising = moving
    .filter((f) => f.points > 0)
    .sort((a, b) => b.points - a.points);
  const lowering = moving
    .filter((f) => f.points < 0)
    .sort((a, b) => a.points - b.points);

  let shown = 0;
  const addHeading = (text) => {
    const li = document.createElement("li");
    li.className = "factor-heading";
    li.textContent = text;
    list.appendChild(li);
  };
  const addFactor = (f) => {
    const li = document.createElement("li");
    li.className = `factor ${f.direction}`;
    const widthPct = Math.min(100, (Math.abs(f.points) / f.maxPoints) * 100);
    li.innerHTML = `
      <div class="factor-top">
        <span class="factor-label"></span>
        <span class="factor-detail"></span>
      </div>
      <div class="factor-bar"><span></span></div>`;
    li.querySelector(".factor-label").textContent = f.label;
    li.querySelector(".factor-detail").textContent = f.detail;
    const bar = li.querySelector(".factor-bar > span");
    if (entrance) {
      // Staggered grow-in on a fresh forecast.
      bar.style.transitionDelay = `${shown * 60}ms`;
      bar.style.width = "0%";
      list.appendChild(li);
      requestAnimationFrame(() =>
        requestAnimationFrame(() => (bar.style.width = `${widthPct}%`))
      );
    } else {
      // Update: set the final width before first paint so it does not replay.
      bar.style.transitionDelay = "0ms";
      bar.style.width = `${widthPct}%`;
      list.appendChild(li);
    }
    shown++;
  };

  if (raising.length) {
    addHeading("Raising the estimate");
    raising.forEach(addFactor);
  }
  if (lowering.length) {
    addHeading("Lowering the estimate");
    lowering.forEach(addFactor);
  }
}

/** Render the compact key/value weather-details list (data already fetched). */
function renderWeatherDetails(rows) {
  const grid = $("wd-grid");
  if (!grid) return;
  grid.innerHTML = "";
  for (const row of rows) {
    const wrap = document.createElement("div");
    const dt = document.createElement("dt");
    dt.textContent = row.label;
    const dd = document.createElement("dd");
    dd.textContent = row.value;
    wrap.append(dt, dd);
    grid.appendChild(wrap);
  }
}

const WEATHER_ICON = (code) => {
  if (code === 0) return "☀️";
  if (code >= 1 && code <= 3) return "⛅";
  if (code >= 45 && code <= 48) return "🌫️";
  if (code >= 51 && code <= 57) return "🌧️";
  if (code >= 61 && code <= 67) return "🌧️";
  if (code >= 71 && code <= 77) return "🌨️";
  if (code >= 80 && code <= 82) return "🌧️";
  if (code >= 85 && code <= 86) return "❄️";
  if (code >= 95) return "⛈️";
  return "🌡️";
};

function renderTimeline(timeline, unit, { entrance }) {
  const wrap = $("timeline");
  wrap.innerHTML = "";
  const spoken = [];
  timeline.forEach((h, i) => {
    const div = document.createElement("div");
    div.className = "t-hour";
    if (entrance) {
      div.classList.add("t-enter");
      div.style.animationDelay = `${Math.min(i, 12) * 35}ms`;
    }
    const snow = h.snowIn > 0.05 ? formatInches(h.snowIn) : "";
    div.innerHTML = `
      <span class="t-time"></span>
      <span class="t-icon" aria-hidden="true">${WEATHER_ICON(h.code)}</span>
      <span class="t-temp"></span>
      <span class="t-snow"></span>`;
    const time = formatHourLabel(h.time);
    const temp = formatTemp(h.tempF, unit);
    div.querySelector(".t-time").textContent = time;
    div.querySelector(".t-temp").textContent = temp;
    div.querySelector(".t-snow").textContent = snow;
    wrap.appendChild(div);
    spoken.push(`${time} ${temp}${snow ? `, snow ${snow}` : ""}`);
  });
  // Accessible text equivalent of the visual timeline (it has role="img").
  wrap.setAttribute(
    "aria-label",
    spoken.length ? `Hourly outlook: ${spoken.join("; ")}` : "Hourly outlook unavailable"
  );
}

export function renderAlertBanner(alert) {
  const banner = $("alert-banner");
  if (!alert || !alert.hasWinterAlert) {
    hide(banner);
    return;
  }
  banner.className = `alert-banner severity-${alert.alertSeverity}`;
  $("alert-title").textContent = alert.event || "Winter weather alert";
  $("alert-text").textContent = alert.headline || "";
  show(banner);
}

// --- Calendar / schedule notices -----------------------------------------

// Track per-session dismissals so a notice doesn't reappear after the user closes it.
const dismissedNotices = new Set();

/**
 * Render heuristic school-calendar reminders into the compact Schedule context
 * card. The whole card (and the list) stays hidden until there is at least one
 * applicable, non-dismissed reminder — and callers only invoke this once a
 * location/result exists. The calculator is never disabled by these notices.
 */
export function renderCalendarNotices(notices) {
  const wrap = $("calendar-notices");
  const card = $("schedule-context");
  if (!wrap) return;
  wrap.innerHTML = "";
  const visible = (notices || []).filter((n) => !dismissedNotices.has(n.id));
  if (!visible.length) {
    hide(wrap);
    if (card) hide(card);
    return;
  }
  for (const n of visible) {
    const el = document.createElement("details");
    el.className = "calendar-notice";
    el.innerHTML = `
      <summary>
        <span class="cn-icon" aria-hidden="true">📅</span>
        <span class="cn-title"></span>
        <span class="cn-caret" aria-hidden="true">›</span>
        <button type="button" class="cn-dismiss icon-btn" aria-label="Dismiss reminder">✕</button>
      </summary>
      <p class="cn-text"></p>`;
    el.querySelector(".cn-title").textContent = n.title;
    el.querySelector(".cn-text").textContent = n.message;
    const dismiss = el.querySelector(".cn-dismiss");
    dismiss.addEventListener("click", (e) => {
      // Don't let the dismiss button toggle the <details>.
      e.preventDefault();
      e.stopPropagation();
      dismissedNotices.add(n.id);
      el.remove();
      if (!wrap.children.length) {
        hide(wrap);
        if (card) hide(card);
      }
    });
    wrap.appendChild(el);
  }
  show(wrap);
  if (card) show(card);
}

/** Show/update the device-local estimate counter (footer + About tab). */
export function setEstimateCounter(count) {
  const n = Number.isFinite(count) ? count : 0;
  const label = `${n} ${n === 1 ? "estimate" : "estimates"} run on this device`;
  const footer = $("footer-counter");
  if (footer) {
    footer.textContent = label;
    if (n > 0) show(footer);
    else hide(footer);
  }
  const about = $("about-counter");
  if (about) about.textContent = `${label} · stored only in your browser, never sent anywhere.`;
}

// --- Saved / recent / suggestions ---------------------------------------

export function renderSavedLocations(list, { onSelect, onRemove }) {
  const group = $("saved-group");
  const container = $("saved-locations");
  container.innerHTML = "";
  if (!list.length) {
    hide(group);
    return;
  }
  for (const loc of list) {
    const chip = document.createElement("span");
    chip.className = "chip tappable";
    const label = document.createElement("span");
    label.textContent = loc.label;
    label.addEventListener("click", () => onSelect(loc));
    const x = document.createElement("span");
    x.className = "chip-x";
    x.textContent = "✕";
    x.setAttribute("role", "button");
    x.setAttribute("aria-label", `Remove ${loc.label}`);
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      onRemove(loc.id);
    });
    chip.append(label, x);
    container.appendChild(chip);
  }
  show(group);
}

export function renderRecentSearches(list, { onSelect }) {
  const group = $("recent-group");
  const container = $("recent-searches");
  container.innerHTML = "";
  if (!list.length) {
    hide(group);
    return;
  }
  for (const item of list) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip tappable";
    chip.textContent = item.name;
    chip.addEventListener("click", () => onSelect(item));
    container.appendChild(chip);
  }
  show(group);
}

/** Render the autocomplete dropdown. Returns nothing; main.js owns selection. */
export function renderSuggestions(places, { onSelect, formatLabel }) {
  const box = $("suggestions");
  const input = $("location");
  box.innerHTML = "";
  if (!places || !places.length) {
    hide(box);
    input.setAttribute("aria-expanded", "false");
    return;
  }
  places.forEach((place, idx) => {
    const li = document.createElement("li");
    li.id = `suggestion-${idx}`;
    li.setAttribute("role", "option");
    li.textContent = formatLabel(place);
    li.addEventListener("mousedown", (e) => {
      e.preventDefault(); // keep focus, fire before blur
      onSelect(place);
    });
    box.appendChild(li);
  });
  show(box);
  input.setAttribute("aria-expanded", "true");
}

export function closeSuggestions() {
  hide($("suggestions"));
  $("location").setAttribute("aria-expanded", "false");
}

// --- Settings dialog with focus trap + entrance/exit animation -----------

let lastFocused = null;
const FOCUSABLE = "a[href], button, input, [tabindex]";

// --- Tabs ----------------------------------------------------------------
const TAB_IDS = ["tab-appearance", "tab-weather", "tab-data", "tab-about"];

/** Select a settings tab and reveal its panel. */
export function activateTab(tabId, { focus = false } = {}) {
  for (const id of TAB_IDS) {
    const tab = $(id);
    if (!tab) continue;
    const selected = id === tabId;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    const panel = $(tab.getAttribute("aria-controls"));
    if (panel) {
      panel.hidden = !selected;
      if (selected) {
        // Restrained fade/slide-in of the newly shown panel (zeroed under reduced
        // motion by the global motion rules). Re-trigger via reflow.
        panel.classList.remove("tab-anim");
        void panel.offsetWidth;
        panel.classList.add("tab-anim");
      }
    }
    if (selected && focus) tab.focus();
  }
}

/** Wire tab clicks + roving-tabindex arrow-key navigation (called once). */
export function initSettingsTabs() {
  const tablist = document.querySelector(".settings-tabs");
  if (!tablist) return;
  TAB_IDS.forEach((id) => {
    const tab = $(id);
    if (tab) tab.addEventListener("click", () => activateTab(id));
  });
  tablist.addEventListener("keydown", (e) => {
    const idx = TAB_IDS.indexOf(document.activeElement.id);
    if (idx < 0) return;
    let next = idx;
    if (e.key === "ArrowRight") next = (idx + 1) % TAB_IDS.length;
    else if (e.key === "ArrowLeft") next = (idx - 1 + TAB_IDS.length) % TAB_IDS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = TAB_IDS.length - 1;
    else return;
    e.preventDefault();
    activateTab(TAB_IDS[next], { focus: true });
  });
}

export function openSettings() {
  const panel = $("settings-panel");
  lastFocused = document.activeElement;
  activateTab("tab-appearance"); // always open on the first tab
  show(panel);
  requestAnimationFrame(() => panel.classList.add("is-open"));
  const closeBtn = $("settings-close");
  if (closeBtn) closeBtn.focus();
  panel.addEventListener("keydown", trapFocus);
}

export function closeSettings() {
  const panel = $("settings-panel");
  if (panel.hidden) return;
  panel.classList.remove("is-open");
  panel.removeEventListener("keydown", trapFocus);
  // Hide after the exit transition; under reduced motion the transition is ~0ms.
  window.setTimeout(() => {
    hide(panel);
    if (lastFocused) lastFocused.focus();
  }, 200);
}

function trapFocus(e) {
  if (e.key === "Escape") {
    closeSettings();
    return;
  }
  if (e.key !== "Tab") return;
  const panel = $("settings-panel");
  // Only truly tabbable, visible controls: skip disabled, roving tabindex=-1,
  // and anything inside a hidden tab panel (offsetParent is null when hidden).
  const items = [...panel.querySelectorAll(FOCUSABLE)].filter(
    (el) => !el.disabled && el.tabIndex !== -1 && el.offsetParent !== null
  );
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

// --- Misc flourishes -----------------------------------------------------

let toastTimer = null;
export function toast(message) {
  const t = $("toast");
  t.textContent = message;
  show(t);
  t.classList.remove("toast-in");
  void t.offsetWidth;
  t.classList.add("toast-in");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => hide(t), 2400);
}

export function launchConfetti() {
  const layer = $("confetti");
  const colors = ["#38bdf8", "#6366f1", "#22c55e", "#f59e0b", "#e2e8f0"];
  for (let i = 0; i < 90; i++) {
    const piece = document.createElement("span");
    piece.className = "confetti-piece";
    piece.style.left = `${Math.random() * 100}vw`;
    piece.style.background = colors[i % colors.length];
    piece.style.animationDelay = `${Math.random() * 0.8}s`;
    layer.appendChild(piece);
    setTimeout(() => piece.remove(), 3800);
  }
}
