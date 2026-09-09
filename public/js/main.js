'use strict';

(function () {
  const STATUS_COLORS = {
    green: '#28a745',
    yellow: '#dbab09',
    red: '#dc3545',
    grey: '#b3bac5'
  };

  const TILES = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
  const ATTRIB = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://www.aemet.es">AEMET</a>';

  let map;
  let tileLayer;
  let layerGroup;
  let markers = new Map();
  let lastData = null;
  let openPopupId = null;
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
      center: [40.0, -3.7],
      zoom: 6,
      minZoom: 4,
      maxZoom: 12
    });
    tileLayer = L.tileLayer(TILES, {
      attribution: ATTRIB,
      maxZoom: 19
    }).addTo(map);
    layerGroup = L.layerGroup().addTo(map);
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

  function buildPopup(st, dayLabels) {
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
      '<div class="popup-title">' + escapeHtml(st.nombre) + '</div>' +
      '<div class="popup-meta">' + meta + '</div>' +
      '<div class="popup-status">' + estado + '</div>' +
      '<div class="popup-uptime-label">Uptime histórico</div>' +
      '<div class="popup-uptime ' + uptimeClass + '">' + fmtPct(st.uptime) + '</div>' +
      '<div class="popup-days-label">Últimos 90 días</div>' +
      '<div class="uptime-grid">' + cells + '</div>' +
      '<div class="popup-legend">' +
      '<span><span class="bar green"></span>100%</span>' +
      '<span><span class="bar yellow"></span>≥99%</span>' +
      '<span><span class="bar red"></span>&lt;99%</span>' +
      '<span><span class="bar grey"></span>sin datos</span>' +
      '</div>'
    );
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function updateGlobal(data) {
    const g = data.global;
    const gEl = document.getElementById('global-uptime');
    const oEl = document.getElementById('global-online');
    const lEl = document.getElementById('global-lastcheck');
    const fEl = document.getElementById('footer');

    const uptimePct = fmtPct(g.uptime);
    gEl.textContent = uptimePct;
    gEl.className = 'stat-value ' + (g.uptime !== null && g.uptime >= 0.999 ? 'ok' : (g.uptime !== null && g.uptime >= 0.99 ? 'warn' : 'bad'));

    oEl.textContent = (g.onlineNowTotal ? g.onlineNow + ' / ' + g.onlineNowTotal : '—');
    oEl.className = 'stat-value ' + (g.onlineNowTotal && g.onlineNow === g.onlineNowTotal ? 'ok' : 'warn');
    lEl.textContent = fmtDate(g.lastCheckTs);

    fEl.textContent = 'Actualizado: ' + new Date(data.generatedAt).toLocaleString('es-ES') +
      ' · Check cada ' + g.intervalMin + ' min · Total estaciones: ' + g.totalStations +
      (g.lastCheckOk === false ? ' · ⚠ Última petición a AEMET falló' : '');
  }

  function renderMarkers(data) {
    const dayLabels = data.dayLabels;
    const stroke = getComputedStyle(document.documentElement).getPropertyValue('--map-stroke').trim() || '#ffffff';
    const newMarkers = new Map();

    data.stations.forEach(function (st) {
      if (st.lat === null || st.lon === null) return;
      let mk = markers.get(st.id);
      if (!mk) {
        mk = L.circleMarker([st.lat, st.lon], {
          radius: 6,
          weight: 1.5,
          color: stroke,
          fillColor: colorFor(st.status),
          fillOpacity: 1
        });
        mk.on('click', function () {
          openPopupId = st.id;
          mk.bindPopup(buildPopup(st, dayLabels), { maxWidth: 360, minWidth: 280 }).openPopup();
        });
      } else {
        mk.setStyle({ fillColor: colorFor(st.status), fillOpacity: 1 });
      }
      mk.setLatLng([st.lat, st.lon]);
      newMarkers.set(st.id, mk);
      mk.addTo(layerGroup);
    });

    markers.forEach(function (mk, id) {
      if (!newMarkers.has(id)) layerGroup.removeLayer(mk);
    });
    markers = newMarkers;

    if (openPopupId) {
      const st = data.stations.find(function (x) { return x.id === openPopupId; });
      const mk = markers.get(openPopupId);
      if (st && mk && mk.getPopup() && mk.getPopup().isOpen()) {
        mk.getPopup().setContent(buildPopup(st, dayLabels));
      } else {
        openPopupId = null;
      }
    }
  }

  async function refresh() {
    try {
      const resp = await fetch('/api/data');
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const data = await resp.json();
      lastData = data;
      updateGlobal(data);
      renderMarkers(data);
    } catch (e) {
      document.getElementById('footer').textContent = 'Error cargando datos: ' + e.message;
    }
  }

  initTheme();

  document.getElementById('theme-toggle').addEventListener('click', function () {
    applyTheme(!isDark());
    if (lastData) renderMarkers(lastData);
  });

  initMap();
  refresh();
  setInterval(refresh, 30000);
})();
