/* BusPulse shared data layer, used by the dashboard and the passenger PWA.
   - demo mode: a JavaScript port of simulator/bus_simulator.py runs in the browser
   - live mode: subscribes to the MQTT broker over WebSocket (mqtt.js)
   Both produce the same telemetry and event messages, so the UI does not care where data comes from. */
(function () {
  "use strict";

  // ------------------------------------------------------------------ config
  const CFG = JSON.parse(JSON.stringify(window.BUSPULSE_CONFIG || {}));
  CFG.mqtt = CFG.mqtt || {};
  CFG.demo = CFG.demo || {};
  CFG.llm = CFG.llm || {};
  try {
    const saved = JSON.parse(localStorage.getItem("buspulse.settings") || "{}");
    if (saved.mode) CFG.mode = saved.mode;
    if (saved.broker) CFG.mqtt.url = saved.broker;
    if (saved.speed) CFG.demo.speed = saved.speed;
  } catch (e) { /* storage blocked: ignore */ }
  const qs = new URLSearchParams(location.search);
  if (qs.get("mode")) CFG.mode = qs.get("mode");
  if (qs.get("broker")) CFG.mqtt.url = qs.get("broker");
  if (qs.get("speed")) CFG.demo.speed = +qs.get("speed");
  if (qs.get("start")) CFG.demo.startHour = +qs.get("start");

  const ROUTES = window.BUSPULSE_ROUTES;
  const SEATS = 32, CAPACITY = 95, VOLUME = 60, CO2_PP = 5.2e-6, CO2_OUT = 420;
  const VENT_NORMAL = 0.25, VENT_FAULT = 0.07, VENT_DOORS = 0.8;

  const LEVELS = {
    free_seats: { label: "Free seats", short: "Free seats", color: "#1F7A70", rank: 0 },
    few_seats: { label: "Few seats", short: "Few seats", color: "#5FA88C", rank: 1 },
    standing: { label: "Standing only", short: "Standing", color: "#E9A23B", rank: 2 },
    full: { label: "Full", short: "Full", color: "#C2410C", rank: 3 }
  };
  const EVENT_TYPES = {
    obstruction: { label: "Double parking", icon: "🚗", group: "obstruction" },
    harsh_braking: { label: "Harsh braking", icon: "⚠", group: "driving" },
    road_bump: { label: "Road bump", icon: "〰", group: "driving" },
    high_co2: { label: "High CO₂", icon: "☁", group: "air" },
    temperature: { label: "Temperature", icon: "🌡", group: "air" },
    crowding: { label: "Bus full", icon: "👥", group: "crowding" }
  };

  // ------------------------------------------------------------------ helpers
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  let rnd = mulberry32(CFG.demo.seed || 42);
  const uniform = (a, b) => a + (b - a) * rnd();
  const randint = (a, b) => Math.floor(uniform(a, b + 1));
  function gauss(mu, sigma) {
    let u = 0, v = 0;
    while (u === 0) u = rnd();
    while (v === 0) v = rnd();
    return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  function poisson(lam) {
    if (lam <= 0) return 0;
    if (lam > 30) return Math.max(0, Math.round(gauss(lam, Math.sqrt(lam))));
    const L = Math.exp(-lam); let k = 0, p = 1;
    do { k++; p *= rnd(); } while (p > L);
    return k - 1;
  }
  function haversine(a, b, c, d) {
    const r = 6371000, p1 = a * Math.PI / 180, p2 = c * Math.PI / 180;
    const dp = p2 - p1, dl = (d - b) * Math.PI / 180;
    const x = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * r * Math.asin(Math.sqrt(x));
  }
  function bearing(a, b, c, d) {
    const p1 = a * Math.PI / 180, p2 = c * Math.PI / 180, dl = (d - b) * Math.PI / 180;
    const x = Math.sin(dl) * Math.cos(p2);
    const y = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return (Math.atan2(x, y) * 180 / Math.PI + 360) % 360;
  }
  function occupancyLevel(n) {
    if (n <= 0.7 * SEATS) return "free_seats";
    if (n <= SEATS) return "few_seats";
    if (n <= 0.85 * CAPACITY) return "standing";
    return "full";
  }
  function comfortScore(co2, temp, noise, harsh, level) {
    let s = 5;
    if (co2 > 1000) s -= Math.min(2, (co2 - 1000) / 500);
    if (temp > 26) s -= Math.min(1.5, (temp - 26) * 0.4);
    if (temp < 19) s -= Math.min(1.5, (19 - temp) * 0.4);
    if (noise > 70) s -= Math.min(1, (noise - 70) / 5);
    s -= Math.min(1.5, 0.5 * harsh);
    s -= { free_seats: 0, few_seats: 0, standing: 0.5, full: 1 }[level];
    return Math.round(Math.max(1, Math.min(5, s)) * 10) / 10;
  }
  // Comfort broken into parts (0–5 each) for the passenger app
  function comfortParts(t) {
    const clamp = v => Math.max(0, Math.min(5, v));
    return {
      air: clamp(5 - Math.max(0, (t.co2 - 800) / 300)),
      temperature: clamp(5 - Math.max(0, Math.abs(t.temperature - 22.5) - 1.5) * 0.8),
      quiet: clamp(5 - Math.max(0, (t.noise - 62) / 3)),
      smooth: clamp(5 - 1.5 * (t.harshEvents5min || 0) - Math.max(0, (t.vibration - 0.4) * 2)),
      space: { free_seats: 5, few_seats: 4, standing: 2.5, full: 1 }[t.occupancyLevel]
    };
  }
  const tod = h => h < 6 ? 0.1 : h < 7 ? 0.6 : h < 9.5 ? 1.8 : h < 12 ? 0.9 : h < 15 ? 1.4 : h < 17 ? 1.0 : h < 20 ? 1.3 : h < 23 ? 0.6 : 0.2;
  const outdoorTemp = h => 14.5 + 4 * Math.sin((h - 9) / 12 * Math.PI);
  function isoLocal(d) {
    const p = n => String(n).padStart(2, "0");
    const off = -d.getTimezoneOffset(), sign = off >= 0 ? "+" : "-";
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
      `${sign}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
  }

  // ------------------------------------------------------------------ route geometry
  class Route {
    constructor(line, data) {
      this.line = line; this.name = data.name; this.stops = data.stops; this.cum = [0];
      for (let i = 1; i < this.stops.length; i++) {
        const a = this.stops[i - 1], b = this.stops[i];
        this.cum.push(this.cum[i - 1] + haversine(a.lat, a.lon, b.lat, b.lon));
      }
      this.length = this.cum[this.cum.length - 1];
      this.stops.forEach((s, i) => { s.s = this.cum[i]; s.index = i; });
    }
    position(s) {
      s = Math.max(0, Math.min(this.length, s));
      for (let i = 0; i < this.stops.length - 1; i++) {
        if (s <= this.cum[i + 1] || i === this.stops.length - 2) {
          const a = this.stops[i], b = this.stops[i + 1], seg = this.cum[i + 1] - this.cum[i];
          const f = seg ? (s - this.cum[i]) / seg : 0;
          return [a.lat + f * (b.lat - a.lat), a.lon + f * (b.lon - a.lon), bearing(a.lat, a.lon, b.lat, b.lon)];
        }
      }
      const l = this.stops[this.stops.length - 1]; return [l.lat, l.lon, 0];
    }
    // distance along the route of the point nearest to lat/lon (works for live data too)
    project(lat, lon) {
      let best = { d: Infinity, s: 0 };
      const k = Math.cos(lat * Math.PI / 180);
      for (let i = 0; i < this.stops.length - 1; i++) {
        const a = this.stops[i], b = this.stops[i + 1];
        const ax = a.lon * k, ay = a.lat, bx = b.lon * k, by = b.lat, px = lon * k, py = lat;
        const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
        let f = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
        f = Math.max(0, Math.min(1, f));
        const qx = ax + f * dx, qy = ay + f * dy, d = (px - qx) ** 2 + (py - qy) ** 2;
        if (d < best.d) best = { d, s: this.cum[i] + f * (this.cum[i + 1] - this.cum[i]) };
      }
      return best.s;
    }
  }
  const routes = {};
  Object.keys(ROUTES).forEach(k => { routes[k] = new Route(k, ROUTES[k]); });

  // ------------------------------------------------------------------ demo bus (port of the Python Bus class)
  class Bus {
    constructor(id, route, s0, dir, now, fault) {
      Object.assign(this, { id, route, s: s0, dir, fault });
      this.speed = 0; this.prevSpeed = 0; this.mode = "drive"; this.timer = 0; this.doors = false;
      this.nextIdx = this.nextStopIndex();
      const h = now.getHours() + now.getMinutes() / 60;
      this.passengers = Math.min(CAPACITY, poisson(18 * tod(h)));
      this.co2 = 650 + 9 * this.passengers; this.temp = 22.5 + 0.03 * this.passengers;
      this.hum = 48; this.pm25 = 12; this.outPm = 12; this.vibration = 0.1; this.accel = 0;
      this.cruise = uniform(8, 10); this.traffic = 1; this.harsh = []; this.harshPending = 0;
      this.flags = { co2: false, co2crit: false, temp: false, full: false }; this.lastAlert = {};
    }
    nextStopIndex() {
      const c = this.route.cum;
      if (this.dir > 0) { for (let i = 0; i < c.length; i++) if (c[i] > this.s + 1) return i; return c.length - 1; }
      for (let i = c.length - 1; i >= 0; i--) if (c[i] < this.s - 1) return i; return 0;
    }
    event(now, type, severity, lat, lon, extra) {
      return Object.assign({ busId: this.id, line: this.route.line, ts: isoLocal(now), type, severity,
        lat: +lat.toFixed(6), lon: +lon.toFixed(6) }, extra || {});
    }
    tick(now, events) {
      const h = now.getHours() + now.getMinutes() / 60;
      this.prevSpeed = this.speed;
      if (this.mode !== "drive") {
        this.speed = 0; this.timer -= 1;
        if (this.timer <= 0) {
          if (this.mode === "layover") {
            this.dir *= -1;
            this.nextIdx = this.dir < 0 ? this.route.stops.length - 1 : 0;
            this.arrive(now, events, true);
            return this.physics(now, h, events);
          }
          if (this.mode === "dwell") this.nextIdx = this.nextStopIndex();
          this.mode = "drive"; this.doors = false;
        }
      } else {
        const target = this.route.cum[this.nextIdx], dist = Math.abs(target - this.s);
        const peak = tod(h) > 1.3 ? 0.8 : 1.0;
        this.traffic = Math.max(0.45, Math.min(1.1, this.traffic + gauss(0, 0.02) + (peak - this.traffic) * 0.01));
        const vt = this.cruise * this.traffic, brake = this.speed ** 2 / 2.4 + 4;
        if (this.harshPending > 0) { this.speed = Math.max(0, this.speed - 3.6); this.harshPending--; }
        else if (dist < brake) this.speed = Math.max(1, this.speed - 1.2);
        else if (this.speed < vt) this.speed = Math.min(vt, this.speed + 1);
        else this.speed = Math.max(vt, this.speed - 0.8);
        if (this.speed > 7 && this.harshPending === 0 && rnd() < 0.0008) {
          this.harshPending = 2;
          const decel = +uniform(3.3, 4.6).toFixed(1);
          this.harsh.push(now.getTime());
          const [la, lo] = this.route.position(this.s);
          events.push(this.event(now, "harsh_braking", "warning", la, lo, { value: -decel, message: `Harsh braking ${decel} m/s²` }));
        }
        if (this.speed > 3 && rnd() < 0.0025) { this.mode = "wait"; this.timer = randint(10, 45); this.speed = 0; }
        if (this.speed >= dist) { this.s = target; this.speed = 0; this.arrive(now, events, false); }
        else this.s += this.dir * this.speed;
      }
      return this.physics(now, h, events);
    }
    arrive(now, events, terminalStart) {
      const stops = this.route.stops, idx = this.nextIdx, stop = stops[idx];
      const h = now.getHours() + now.getMinutes() / 60, last = stops.length - 1;
      const terminal = (idx === last && this.dir > 0) || (idx === 0 && this.dir < 0);
      if (terminal && !terminalStart) {
        this.passengers = 0; this.mode = "layover"; this.timer = randint(120, 240); this.doors = true; return;
      }
      let frac = 0.15;
      if (this.dir > 0 && stop.id === "S6") frac = h < 13 ? 0.55 : 0.35;
      if (this.dir < 0 && (stop.id === "S1" || stop.id === "S2")) frac = 0.4;
      let alight = 0; for (let i = 0; i < this.passengers; i++) if (rnd() < frac) alight++;
      this.passengers -= alight;
      const t = tod(h); let bias = 1;
      if (h >= 6 && h < 11) bias = this.dir > 0 ? 1.7 : 0.6; else if (h >= 13 && h < 16) bias = this.dir < 0 ? 1.4 : 0.7;
      const board = Math.min(CAPACITY - this.passengers, poisson(8 * stop.demand * t * bias));
      this.passengers += board;
      let dwell = 8 + 2.5 * board + 1.2 * alight;
      const pObs = (stop.hotspot || 0) * (t > 1.3 ? 0.6 : 0.3);
      if (!terminalStart && rnd() < pObs) {
        const vc = ["car", "car", "car", "van", "truck"][randint(0, 4)], dur = randint(40, 420), conf = +uniform(0.78, 0.97).toFixed(2);
        dwell += randint(10, 25);
        events.push(this.event(now, "obstruction", "warning", stop.lat, stop.lon, { value: dur, stop: stop.name, vehicleClass: vc,
          confidence: conf, durationS: dur, message: `${vc[0].toUpperCase() + vc.slice(1)} double-parked at stop ${stop.name}` }));
      }
      this.mode = "dwell"; this.timer = Math.min(60, dwell); this.doors = true;
      const lvl = occupancyLevel(this.passengers);
      if (lvl === "full" && !this.flags.full) {
        this.flags.full = true;
        events.push(this.event(now, "crowding", "info", stop.lat, stop.lon, { value: this.passengers, stop: stop.name,
          message: `Bus full after ${stop.name} (${this.passengers} on board)` }));
      } else if (lvl !== "full") this.flags.full = false;
    }
    physics(now, h, events) {
      const n = this.passengers;
      const q = (this.fault ? VENT_FAULT : VENT_NORMAL) + (this.doors ? VENT_DOORS : 0);
      this.co2 += n * CO2_PP / VOLUME * 1e6 - q / VOLUME * (this.co2 - CO2_OUT);
      const tout = outdoorTemp(h), target = 23 + 0.03 * n + (this.fault ? 0.05 * n : 0);
      this.temp += (target - this.temp) * 0.004 + (this.doors ? (tout - this.temp) * 0.004 : 0);
      this.hum += ((46 + 0.2 * n) - this.hum) * 0.005;
      this.outPm = Math.max(5, Math.min(35, this.outPm + gauss(0, 0.15)));
      this.pm25 += ((this.outPm + (this.doors ? 6 : 0)) - this.pm25) * 0.02;
      this.accel = (this.speed - this.prevSpeed) + gauss(0, 0.12);
      this.vibration = 0.05 + 0.02 * this.speed + Math.abs(gauss(0, 0.03));
      const [la, lo] = this.route.position(this.s);
      if (this.speed > 5 && rnd() < 0.0003) {
        const spike = +uniform(1.1, 2.6).toFixed(2); this.vibration = spike;
        events.push(this.event(now, "road_bump", "info", la, lo, { value: spike, message: `Road bump / pothole, vibration ${spike} m/s²` }));
      }
      const cool = k => { const t = now.getTime(), last = this.lastAlert[k] || 0; if (t - last < 600000) return false; this.lastAlert[k] = t; return true; };
      if (this.co2 > 1500 && !this.flags.co2 && cool("co2")) {
        this.flags.co2 = true;
        events.push(this.event(now, "high_co2", "warning", la, lo, { value: Math.round(this.co2), message: `CO₂ ${Math.round(this.co2)} ppm: ventilation needed` }));
      } else if (this.co2 < 1200) this.flags.co2 = false;
      if (this.co2 > 2000 && !this.flags.co2crit && cool("co2crit")) {
        this.flags.co2crit = true;
        events.push(this.event(now, "high_co2", "critical", la, lo, { value: Math.round(this.co2), message: `CO₂ ${Math.round(this.co2)} ppm: possible ventilation fault` }));
      } else if (this.co2 < 1500) this.flags.co2crit = false;
      if ((this.temp > 27 || this.temp < 18) && !this.flags.temp) {
        this.flags.temp = true;
        events.push(this.event(now, "temperature", "warning", la, lo, { value: +this.temp.toFixed(1), message: `Cabin temperature ${this.temp.toFixed(1)} °C` }));
      } else if (this.temp > 18.5 && this.temp < 26.5) this.flags.temp = false;
      while (this.harsh.length && now.getTime() - this.harsh[0] > 300000) this.harsh.shift();
    }
    telemetry(now) {
      let [lat, lon, heading] = this.route.position(this.s);
      if (this.dir < 0) heading = (heading + 180) % 360;
      const n = this.passengers, seated = Math.min(n, SEATS), lvl = occupancyLevel(n), kmh = this.speed * 3.6;
      const noise = 57 + 0.22 * kmh + 0.07 * n + (this.doors ? 3 : 0) + gauss(0, 1.2);
      const stop = this.route.stops[this.nextIdx];
      return {
        busId: this.id, line: this.route.line, ts: isoLocal(now),
        lat: +lat.toFixed(6), lon: +lon.toFixed(6), speed: +kmh.toFixed(1), heading: Math.round(heading),
        direction: this.dir > 0 ? "outbound" : "inbound", nextStop: stop.name, nextStopId: stop.id, doorsOpen: this.doors,
        passengers: n, seated, standing: n - seated, seats: SEATS, capacity: CAPACITY, occupancyLevel: lvl,
        co2: Math.round(this.co2), temperature: +this.temp.toFixed(1), humidity: Math.round(this.hum),
        pm25: +this.pm25.toFixed(1), noise: +noise.toFixed(1), accel: +this.accel.toFixed(2), vibration: +this.vibration.toFixed(2),
        harshEvents5min: this.harsh.length, bleDevices: Math.max(0, Math.round(0.7 * n + gauss(0, 2))),
        comfort: comfortScore(this.co2, this.temp, noise, this.harsh.length, lvl)
      };
    }
  }

  // ------------------------------------------------------------------ store
  const store = {
    buses: new Map(), history: new Map(), events: [], source: "demo", status: "starting", lastTs: null,
    hourly: Array.from({ length: 24 }, () => ({ sum: 0, n: 0 }))
  };
  const listeners = new Set();
  let pending = false;
  function notify() {
    if (pending) return; pending = true;
    requestAnimationFrame(() => { pending = false; listeners.forEach(f => { try { f(store); } catch (e) { console.error(e); } }); });
  }
  function ingestTelemetry(t, keepHistory = true) {
    store.buses.set(t.busId, t);
    store.lastTs = t.ts;
    if (keepHistory) {
      if (!store.history.has(t.busId)) store.history.set(t.busId, []);
      const h = store.history.get(t.busId);
      const last = h[h.length - 1];
      if (!last || new Date(t.ts) - new Date(last.ts) >= 30000) {
        h.push({ ts: t.ts, passengers: t.passengers, co2: t.co2, temperature: t.temperature, noise: t.noise, comfort: t.comfort, speed: t.speed });
        if (h.length > 400) h.shift();
        const hr = new Date(t.ts).getHours(); store.hourly[hr].sum += t.passengers; store.hourly[hr].n++;
      }
    }
  }
  function ingestEvent(e) {
    store.events.unshift(e);
    if (store.events.length > 800) store.events.pop();
  }

  // ------------------------------------------------------------------ demo engine
  let demo = null;
  function startDemo() {
    const route = routes["6"], N = CFG.demo.buses || 6, cycle = 2 * route.length;
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const warm = (CFG.demo.warmupMinutes || 0) * 60;
    let now = new Date(start.getTime() + (CFG.demo.startHour || 8) * 3600000 - warm * 1000);
    const buses = [];
    for (let i = 0; i < N; i++) {
      const pos = (i + 0.5) * cycle / N;
      const [s0, d] = pos < route.length ? [pos, 1] : [cycle - pos, -1];
      const id = `BP-${1121 + i}`;
      buses.push(new Bus(id, route, s0, d, now, id === CFG.demo.faultBus));
    }
    // warm-up: generate history instantly
    for (let k = 0; k < warm; k++) {
      now = new Date(now.getTime() + 1000);
      const ev = []; buses.forEach(b => b.tick(now, ev)); ev.forEach(ingestEvent);
      if (k % 30 === 0) buses.forEach(b => ingestTelemetry(b.telemetry(now)));
    }
    buses.forEach(b => ingestTelemetry(b.telemetry(now)));
    store.source = "demo"; store.status = "running";
    demo = { buses, now, timer: null };
    const speed = CFG.demo.speed || 20;
    demo.timer = setInterval(() => {
      const ev = [];
      for (let k = 0; k < speed; k++) { demo.now = new Date(demo.now.getTime() + 1000); buses.forEach(b => b.tick(demo.now, ev)); }
      ev.forEach(ingestEvent);
      buses.forEach(b => ingestTelemetry(b.telemetry(demo.now)));
      notify();
    }, 1000);
    notify();
  }

  // ------------------------------------------------------------------ live engine (MQTT over WebSocket)
  let client = null;
  function startLive() {
    store.source = "live"; store.status = "connecting"; notify();
    if (!window.mqtt) { store.status = "mqtt.js not loaded"; notify(); return; }
    const prefix = CFG.mqtt.topicPrefix || "buspulse/bus";
    client = window.mqtt.connect(CFG.mqtt.url, {
      username: CFG.mqtt.username || undefined, password: CFG.mqtt.password || undefined,
      clientId: "buspulse-web-" + Math.random().toString(16).slice(2, 8), reconnectPeriod: 3000, connectTimeout: 8000
    });
    client.on("connect", () => {
      store.status = "connected";
      client.subscribe([`${prefix}/+/telemetry`, `${prefix}/+/event`], { qos: 1 });
      notify();
    });
    client.on("reconnect", () => { store.status = "reconnecting"; notify(); });
    client.on("error", err => { store.status = "error: " + err.message; notify(); });
    client.on("close", () => { if (store.status === "connected") { store.status = "disconnected"; notify(); } });
    client.on("message", (topic, payload) => {
      let msg; try { msg = JSON.parse(payload.toString()); } catch (e) { return; }
      if (topic.endsWith("/telemetry")) ingestTelemetry(msg); else if (topic.endsWith("/event")) ingestEvent(msg);
      notify();
    });
  }

  // ------------------------------------------------------------------ derived values for the UIs
  function busPosition(t) {
    const r = routes[t.line] || routes["6"];
    return r.project(t.lat, t.lon);
  }
  // seconds until bus t reaches stop (index) travelling in direction dir ("outbound"/"inbound")
  function eta(t, stopIndex, dir) {
    const r = routes[t.line] || routes["6"], L = r.length, cyc = 2 * L;
    const s = busPosition(t);
    let pBus = t.direction === "outbound" ? s : cyc - s, extra = 0;
    // a bus waiting at a terminus is about to start the other direction
    if (t.direction === "inbound" && s < 30) { pBus = 0; extra = t.speed < 1 ? 120 : 0; }
    if (t.direction === "outbound" && s > L - 30) { pBus = L; extra = t.speed < 1 ? 120 : 0; }
    const pStop = dir === "outbound" ? r.cum[stopIndex] : cyc - r.cum[stopIndex];
    let d = (pStop - pBus + cyc) % cyc;
    if (d > cyc - 30) d = 0;
    let stopsBetween = 0, turns = 0;
    for (let i = 0; i < r.stops.length; i++) {
      [r.cum[i], cyc - r.cum[i]].forEach(p => { const x = (p - pBus + cyc) % cyc; if (x > 30 && x < d - 30) stopsBetween++; });
    }
    [L, cyc].forEach(p => { const x = (p - pBus + cyc) % cyc; if (x > 1 && x < d) turns++; });
    return Math.round(d / 6.5 + stopsBetween * 22 + turns * 180 + extra);
  }
  function stats() {
    const buses = [...store.buses.values()];
    const pax = buses.reduce((a, b) => a + b.passengers, 0);
    const crowded = buses.filter(b => b.occupancyLevel === "standing" || b.occupancyLevel === "full").length;
    const comfort = buses.length ? buses.reduce((a, b) => a + b.comfort, 0) / buses.length : 0;
    const day = store.lastTs ? store.lastTs.slice(0, 10) : "";
    const today = store.events.filter(e => e.ts.slice(0, 10) === day);
    const recent = store.events.filter(e => store.lastTs && new Date(store.lastTs) - new Date(e.ts) < 3600000);
    return {
      buses: buses.length, passengers: pax, crowded, comfort: Math.round(comfort * 10) / 10,
      openAlerts: recent.filter(e => e.severity !== "info" && e.type !== "obstruction").length,
      obstructionsToday: today.filter(e => e.type === "obstruction").length, eventsToday: today
    };
  }
  function hotspots() {
    const m = new Map();
    store.events.filter(e => e.type === "obstruction").forEach(e => {
      const k = e.stop || "?"; const h = m.get(k) || { stop: k, lat: e.lat, lon: e.lon, count: 0, dur: 0, last: e.ts, classes: {} };
      h.count++; h.dur += e.durationS || 0; if (e.ts > h.last) h.last = e.ts; h.classes[e.vehicleClass] = (h.classes[e.vehicleClass] || 0) + 1;
      m.set(k, h);
    });
    return [...m.values()].map(h => Object.assign(h, { avgDur: Math.round(h.dur / h.count) })).sort((a, b) => b.count - a.count);
  }

  // ------------------------------------------------------------------ rule-based assistant (stand-in for the lab LLM)
  async function ask(question, context) {
    if (CFG.llm && CFG.llm.url) {
      try {
        const res = await fetch(CFG.llm.url, {
          method: "POST",
          headers: Object.assign({ "Content-Type": "application/json" }, CFG.llm.apiKey ? { Authorization: "Bearer " + CFG.llm.apiKey } : {}),
          body: JSON.stringify({ model: CFG.llm.model || undefined, messages: [
            { role: "system", content: "You are BusPulse, an assistant for Patras city buses. Answer briefly using only the JSON data given." },
            { role: "user", content: "DATA: " + JSON.stringify(context || summary()) + "\n\nQUESTION: " + question }] })
        });
        const j = await res.json();
        return (j.choices && j.choices[0] && j.choices[0].message.content) || JSON.stringify(j);
      } catch (e) { return "The LLM service did not answer (" + e.message + "). Built-in answer:\n" + ruleAnswer(question); }
    }
    return ruleAnswer(question);
  }
  function summary() {
    const st = stats();
    return { time: store.lastTs, buses: [...store.buses.values()].map(b => ({ id: b.busId, dir: b.direction, next: b.nextStop,
      passengers: b.passengers, level: b.occupancyLevel, co2: b.co2, temp: b.temperature, comfort: b.comfort })),
      stats: { passengers: st.passengers, crowded: st.crowded, comfort: st.comfort }, hotspots: hotspots().slice(0, 3) };
  }
  function ruleAnswer(q) {
    q = q.toLowerCase();
    const buses = [...store.buses.values()];
    const name = b => `${b.busId} (${b.direction === "outbound" ? "to Rio" : "to the centre"}, next ${b.nextStop})`;
    if (/crowd|full|seat|γεμ|θέσ|stand/.test(q)) {
      const c = buses.filter(b => LEVELS[b.occupancyLevel].rank >= 2).sort((a, b) => b.passengers - a.passengers);
      const f = buses.filter(b => b.occupancyLevel === "free_seats");
      return (c.length ? `Crowded now: ${c.map(b => `${name(b)} with ${b.passengers} on board`).join("; ")}.` : "No bus is crowded right now.") +
        (f.length ? ` Free seats on ${f.map(b => b.busId).join(", ")}.` : "");
    }
    if (/co2|co₂|air|αέρ|vent|temp|ζέστ|κρύ/.test(q)) {
      const w = buses.slice().sort((a, b) => b.co2 - a.co2)[0];
      return w ? `Worst air: ${name(w)}, CO₂ ${w.co2} ppm, ${w.temperature} °C. ${w.co2 > 1500 ? "Ask the driver to open the vents; if it repeats, check the ventilation." : "All buses are within normal limits."}` : "No data yet.";
    }
    if (/park|block|obstr|διπλ|εμπόδ|hot/.test(q)) {
      const h = hotspots();
      return h.length ? `Most blocked stops: ${h.slice(0, 3).map(x => `${x.stop} (${x.count} times, about ${Math.round(x.avgDur / 60)} min each)`).join(", ")}.` : "No double parking detected yet.";
    }
    if (/brak|φρέν|driv|smooth/.test(q)) {
      const n = store.events.filter(e => e.type === "harsh_braking").length;
      return `${n} harsh-braking events in the data so far. Most recent: ${(store.events.find(e => e.type === "harsh_braking") || {}).message || "none"}.`;
    }
    const st = stats();
    return `${st.buses} buses in service with ${st.passengers} passengers on board. ${st.crowded} crowded, average comfort ${st.comfort}/5, ${st.obstructionsToday} double-parking events today.`;
  }

  // ------------------------------------------------------------------ public API
  window.BusPulse = {
    config: CFG, routes, LEVELS, EVENT_TYPES, SEATS, CAPACITY, store,
    start() { if (store.status !== "starting") return; (CFG.mode === "live" ? startLive : startDemo)(); },
    onUpdate(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    saveSettings(s) { try { localStorage.setItem("buspulse.settings", JSON.stringify(s)); } catch (e) { /* ignore */ } },
    eta, busPosition, stats, hotspots, comfortParts, ask, summary, occupancyLevel,
    fmtTime: ts => ts ? ts.slice(11, 16) : "–",
    fmtAgo(ts) {
      if (!ts || !store.lastTs) return "";
      const s = Math.max(0, (new Date(store.lastTs) - new Date(ts)) / 1000);
      return s < 60 ? "just now" : s < 3600 ? Math.round(s / 60) + " min ago" : Math.round(s / 3600) + " h ago";
    }
  };
})();
