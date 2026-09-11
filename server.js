'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');

const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const API_KEY = process.env.AEMET_API_KEY || config.apiKey || '';
const PORT = Number(process.env.PORT || config.port) || 3000;
const HISTORY_DAYS = 90;
const FETCH_TIMEOUT_MS = 45000;
const CACHE_TTL_MS = 30000;

const GREEN = { min: 99.9 };
const YELLOW = { min: 99.0 };

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// Météo-France: token OAuth2 (client_credentials) con renovación automática
// ---------------------------------------------------------------------------
const MF_TOKEN_URL = 'https://portail-api.meteofrance.fr/token';
const MF_BASE = 'https://public-api.meteofrance.fr/public/DPObs/v2';
const MF_MAX_RPS = Math.max(0.5, Number(config.mfMaxRps) || 2);

function normalizeMfCreds(v) {
  if (!v) return [];
  const list = Array.isArray(v) ? v : String(v).split(/[;,]/);
  return list.map((s) => String(s).trim()).filter(Boolean);
}

const mfCreds = normalizeMfCreds(process.env.METEOFRANCE_AUTH || config.meteoFranceAuth);
const mfTokens = [];
const mfTokenPromises = [];
let mfCredCounter = 0;

async function mfGetToken(i) {
  const c = mfTokens[i];
  if (c && c.expiry > Date.now() + 60000) return c.token;
  if (!mfCreds[i]) throw new Error('Falta meteoFranceAuth[' + i + '] en config.json');
  if (!mfTokenPromises[i]) {
    mfTokenPromises[i] = (async () => {
      const res = await fetchWithTimeout(
        MF_TOKEN_URL,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + mfCreds[i] },
          body: 'grant_type=client_credentials'
        },
        20000
      );
      if (!res.ok) throw new Error('Token Météo-France [' + i + ']: HTTP ' + res.status);
      const j = await res.json();
      if (!j.access_token) throw new Error('Respuesta de token sin access_token');
      const expiresInSec = Math.min(Number(j.expires_in) || 3600, 3600);
      mfTokens[i] = { token: j.access_token, expiry: Date.now() + expiresInSec * 1000 };
      console.log('[Météo-France] Cuenta ' + (i + 1) + '/' + mfCreds.length + ': token renovado (' + Math.round(expiresInSec / 60) + ' min)');
      return mfTokens[i].token;
    })().catch((err) => {
      mfTokenPromises[i] = null;
      throw err;
    });
  }
  return mfTokenPromises[i];
}

let mfRateState = { tokens: 0, last: Date.now() };
async function mfGate() {
  const accounts = Math.max(1, mfCreds.length);
  const perSec = MF_MAX_RPS * accounts;
  const capacity = Math.max(1, Math.round(perSec * 0.5));
  while (true) {
    const now = Date.now();
    mfRateState.tokens = Math.min(capacity, mfRateState.tokens + ((now - mfRateState.last) / 1000) * perSec);
    mfRateState.last = now;
    if (mfRateState.tokens >= 1) {
      mfRateState.tokens -= 1;
      return;
    }
    await sleep(200);
  }
}

function mfRetryAfterMs(res) {
  const v = res.headers.get('retry-after');
  if (!v) return 0;
  const d = Date.parse(v);
  if (!Number.isNaN(d)) return Math.max(0, d - Date.now());
  const sec = Number(v);
  if (!Number.isNaN(sec)) return Math.max(0, sec * 1000);
  return 0;
}

console.log('[Météo-France] ' + mfCreds.length + ' cuenta(s) API configurada(s) · ritmo objetivo ~' + MF_MAX_RPS + ' req/s por cuenta');

function parseMfCsv(text) {
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim().length);
  if (lines.length < 2) return [];
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split(';');
    if (f.length < 6 || !f[0]) continue;
    out.push({
      id: String(f[0]).trim(),
      idOmm: (f[1] || '').trim() || null,
      nombre: (f[2] || f[0]).replace(/\s+/g, ' ').trim(),
      lat: Number(f[3]),
      lon: Number(f[4]),
      altitud: f[5] ? Number(f[5]) : null,
      pack: (f[7] || '').trim() || null,
      dateOuverture: (f[6] || '').trim() || null
    });
  }
  return out;
}

async function mfFetchStationList() {
  const token = await mfGetToken(0);
  const res = await fetchWithTimeout(MF_BASE + '/liste-stations', { headers: { Authorization: 'Bearer ' + token } }, FETCH_TIMEOUT_MS);
  if (!res.ok) throw new Error('liste-stations: HTTP ' + res.status);
  return parseMfCsv(await res.text());
}

