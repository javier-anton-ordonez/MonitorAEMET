'use strict';

(function () {
  const STATUS_COLORS = {
    green: '#28a745',
    yellow: '#dbab09',
    red: '#dc3545',
    grey: '#b3bac5'
  };

  const TILES = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
  const ATTRIB = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://www.aemet.es">AEMET</a> &copy; Météo-France';

  let map;
  let layerGroup;
  let markers = new Map();
  let lastData = { es: null, fr: null };
  let activeView = 'both';
  let openKey = null;
  let dark = false;

  function isDark() {
    return dark;
  }

  function applyTheme(darkMode) {
    dark = darkMode;
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    const btn = document.getElementById('theme-toggle');
    if (btn) btn.textContent = dark ? 'Modo claro' : 'Modo oscuro';
    localStorage.setItem('aemet-theme', dark ? 'dark' : 'light');

    const stroke = getComputedStyle(document.documentElement).getPropertyValue('--map-stroke').trim() || '#ffffff';
    markers.forEach(function (mk) {
      mk.setStyle({ color: stroke });
    });
  }

  function initTheme() {
    const saved = localStorage.getItem('aemet-theme');
    const preferredDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    applyTheme(saved ? saved === 'dark' : preferredDark);
  }

  function initMap() {
    map = L.map('map', {
      center: [45.0, 1.5],
      zoom: 5,
      minZoom: 3,
      maxZoom: 12
    });
    L.tileLayer(TILES, { attribution: ATTRIB, maxZoom: 19 }).addTo(map);
    layerGroup = L.layerGroup().addTo(map);
  }

  function setView(view) {
    activeView = view;
    document.querySelectorAll('.view-btn').forEach(function (b) { b.classList.remove('active'); });
    const btn = document.getElementById('view-' + view);
    if (btn) btn.classList.add('active');
    if (lastData.es || lastData.fr) {
      updateGlobal();
      renderAll();
      fitView();
    }
  }

  function colorFor(status) {
    return STATUS_COLORS[status] || STATUS_COLORS.grey;
  }

  function fmtPct(uptime) {
    if (uptime === null || uptime === undefined) return 'Sin datos';
    return (uptime * 100).toFixed(3) + '%';
  }

  function fmtDate(ts) {
    if (!ts) return '—';
    return new Date(ts).toLocaleString('es-ES', {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });
  }

  function dayCell(label, pct) {
    const tip = label + ' · ' + fmtPct(pct === null ? null : pct / 100);
    if (pct === null) return '<span class="uptime-cell" title="' + tip + '"></span>';
    let cls = 'red';
    if (pct >= 99.0) cls = 'green';
    else if (pct >= 90.0) cls = 'yellow';
    return '<span class="uptime-cell ' + cls + '" title="' + tip + '"></span>';
  }

  function buildPopup(st, dayLabels, flag) {
    let estado;
    if (st.onlineNow === true) {
      estado = '<span class="status-dot on" title="Online ahora"></span> Encendida en el último check';
    } else if (st.onlineNow === false) {
      estado = '<span class="status-dot off" title="Fuera de servicio"></span> Sin respuesta en el último check';
    } else {
      estado = 'Último check con error de red';
    }
    const uptimeClass = st.status === 'green' ? 'green' : (st.status === 'yellow' ? 'yellow' : (st.status === 'red' ? 'red' : 'grey'));
    const geo = [];
    if (st.lat !== null && st.lon !== null) {
      geo.push('Lat ' + st.lat.toFixed(3) + '° · Lon ' + st.lon.toFixed(3) + '°');
    }
    if (st.altitud !== null && st.altitud !== undefined) {
      geo.push('Alt ' + st.altitud + ' m');
    }

    let cells = '';
    for (let i = 0; i < dayLabels.length; i++) {
      cells += dayCell(dayLabels[i], st.days90[i]);
    }

    let meta = 'ID: <b>' + st.id + '</b>';
    if (geo.length) meta += ' · ' + geo.join(' · ');

    return (
      '<div class="popup-title">' + flag + ' ' + escapeHtml(st.nombre) + '</div>' +
      '<div class="popup-meta">' + meta + '</div>' +
      '<div class="popup-status">' + estado + '</div>' +
      '<div class="popup-uptime-label">Uptime histórico</div>' +
      '<div class="popup-uptime ' + uptimeClass + '">' + fmtPct(st.uptime) + '</div>' +
      '<div class="popup-days-label">Últimos 90 días</div>' +
      '<div class="uptime-grid">' + cells + '</div>' +
      '<div class="popup-legend">' +
      '<span><span class="bar green"></span>≥99%</span>' +
      '<span><span class="bar yellow"></span>90–99%</span>' +
      '<span><span class="bar red"></span>&lt;90%</span>' +
      '<span><span class="bar grey"></span>sin datos</span>' +
      '</div>'
    );
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function combineGlobal(a, b) {
    if (!a) return b;
    if (!b) return a;
    const denom = (a.totalStations || 0) + (b.totalStations || 0);
    let up = null;
    if (a.uptime !== null && b.uptime !== null) {
      up = (a.uptime * (a.totalStations || 0) + b.uptime * (b.totalStations || 0)) / denom;
    } else if (a.uptime !== null) up = a.uptime;
    else if (b.uptime !== null) up = b.uptime;
    return {
      uptime: up,
      totalStations: denom,
      onlineNow: (a.onlineNow || 0) + (b.onlineNow || 0),
      onlineNowTotal: (a.onlineNowTotal || 0) + (b.onlineNowTotal || 0),
      lastCheckTs: Math.max(a.lastCheckTs || 0, b.lastCheckTs || 0) || null,
      lastCheckOk: a.lastCheckOk && b.lastCheckOk,
      intervalMin: [a.intervalMin, b.intervalMin]
    };
  }

  function updateGlobal() {
    const combined = combineGlobal(lastData.es && lastData.es.global, lastData.fr && lastData.fr.global);
    const g = activeView === 'es' ? (lastData.es && lastData.es.global) :
      (activeView === 'fr' ? (lastData.fr && lastData.fr.global) : combined);
    const gEl = document.getElementById('global-uptime');
    const oEl = document.getElementById('global-online');
    const lEl = document.getElementById('global-lastcheck');
    const fEl = document.getElementById('footer');

    const uptimePct = fmtPct(g && g.uptime !== null ? g.uptime : null);
    gEl.textContent = uptimePct;
    gEl.className = 'stat-value ' + (g && g.uptime !== null && g.uptime >= 0.99 ? 'ok' : (g && g.uptime !== null && g.uptime >= 0.90 ? 'warn' : 'bad'));

    oEl.textContent = (g && g.onlineNowTotal ? g.onlineNow + ' / ' + g.onlineNowTotal : '—');
    oEl.className = 'stat-value ' + (g && g.onlineNowTotal && g.onlineNow === g.onlineNowTotal ? 'ok' : 'warn');
    lEl.textContent = fmtDate(g && g.lastCheckTs);

    let intervalTxt = '';
    if (g && Array.isArray(g.intervalMin)) {
      intervalTxt = 'Check ES/FR: ' + g.intervalMin.join('/') + ' min';
    } else if (g && g.intervalMin) {
      intervalTxt = 'Check cada ' + g.intervalMin + ' min';
    }
    let warn = '';
    if (g && g.lastCheckOk === false) warn = ' · ⚠ Última petición a AEMET o Météo-France falló';
    fEl.textContent = 'Actualizado: ' + new Date(dataGeneratedAt()).toLocaleString('es-ES') +
      ' · ' + intervalTxt + ' · Total estaciones: ' + (g ? g.totalStations : '—') + warn;
  }

  function dataGeneratedAt() {
    const es = lastData.es, fr = lastData.fr;
    if (es && fr) return Math.max(es.generatedAt, fr.generatedAt);
    return (es || fr || {}).generatedAt || Date.now();
  }

  function renderAll() {
    const stroke = getComputedStyle(document.documentElement).getPropertyValue('--map-stroke').trim() || '#ffffff';
    const items = [];

    const add = function (country, data) {
      if (!data) return;
      const flag = country === 'es' ? '🇪🇸' : '🇫🇷';
      data.stations.forEach(function (st) {
        if (st.lat === null || st.lon === null) return;
        items.push({ key: country + '-' + st.id, st: st, flag: flag, dayLabels: data.dayLabels });
      });
    };

    const showEs = activeView !== 'fr';
    const showFr = activeView !== 'es';
    if (showEs) add('es', lastData.es);
    if (showFr) add('fr', lastData.fr);

    const newMarkers = new Map();
    items.forEach(function (item) {
      let mk = markers.get(item.key);
      if (!mk) {
        const latlng = L.latLng(item.st.lat, item.st.lon);
        mk = L.circleMarker(latlng, {
          radius: 6,
          weight: 1.5,
          color: stroke,
          fillColor: colorFor(item.st.status),
          fillOpacity: 1
        }).addTo(layerGroup);
        mk.on('click', function () {
          openKey = item.key;
          mk.bindPopup(buildPopup(item.st, item.dayLabels, item.flag), { maxWidth: 360, minWidth: 280 }).openPopup();
        });
      } else {
        mk.setStyle({ fillColor: colorFor(item.st.status), fillOpacity: 1 });
        if (mk.getPopup() && mk.getPopup().isOpen()) {
          mk.getPopup().setContent(buildPopup(item.st, item.dayLabels, item.flag));
        }
      }
      newMarkers.set(item.key, mk);
    });

    markers.forEach(function (mk, key) {
      if (!newMarkers.has(key)) layerGroup.removeLayer(mk);
    });
    markers = newMarkers;

    if (openKey) {
      const found = items.find(function (i) { return i.key === openKey; });
      const mk = markers.get(openKey);
      if (found && mk && mk.getPopup() && mk.getPopup().isOpen()) {
        mk.getPopup().setContent(buildPopup(found.st, found.dayLabels, found.flag));
      } else {
        openKey = null;
      }
    }
  }

  function fitView() {
    const pts = [];
    const add = function (data) {
      if (!data) return;
      data.stations.forEach(function (s) {
        if (s.lat !== null && s.lon !== null) pts.push([s.lat, s.lon]);
      });
    };
    if (activeView !== 'fr') add(lastData.es);
    if (activeView !== 'es') add(lastData.fr);
    if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [15, 15], maxZoom: 6 });
  }

  async function refresh() {
    try {
      const [es, fr] = await Promise.all([
        fetch('/api/data').then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }),
        fetch('/api/data-fr').then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; })
      ]);
      const firstLoad = !lastData.es && !lastData.fr;
      if (es) {
        lastData.es = es;
        lastData.es.global = es.global;
      }
      if (fr) {
        lastData.fr = fr;
        lastData.fr.global = fr.global;
      }
      updateGlobal();
      renderAll();
      if (firstLoad) fitView();
    } catch (e) {
      document.getElementById('footer').textContent = 'Error cargando datos: ' + e.message;
    }
  }

  function bindViewButtons() {
    document.getElementById('view-es').addEventListener('click', function () { setView('es'); });
    document.getElementById('view-fr').addEventListener('click', function () { setView('fr'); });
    document.getElementById('view-both').addEventListener('click', function () { setView('both'); });
  }

  initTheme();
  document.getElementById('theme-toggle').addEventListener('click', function () {
    applyTheme(!isDark());
    renderAll();
  });
  bindViewButtons();

  initMap();
  refresh();
  setInterval(refresh, 30000);
})();