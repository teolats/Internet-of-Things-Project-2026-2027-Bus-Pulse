/* BusPulse dashboard logic */
(function () {
  "use strict";
  const BP = window.BusPulse, store = BP.store, LV = BP.LEVELS, ET = BP.EVENT_TYPES;
  const route = BP.routes["6"];
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const busColors = ["#1F7A70", "#E9A23B", "#3B6FB6", "#C2410C", "#7A5AA6", "#5A6B71", "#2E9E6B", "#B5651D"];
  const colorOf = id => busColors[(parseInt(id.replace(/\D/g, ""), 10) || 0) % busColors.length];
  let view = "overview", selected = null, alertFilter = "all", sortKey = "busId", sortDir = 1;

  $("lineName").textContent = route.name;

  // ------------------------------------------------------------ navigation
  const titles = { overview: "Overview", fleet: "Fleet", comfort: "Comfort & air", obstructions: "Double parking (YOLO)", reports: "Reports & AI", settings: "Settings" };
  function show(v) {
    view = v;
    document.querySelectorAll("#nav a").forEach(a => a.classList.toggle("active", a.dataset.view === v));
    document.querySelectorAll(".view").forEach(s => s.classList.toggle("active", s.id === "view-" + v));
    $("viewTitle").textContent = titles[v];
    if (location.hash !== "#" + v) history.replaceState(null, "", "#" + v);
    setTimeout(() => { Object.values(maps).forEach(m => { if (m) { m.invalidateSize(); m.fitBounds(route.stops.map(s => [s.lat, s.lon]), { padding: [24, 24] }); } }); render(true); }, 30);
  }
  document.querySelectorAll("#nav a").forEach(a => a.addEventListener("click", () => show(a.dataset.view)));

  // ------------------------------------------------------------ maps
  const maps = {};
  function makeMap(id) {
    if (!window.L) { $(id).innerHTML = '<div class="empty">Map library not loaded</div>'; return null; }
    const m = L.map(id, { zoomControl: true, attributionControl: true, zoomSnap: 0.25 }).fitBounds(route.stops.map(s => [s.lat, s.lon]), { padding: [30, 30] });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(m);
    L.polyline(route.stops.map(s => [s.lat, s.lon]), { color: "#1F7A70", weight: 6, opacity: .75 }).addTo(m);
    route.stops.forEach(s => L.marker([s.lat, s.lon], { icon: L.divIcon({ className: "", html: '<div class="stopmk"></div>', iconSize: [12, 12] }) })
      .bindTooltip(s.name, { direction: "right", offset: [8, 0], permanent: id === "map", className: "stoplbl" }).addTo(m));
    return m;
  }
  maps.main = makeMap("map");
  maps.obs = makeMap("obsMap");
  const busMarkers = new Map(), obsLayer = maps.obs ? L.layerGroup().addTo(maps.obs) : null, obsMainLayer = maps.main ? L.layerGroup().addTo(maps.main) : null;
  $("legend").innerHTML = Object.values(LV).map(l => `<span><i style="background:${l.color}"></i>${l.label}</span>`).join("") +
    '<span><i style="background:#E9A23B;border-radius:3px"></i>Double parking (last hour)</span>';

  function renderMap() {
    if (!maps.main) return;
    store.buses.forEach(t => {
      const c = LV[t.occupancyLevel].color;
      const html = `<div class="busmk" style="background:${c}" title="${t.busId}">${t.passengers}</div>`;
      let mk = busMarkers.get(t.busId);
      if (!mk) {
        mk = L.marker([t.lat, t.lon], { icon: L.divIcon({ className: "", html, iconSize: [34, 34], iconAnchor: [17, 17] }), zIndexOffset: 500 }).addTo(maps.main);
        mk.on("click", () => { selected = t.busId; show("fleet"); });
        busMarkers.set(t.busId, mk);
      } else { mk.setLatLng([t.lat, t.lon]); mk.setIcon(L.divIcon({ className: "", html, iconSize: [34, 34], iconAnchor: [17, 17] })); }
      mk.bindTooltip(`<b>${t.busId}</b> · ${t.direction === "outbound" ? "to Rio" : "to centre"}<br>${t.passengers} on board · ${LV[t.occupancyLevel].label}<br>CO₂ ${t.co2} ppm · comfort ${t.comfort}`);
    });
    obsMainLayer.clearLayers();
    const now = new Date(store.lastTs);
    store.events.filter(e => e.type === "obstruction" && now - new Date(e.ts) < 3600000).forEach(e =>
      L.marker([e.lat + 0.0006, e.lon - 0.0009], { icon: L.divIcon({ className: "", html: '<div class="obsmk">P</div>', iconSize: [22, 22] }) })
        .bindTooltip(`${esc(e.message)}<br>${BP.fmtTime(e.ts)} · ${Math.round((e.durationS || 0) / 60)} min`).addTo(obsMainLayer));
  }

  // ------------------------------------------------------------ KPIs
  function renderKpis() {
    const st = BP.stats();
    $("kBuses").textContent = st.buses;
    $("kPax").textContent = st.passengers;
    $("kPaxNote").textContent = `${Math.round(st.passengers / Math.max(1, st.buses))} per bus on average`;
    $("kCrowd").innerHTML = `${st.crowded}<small> / ${st.buses}</small>`;
    $("kComfort").innerHTML = `${st.comfort.toFixed(1)}<small> / 5</small>`;
    $("kComfortBar").style.width = (st.comfort / 5 * 100) + "%";
    $("kAlerts").textContent = st.openAlerts;
    $("kAlerts").parentNode.classList.toggle("warn", st.openAlerts > 0);
    $("kObs").textContent = st.obstructionsToday;
    const hs = BP.hotspots();
    $("kObsNote").textContent = hs.length ? `most at ${hs[0].stop}` : "none yet";
    $("navObs").textContent = st.obstructionsToday;
  }

  // ------------------------------------------------------------ alerts feed
  const groups = [["all", "All"], ["obstruction", "Double parking"], ["air", "Air & temperature"], ["driving", "Driving"], ["crowding", "Crowding"]];
  $("alertChips").innerHTML = groups.map(([k, l]) => `<button class="chip${k === "all" ? " on" : ""}" data-k="${k}">${l}</button>`).join("");
  $("alertChips").addEventListener("click", e => {
    const b = e.target.closest(".chip"); if (!b) return;
    alertFilter = b.dataset.k; document.querySelectorAll("#alertChips .chip").forEach(c => c.classList.toggle("on", c === b)); renderAlerts();
  });
  function renderAlerts() {
    const list = store.events.filter(e => alertFilter === "all" || (ET[e.type] && ET[e.type].group === alertFilter)).slice(0, 40);
    $("alertCount").textContent = `${store.events.length} events`;
    $("alerts").innerHTML = list.length ? list.map(e => `<li class="${e.severity}"><div class="ic">${(ET[e.type] || {}).icon || "•"}</div>
      <div><b>${esc((ET[e.type] || {}).label || e.type)} · ${esc(e.busId)}</b><p>${esc(e.message)}</p></div><time>${BP.fmtTime(e.ts)}</time></li>`).join("")
      : '<li><div></div><div class="muted">No events</div></li>';
  }

  // ------------------------------------------------------------ line strip
  function renderStrip() {
    const W = 1000, H = 220, x0 = 60, x1 = 940, yLine = 110, L = route.length;
    const X = s => x0 + (x1 - x0) * s / L;
    let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="Inter,Segoe UI,Arial">
      <line x1="${x0}" y1="${yLine}" x2="${x1}" y2="${yLine}" stroke="#1F7A70" stroke-width="6" stroke-linecap="round"/>`;
    route.stops.forEach((s, i) => {
      svg += `<circle cx="${X(s.s)}" cy="${yLine}" r="7" fill="#fff" stroke="#102A33" stroke-width="3"/>
        <text x="${X(s.s)}" y="${yLine + (i % 2 ? -14 : 24)}" font-size="11" text-anchor="middle" fill="#5A6B71" font-weight="600">${esc(s.name)}</text>`;
    });
    const placed = { outbound: [], inbound: [] };
    [...store.buses.values()].map(t => ({ t, x: X(BP.busPosition(t)) })).sort((a, b) => a.x - b.x).forEach(({ t, x }) => {
      const out = t.direction === "outbound", lane = placed[t.direction];
      let level = 0; while (lane.some(p => p.level === level && Math.abs(p.x - x) < 80)) level++;
      lane.push({ x, level });
      const y = out ? 8 + (level % 2) * 34 : 146 + (level % 2) * 34, c = LV[t.occupancyLevel].color;
      svg += `<g><line x1="${x}" y1="${out ? y + 30 : y}" x2="${x}" y2="${out ? yLine - 10 : yLine + 10}" stroke="${c}" stroke-width="2" stroke-dasharray="3 3"/>
        <rect x="${x - 38}" y="${y}" width="76" height="30" rx="8" fill="${c}" stroke="#fff" stroke-width="1.5"/>
        <text x="${x}" y="${y + 13}" font-size="10" text-anchor="middle" fill="#fff" font-weight="600">${esc(t.busId)} ${out ? "→" : "←"}</text>
        <text x="${x}" y="${y + 25}" font-size="11" text-anchor="middle" fill="#fff" font-weight="800">${t.passengers} pax</text></g>`;
    });
    $("strip").innerHTML = svg + "</svg>";
  }

  // ------------------------------------------------------------ charts
  Chart.defaults.font.family = "Inter, Segoe UI, Roboto, Arial";
  Chart.defaults.font.size = 11;
  Chart.defaults.color = "#5A6B71";
  Chart.defaults.animation = false;
  const charts = {};
  function lineChart(id, field, opts) {
    return new Chart($(id), {
      type: "line", data: { datasets: [] },
      options: Object.assign({ responsive: true, maintainAspectRatio: false, parsing: false, interaction: { mode: "nearest", intersect: false },
        scales: { x: { type: "linear", ticks: { callback: v => { const d = new Date(v); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); }, maxTicksLimit: 6 }, grid: { display: false } },
          y: { grid: { color: "#EEF2F0" } } },
        plugins: { legend: { position: "bottom", labels: { boxWidth: 10, boxHeight: 10 } } }, elements: { point: { radius: 0 }, line: { borderWidth: 2, tension: .3 } } }, opts || {})
    });
  }
  function seriesFor(field, minutes) {
    const end = store.lastTs ? new Date(store.lastTs).getTime() : Date.now();
    return [...store.history.entries()].sort().map(([id, h]) => ({
      label: id, borderColor: colorOf(id), backgroundColor: colorOf(id),
      data: h.filter((p, i) => end - new Date(p.ts).getTime() <= minutes * 60000 && i % 2 === 0).map(p => ({ x: new Date(p.ts).getTime(), y: p[field] }))
    }));
  }
  function initCharts() {
    charts.hourly = new Chart($("chHourly"), { type: "bar", data: { labels: [], datasets: [{ data: [], backgroundColor: "#1F7A70", borderRadius: 4 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { display: false } }, y: { grid: { color: "#EEF2F0" }, title: { display: true, text: "avg passengers" } } } } });
    charts.co2 = lineChart("chCo2", "co2", {});
    charts.co2.options.plugins.annotationLine = true;
    charts.comfort = new Chart($("chComfort"), { type: "bar", data: { labels: [], datasets: [{ data: [], backgroundColor: [], borderRadius: 4 }] },
      options: { indexAxis: "y", responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { min: 0, max: 5, grid: { color: "#EEF2F0" } }, y: { grid: { display: false } } } } });
    charts.temp = lineChart("chTemp", "temperature");
    charts.noise = lineChart("chNoise", "noise");
  }
  // horizontal limit line plugin (CO2 1500 ppm)
  Chart.register({ id: "limit", afterDraw(c) {
    if (c.canvas.id !== "chCo2") return;
    const y = c.scales.y.getPixelForValue(1500), ctx = c.ctx; if (!isFinite(y)) return;
    ctx.save(); ctx.strokeStyle = "#C2410C"; ctx.setLineDash([5, 4]); ctx.beginPath(); ctx.moveTo(c.chartArea.left, y); ctx.lineTo(c.chartArea.right, y); ctx.stroke();
    ctx.fillStyle = "#C2410C"; ctx.font = "600 10px Inter, Arial"; ctx.fillText("1,500 ppm limit", c.chartArea.left + 4, y - 4); ctx.restore();
  } });
  function renderCharts() {
    const hrs = store.hourly.map((h, i) => ({ i, v: h.n ? h.sum / h.n : null })).filter(h => h.v !== null);
    charts.hourly.data.labels = hrs.map(h => String(h.i).padStart(2, "0") + ":00");
    charts.hourly.data.datasets[0].data = hrs.map(h => Math.round(h.v));
    charts.hourly.update("none");
    const end = store.lastTs ? new Date(store.lastTs).getTime() : Date.now();
    [charts.co2, charts.temp, charts.noise].forEach(c => { c.options.scales.x.min = end - 3600000; c.options.scales.x.max = end; c.options.scales.x.ticks.stepSize = 600000; });
    charts.co2.data.datasets = seriesFor("co2", 60); charts.co2.update("none");
    const b = [...store.buses.values()].sort((a, c) => a.busId.localeCompare(c.busId));
    charts.comfort.data.labels = b.map(x => x.busId);
    charts.comfort.data.datasets[0].data = b.map(x => x.comfort);
    charts.comfort.data.datasets[0].backgroundColor = b.map(x => x.comfort >= 4 ? "#1F7A70" : x.comfort >= 3 ? "#E9A23B" : "#C2410C");
    charts.comfort.update("none");
    if (view === "comfort") {
      charts.temp.data.datasets = seriesFor("temperature", 60); charts.temp.update("none");
      charts.noise.data.datasets = seriesFor("noise", 60); charts.noise.update("none");
    }
  }

  // ------------------------------------------------------------ fleet table + detail
  document.querySelectorAll("#fleet th").forEach(th => th.addEventListener("click", () => {
    const k = th.dataset.k; sortDir = sortKey === k ? -sortDir : (k === "busId" ? 1 : -1); sortKey = k; renderFleet();
  }));
  $("fleet").querySelector("tbody").addEventListener("click", e => { const tr = e.target.closest("tr"); if (tr) { selected = tr.dataset.id; renderFleet(); renderDetail(); } });
  function pill(lvl) { return `<span class="pill" style="background:${LV[lvl].color}">${LV[lvl].short}</span>`; }
  function loadBar(t) {
    return `<span class="load"><span class="se" style="width:${t.seated / t.capacity * 100}%"></span><span class="st" style="left:${t.seated / t.capacity * 100}%;width:${t.standing / t.capacity * 100}%"></span></span>`;
  }
  function renderFleet() {
    const rows = [...store.buses.values()].sort((a, b) => (a[sortKey] > b[sortKey] ? 1 : a[sortKey] < b[sortKey] ? -1 : 0) * sortDir);
    if (!selected && rows.length) selected = rows[0].busId;
    $("fleet").querySelector("tbody").innerHTML = rows.map(t => `<tr data-id="${t.busId}" class="${t.busId === selected ? "sel" : ""}">
      <td><b>${t.busId}</b></td><td>${t.direction === "outbound" ? "→ Rio" : "← Centre"}</td><td>${esc(t.nextStop)}</td>
      <td>${loadBar(t)}<b>${t.passengers}</b> ${pill(t.occupancyLevel)}</td>
      <td class="${t.co2 > 1500 ? "bad" : ""}">${t.co2}</td><td class="${t.temperature > 27 || t.temperature < 18 ? "bad" : ""}">${t.temperature} °C</td>
      <td>${t.noise} dB</td><td>${t.speed} km/h</td><td class="${t.comfort < 3 ? "bad" : t.comfort >= 4 ? "ok" : ""}">${t.comfort}</td></tr>`).join("");
  }
  let detailCharts = [];
  function renderDetail() {
    const t = store.buses.get(selected); if (!t) return;
    const h = store.history.get(selected) || [];
    const evs = store.events.filter(e => e.busId === selected).slice(0, 6);
    const parts = BP.comfortParts(t);
    $("detail").innerHTML = `<div class="detail-head"><h3>${t.busId}</h3>${pill(t.occupancyLevel)}<span class="muted">${t.direction === "outbound" ? "to Rio Hospital" : "to the centre"} · next stop ${esc(t.nextStop)}</span></div>
      <div class="metrics">
        <div class="metric"><span>On board</span><b>${t.passengers}</b> <span>${t.seated} seated · ${t.standing} standing</span></div>
        <div class="metric"><span>CO₂</span><b class="${t.co2 > 1500 ? "bad" : ""}">${t.co2}</b> <span>ppm</span></div>
        <div class="metric"><span>Temperature</span><b>${t.temperature}°</b> <span>${t.humidity}% humidity</span></div>
        <div class="metric"><span>Comfort</span><b>${t.comfort}</b> <span>air ${parts.air.toFixed(1)} · smooth ${parts.smooth.toFixed(1)}</span></div>
        <div class="metric"><span>Noise</span><b>${t.noise}</b> <span>dB(A)</span></div>
        <div class="metric"><span>PM2.5</span><b>${t.pm25}</b> <span>µg/m³</span></div>
        <div class="metric"><span>Speed</span><b>${t.speed}</b> <span>km/h · doors ${t.doorsOpen ? "open" : "closed"}</span></div>
        <div class="metric"><span>Phones nearby</span><b>${t.bleDevices}</b> <span>BLE, hashed</span></div>
      </div>
      <div class="grid g-2" style="margin-bottom:6px"><div class="minichart"><canvas id="dPax"></canvas></div><div class="minichart"><canvas id="dCo2"></canvas></div></div>
      <h2 style="margin-top:10px">Recent events</h2><ul class="alerts" style="max-height:200px">${evs.map(e => `<li class="${e.severity}"><div class="ic">${(ET[e.type] || {}).icon || "•"}</div><div><b>${esc((ET[e.type] || {}).label || e.type)}</b><p>${esc(e.message)}</p></div><time>${BP.fmtTime(e.ts)}</time></li>`).join("") || '<li><div></div><div class="muted">No events for this bus</div></li>'}</ul>`;
    detailCharts.forEach(c => c.destroy());
    const mk = (id, field, color, label) => new Chart($(id), { type: "line", data: { datasets: [{ label, data: h.map(p => ({ x: new Date(p.ts).getTime(), y: p[field] })), borderColor: color, backgroundColor: color + "22", fill: true }] },
      options: { responsive: true, maintainAspectRatio: false, parsing: false, plugins: { legend: { display: true, labels: { boxWidth: 10 } } }, elements: { point: { radius: 0 }, line: { borderWidth: 2, tension: .3 } },
        scales: { x: { type: "linear", ticks: { maxTicksLimit: 5, callback: v => new Date(v).toTimeString().slice(0, 5) }, grid: { display: false } }, y: { grid: { color: "#EEF2F0" } } } } });
    detailCharts = [mk("dPax", "passengers", "#1F7A70", "Passengers"), mk("dCo2", "co2", "#E9A23B", "CO₂ (ppm)")];
  }

  // ------------------------------------------------------------ comfort view
  $("grafana").innerHTML = BP.config.grafanaUrl ? `<iframe src="${esc(BP.config.grafanaUrl)}" style="width:100%;height:300px;border:0;border-radius:10px"></iframe>`
    : '<div class="empty">Set <span class="code">grafanaUrl</span> in <span class="code">web/shared/config.js</span> to embed the Grafana panels (InfluxDB history: CO₂, temperature, passengers per line and hour).</div>';
  function renderVent() {
    const rows = [...store.history.entries()].sort().map(([id, h]) => {
      const end = new Date(store.lastTs).getTime(), last = h.filter(p => end - new Date(p.ts).getTime() <= 3600000);
      const above = last.filter(p => p.co2 > 1500).length * 0.5, peak = Math.max(...last.map(p => p.co2), 0), now = (store.buses.get(id) || {}).co2;
      const verdict = above > 15 ? '<span class="bad">Check ventilation</span>' : above > 0 ? "Crowding peaks" : '<span class="ok">OK</span>';
      return `<tr><td><b>${id}</b></td><td>${now} ppm</td><td>${peak} ppm</td><td>${above.toFixed(0)} min</td><td>${verdict}</td></tr>`;
    });
    $("ventTable").querySelector("tbody").innerHTML = rows.join("");
  }

  // ------------------------------------------------------------ obstructions view
  function renderObs() {
    const st = BP.stats(), hs = BP.hotspots(), today = st.eventsToday.filter(e => e.type === "obstruction");
    $("oToday").textContent = today.length;
    $("oTop").textContent = hs.length ? hs[0].stop : "–";
    $("oTopNote").textContent = hs.length ? `${hs[0].count} events in the data` : "";
    const avg = today.length ? today.reduce((a, e) => a + (e.durationS || 0), 0) / today.length : 0;
    $("oAvg").innerHTML = `${(avg / 60).toFixed(1)}<small> min</small>`;
    $("oLost").innerHTML = `${Math.round(today.length * 17 / 60 * 10) / 10}<small> min</small>`;
    $("hotTable").querySelector("tbody").innerHTML = hs.map(h => `<tr><td><b>${esc(h.stop)}</b></td><td>${h.count}</td><td>${(h.avgDur / 60).toFixed(1)} min</td><td>${BP.fmtTime(h.last)}</td></tr>`).join("") || '<tr><td colspan="4" class="muted">No events yet</td></tr>';
    $("obsTable").querySelector("tbody").innerHTML = store.events.filter(e => e.type === "obstruction").slice(0, 30).map(e =>
      `<tr><td>${BP.fmtTime(e.ts)}</td><td>${e.busId}</td><td>${esc(e.stop)}</td><td>${esc(e.vehicleClass)}</td><td>${Math.round((e.confidence || 0) * 100)}%</td><td>${Math.round((e.durationS || 0) / 60 * 10) / 10} min</td></tr>`).join("");
    if (obsLayer) {
      obsLayer.clearLayers();
      hs.forEach(h => L.circleMarker([h.lat, h.lon], { radius: 8 + 3 * Math.sqrt(h.count) * 2, color: "#C2410C", weight: 2, fillColor: "#E9A23B", fillOpacity: .55 })
        .bindTooltip(`<b>${esc(h.stop)}</b><br>${h.count} events · avg ${(h.avgDur / 60).toFixed(1)} min`, { permanent: true, direction: "right", offset: [12, 0] }).addTo(obsLayer));
    }
  }

  // ------------------------------------------------------------ reports + AI
  function weeklyReport() {
    const st = BP.stats(), hs = BP.hotspots(), buses = [...store.buses.values()];
    const peak = store.hourly.map((h, i) => ({ i, v: h.n ? h.sum / h.n : 0 })).sort((a, b) => b.v - a.v)[0];
    const harsh = store.events.filter(e => e.type === "harsh_braking"), bumps = store.events.filter(e => e.type === "road_bump");
    const co2 = store.events.filter(e => e.type === "high_co2"), worst = {};
    co2.forEach(e => { worst[e.busId] = (worst[e.busId] || 0) + 1; });
    const worstBus = Object.entries(worst).sort((a, b) => b[1] - a[1])[0];
    const d = store.lastTs ? new Date(store.lastTs) : new Date();
    return `BusPulse report · Line 6 · ${d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}
(draft written from the collected data; in the final version the lab's LLM writes it)

1. Crowding
• Busiest hour: ${String(peak.i).padStart(2, "0")}:00, with ${Math.round(peak.v)} passengers per bus on average.
• Right now ${st.crowded} of ${st.buses} buses are standing-only or full.
• Recommendation: add one extra trip towards the University in the morning peak.

2. Air and comfort
• Average comfort score: ${st.comfort} / 5.
• ${co2.length} high-CO₂ alerts${worstBus ? `, ${worstBus[1]} of them on ${worstBus[0]}` : ""}.
${worstBus && worstBus[1] >= 2 ? `• ${worstBus[0]} stays above 1,500 ppm even when half empty: check its ventilation.` : "• No bus shows a ventilation fault."}

3. Driving and road surface
• ${harsh.length} harsh-braking events (above 3.3 m/s²).
• ${bumps.length} strong road bumps recorded with their location: shared with the Municipality as a pothole list.

4. Double parking
• ${store.events.filter(e => e.type === "obstruction").length} detections by the front camera.
${hs.slice(0, 3).map((h, i) => `• ${i + 1}. ${h.stop}: ${h.count} events, ${(h.avgDur / 60).toFixed(1)} min on average`).join("\n")}
• Suggested action: Municipal Police checks at ${hs[0] ? hs[0].stop : "the top stop"} during the morning peak.`;
  }
  function renderReport() { $("report").textContent = weeklyReport(); }
  $("btnReport").addEventListener("click", renderReport);
  function download(name, rows) {
    if (!rows.length) return;
    const keys = Object.keys(rows[0]);
    const csv = [keys.join(",")].concat(rows.map(r => keys.map(k => JSON.stringify(r[k] == null ? "" : r[k])).join(","))).join("\n");
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = name; a.click();
  }
  $("btnCsv").addEventListener("click", () => download("buspulse_events.csv", store.events));
  $("btnFleetCsv").addEventListener("click", () => download("buspulse_fleet.csv", [...store.buses.values()]));

  $("llmMode").textContent = BP.config.llm && BP.config.llm.url ? "lab LLM" : "built-in answers (lab LLM not connected yet)";
  const chat = $("chat");
  function addMsg(text, who) { const d = document.createElement("div"); d.className = "msg " + who; d.textContent = text; chat.appendChild(d); chat.scrollTop = chat.scrollHeight; }
  addMsg("Hello! Ask me about crowding, air quality, double parking or driving on line 6.", "a");
  const sugg = ["Which buses are crowded right now?", "Where is the air worst?", "Which stops are blocked most often?", "Summary of the line"];
  $("suggest").innerHTML = sugg.map(s => `<button class="chip" type="button">${s}</button>`).join("");
  $("suggest").addEventListener("click", e => { const b = e.target.closest(".chip"); if (b) askQ(b.textContent); });
  async function askQ(q) { addMsg(q, "q"); addMsg(await BP.ask(q), "a"); }
  $("askForm").addEventListener("submit", e => { e.preventDefault(); const q = $("askInput").value.trim(); if (q) { $("askInput").value = ""; askQ(q); } });

  // ------------------------------------------------------------ settings
  document.querySelector(`input[name=mode][value=${BP.config.mode}]`).checked = true;
  $("broker").value = BP.config.mqtt.url || "";
  $("speed").value = BP.config.demo.speed || 20;
  $("btnSave").addEventListener("click", () => {
    BP.saveSettings({ mode: document.querySelector("input[name=mode]:checked").value, broker: $("broker").value.trim(), speed: +$("speed").value || 20 });
    location.href = location.pathname + location.hash;
  });

  // ------------------------------------------------------------ status + render loop
  function renderStatus() {
    const s = $("source");
    if (store.source === "demo") { s.className = "badge"; s.textContent = "DEMO DATA"; }
    else if (store.status === "connected") { s.className = "badge live"; s.textContent = "LIVE · MQTT"; }
    else { s.className = "badge err"; s.textContent = "MQTT " + store.status.toUpperCase(); }
    $("clock").textContent = store.lastTs ? store.lastTs.slice(11, 16) : "--:--";
  }
  let lastHeavy = 0;
  function render(force) {
    renderStatus();
    if (!store.buses.size) return;
    renderKpis();
    const heavy = force || Date.now() - lastHeavy > 2500;
    if (view === "overview") { renderMap(); renderAlerts(); renderStrip(); if (heavy) renderCharts(); }
    if (view === "fleet") { renderFleet(); if (heavy || !detailCharts.length) renderDetail(); }
    if (view === "comfort" && heavy) { renderCharts(); renderVent(); }
    if (view === "obstructions" && heavy) renderObs();
    if (view === "reports" && !$("report").textContent) renderReport();
    if (heavy) lastHeavy = Date.now();
  }
  initCharts();
  BP.onUpdate(() => render(false));
  BP.start();
  window.addEventListener("hashchange", () => { const v = location.hash.slice(1); if (titles[v] && v !== view) show(v); });
  const startView = (location.hash || "#overview").slice(1);
  show(titles[startView] ? startView : "overview");
})();
