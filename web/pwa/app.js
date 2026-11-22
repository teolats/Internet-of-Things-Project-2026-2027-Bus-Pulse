/* BusPulse passenger PWA */
(function () {
  "use strict";
  const BP = window.BusPulse, store = BP.store, LV = BP.LEVELS, route = BP.routes["6"];
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  let prefs = { stop: "S2", dir: "outbound", seatAlert: false };
  try { Object.assign(prefs, JSON.parse(localStorage.getItem("buspulse.pwa") || "{}")); } catch (e) { /* ignore */ }
  const save = () => { try { localStorage.setItem("buspulse.pwa", JSON.stringify(prefs)); } catch (e) { /* ignore */ } };
  let tab = "arrivals", openBus = null, alerted = new Set();

  // ------------------------------------------------------------ stop + direction
  $("stop").innerHTML = route.stops.map(s => `<option value="${s.id}">${esc(s.name)} · ${esc(s.nameEn)}</option>`).join("");
  $("stop").value = prefs.stop;
  $("stop").addEventListener("change", () => { prefs.stop = $("stop").value; save(); render(); drawStops(); });
  function setDir(d) { prefs.dir = d; save(); document.querySelectorAll("#dirs button").forEach(b => b.classList.toggle("on", b.dataset.dir === d)); render(); }
  document.querySelectorAll("#dirs button").forEach(b => b.addEventListener("click", () => setDir(b.dataset.dir)));
  setDir(prefs.dir);
  const myStop = () => route.stops.find(s => s.id === prefs.stop);

  // ------------------------------------------------------------ tabs
  function showTab(t) {
    tab = t;
    document.querySelectorAll(".tab").forEach(s => s.classList.toggle("active", s.id === "tab-" + t));
    document.querySelectorAll("#tabbar button").forEach(b => b.classList.toggle("on", b.dataset.tab === t));
    if (t === "map" && map) setTimeout(() => { map.invalidateSize(); map.fitBounds(route.stops.map(s => [s.lat, s.lon]), { padding: [20, 20] }); }, 30);
    render();
  }
  document.querySelectorAll("#tabbar button").forEach(b => b.addEventListener("click", () => showTab(b.dataset.tab)));

  $("levels").innerHTML = Object.values(LV).map(l => `<span><i style="background:${l.color}"></i>${l.label}</span>`).join("");

  // ------------------------------------------------------------ arrivals
  function arrivals() {
    const s = myStop();
    return [...store.buses.values()].map(t => ({ t, eta: BP.eta(t, s.index, prefs.dir) })).sort((a, b) => a.eta - b.eta).slice(0, 5);
  }
  function people(level) {
    const n = { free_seats: 1, few_seats: 2, standing: 3, full: 4 }[level], c = LV[level].color;
    return `<span class="people">${[0, 1, 2, 3].map(i => `<i style="${i < n ? "background:" + c : ""}"></i>`).join("")}</span>`;
  }
  function comfortTag(c) { return `<span class="tag ${c >= 4 ? "good" : c >= 3 ? "mid" : "bad"}">Comfort ${c.toFixed(1)}</span>`; }
  function etaText(sec) { return sec < 60 ? { v: "Now", u: "" } : { v: Math.round(sec / 60), u: "min" }; }
  function renderArrivals() {
    const list = arrivals();
    $("arrivals").innerHTML = list.length ? list.map(({ t, eta }) => {
      const e = etaText(eta), free = Math.max(0, t.seats - t.seated);
      const same = t.direction === prefs.dir;
      return `<li class="arr" data-id="${t.busId}"><div class="eta ${e.u ? "" : "now"}"><b>${e.v}</b><span>${e.u}</span></div>
        <div><div class="id">${t.busId} <small>· ${same ? "now near " + esc(t.nextStop) : "coming back from the terminus"}</small></div>
        <div class="occ">${people(t.occupancyLevel)}<span class="lvl" style="color:${LV[t.occupancyLevel].color}">${LV[t.occupancyLevel].label}</span></div>
        <div class="meta">${comfortTag(t.comfort)}<span class="tag">${t.occupancyLevel === "free_seats" || t.occupancyLevel === "few_seats" ? free + " seats free" : t.standing + " standing"}</span>
        <span class="tag">${t.temperature}°C</span>${t.co2 > 1500 ? '<span class="tag bad">Stuffy air</span>' : ""}</div></div><div class="chev">›</div></li>`;
    }).join("") : '<li class="empty">No buses on the line right now</li>';
    // double parking at my stop, last 20 minutes
    const s = myStop(), now = new Date(store.lastTs);
    const ob = store.events.find(e => e.type === "obstruction" && e.stop === s.name && now - new Date(e.ts) < 20 * 60000);
    $("notice").innerHTML = ob ? `<div class="notice"><span class="ic">🚗</span><div><b>Your stop is often blocked</b>A ${esc(ob.vehicleClass)} was double-parked at ${esc(s.name)} ${BP.fmtAgo(ob.ts)}. The bus may stop a few metres further.</div></div>` : "";
    checkSeatAlert(list);
  }
  $("arrivals").addEventListener("click", e => { const li = e.target.closest(".arr"); if (li) openSheet(li.dataset.id); });

  // ------------------------------------------------------------ seat alert (Notification API)
  $("seatAlert").checked = !!prefs.seatAlert;
  $("seatAlert").addEventListener("change", async () => {
    prefs.seatAlert = $("seatAlert").checked; save();
    if (prefs.seatAlert && "Notification" in window && Notification.permission === "default") { try { await Notification.requestPermission(); } catch (e) { /* ignore */ } }
    toast(prefs.seatAlert ? "We will tell you when a bus with free seats is 5 minutes away." : "Seat alert off.");
  });
  function checkSeatAlert(list) {
    if (!prefs.seatAlert) return;
    list.forEach(({ t, eta }) => {
      if (eta < 330 && eta > 60 && (t.occupancyLevel === "free_seats" || t.occupancyLevel === "few_seats") && !alerted.has(t.busId + prefs.stop)) {
        alerted.add(t.busId + prefs.stop);
        const msg = `${t.busId} arrives at ${myStop().name} in ${Math.round(eta / 60)} min with ${t.seats - t.seated} free seats.`;
        if ("Notification" in window && Notification.permission === "granted") {
          navigator.serviceWorker && navigator.serviceWorker.ready.then(r => r.showNotification("BusPulse · seat alert", { body: msg, icon: "icons/icon-192.png" }))
            .catch(() => new Notification("BusPulse · seat alert", { body: msg }));
        } else toast(msg);
      }
    });
  }
  function toast(m) { const t = $("toast"); t.textContent = m; t.classList.add("show"); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 4200); }

  // ------------------------------------------------------------ bus sheet
  function openSheet(id) { openBus = id; $("sheet").classList.add("open"); renderSheet(); }
  $("sheet").addEventListener("click", e => { if (e.target.id === "sheet" || e.target.closest(".close")) { $("sheet").classList.remove("open"); openBus = null; } });
  function renderSheet() {
    const t = store.buses.get(openBus); if (!t) return;
    const s = myStop(), eta = BP.eta(t, s.index, prefs.dir), e = etaText(eta), parts = BP.comfortParts(t);
    const seats = Array.from({ length: t.seats }, (_, i) => `<i class="${i < t.seated ? "taken" : ""}"></i>`).join("");
    const stand = Array.from({ length: Math.min(t.standing, 48) }, () => '<i class="standing"></i>').join("");
    const pColor = v => v >= 4 ? "#1F7A70" : v >= 2.5 ? "#E9A23B" : "#C2410C";
    const order = t.direction === "outbound" ? route.stops : route.stops.slice().reverse();
    const nextI = order.findIndex(x => x.name === t.nextStop);
    const upcoming = order.slice(Math.max(0, nextI), Math.max(0, nextI) + 5);
    $("sheetBody").innerHTML = `<div class="grab"></div>
      <div class="sh-head"><h3>${t.busId}</h3><span class="tag">Line 6 · ${t.direction === "outbound" ? "to Rio" : "to the centre"}</span><button class="close" aria-label="Close">×</button></div>
      <div class="big"><div class="card"><span class="small">At ${esc(s.name)}, ${prefs.dir === "outbound" ? "to University" : "to the centre"}</span><b>${e.v} ${e.u}</b></div>
        <div class="card"><span class="small">How full</span><b style="color:${LV[t.occupancyLevel].color};font-size:22px">${LV[t.occupancyLevel].label}</b><span class="small">${t.passengers} on board</span></div></div>
      <div class="card"><b>${Math.max(0, t.seats - t.seated)} of ${t.seats} seats free</b>${t.standing ? ` · ${t.standing} standing` : ""}
        <div class="seats">${seats}</div>${stand ? `<div class="seats">${stand}</div>` : ""}<p class="small">Counted by the on-board camera, no images stored.</p></div>
      <div class="card parts"><b>Comfort ${t.comfort.toFixed(1)} / 5</b>
        ${[["Air quality", parts.air, `CO₂ ${t.co2} ppm`], ["Temperature", parts.temperature, `${t.temperature} °C`], ["Quiet", parts.quiet, `${t.noise} dB`], ["Smooth ride", parts.smooth, `${t.harshEvents5min} hard brakes`], ["Space", parts.space, LV[t.occupancyLevel].short]]
          .map(([l, v, d]) => `<div class="row"><span>${l}<br><span class="small">${d}</span></span><div class="bar"><span style="width:${v / 5 * 100}%;background:${pColor(v)}"></span></div><b>${v.toFixed(1)}</b></div>`).join("")}</div>
      <div class="card"><b>Next stops</b><ul class="stops">${upcoming.map(x => `<li class="${x.id === s.id && t.direction === prefs.dir ? "mine" : ""}"><span>${esc(x.name)}</span><span>${Math.max(1, Math.round(BP.eta(t, x.index, t.direction) / 60))} min</span></li>`).join("")}</ul></div>
      <div class="actions"><button class="btn" id="shAlert">Alert me for this bus</button><button class="btn ghost" id="shReport">Report a problem</button></div>`;
    $("shAlert").onclick = () => toast(`We will notify you 3 minutes before ${t.busId} reaches ${s.name}.`);
    $("shReport").onclick = () => toast("Thanks! Your report goes to Astiko KTEL with this trip attached (Sense.City in the final version).");
  }

  // ------------------------------------------------------------ map
  let map = null; const markers = new Map(); let stopLayer = null;
  if (window.L) {
    map = L.map("map", { zoomSnap: 0.25 }).fitBounds(route.stops.map(s => [s.lat, s.lon]), { padding: [20, 20] });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(map);
    L.polyline(route.stops.map(s => [s.lat, s.lon]), { color: "#1F7A70", weight: 6, opacity: .75 }).addTo(map);
    stopLayer = L.layerGroup().addTo(map);
  }
  function drawStops() {
    if (!map) return; stopLayer.clearLayers();
    route.stops.forEach(s => L.marker([s.lat, s.lon], { icon: L.divIcon({ className: "", html: `<div class="stopmk ${s.id === prefs.stop ? "mine" : ""}"></div>`, iconSize: [16, 16] }) })
      .bindTooltip(s.name, { direction: "right", offset: [8, 0] }).addTo(stopLayer));
  }
  drawStops();
  function renderMap() {
    if (!map) return;
    store.buses.forEach(t => {
      const icon = L.divIcon({ className: "", html: `<div class="busmk" style="background:${LV[t.occupancyLevel].color}">${t.passengers}</div>`, iconSize: [30, 30], iconAnchor: [15, 15] });
      let m = markers.get(t.busId);
      if (!m) { m = L.marker([t.lat, t.lon], { icon }).addTo(map); m.on("click", () => openSheet(t.busId)); markers.set(t.busId, m); }
      else { m.setLatLng([t.lat, t.lon]); m.setIcon(icon); }
    });
  }

  // ------------------------------------------------------------ ask
  const chat = $("chat");
  function say(text, who) { const d = document.createElement("div"); d.className = "msg " + who; d.textContent = text; chat.appendChild(d); window.scrollTo(0, document.body.scrollHeight); }
  say("Hi! Ask me whether you will find a seat, how the air is on the bus, or whether your stop is blocked.", "a");
  const sugg = ["Will I find a seat on the next bus?", "Which bus has the best air?", "Is my stop blocked?"];
  $("sugg").innerHTML = sugg.map(s => `<button type="button">${s}</button>`).join("");
  $("sugg").addEventListener("click", e => { if (e.target.tagName === "BUTTON") askQ(e.target.textContent); });
  $("askForm").addEventListener("submit", e => { e.preventDefault(); const q = $("askIn").value.trim(); if (q) { $("askIn").value = ""; askQ(q); } });
  async function askQ(q) {
    say(q, "q");
    const l = q.toLowerCase(), s = myStop(), list = arrivals();
    if (/seat|θέσ|full|γεμ|next|επόμ/.test(l) && list.length) {
      const first = list[0], seat = list.find(x => x.t.occupancyLevel === "free_seats" || x.t.occupancyLevel === "few_seats");
      let a = `The next bus at ${s.name} is ${first.t.busId} in ${Math.max(1, Math.round(first.eta / 60))} min: ${LV[first.t.occupancyLevel].label.toLowerCase()}.`;
      if (seat && seat !== first) a += ` If you want a seat, wait for ${seat.t.busId} in ${Math.round(seat.eta / 60)} min (${seat.t.seats - seat.t.seated} seats free).`;
      return say(a, "a");
    }
    if (/block|park|διπλ|stop/.test(l)) {
      const h = BP.hotspots().find(x => x.stop === s.name);
      return say(h ? `${s.name} was blocked by double parking ${h.count} times today, about ${Math.round(h.avgDur / 60)} min each time. Last time at ${BP.fmtTime(h.last)}.` : `No double parking reported at ${s.name} today.`, "a");
    }
    if (/air|co2|αέρ|best/.test(l)) {
      const best = list.slice().sort((a, b) => a.t.co2 - b.t.co2)[0];
      if (best) return say(`Best air among the next buses: ${best.t.busId} (CO₂ ${best.t.co2} ppm, ${best.t.temperature} °C), arriving in ${Math.max(1, Math.round(best.eta / 60))} min.`, "a");
    }
    say(await BP.ask(q), "a");
  }

  // ------------------------------------------------------------ install + service worker
  let deferred = null;
  window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); deferred = e; $("installBtn").hidden = false; });
  $("installBtn").addEventListener("click", async () => { if (deferred) { deferred.prompt(); deferred = null; $("installBtn").hidden = true; } });
  if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("sw.js").catch(() => { /* ignore */ });

  // ------------------------------------------------------------ render loop
  function render() {
    const src = $("src");
    if (store.source === "live") { src.textContent = store.status === "connected" ? "live" : store.status; src.className = "src" + (store.status === "connected" ? " live" : ""); }
    else src.textContent = "demo data";
    $("srcInfo").textContent = store.source === "live" ? `MQTT ${BP.config.mqtt.url} (${store.status})` : "simulated in the browser (demo)";
    $("clock").textContent = store.lastTs ? store.lastTs.slice(11, 16) : "--:--";
    if (!store.buses.size) return;
    if (tab === "arrivals") renderArrivals();
    if (tab === "map") renderMap();
    if (openBus) renderSheet();
  }
  BP.onUpdate(render);
  BP.start();
  const h = location.hash.slice(1);
  if (["arrivals", "map", "ask", "info"].includes(h)) showTab(h);
})();
