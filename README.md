# SnowSignal

**Know before the bell.** — A transparent snow-day and school-delay predictor.

A free, modern, **fully static** web app. It pulls live weather from
[Open-Meteo](https://open-meteo.com) and (for U.S. locations) official winter alerts
from the [National Weather Service](https://www.weather.gov), then runs a transparent,
deterministic scoring engine to estimate the chance that school is **closed** or **delayed**.

No backend. No API keys. No sign-up. No tracking. It runs entirely in the browser and
deploys to GitHub Pages as-is. The only third-party calls are Open-Meteo (weather +
geocoding), the NWS alerts API (U.S. only), and BigDataCloud's free, keyless
reverse-geocode endpoint for friendly "My location" labels.

> **Status:** stable release (`v1.0.0`). See [Versioning](#versioning),
> [CHANGELOG.md](CHANGELOG.md), and [ROADMAP.md](ROADMAP.md).
> The GitHub Pages URL is served from the `/snowsignal/` project subpath and all asset
> paths are relative so the app keeps working there.

## Features

- 🔎 Search by **ZIP / postal code, city, or town**, use **browser geolocation**, or open a **shared link**
- ❄️ Separate **closure %** and **2-hour delay %**, a **confidence** level, a plain-English
  recommendation, and a **visible factor breakdown** (you can see exactly what's driving the number)
- 🌡️ Accounts for overnight snow, **snow during the morning commute**, **freezing rain / ice**,
  temperature & wind chill, wind gusts, low visibility, existing snow depth, precip probability,
  official winter alerts, storm timing, district sensitivity, area type, school type, and snow days used
- 🛑 A **winter-weather plausibility gate**: with no meaningful winter hazard in the forecast window,
  the estimate resolves to **0%** with a clear explanation — sensitivity, warm-weather wind, or the
  calendar month can't create a phantom snow day, and unusual out-of-season storms still count
- 🎨 **System / Light / Dark** themes (with a "System detected" badge) plus a **Seasonal palette**
  (Auto / Winter / Spring / Summer / Fall / Custom). **Auto** follows the location's latitude + local
  date (Southern Hemisphere inverts) and shows an `Auto palette: <Season>` badge; the constrained
  **hue slider** still lets you go **Custom** (Reset restores Auto). Status colors stay fixed.
- 🌗 **Time-of-day ambient intensity** under Auto — a subtle brighter-by-day / softer-evening /
  deeper-night variation of the ambient glow and particle brightness (not separate themes)
- 🍃 **Seasonal atmosphere** — restrained, motion-respecting ambient effects: varied drifting snow,
  swaying spring petals, firefly-like summer motes, and rotating fall leaves — tuned for light & dark
  and fully disabled under reduced motion
- 📅 A separate **Schedule context** panel — clearly-labeled weekend / summer-break / winter-break
  heuristics, hidden until a result exists (dismissible, never authoritative)
- 🗓️ A result **date & freshness header** (location-local date, forecast window, "Updated …" stamp) and
  a collapsible **Weather details** panel (current temp, low/high, window snowfall, gusts, alert status,
  hourly outlook)
- 💾 **Saved locations**, **recent searches**, **cached forecasts** (offline-friendly), an honest
  **device-local estimate counter**, and **explicit share links** that keep the everyday URL clean
- 📋 One-click **copy summary** + **copy share link**, friendly loading/error states with a **Try again**
  action, and expandable **advanced settings**
- ⚙️ A wider **tabbed Settings** dialog (Appearance / Weather / Data / About) with one-tap data resets
- ♿ Accessible: keyboard navigation, focus trapping, tab semantics, `aria-live` results, text
  equivalents for the hourly chart, and **reduced-motion** support

## How the prediction works

The engine (`js/engine.js`) is a **pure, deterministic function** — no randomness, no fabricated
historical data, no accuracy claims. It adds up named, weighted factors and maps the total to a
percentage. **Ice risk** and **snow during the morning commute** are intentionally the two heaviest
factors. Every factor is shown in the UI with its contribution, so the number is explainable rather
than a black box.

- **Closure %** — weighted sum of all factors, scaled and capped at 99%. A small, isolated
  `hasMeaningfulWinterHazard()` gate forces both the closure and delay to **0%** when the forecast
  window holds no real winter hazard, so the score stays honest in benign weather.
- **Timing-aware** — beyond raw totals, the engine reads the *shape* of the storm: a wet evening
  refreezing into black ice by bus time, a storm winding down before school (crews get a clearing
  window) vs. worsening into the commute, and heavy hourly bursts that outrun the plows.
- **Delay %** — a separate profile that favors morning-timed storms that clear and refreeze
  mornings; it's suppressed when a full closure is already likely (a district would just close
  instead).
- **Confidence** — reflects how *clear-cut the inputs are* (alert agreement, precip certainty,
  rain-vs-snow ambiguity near freezing, whether several strong signals agree, whether the result
  sits in a mushy middle), **not** a probability that the estimate is correct.
- **Drivers** — every result lists the top few plain-language reasons behind the number, including
  the biggest factor holding it down.

The weights live at the top of `js/engine.js` and are documented inline so you can tune them.

## Project structure

```
index.html          # markup; loads js/main.js as an ES module
css/                # tokens (themes) + base + components, joined by main.css
js/
  engine.js         # pure prediction engine (unit-tested)
  weather.js        # Open-Meteo fetch + forecast→engine-input mapping
  geocode.js        # Open-Meteo geocoding (city / ZIP / postal)
  alerts.js         # optional NWS winter alerts (fails gracefully)
  storage.js        # localStorage: settings, saved/recent, cached forecasts, resets
  urlState.js       # explicit share links (clean URL; defaults omitted)
  geocode.js        # Open-Meteo geocoding + keyless reverse-geocode labels
  calendarContext.js# pure season + school-calendar heuristics (unit-tested)
  atmosphere.js     # lightweight seasonal ambient particle layer
  geolocation.js    # browser geolocation wrapper
  ui.js             # all DOM rendering + accessibility + motion polish
  main.js           # orchestrator wiring events → fetch → engine → ui
tests/              # node:test unit tests + fixtures
```

## Running locally

ES modules must be served over HTTP (opening `index.html` via `file://` will not work). Any static
server is fine:

```bash
# Python (no install)
python3 -m http.server 8000
#   → open http://localhost:8000

# or with this repo's helper script
npm run serve
```

## Tests

Tests use Node's built-in test runner — **zero dependencies, no install required** (Node 18+):

```bash
npm test        # or: node --test
```

They cover the engine (monotonicity, weighting, closure-vs-delay separation, confidence,
determinism, edge cases), the Open-Meteo→engine mapping (window bucketing, unit conversion),
the NWS alert summarizer, the storage layer (persistence + resets), the season/calendar
heuristics (hemisphere inversion, summer/winter-break and weekend notices), the clean-URL
share builder (default omission), the reverse-geocode label parser, atmosphere motion-gating,
and GitHub Pages relative-path safety.

## Deploying to GitHub Pages

1. Push to GitHub.
2. **Settings → Pages → Build and deployment → Source: "Deploy from a branch."**
3. Choose your branch and the **`/ (root)`** folder, then save.
4. Your site goes live at `https://<user>.github.io/<repo>/`.

Notes:
- A `.nojekyll` file is included so GitHub Pages serves the `js/` and `css/` folders untouched.
- All asset paths are **relative**, so the app works under the project subpath without changes.
- There is no build step — the files you see are the files that ship.

## Privacy

- Everything runs in your browser. There is **no backend** and **no analytics**.
- Saved locations, recent searches, settings, and cached forecasts are stored **only in your
  browser's `localStorage`** and never leave your device.
- When you look up a location, only its **coordinates** are sent to Open-Meteo (and, for U.S.
  points, to the NWS) to fetch the forecast/alerts. Geolocation, if used, stays on your device
  except for that coordinate lookup.

## Limitations

- This is an **estimate for planning and fun** — it is **not affiliated with any school district**
  and cannot know local policies, road crews, or administrator judgment. **Always rely on official
  announcements.**
- It uses **forecast** data, which can be wrong; predictions are only as good as the forecast.
- NWS alerts are **U.S.-only**; outside the U.S. the app still works but shows no official alerts.
- District sensitivity, area type, and snow-days-used are **your inputs** — adjust them to match
  your district.

## Versioning

This is **`v1.0.0`** — the first **stable release**. The `beta.1`–`beta.4` line rebuilt the
app module by module and polished it release over release; `v1.0.0` finishes the job with a
smarter engine (refreeze/black-ice detection, trend into the commute, snowfall intensity,
sharper confidence, plain-language drivers), a finished UI, and a full accessibility and
compatibility pass. Stable still means *estimate*: SnowSignal can't know local policies or an
administrator's 5 AM judgment call, so always rely on official announcements. Full notes,
including all beta history, are in [CHANGELOG.md](CHANGELOG.md); ideas for `v1.1+` live in
[ROADMAP.md](ROADMAP.md).

## Attribution

- Weather & geocoding: [Open-Meteo](https://open-meteo.com) (free, no key, CC BY 4.0).
- U.S. winter alerts: [National Weather Service / api.weather.gov](https://www.weather.gov) (public domain).
- Reverse-geocode labels: [BigDataCloud](https://www.bigdatacloud.com) free client-side endpoint (no key).

## Open source

SnowSignal is open source and available under the **MIT License** — see the root
[`LICENSE`](LICENSE) file. You're free to use, modify, and redistribute it, including for
commercial purposes, provided the license and copyright notice are preserved. A compact
**MIT License** and **View source** link appear in the app's footer and the Settings → About
tab, pointing back to <https://github.com/DawsonCodes/snowsignal>.

Contributions are welcome — please read [CONTRIBUTING.md](CONTRIBUTING.md) first. In short:
report bugs via GitHub Issues, work on a feature branch and open a pull request, keep the app a
static GitHub Pages site (no backend/framework/build step), justify any new dependency, API,
analytics, or tracking, and run the full test suite (`node --test`) before submitting.

## License

[MIT](LICENSE) © 2026 DawsonCodes.