async function mfTryStation(id, token) {
  let status = 'offline';
  for (const ep of ['infrahoraire-6m', 'horaire']) {
    try {
      const r = await fetchWithTimeout(
        MF_BASE + '/station/' + ep + '?id_station=' + encodeURIComponent(id) + '&format=json',
        { headers: { Authorization: 'Bearer ' + token } },
        15000
      );
      if (r.status === 429 || r.status >= 500) {
        return 'throttled';
      }
      if (r.ok) {
        const b = await r.json();
        if (Array.isArray(b) && b.length > 0) return 'online';
        status = 'offline';
      }
    } catch {
      return 'throttled';
    }
  }
  return status;
}

async function mfStationOnlineAny(id) {
  if (!mfCreds.length) return 'offline';
  let status = 'offline';
  const first = mfCredCounter % mfCreds.length;
  mfCredCounter += 1;
  for (let attempt = 0; attempt < mfCreds.length; attempt++) {
    const credIdx = (first + attempt) % mfCreds.length;
    await mfGate();
    const token = await mfGetToken(credIdx);
    status = await mfTryStation(id, token);
    if (status !== 'throttled') return status;
  }
  return status;
}

// ---------------------------------------------------------------------------
// Motor genérico de monitor
// ---------------------------------------------------------------------------
function createMonitor(name, options) {
  const m = {
    name,
    stations: [],
    checks: [],
    counters: {},
    lastCheckTs: null,
    lastCheckOk: null,
    running: false,
    dataCache: null,
    dataCacheTs: 0,
    stationsFile: path.join(DATA_DIR, options.stationsFile),
    uptimeFile: path.join(DATA_DIR, options.uptimeFile),
    intervalMs: options.intervalMs || 300000,
    doRunCheck: async function runDefault() {
      throw new Error('doRunCheck no implementado para ' + name);
    }
  };

  m.load = function () {
    const st = readJson(m.stationsFile, []);
    if (Array.isArray(st)) m.stations = st;
    const up = readJson(m.uptimeFile, null);
    if (up && Array.isArray(up.checks)) m.checks = up.checks;
    if (up && up.counters && typeof up.counters === 'object') m.counters = up.counters;
    m.lastCheckTs = m.checks.length ? m.checks[m.checks.length - 1].ts : null;
  };

  m.saveStations = function () {
    writeJson(m.stationsFile, m.stations);
  };

  m.saveUptime = function () {
    writeJson(m.uptimeFile, { counters: m.counters, checks: m.checks, updatedAt: Date.now() });
  };

  m.pruneIfNeeded = function () {
    const retentionDays = Number(config.retentionDays);
    if (!retentionDays) return;
    const cutoff = Date.now() - retentionDays * 86400000;
    const keptIdx = firstIndexAtOrAfter(m.checks, cutoff);
    if (keptIdx <= 0) return;
    m.checks = m.checks.slice(keptIdx);
    const newCounters = {};
    for (const s of m.stations) {
      if (!s.firstSeen) continue;
      let total = 0;
      let online = 0;
      for (const ch of m.checks) {
        if (ch.error || s.firstSeen > ch.ts) continue;
        total += 1;
        if (ch.online && ch.online.includes(s.id)) online += 1;
      }
      newCounters[s.id] = { onlineChecks: online, totalChecks: total };
    }
    m.counters = newCounters;
    m.saveUptime();
    console.log(`[prune] ${m.name}: historial podado, quedan ${m.checks.length} checks`);
  };

  m.runCheck = async function () {
    if (m.running) return;
    m.running = true;
    try {
      await m.doRunCheck();
    } finally {
      m.running = false;
    }
  };

  m.buildData = function () {
    const now = Date.now();
    if (m.dataCache && now - m.dataCacheTs < CACHE_TTL_MS && m.lastCheckTs === m.dataCache.lastCheckSeen) {
      return m.dataCache.payload;
    }

    const dayLabels = buildDayLabels(HISTORY_DAYS);
    const dayIndex = new Map();
    dayLabels.forEach((k, i) => dayIndex.set(k, i));

    const cutoff = new Date(now);
    cutoff.setUTCHours(0, 0, 0, 0);
    cutoff.setUTCDate(cutoff.getUTCDate() - (HISTORY_DAYS - 1));

    const dayTotal = new Map();
    const dayOnline = new Map();
    for (const s of m.stations) {
      dayTotal.set(s.id, new Array(HISTORY_DAYS).fill(0));
      dayOnline.set(s.id, new Array(HISTORY_DAYS).fill(0));
    }

    const startIdx = firstIndexAtOrAfter(m.checks, cutoff.getTime());
    for (let i = startIdx; i < m.checks.length; i++) {
      const ch = m.checks[i];
      if (ch.error) continue;
      const di = dayIndex.get(dayKey(ch.ts));
      if (di === undefined) continue;
      for (const s of m.stations) {
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
    const lastCheck = m.checks.length ? m.checks[m.checks.length - 1] : null;

    const stationsOut = m.stations.map((s) => {
      const c = m.counters[s.id];
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
        status: classify(uptime, total),
        onlineNow: isUpNow,
        days90: days
      };
    });

    const payload = {
      generatedAt: now,
      dayLabels,
      global: {
        uptime: sumTotal > 0 ? sumOnline / sumTotal : null,
        totalStations: m.stations.length,
        onlineNow: onlineNowCount,
        onlineNowTotal: onlineNowTotal,
        lastCheckTs: m.lastCheckTs,
        lastCheckOk: m.lastCheckOk,
        intervalMin: m.intervalMs / 60000
      },
      stations: stationsOut
    };

    m.dataCache = { payload, lastCheckSeen: m.lastCheckTs };
    m.dataCacheTs = now;
    return payload;
  };

  return m;
}

// ---------------------------------------------------------------------------
// Monitor AEMET (España)
// ---------------------------------------------------------------------------
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
  return JSON.parse(text);
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

const esMonitor = createMonitor('AEMET', {
  stationsFile: 'stations.json',
  uptimeFile: 'uptime.json',
  intervalMs: (Number(config.intervalMin) || 5) * 60 * 1000
});

esMonitor.doRunCheck = async function () {
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
      const existing = this.stations.find((s) => s.id === st.id);
      if (!existing) {
        st.firstSeen = ts;
        this.stations.push(st);
        this.counters[st.id] = { onlineChecks: 0, totalChecks: 0 };
      } else {
        existing.nombre = st.nombre || existing.nombre;
        if (st.lat !== null) existing.lat = st.lat;
        if (st.lon !== null) existing.lon = st.lon;
        if (st.altitud !== null) existing.altitud = st.altitud;
      }
    }
    this.saveStations();
    this.lastCheckOk = true;
  } catch (e) {
    onlineSet = new Set();
    this.lastCheckOk = false;
    console.error(`[${this.name}] check ERROR ${ts} — ${e.message}. Se cuenta como 0 estaciones online.`);
  }

  for (const s of this.stations) {
    const c = this.counters[s.id] || (this.counters[s.id] = { onlineChecks: 0, totalChecks: 0 });
    if (s.firstSeen && s.firstSeen <= ts) {
      c.totalChecks += 1;
      if (onlineSet.has(s.id)) c.onlineChecks += 1;
    }
  }

  this.checks.push({ ts, online: Array.from(onlineSet) });
  this.saveUptime();
  this.pruneIfNeeded();
  this.lastCheckTs = ts;
  if (onlineSet.size === 0) {
    console.warn(`[${this.name}] check CAÍDA ${ts} — 0 estaciones online (todas caídas)`);
  } else {
    console.log(`[${this.name}] check OK ${ts} — ${this.stations.length} estaciones, ${onlineSet.size} online`);
  }
};

