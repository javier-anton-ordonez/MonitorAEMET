'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const STATIONS_FILE = path.join(DATA_DIR, 'stations.json');
const UPTIME_FILE = path.join(DATA_DIR, 'uptime.json');

const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const API_KEY = process.env.AEMET_API_KEY || config.apiKey || '';
const PORT = Number(process.env.PORT || config.port) || 3000;
const CHECK_INTERVAL_MS = (Number(config.intervalMin) || 5) * 60 * 1000;
const HISTORY_DAYS = 90;
const FETCH_TIMEOUT_MS = 45000;

const GREEN = { min: 99.9 };
const YELLOW = { min: 99.0 };

let stations = [];
let checks = [];
let counters = {};
let lastCheckTs = null;
let lastCheckOk = null;
let running = false;
let dataCache = null;
let dataCacheTs = 0;
const CACHE_TTL_MS = 30000;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

function loadData() {
  const st = readJson(STATIONS_FILE, []);
  if (Array.isArray(st)) stations = st;
  const up = readJson(UPTIME_FILE, null);
  if (up && Array.isArray(up.checks)) checks = up.checks;
  if (up && up.counters && typeof up.counters === 'object') counters = up.counters;
  lastCheckTs = checks.length ? checks[checks.length - 1].ts : null;
}

function saveStations() {
  writeJson(STATIONS_FILE, stations);
}

function saveUptime() {
  writeJson(UPTIME_FILE, { counters, checks, updatedAt: Date.now() });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAllObservations() {
  const metaUrl = 'https://opendata.aemet.es/opendata/api/observacion/convencional/todas';
  const res1 = await fetchWithTimeout(
    metaUrl,
    { headers: { 'api_key': API_KEY, 'cache-control': 'no-cache' } },
    FETCH_TIMEOUT_MS
  );
  if (!res1.ok) throw new Error('HTTP ' + res1.status + ' en API');
  const j1 = await res1.json();
  if (!j1 || !j1.datos) {
    throw new Error('Respuesta API sin URL de datos: ' + JSON.stringify(j1).slice(0, 300));
  }
  const res2 = await fetchWithTimeout(
    j1.datos,
    { headers: { 'api_key': API_KEY } },
    FETCH_TIMEOUT_MS
  );
  if (!res2.ok) throw new Error('HTTP ' + res2.status + ' al obtener datos');
  const buf = Buffer.from(await res2.arrayBuffer());
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    text = buf.toString('latin1');
  }
  let obs;
  try {
    obs = JSON.parse(text);
  } catch {
    throw new Error('Respuesta de datos no es JSON válido');
  }
  return Array.isArray(obs) ? obs : [];
}

function normalizeStation(o) {
  const parse = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    id: String(o.idema || o.id),
    nombre: (o.ubi || o.nombre || o.idema || '').replace(/\s+/g, ' ').trim(),
    lat: parse(o.lat ?? o.latitud),
    lon: parse(o.lon ?? o.longitud),
    altitud: parse(o.alt ?? o.altitud)
  };
}

function pruneIfNeeded() {
  const retentionDays = Number(config.retentionDays);
  if (!retentionDays) return;
  const cutoff = Date.now() - retentionDays * 86400000;
  const keptIdx = firstIndexAtOrAfter(checks, cutoff);
  if (keptIdx <= 0) return;
  checks = checks.slice(keptIdx);
  const newCounters = {};
  for (const s of stations) {
    if (!s.firstSeen) continue;
    let total = 0;
    let online = 0;
    for (const ch of checks) {
      if (ch.error || s.firstSeen > ch.ts) continue;
      total += 1;
      if (ch.online && ch.online.includes(s.id)) online += 1;
    }
    newCounters[s.id] = { onlineChecks: online, totalChecks: total };
  }
  counters = newCounters;
  saveUptime();
  console.log(`[prune] Historial podado: quedan ${checks.length} checks (${retentionDays} días)`);
}

async function runCheck() {
  if (running) return;
  running = true;
  try {
    await doRunCheck();
  } finally {
    running = false;
  }
}

async function doRunCheck() {
  const ts = Date.now();
  let onlineSet = new Set();
  try {
    const obs = await fetchAllObservations();
    const parsed = [];
    for (const o of obs) {
      if (!o.idema) continue;
      const st = normalizeStation(o);
      onlineSet.add(st.id);
      parsed.push(st);
    }
    for (const st of parsed) {
      const existing = stations.find((s) => s.id === st.id);
      if (!existing) {
        st.firstSeen = ts;
        stations.push(st);
        counters[st.id] = { onlineChecks: 0, totalChecks: 0 };
      } else {
        existing.nombre = st.nombre || existing.nombre;
        if (st.lat !== null) existing.lat = st.lat;
        if (st.lon !== null) existing.lon = st.lon;
        if (st.altitud !== null) existing.altitud = st.altitud;
      }
    }
    saveStations();
    lastCheckOk = true;
  } catch (e) {
    onlineSet = new Set();
    lastCheckOk = false;
    console.error(`[check ERROR] ${ts} — ${e.message}. Se cuenta como 0 estaciones online.`);
  }

  for (const s of stations) {
    const c = counters[s.id] || (counters[s.id] = { onlineChecks: 0, totalChecks: 0 });
    if (s.firstSeen && s.firstSeen <= ts) {
      c.totalChecks += 1;
      if (onlineSet.has(s.id)) c.onlineChecks += 1;
    }
  }

  checks.push({ ts, online: Array.from(onlineSet) });
  saveUptime();
  pruneIfNeeded();
  lastCheckTs = ts;
  if (onlineSet.size === 0) {
    console.warn(`[check CAÍDA] ${ts} — 0 estaciones online (todas caídas)`);
  } else {
    console.log(`[check OK] ${ts} — ${stations.length} estaciones, ${onlineSet.size} online`);
  }
}

