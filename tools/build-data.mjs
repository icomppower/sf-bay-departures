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
 *    dests:    ["Antioch", ...]                          // headsign string table
 *    sched:    { stationId: [[secondsSinceMidnight, lineIdx, destIdx, termStationIdx], ...] }  // one real weekday, sorted
 *    tt:       { lineIdx: { "oIdx>dIdx": seconds } }     // median scheduled travel time between station pairs,
 *    fare:     { "oIdx>dIdx": dollars }                  // one-way adult fare, from each operator's own fare_rules —
 *  }                                                      // from real trips → powers the optional arrival-time mode
 *                                                          // fare is a pure O-D lookup, not per-line (neither operator prices by route taken)
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

const stations = [], lines = [], dests = [];
const lineIdx = {}, destIdx = {};
const tripStops = [];   // [{l, d, stops: [[stationId, t], ...]}] across both operators
const zoneOf = {};      // parent stop_id (unprefixed) -> fare zone, read off any child platform stop
                         // (BART: its zone_id column just duplicates the station code, unused there;
                         //  Caltrain: fare_rules prices by zone, and only child stops carry the real zone_id —
                         //  parent/station rows all carry a meaningless placeholder)
const destOf = d => { if(!(d in destIdx)){ destIdx[d] = dests.length; dests.push(d); } return destIdx[d]; };
const lineOf = (k, color, text, op) => { const key = op + ":" + k;
  if(!(key in lineIdx)){ lineIdx[key] = lines.length; lines.push({ k, color: "#" + color, text: "#" + text, op }); }
  return lineIdx[key]; };

/* one pass per operator: stations + per-trip ordered stop lists */
function processOperator(dir, op, { stationExtras, routeFilter, routeLabel, nameClean }){
  const stops = parseCSV(dir + "/stops.txt");
  const parents = stops.filter(s => s.location_type === "1");
  const parentOf = {}, codesOf = {};
  for(const s of stops) if(s.parent_station){ parentOf[s.stop_id] = s.parent_station;
    (codesOf[s.parent_station] ||= []).push(s.stop_code || s.stop_id);
    if(!(s.parent_station in zoneOf) && s.zone_id) zoneOf[s.parent_station] = s.zone_id; }
  for(const p of parents) stations.push({ id: op + ":" + p.stop_id, op,
    ...stationExtras(p, codesOf[p.stop_id] || []),
    name: nameClean(p.stop_name), lat: +p.stop_lat, lon: +p.stop_lon });

  const routes = {};
  for(const r of parseCSV(dir + "/routes.txt")) if(routeFilter(r))
    routes[r.route_id] = { k: routeLabel(r), color: r.route_color || "E31837", text: r.route_text_color || "FFFFFF" };

  const svc = weekdayServices(dir);
  const trips = {};
  for(const t of parseCSV(dir + "/trips.txt")){
    if(!svc.has(t.service_id)) continue; const r = routes[t.route_id]; if(!r) continue;
    trips[t.trip_id] = { l: lineOf(r.k, r.color, r.text, op), d: destOf(t.trip_headsign), stops: [] };
    tripStops.push(trips[t.trip_id]);
  }
  for(const st of parseCSV(dir + "/stop_times.txt")){
    const tr = trips[st.trip_id]; if(!tr) continue;
    const parent = parentOf[st.stop_id]; if(!parent && op === "ct") continue;   // CT rows must map to a station complex
    tr.stops.push([op + ":" + (parent || st.stop_id), hms(st.departure_time || st.arrival_time), +st.stop_sequence]);
  }
}

processOperator("gtfs-bart", "bart", {
  stationExtras: p => ({ code: p.stop_id }),                                   // ETD API abbr
  routeFilter: r => r.route_type === "1",                                      // rail only, not the Bus Bridge
  routeLabel: r => r.route_short_name.replace(/-[NS]$/, ""),
  nameClean: n => n,
});
processOperator("gtfs-caltrain", "ct", {
  stationExtras: (p, codes) => ({ codes }),                                    // 511 platform stopCodes
  routeFilter: () => true,
  // Caltrain's GTFS carries separate routes per day-type for the same physical stopping pattern
  // ("Local Weekday" vs "Local Weekend", distinct route_ids) — collapse them to one line key so
  // client-side live matching works regardless of which day-type is currently running, and so the
  // weekday-derived travel times below double as the (same-pattern) weekend estimate.
  routeLabel: r => (r.route_short_name || r.route_id).replace(/\s*(Weekday|Weekend|Saturday|Sunday)$/i, ""),
  nameClean: n => n.replace(/\s*Caltrain Station$/i, ""),
});

