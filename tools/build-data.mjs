#!/usr/bin/env node
/* =====================================================================
 *  build-data.mjs — GTFS → data.js for the Bulletin Board
 *
 *  Re-derives everything this board needs straight from the operators'
 *  own GTFS (BART via bart.gov, Caltrain via 511.org) — deliberately NOT
 *  imported from the sf-bay-transit-3d repo, so this project has zero
 *  dependency on the 3D one (see the Notion doc's "why fully separate").
 *
 *  Input : ./gtfs-bart/ and ./gtfs-caltrain/ (unzipped GTFS, gitignored)
 *  Output: ./data.js — window.BOARD_DATA = {
 *    stations: [{id, op, code|codes, name, lat, lon}]   // BART: ETD abbr; CT: platform stopCodes for the 511 proxy
 *    lines:    [{k, color, text, op}]                   // official route_color/route_text_color per operator
 *    dests:    ["Antioch", ...]                          // string table (schedule rows index into it)
 *    sched:    { stationId: [[secondsSinceMidnight, lineIdx, destIdx], ...] }  // one real weekday, sorted
 *  }
 *  The schedule is the OFFLINE FALLBACK; live rows come from BART's ETD
 *  API and Caltrain's 511 StopMonitoring (via sf-bay-transit-proxy).
 * ===================================================================== */
import { readFileSync, writeFileSync } from "fs";

/* tiny CSV parser (GTFS quoting: fields may be "..." with embedded commas) */
function parseCSV(path){
  const lines = readFileSync(path, "utf8").split(/\r?\n/).filter(l => l.length);
  const parse = l => { const out = []; let cur = "", q = false;
    for(let i = 0; i < l.length; i++){ const c = l[i];
      if(q){ if(c === '"'){ if(l[i+1] === '"'){ cur += '"'; i++; } else q = false; } else cur += c; }
      else if(c === '"') q = true;
      else if(c === ","){ out.push(cur); cur = ""; }
      else cur += c; }
    out.push(cur); return out; };
  const head = parse(lines[0].replace(/^﻿/, ""));
  return lines.slice(1).map(l => { const f = parse(l), o = {}; head.forEach((h, i) => o[h] = f[i] ?? ""); return o; });
}
const hms = t => { const [h, m, s] = t.split(":").map(Number); return h*3600 + m*60 + (s||0); };

/* ALL regular weekday services, not just one: BART splits its weekday timetable
 * across service_ids (main lines under one id, the Grey OAK shuttle under two
 * more). Keep every Mon–Fri service whose calendar spans ≥ 30 days — that drops
 * the one-day/holiday exception services without dropping whole lines. */
function weekdayServices(dir){
  const day = d => new Date(d.slice(0,4) + "-" + d.slice(4,6) + "-" + d.slice(6,8));
  const cal = parseCSV(dir + "/calendar.txt").filter(r =>
    +r.monday && +r.tuesday && +r.wednesday && +r.thursday && +r.friday
    && (day(r.end_date) - day(r.start_date)) >= 30 * 86400e3);
  if(!cal.length) throw new Error("no regular weekday service found in " + dir);
  console.log(`${dir}: weekday services ${cal.map(r => r.service_id).join(", ")}`);
  return new Set(cal.map(r => r.service_id));
}

const stations = [], lines = [], dests = [], sched = {};
const lineIdx = {}, destIdx = {};
const destOf = d => { if(!(d in destIdx)){ destIdx[d] = dests.length; dests.push(d); } return destIdx[d]; };
const lineOf = (k, color, text, op) => { const key = op + ":" + k;
  if(!(key in lineIdx)){ lineIdx[key] = lines.length; lines.push({ k, color: "#" + color, text: "#" + text, op }); }
  return lineIdx[key]; };