function firstIndexAtOrAfter(arr, ts) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].ts < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function classify(uptime) {
  if (uptime === null || uptime === undefined) return 'grey';
  const pct = uptime * 100;
  if (pct >= GREEN.min) return 'green';
  if (pct >= YELLOW.min) return 'yellow';
  return 'red';
}

function dayKey(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

function buildDayLabels(days) {
  const labels = [];
  const now = new Date();
  now.setUTCHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    labels.push(d.toISOString().slice(0, 10));
  }
  return labels;
}

function buildData() {
  const now = Date.now();
  if (dataCache && now - dataCacheTs < CACHE_TTL_MS && lastCheckTs === dataCache.lastCheckSeen) {
    return dataCache.payload;
  }

  const dayLabels = buildDayLabels(HISTORY_DAYS);
  const dayIndex = new Map();
  dayLabels.forEach((k, i) => dayIndex.set(k, i));

  const cutoff = new Date(now);
  cutoff.setUTCHours(0, 0, 0, 0);
  cutoff.setUTCDate(cutoff.getUTCDate() - (HISTORY_DAYS - 1));

  const dayTotal = new Map();
  const dayOnline = new Map();
  for (const s of stations) {
    dayTotal.set(s.id, new Array(HISTORY_DAYS).fill(0));
    dayOnline.set(s.id, new Array(HISTORY_DAYS).fill(0));
  }

  const startIdx = firstIndexAtOrAfter(checks, cutoff.getTime());
  for (let i = startIdx; i < checks.length; i++) {
    const ch = checks[i];
    if (ch.error) continue;
    const di = dayIndex.get(dayKey(ch.ts));
    if (di === undefined) continue;
    for (const s of stations) {
      if (s.firstSeen && s.firstSeen <= ch.ts) {
        dayTotal.get(s.id)[di] += 1;
        if (ch.online && ch.online.includes(s.id)) dayOnline.get(s.id)[di] += 1;
      }
    }
  }

  let sumOnline = 0;
  let sumTotal = 0;
  let onlineNowCount = 0;
  let onlineNowTotal = 0;
  const lastCheck = checks.length ? checks[checks.length - 1] : null;

  const stationsOut = stations.map((s) => {
    const c = counters[s.id];
    const total = c ? c.totalChecks : 0;
    const up = c ? c.onlineChecks : 0;
    if (total > 0) {
      sumOnline += up;
      sumTotal += total;
    }
    let isUpNow = null;
    if (lastCheck && !lastCheck.error && s.firstSeen && s.firstSeen <= lastCheck.ts) {
      onlineNowTotal += 1;
      isUpNow = !!lastCheck.online.includes(s.id);
      if (isUpNow) onlineNowCount += 1;
    }

    const uptime = total > 0 ? up / total : null;
    const dt = dayTotal.get(s.id);
    const do2 = dayOnline.get(s.id);
    const days = [];
    for (let d = 0; d < HISTORY_DAYS; d++) {
      if (dt[d] > 0) days.push(Math.round((do2[d] / dt[d]) * 10000) / 100);
      else days.push(null);
    }

    return {
      id: s.id,
      nombre: s.nombre,
      lat: s.lat,
      lon: s.lon,
      altitud: s.altitud,
      firstSeen: s.firstSeen,
      uptime,
      status: classify(uptime),
      onlineNow: isUpNow,
      days90: days
    };
  });

  const payload = {
    generatedAt: now,
    dayLabels,
    global: {
      uptime: sumTotal > 0 ? sumOnline / sumTotal : null,
      totalStations: stations.length,
      onlineNow: onlineNowCount,
      onlineNowTotal: onlineNowTotal,
      lastCheckTs,
      lastCheckOk,
      intervalMin: CHECK_INTERVAL_MS / 60000
    },
    stations: stationsOut
  };

  dataCache = { payload, lastCheckSeen: lastCheckTs };
  dataCacheTs = now;
  return payload;
}

// HTTP server
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/data') {
    try {
      const data = buildData();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url.pathname === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      running,
      lastCheckTs,
      lastCheckOk,
      stations: stations.length,
      checks: checks.length,
      nextCheckInMs: lastCheckTs ? Math.max(0, lastCheckTs + CHECK_INTERVAL_MS - Date.now()) : null
    }));
    return;
  }

  let filePath = path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  try {
    const stat = await fs.promises.stat(filePath);
    if (stat.isDirectory()) filePath = path.join(filePath, 'index.html');
  } catch {
    filePath = path.join(PUBLIC_DIR, 'index.html');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
});

server.listen(PORT, () => {
  console.log(`Monitor AEMET escuchando en http://localhost:${PORT}`);
  console.log(`Polling cada ${CHECK_INTERVAL_MS / 60000} min`);
});

// Boot
loadData();
runCheck();
setInterval(runCheck, CHECK_INTERVAL_MS);