/* ---- fares: each operator publishes one row per O-D pair (BART keys by station code,
 *  Caltrain by zone) — a flat lookup, no per-line pricing to reconcile. ---- */
function loadFareRaw(dir){
  let attrs, rules;
  try{ attrs = parseCSV(dir + "/fare_attributes.txt"); rules = parseCSV(dir + "/fare_rules.txt"); }
  catch(e){ return {}; }
  const priceById = {}; for(const a of attrs) priceById[a.fare_id] = +a.price;
  const out = {};
  for(const r of rules){ const p = priceById[r.fare_id]; if(p == null || !r.origin_id || !r.destination_id) continue;
    out[r.origin_id + ">" + r.destination_id] = p; }
  return out;
}
const fareRawBart = loadFareRaw("gtfs-bart");   // keyed by BART station-code pairs (== stop_id, same as `code`)
const fareRawCt = loadFareRaw("gtfs-caltrain"); // keyed by Caltrain zone-id pairs

/* per-trip stop order → the departure schedule, each trip's terminal, and the travel-time pairs */
const sched = {}, ttLists = {};
for(const tr of tripStops){
  if(tr.stops.length < 2) continue;
  tr.stops.sort((a,b) => a[2] - b[2]);
  const term = tr.stops[tr.stops.length - 1][0];
  /* dwell handling: board at the LAST time a trip shows a station, alight at the FIRST */
  const firstAt = {}, lastAt = {}, order = [];
  for(const [id, t] of tr.stops){ if(!(id in firstAt)){ firstAt[id] = t; order.push(id); } lastAt[id] = t; }
  for(const id of order){ if(id !== term) (sched[id] ||= []).push([lastAt[id], tr.l, tr.d, term]); }
  for(let i = 0; i < order.length; i++) for(let j = i + 1; j < order.length; j++){
    const key = order[i] + ">" + order[j], dt = firstAt[order[j]] - lastAt[order[i]];
    if(dt > 0) ((ttLists[tr.l] ||= {})[key] ||= []).push(dt);
  }
}

/* drop stations with no weekday departures, then remap everything to final indexes */
const active = stations.filter(s => (sched[s.id] || []).length || Object.values(ttLists).some(m => Object.keys(m).some(k => k.endsWith(">" + s.id))));
const idxOf = {}; active.forEach((s, i) => idxOf[s.id] = i);
const schedOut = {};
for(const [id, rows] of Object.entries(sched)){
  rows.sort((a,b) => a[0] - b[0]);
  schedOut[id] = rows.map(([t, l, d, term]) => [t, l, d, idxOf[term] ?? -1]);
}
const median = a => { a.sort((x,y) => x - y); return a[a.length >> 1]; };
const tt = {};
for(const [l, pairs] of Object.entries(ttLists)){
  tt[l] = {};
  for(const [key, list] of Object.entries(pairs)){
    const [o, d] = key.split(">");
    if(idxOf[o] == null || idxOf[d] == null) continue;
    tt[l][idxOf[o] + ">" + idxOf[d]] = median(list);
  }
}
const nDep = Object.values(schedOut).reduce((n,a) => n + a.length, 0);
const nPairs = Object.values(tt).reduce((n,m) => n + Object.keys(m).length, 0);

/* fare: same-operator active-station pairs only, priced via each operator's own raw table
 * (BART: station code pair direct; Caltrain: zone pair via the zoneOf lookup above) */
const fare = {};
for(let i = 0; i < active.length; i++) for(let j = 0; j < active.length; j++){
  if(i === j || active[i].op !== active[j].op) continue;
  const a = active[i], b = active[j], op = a.op;
  const rawA = a.id.slice(op.length + 1), rawB = b.id.slice(op.length + 1);
  const key = op === "bart" ? (rawA + ">" + rawB) : ((zoneOf[rawA] || "") + ">" + (zoneOf[rawB] || ""));
  const price = (op === "bart" ? fareRawBart : fareRawCt)[key];
  if(price != null) fare[i + ">" + j] = price;
}
const nFares = Object.keys(fare).length;
console.log(`stations: ${active.length} (of ${stations.length} in GTFS) · lines: ${lines.length} · dests: ${dests.length} · departures: ${nDep} · travel-time pairs: ${nPairs} · fares: ${nFares}`);

const out = "/* GENERATED by tools/build-data.mjs from BART GTFS (bart.gov) + Caltrain GTFS (511.org) — do not edit by hand */\n"
  + "window.BOARD_DATA = " + JSON.stringify({
      generated: new Date().toISOString().slice(0,10),
      stations: active, lines, dests, sched: schedOut, tt, fare
    }) + ";\n";
writeFileSync("data.js", out);
console.log(`data.js written (${(out.length/1024).toFixed(0)} KB)`);