// ---------------------------------------------------------------------------
// Monitor Météo-France (Francia)
// ---------------------------------------------------------------------------
const frMonitor = createMonitor('Météo-France', {
  stationsFile: 'fr-stations.json',
  uptimeFile: 'fr-uptime.json',
  intervalMs: (Number(config.franceIntervalMin) || 5) * 60 * 1000
});

frMonitor.ensureStations = async function (firstSeenTs) {
  if (this.stations.length) return;
  const cached = readJson(this.stationsFile, null);
  if (cached && Array.isArray(cached) && cached.length) {
    this.stations = cached;
    console.log(`[${this.name}] ${this.stations.length} estaciones cargadas de disco`);
    return;
  }
  const list = await mfFetchStationList();
  for (const st of list) st.firstSeen = firstSeenTs;
  this.stations = list;
  this.saveStations();
  console.log(`[${this.name}] ${this.stations.length} estaciones cargadas desde la API`);
};

frMonitor.doRunCheck = async function () {
  const ts = Date.now();
  let onlineSet = new Set();
  let skipSet = new Set();
  try {
    await this.ensureStations(ts);
    if (!mfCreds.length) throw new Error('Falta meteoFranceAuth en config.json');

    let idx = 0;
    const worker = async () => {
      while (idx < this.stations.length) {
        const s = this.stations[idx++];
        const st = await mfStationOnlineAny(s.id);
        if (st === 'online') onlineSet.add(s.id);
        else if (st === 'throttled') skipSet.add(s.id);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(24, Math.round(MF_MAX_RPS * mfCreds.length))) }, worker));

    this.lastCheckOk = true;
  } catch (e) {
    onlineSet = new Set();
    skipSet = new Set();
    this.lastCheckOk = false;
    console.error(`[${this.name}] check ERROR ${ts} — ${e.message}. Se cuenta como 0 estaciones online.`);
  }

  for (const s of this.stations) {
    const c = this.counters[s.id] || (this.counters[s.id] = { onlineChecks: 0, totalChecks: 0 });
    if (s.firstSeen && s.firstSeen <= ts && !skipSet.has(s.id)) {
      c.totalChecks += 1;
      if (onlineSet.has(s.id)) c.onlineChecks += 1;
    }
  }

  this.checks.push({ ts, online: Array.from(onlineSet) });
  this.saveUptime();
  this.pruneIfNeeded();
  this.lastCheckTs = ts;
  if (onlineSet.size === 0 && skipSet.size === 0) {
    console.warn(`[${this.name}] check CAÍDA ${ts} — 0 estaciones online (todas caídas)`);
  } else {
    console.log(
      `[${this.name}] check OK ${ts} — ${this.stations.length} estaciones, ${onlineSet.size} online ` +
      `(${((onlineSet.size / this.stations.length) * 100).toFixed(1)}%) · ${skipSet.size} skippeadas por throttle`
    );
  }
};

