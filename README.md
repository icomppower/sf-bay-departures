# Bay Departures 灣區班次 — Bulletin Board (Mobile Lite Mode)

A fast, phone-first **live departure board** for BART + Caltrain: pick a station, see line / destination / real countdown. Plain HTML/CSS/vanilla JS — no WebGL, no terrain tiles, no build step, loads near-instantly on any phone.

**Live:** https://icomppower.github.io/sf-bay-departures

This is the standalone mobile-lite companion to [SF Bay Area 3D](https://icomppower.github.io/sf-bay-transit-3d) — a **separate product sharing only the data sources**, deliberately zero code dependency on the 3D repo (so no 3D weight can ever leak into this build).

## Data

- **Live**: BART's open ETD API (`api.bart.gov`, direct client-side, public demo key) and Caltrain via the deployed [sf-bay-transit-proxy](https://sf-bay-transit-proxy.vercel.app) (511.org StopMonitoring, CORS-wrapped). BART refreshes every 30 s, Caltrain every 60 s (511 token is rate-limited server-side).
- **Fallback**: the official weekday GTFS timetable (embedded `data.js`), on America/Los_Angeles time regardless of visitor timezone. Shown with a `SCHED` tag whenever live data is unavailable (offline, API down, late night).
- Countdown urgency: green > 5 min, amber 2–5 min, flashing red < 2 min.

## Rebuild the schedule data

1. Fetch GTFS (gitignored):
   - BART: `curl -sL https://www.bart.gov/dev/schedules/google_transit.zip -o bart-gtfs.zip && unzip -o bart-gtfs.zip -d gtfs-bart`
   - Caltrain: `curl -sL "http://api.511.org/transit/datafeeds?api_key=YOUR_511_TOKEN&operator_id=CT" -o caltrain-gtfs.zip && unzip -o caltrain-gtfs.zip -d gtfs-caltrain`
2. `node tools/build-data.mjs` → regenerates `data.js` (stations incl. BART ETD codes + Caltrain 511 stop codes, official line colours, one weekday of departures).

Serve locally with any static server (e.g. `python3 -m http.server`).