/* ---------------- BART ---------------- */
{
  const dir = "gtfs-bart";
  const stops = parseCSV(dir + "/stops.txt");
  const parents = stops.filter(s => s.location_type === "1");
  const parentOf = {};   // platform stop_id -> station abbr
  for(const s of stops) if(s.parent_station) parentOf[s.stop_id] = s.parent_station;
  for(const p of parents) stations.push({ id: "bart:" + p.stop_id, op: "bart", code: p.stop_id,
    name: p.stop_name, lat: +p.stop_lat, lon: +p.stop_lon });

  const routes = {};
  for(const r of parseCSV(dir + "/routes.txt"))
    if(r.route_type === "1")   // rail only — the Bus Bridge routes are not board content
      routes[r.route_id] = { k: r.route_short_name.replace(/-[NS]$/, ""), color: r.route_color, text: r.route_text_color };

  const svc = weekdayServices(dir);
  const trips = {};   // trip_id -> {lineIdx, destIdx}
  for(const t of parseCSV(dir + "/trips.txt")){
    if(!svc.has(t.service_id)) continue; const r = routes[t.route_id]; if(!r) continue;
    trips[t.trip_id] = { l: lineOf(r.k, r.color, r.text, "bart"), d: destOf(t.trip_headsign) };
  }
  for(const st of parseCSV(dir + "/stop_times.txt")){
    const tr = trips[st.trip_id]; if(!tr) continue;
    const abbr = parentOf[st.stop_id] || st.stop_id; const id = "bart:" + abbr;
    (sched[id] ||= []).push([hms(st.departure_time || st.arrival_time), tr.l, tr.d]);
  }
}

/* ---------------- Caltrain ---------------- */
{
  const dir = "gtfs-caltrain";
  const stops = parseCSV(dir + "/stops.txt");
  const parents = stops.filter(s => s.location_type === "1");
  const parentOf = {}, codesOf = {};
  for(const s of stops) if(s.parent_station){ parentOf[s.stop_id] = s.parent_station;
    (codesOf[s.parent_station] ||= []).push(s.stop_code || s.stop_id); }
  for(const p of parents) stations.push({ id: "ct:" + p.stop_id, op: "ct", codes: codesOf[p.stop_id] || [],
    name: p.stop_name.replace(/\s*Caltrain Station$/i, ""), lat: +p.stop_lat, lon: +p.stop_lon });

  const routes = {};
  for(const r of parseCSV(dir + "/routes.txt"))
    routes[r.route_id] = { k: (r.route_short_name || r.route_id).replace(/\s*Weekday$/i, ""), color: r.route_color || "E31837", text: r.route_text_color || "FFFFFF" };

  const svc = weekdayServices(dir);
  const trips = {};
  for(const t of parseCSV(dir + "/trips.txt")){
    if(!svc.has(t.service_id)) continue; const r = routes[t.route_id]; if(!r) continue;
    trips[t.trip_id] = { l: lineOf(r.k, r.color, r.text, "ct"), d: destOf(t.trip_headsign) };
  }
  for(const st of parseCSV(dir + "/stop_times.txt")){
    const tr = trips[st.trip_id]; if(!tr) continue;
    const parent = parentOf[st.stop_id]; if(!parent) continue;
    (sched["ct:" + parent] ||= []).push([hms(st.departure_time || st.arrival_time), tr.l, tr.d]);
  }
}

/* sort each station's departures; drop stations with no weekday service (e.g. special-event only) */
for(const id of Object.keys(sched)) sched[id].sort((a,b) => a[0] - b[0]);
const active = stations.filter(s => (sched[s.id] || []).length);
console.log(`stations: ${active.length} (of ${stations.length} in GTFS) · lines: ${lines.length} · dests: ${dests.length} · departures: ${Object.values(sched).reduce((n,a) => n + a.length, 0)}`);

const out = "/* GENERATED by tools/build-data.mjs from BART GTFS (bart.gov) + Caltrain GTFS (511.org) — do not edit by hand */\n"
  + "window.BOARD_DATA = " + JSON.stringify({
      generated: new Date().toISOString().slice(0,10),
      stations: active, lines, dests, sched
    }) + ";\n";
writeFileSync("data.js", out);
console.log(`data.js written (${(out.length/1024).toFixed(0)} KB)`);