// ---------------------------------------------------------------------------
// Utilidades compartidas
// ---------------------------------------------------------------------------
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

function classify(uptime, totalChecks) {
  if (uptime === null || uptime === undefined) return 'grey';
  if (totalChecks < 3) return 'grey';
  const pct = uptime * 100;
  if (pct >= GREEN.min) return 'green';
  if (pct >= YELLOW.min) return 'yellow';
  return 'red';
}

function dayKey(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

function nextAlignedTs(targetMinutes) {
  const now = Date.now();
  for (let i = 0; i < 120; i++) {
    const ms = now + i * 60000;
    const d = new Date(ms);
    if (targetMinutes.includes(d.getMinutes()) && ms >= now + 60000) return ms;
  }
  return now + 60 * 60000;
}

function scheduleMonitor(monitor, targetMinutes) {
  const nextTs = nextAlignedTs(targetMinutes);
  monitor.nextRunTs = nextTs;
  setTimeout(() => {
    monitor.runCheck().then(() => scheduleMonitor(monitor, targetMinutes));
  }, nextTs - Date.now());
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

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
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

function apiData(res, monitor) {
  try {
    const data = monitor.buildData();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/data') {
    apiData(res, esMonitor);
    return;
  }

  if (url.pathname === '/api/data-fr') {
    apiData(res, frMonitor);
    return;
  }

  if (url.pathname === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      aemet: {
        running: esMonitor.running,
        lastCheckTs: esMonitor.lastCheckTs,
        lastCheckOk: esMonitor.lastCheckOk,
        stations: esMonitor.stations.length,
        checks: esMonitor.checks.length,
        nextCheckInMs: esMonitor.nextRunTs ? Math.max(0, esMonitor.nextRunTs - Date.now()) : null
      },
      france: {
        running: frMonitor.running,
        lastCheckTs: frMonitor.lastCheckTs,
        lastCheckOk: frMonitor.lastCheckOk,
        stations: frMonitor.stations.length,
        checks: frMonitor.checks.length,
        nextCheckInMs: frMonitor.nextRunTs ? Math.max(0, frMonitor.nextRunTs - Date.now()) : null
      }
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
  console.log(`Monitor AEMET + Météo-France escuchando en http://localhost:${PORT}`);
  console.log(`Horarios: AEMET :01/:31 · Météo-France :00/:20/:40`);
});

// Boot
esMonitor.load();
frMonitor.load();
esMonitor.runCheck();
setTimeout(() => frMonitor.runCheck(), 2000);
scheduleMonitor(esMonitor, [1, 31]);
scheduleMonitor(frMonitor, [0, 20, 40]);