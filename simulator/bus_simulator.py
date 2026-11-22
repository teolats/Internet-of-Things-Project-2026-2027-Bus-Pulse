#!/usr/bin/env python3
"""
BusPulse – bus sensor simulator (Alpha)
=======================================

Simulates the sensors inside Patras city buses and publishes exactly what the
real Raspberry Pi will publish later: one JSON message per bus every few
seconds over MQTT, plus event messages (harsh braking, double parking, high CO2...).

  Telemetry topic : buspulse/bus/<busId>/telemetry   (QoS 0)
  Event topic     : buspulse/bus/<busId>/event       (QoS 1)

When the hardware arrives, the Pi publishes the same topics and payloads,
so nothing downstream (FIWARE, InfluxDB, Grafana, dashboard, PWA) changes.

Examples
--------
  # print only, no broker needed
  python bus_simulator.py --dry-run

  # local Mosquitto, 6 buses, 10x faster than real time, starting at the morning peak
  python bus_simulator.py --broker localhost --speed 10 --start 07:45

  # lab broker + FIWARE IoT Agent (JSON) + InfluxDB
  python bus_simulator.py --broker <lab-host> --port 1883 --iota-apikey buspulse \
      --influx-url http://<host>:8086 --influx-token <token> --influx-org <org> --influx-bucket buspulse

Everything is synthetic. Stop positions are approximate.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import os
import random
import sys
import time
from collections import deque
from datetime import datetime, timedelta

try:
    from zoneinfo import ZoneInfo
    TZ = ZoneInfo("Europe/Athens")
except Exception:  # pragma: no cover
    TZ = None

HERE = os.path.dirname(os.path.abspath(__file__))

# ----------------------------------------------------------------------------- constants
SEATS = 32            # seated places, 12 m city bus
CAPACITY = 95         # seated + standing
CABIN_VOLUME = 60.0   # m3
CO2_PER_PERSON = 5.2e-6  # m3/s exhaled CO2 per adult (light activity)
CO2_OUTDOOR = 420.0   # ppm
VENT_NORMAL = 0.25    # m3/s fresh air, doors closed
VENT_FAULT = 0.07     # m3/s with a ventilation fault
VENT_DOORS = 0.80     # extra m3/s while doors are open

LEVELS = ["free_seats", "few_seats", "standing", "full"]
LEVEL_TEXT = {"free_seats": "FREE SEATS", "few_seats": "FEW SEATS", "standing": "STANDING", "full": "FULL"}


# ----------------------------------------------------------------------------- helpers
def haversine(lat1, lon1, lat2, lon2):
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def bearing(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    x = math.sin(dl) * math.cos(p2)
    y = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(x, y)) + 360) % 360


def poisson(rng: random.Random, lam: float) -> int:
    if lam <= 0:
        return 0
    if lam > 30:
        return max(0, int(round(rng.gauss(lam, math.sqrt(lam)))))
    L, k, p = math.exp(-lam), 0, 1.0
    while True:
        k += 1
        p *= rng.random()
        if p <= L:
            return k - 1


def occupancy_level(passengers: int) -> str:
    if passengers <= 0.7 * SEATS:
        return "free_seats"
    if passengers <= SEATS:
        return "few_seats"
    if passengers <= 0.85 * CAPACITY:
        return "standing"
    return "full"


def comfort_score(co2, temp, noise, harsh_recent, level) -> float:
    """1 (poor) to 5 (excellent). Same formula as web/shared/buspulse-data.js."""
    s = 5.0
    if co2 > 1000:
        s -= min(2.0, (co2 - 1000) / 500)
    if temp > 26:
        s -= min(1.5, (temp - 26) * 0.4)
    if temp < 19:
        s -= min(1.5, (19 - temp) * 0.4)
    if noise > 70:
        s -= min(1.0, (noise - 70) / 5)
    s -= min(1.5, 0.5 * harsh_recent)
    s -= {"free_seats": 0, "few_seats": 0, "standing": 0.5, "full": 1.0}[level]
    return round(max(1.0, min(5.0, s)), 1)


def time_of_day_factor(hour: float) -> float:
    if hour < 6:
        return 0.1
    if hour < 7:
        return 0.6
    if hour < 9.5:
        return 1.8
    if hour < 12:
        return 0.9
    if hour < 15:
        return 1.4
    if hour < 17:
        return 1.0
    if hour < 20:
        return 1.3
    if hour < 23:
        return 0.6
    return 0.2


def outdoor_temp(hour: float) -> float:
    # a mild November day in Patras
    return 14.5 + 4.0 * math.sin((hour - 9) / 12 * math.pi)


# ----------------------------------------------------------------------------- route
class Route:
    def __init__(self, line_id: str, data: dict):
        self.line = line_id
        self.name = data["name"]
        self.stops = data["stops"]
        self.cum = [0.0]
        for a, b in zip(self.stops, self.stops[1:]):
            self.cum.append(self.cum[-1] + haversine(a["lat"], a["lon"], b["lat"], b["lon"]))
        self.length = self.cum[-1]

    def position(self, s: float):
        s = max(0.0, min(self.length, s))
        for i in range(len(self.stops) - 1):
            if s <= self.cum[i + 1] or i == len(self.stops) - 2:
                a, b = self.stops[i], self.stops[i + 1]
                seg = self.cum[i + 1] - self.cum[i]
                f = 0 if seg == 0 else (s - self.cum[i]) / seg
                return (a["lat"] + f * (b["lat"] - a["lat"]),
                        a["lon"] + f * (b["lon"] - a["lon"]),
                        bearing(a["lat"], a["lon"], b["lat"], b["lon"]))
        last = self.stops[-1]
        return last["lat"], last["lon"], 0.0


# ----------------------------------------------------------------------------- bus
class Bus:
    def __init__(self, bus_id: str, route: Route, s0: float, direction: int, rng: random.Random,
                 sim_time: datetime, ventilation_fault=False):
        self.id, self.route, self.rng = bus_id, route, rng
        self.s, self.dir = s0, direction            # +1 outbound (to Rio), -1 inbound (to centre)
        self.speed = 0.0                            # m/s
        self.prev_speed = 0.0
        self.mode, self.timer = "drive", 0.0        # drive | dwell | wait | layover
        self.doors = False
        self.next_idx = self._next_stop_index()
        self.fault = ventilation_fault
        hour = sim_time.hour + sim_time.minute / 60
        self.passengers = min(CAPACITY, poisson(rng, 18 * time_of_day_factor(hour)))
        self.co2 = 650 + 9 * self.passengers
        self.temp = 22.5 + 0.03 * self.passengers
        self.hum = 48.0
        self.pm25 = 12.0
        self.outdoor_pm = 12.0
        self.vibration = 0.1
        self.cruise = rng.uniform(8.0, 10.0)         # m/s target (29–36 km/h)
        self.traffic = 1.0
        self.harsh = deque()                          # timestamps of harsh events
        self.harsh_pending = 0
        self.flags = {"co2": False, "co2crit": False, "temp": False, "full": False}
        self.last_alert = {}
        self.accel = 0.0

    # -- geometry
    def _next_stop_index(self):
        cum = self.route.cum
        if self.dir > 0:
            for i, c in enumerate(cum):
                if c > self.s + 1:
                    return i
            return len(cum) - 1
        for i in range(len(cum) - 1, -1, -1):
            if cum[i] < self.s - 1:
                return i
        return 0

    def next_stop(self):
        return self.route.stops[self.next_idx]

    # -- one second of simulated time
    def tick(self, now: datetime, events: list):
        rng = self.rng
        hour = now.hour + now.minute / 60
        self.prev_speed = self.speed

        if self.mode in ("dwell", "wait", "layover"):
            self.speed = 0.0
            self.timer -= 1
            if self.timer <= 0:
                if self.mode == "layover":
                    self.dir *= -1
                    self.next_idx = len(self.route.stops) - 1 if self.dir < 0 else 0
                    self._arrive_at_stop(now, events, terminal_start=True)
                    return self._physics(now, hour, events)
                if self.mode == "dwell":
                    self.next_idx = self._next_stop_index()
                self.mode, self.doors = "drive", False
        else:
            target_s = self.route.cum[self.next_idx]
            dist = abs(target_s - self.s)
            # traffic: random walk, slower at peaks
            peak = 0.8 if time_of_day_factor(hour) > 1.3 else 1.0
            self.traffic = max(0.45, min(1.1, self.traffic + rng.gauss(0, 0.02) + (peak - self.traffic) * 0.01))
            v_target = self.cruise * self.traffic
            brake_dist = self.speed ** 2 / (2 * 1.2) + 4
            if self.harsh_pending > 0:
                self.speed = max(0.0, self.speed - 3.6)
                self.harsh_pending -= 1
            elif dist < brake_dist:
                self.speed = max(1.0, self.speed - 1.2)
            elif self.speed < v_target:
                self.speed = min(v_target, self.speed + 1.0)
            else:
                self.speed = max(v_target, self.speed - 0.8)
            # rare harsh braking (someone cuts in)
            if self.speed > 7 and self.harsh_pending == 0 and rng.random() < 0.0008:
                self.harsh_pending = 2
                decel = round(rng.uniform(3.3, 4.6), 1)
                self.harsh.append(now)
                lat, lon, _ = self.route.position(self.s)
                events.append(self._event(now, "harsh_braking", "warning", lat, lon, value=-decel,
                                          message=f"Harsh braking {decel} m/s²"))
            # traffic lights / congestion
            if self.speed > 3 and rng.random() < 0.0025:
                self.mode, self.timer, self.speed = "wait", rng.randint(10, 45), 0.0
            step = self.speed
            if step >= dist:
                self.s = target_s
                self.speed = 0.0
                self._arrive_at_stop(now, events)
            else:
                self.s += self.dir * step
        return self._physics(now, hour, events)

    def _arrive_at_stop(self, now, events, terminal_start=False):
        rng, stops = self.rng, self.route.stops
        idx = self.next_idx
        stop = stops[idx]
        hour = now.hour + now.minute / 60
        last = len(stops) - 1
        is_terminal = (idx == last and self.dir > 0) or (idx == 0 and self.dir < 0)
        if is_terminal and not terminal_start:
            alight = self.passengers
            self.passengers = 0
            self.mode, self.timer, self.doors = "layover", rng.randint(120, 240), True
            return
        # alighting
        frac = 0.15
        if self.dir > 0 and stop["id"] == "S6":
            frac = 0.55 if hour < 13 else 0.35
        if self.dir < 0 and stop["id"] in ("S1", "S2"):
            frac = 0.40
        alight = sum(1 for _ in range(self.passengers) if rng.random() < frac)
        self.passengers -= alight
        # boarding
        tod = time_of_day_factor(hour)
        bias = 1.0
        if 6 <= hour < 11:
            bias = 1.7 if self.dir > 0 else 0.6
        elif 13 <= hour < 16:
            bias = 1.4 if self.dir < 0 else 0.7
        lam = 8.0 * stop["demand"] * tod * bias
        board = min(CAPACITY - self.passengers, poisson(rng, lam))
        self.passengers += board
        dwell = 8 + 2.5 * board + 1.2 * alight
        # double parking at the stop (what the front camera would detect)
        p_obs = stop.get("hotspot", 0) * (0.6 if tod > 1.3 else 0.3)
        if not terminal_start and rng.random() < p_obs:
            vclass = rng.choice(["car", "car", "car", "van", "truck"])
            dur = rng.randint(40, 420)
            conf = round(rng.uniform(0.78, 0.97), 2)
            dwell += rng.randint(10, 25)
            events.append(self._event(now, "obstruction", "warning", stop["lat"], stop["lon"],
                                      value=dur, stop=stop["name"], vehicleClass=vclass, confidence=conf,
                                      durationS=dur, message=f"{vclass.capitalize()} double-parked at stop {stop['name']}"))
        self.mode, self.timer, self.doors = "dwell", min(60, dwell), True
        lvl = occupancy_level(self.passengers)
        if lvl == "full" and not self.flags["full"]:
            self.flags["full"] = True
            events.append(self._event(now, "crowding", "info", stop["lat"], stop["lon"], value=self.passengers,
                                      stop=stop["name"], message=f"Bus full after {stop['name']} ({self.passengers} on board)"))
        elif lvl != "full":
            self.flags["full"] = False

    def _physics(self, now, hour, events):
        rng = self.rng
        n = self.passengers
        # CO2 mass balance
        q = (VENT_FAULT if self.fault else VENT_NORMAL) + (VENT_DOORS if self.doors else 0.0)
        gen = n * CO2_PER_PERSON / CABIN_VOLUME * 1e6
        self.co2 += gen - q / CABIN_VOLUME * (self.co2 - CO2_OUTDOOR)
        # temperature and humidity
        t_out = outdoor_temp(hour)
        target = 23.0 + 0.03 * n + (0.05 * n if self.fault else 0)
        self.temp += (target - self.temp) * 0.004 + ((t_out - self.temp) * 0.004 if self.doors else 0)
        self.hum += ((46 + 0.2 * n) - self.hum) * 0.005
        # particles
        self.outdoor_pm = max(5, min(35, self.outdoor_pm + rng.gauss(0, 0.15)))
        self.pm25 += ((self.outdoor_pm + (6 if self.doors else 0)) - self.pm25) * 0.02
        # motion
        self.accel = (self.speed - self.prev_speed) + rng.gauss(0, 0.12)
        self.vibration = 0.05 + 0.02 * self.speed + abs(rng.gauss(0, 0.03))
        if self.speed > 5 and rng.random() < 0.0003:
            spike = round(rng.uniform(1.1, 2.6), 2)
            self.vibration = spike
            lat, lon, _ = self.route.position(self.s)
            events.append(self._event(now, "road_bump", "info", lat, lon, value=spike,
                                      message=f"Road bump / pothole, vibration {spike} m/s²"))
        # threshold events (with hysteresis)
        lat, lon, _ = self.route.position(self.s)
        def cool(k):
            last = self.last_alert.get(k)
            if last and (now - last).total_seconds() < 600:
                return False
            self.last_alert[k] = now
            return True
        if self.co2 > 1500 and not self.flags["co2"] and cool("co2"):
            self.flags["co2"] = True
            events.append(self._event(now, "high_co2", "warning", lat, lon, value=round(self.co2),
                                      message=f"CO₂ {round(self.co2)} ppm: ventilation needed"))
        elif self.co2 < 1200:
            self.flags["co2"] = False
        if self.co2 > 2000 and not self.flags["co2crit"] and cool("co2crit"):
            self.flags["co2crit"] = True
            events.append(self._event(now, "high_co2", "critical", lat, lon, value=round(self.co2),
                                      message=f"CO₂ {round(self.co2)} ppm: possible ventilation fault"))
        elif self.co2 < 1500:
            self.flags["co2crit"] = False
        if (self.temp > 27 or self.temp < 18) and not self.flags["temp"]:
            self.flags["temp"] = True
            events.append(self._event(now, "temperature", "warning", lat, lon, value=round(self.temp, 1),
                                      message=f"Cabin temperature {self.temp:.1f} °C"))
        elif 18.5 < self.temp < 26.5:
            self.flags["temp"] = False
        while self.harsh and (now - self.harsh[0]).total_seconds() > 300:
            self.harsh.popleft()

    def _event(self, now, etype, severity, lat, lon, **kw):
        ev = {"busId": self.id, "line": self.route.line, "ts": now.isoformat(timespec="seconds"),
              "type": etype, "severity": severity, "lat": round(lat, 6), "lon": round(lon, 6)}
        ev.update(kw)
        return ev

    # -- what the Pi publishes
    def telemetry(self, now: datetime) -> dict:
        rng = self.rng
        lat, lon, heading = self.route.position(self.s)
        if self.dir < 0:
            heading = (heading + 180) % 360
        n = self.passengers
        seated = min(n, SEATS)
        lvl = occupancy_level(n)
        kmh = self.speed * 3.6
        noise = 57 + 0.22 * kmh + 0.07 * n + (3 if self.doors else 0) + rng.gauss(0, 1.2)
        harsh_recent = len(self.harsh)
        stop = self.next_stop()
        return {
            "busId": self.id,
            "line": self.route.line,
            "ts": now.isoformat(timespec="seconds"),
            "lat": round(lat, 6), "lon": round(lon, 6),
            "speed": round(kmh, 1), "heading": round(heading),
            "direction": "outbound" if self.dir > 0 else "inbound",
            "nextStop": stop["name"], "nextStopId": stop["id"],
            "doorsOpen": self.doors,
            "passengers": n, "seated": seated, "standing": n - seated,
            "seats": SEATS, "capacity": CAPACITY,
            "occupancyLevel": lvl,
            "co2": round(self.co2), "temperature": round(self.temp, 1), "humidity": round(self.hum),
            "pm25": round(self.pm25, 1), "noise": round(noise, 1),
            "accel": round(self.accel, 2), "vibration": round(self.vibration, 2),
            "harshEvents5min": harsh_recent,
            "bleDevices": max(0, int(round(0.7 * n + rng.gauss(0, 2)))),
            "comfort": comfort_score(self.co2, self.temp, noise, harsh_recent, lvl),
        }


# ----------------------------------------------------------------------------- outputs
class MqttOut:
    def __init__(self, args):
        try:
            import paho.mqtt.client as mqtt
        except ImportError:
            sys.exit("paho-mqtt is missing: pip install paho-mqtt   (or run with --dry-run)")
        self.mqtt = mqtt
        cid = f"buspulse-sim-{os.getpid()}"
        try:
            self.c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=cid, transport=args.transport)
        except AttributeError:  # paho-mqtt < 2
            self.c = mqtt.Client(client_id=cid, transport=args.transport)
        if args.username:
            self.c.username_pw_set(args.username, args.password)
        if args.tls:
            self.c.tls_set()
        if args.transport == "websockets":
            self.c.ws_set_options(path=args.ws_path)
        self.connected = False

        def on_connect(client, userdata, flags, rc, *extra):
            self.connected = not getattr(rc, "is_failure", rc != 0)
        self.c.on_connect = on_connect
        self.c.connect(args.broker, args.port, keepalive=30)
        self.c.loop_start()
        t0 = time.time()
        while not self.connected and time.time() - t0 < 8:
            time.sleep(0.1)
        if not self.connected:
            sys.exit(f"Could not connect to MQTT broker {args.broker}:{args.port}")

    def publish(self, topic, payload, qos=0):
        return self.c.publish(topic, json.dumps(payload, ensure_ascii=False), qos=qos)

    def close(self):
        self.c.loop_stop()
        self.c.disconnect()


class InfluxOut:
    NUMERIC = ["lat", "lon", "speed", "passengers", "seated", "standing", "co2", "temperature", "humidity",
               "pm25", "noise", "accel", "vibration", "harshEvents5min", "bleDevices", "comfort"]

    def __init__(self, args):
        try:
            from influxdb_client import InfluxDBClient, Point
            from influxdb_client.client.write_api import SYNCHRONOUS
        except ImportError:
            sys.exit("influxdb-client is missing: pip install influxdb-client")
        self.Point = Point
        self.client = InfluxDBClient(url=args.influx_url, token=args.influx_token, org=args.influx_org)
        self.write_api = self.client.write_api(write_options=SYNCHRONOUS)
        self.bucket, self.org = args.influx_bucket, args.influx_org

    def write(self, t: dict, now: datetime):
        p = self.Point("bus_telemetry").tag("bus", t["busId"]).tag("line", t["line"]) \
            .tag("direction", t["direction"]).tag("level", t["occupancyLevel"]).time(now)
        for k in self.NUMERIC:
            p = p.field(k, float(t[k]))
        self.write_api.write(bucket=self.bucket, org=self.org, record=p)

    def write_event(self, e: dict, now: datetime):
        p = self.Point("bus_event").tag("bus", e["busId"]).tag("type", e["type"]).tag("severity", e["severity"]) \
            .field("value", float(e.get("value", 0) or 0)).field("lat", e["lat"]).field("lon", e["lon"]) \
            .field("message", e.get("message", "")).time(now)
        self.write_api.write(bucket=self.bucket, org=self.org, record=p)


C = {"dim": "\033[2m", "b": "\033[1m", "g": "\033[32m", "y": "\033[33m", "r": "\033[31m", "c": "\033[36m", "x": "\033[0m"}


def color(s, k, on):
    return f"{C[k]}{s}{C['x']}" if on else s


# ----------------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description="BusPulse bus sensor simulator")
    ap.add_argument("--broker", default="localhost")
    ap.add_argument("--port", type=int, default=1883)
    ap.add_argument("--transport", choices=["tcp", "websockets"], default="tcp")
    ap.add_argument("--ws-path", default="/mqtt")
    ap.add_argument("--tls", action="store_true")
    ap.add_argument("--username", default=os.getenv("MQTT_USERNAME", ""))
    ap.add_argument("--password", default=os.getenv("MQTT_PASSWORD", ""))
    ap.add_argument("--topic-prefix", default="buspulse/bus")
    ap.add_argument("--iota-apikey", default="", help="also publish to the FIWARE IoT Agent JSON topic /json/<apikey>/<device>/attrs")
    ap.add_argument("--influx-url", default="")
    ap.add_argument("--influx-token", default=os.getenv("INFLUX_TOKEN", ""))
    ap.add_argument("--influx-org", default="buspulse")
    ap.add_argument("--influx-bucket", default="buspulse")
    ap.add_argument("--routes", default=os.path.join(HERE, "routes.json"))
    ap.add_argument("--line", default="6")
    ap.add_argument("--buses", type=int, default=6)
    ap.add_argument("--interval", type=float, default=5.0, help="real seconds between messages")
    ap.add_argument("--speed", type=float, default=1.0, help="simulated seconds per real second (10 = 10x faster)")
    ap.add_argument("--start", default="", help="simulated start time HH:MM (default: now)")
    ap.add_argument("--duration", type=float, default=0, help="stop after N real minutes (0 = run until Ctrl+C)")
    ap.add_argument("--ticks", type=int, default=0, help="stop after N messages per bus")
    ap.add_argument("--fault-bus", default="BP-1124", help="bus with a ventilation fault ('' for none)")
    ap.add_argument("--csv-dir", default=os.path.join(HERE, "data"))
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--dry-run", action="store_true", help="do not connect to MQTT, just print and log")
    ap.add_argument("--quiet", action="store_true")
    ap.add_argument("--no-color", action="store_true")
    args = ap.parse_args()

    rng = random.Random(args.seed)
    use_color = sys.stdout.isatty() and not args.no_color
    with open(args.routes, encoding="utf-8") as f:
        route = Route(args.line, json.load(f)["lines"][args.line])

    now = datetime.now(TZ) if TZ else datetime.now()
    if args.start:
        hh, mm = (int(x) for x in args.start.split(":"))
        now = now.replace(hour=hh, minute=mm, second=0, microsecond=0)

    buses = []
    cycle = 2 * route.length
    for i in range(args.buses):
        pos = (i + 0.5) * cycle / args.buses
        s0, d = (pos, 1) if pos < route.length else (cycle - pos, -1)
        bid = f"BP-{1121 + i}"
        buses.append(Bus(bid, route, s0, d, rng, now, ventilation_fault=(bid == args.fault_bus)))

    print(color("--- BusPulse sensor simulator ---", "b", use_color))
    print(f"Line {route.line}: {route.name}  ({route.length/1000:.1f} km, {len(route.stops)} stops)")
    print(f"{len(buses)} buses · message every {args.interval:g} s · time x{args.speed:g} · sim start {now:%H:%M}")

    mqtt_out = None
    if not args.dry_run:
        print(f"Connecting to MQTT broker {args.broker}:{args.port} ({args.transport}) ...")
        mqtt_out = MqttOut(args)
        print(color("SUCCESSFUL connection to the broker", "g", use_color))
        print(f"Publishing to {args.topic_prefix}/<busId>/telemetry and /event"
              + (f", IoT Agent topic /json/{args.iota_apikey}/<device>/attrs" if args.iota_apikey else ""))
    influx = InfluxOut(args) if args.influx_url else None
    if influx:
        print(f"Writing to InfluxDB {args.influx_url}, bucket {args.influx_bucket}")

    os.makedirs(args.csv_dir, exist_ok=True)
    tel_path = os.path.join(args.csv_dir, "telemetry.csv")
    ev_path = os.path.join(args.csv_dir, "events.csv")
    tel_f = open(tel_path, "w", newline="", encoding="utf-8")
    ev_f = open(ev_path, "w", newline="", encoding="utf-8")
    tel_w = ev_w = None
    print(f"Logging to {tel_path} and {ev_path}\n")

    t_real0 = time.time()
    tick = 0
    try:
        while True:
            tick += 1
            events = []
            steps = max(1, int(round(args.interval * args.speed)))
            for _ in range(steps):
                now += timedelta(seconds=1)
                for b in buses:
                    b.tick(now, events)
            for e in events:
                if ev_w is None:
                    ev_w = csv.DictWriter(ev_f, fieldnames=["ts", "busId", "line", "type", "severity", "lat", "lon",
                                                            "value", "stop", "vehicleClass", "confidence", "durationS",
                                                            "message"], extrasaction="ignore")
                    ev_w.writeheader()
                ev_w.writerow(e)
                if mqtt_out:
                    mqtt_out.publish(f"{args.topic_prefix}/{e['busId']}/event", e, qos=1)
                if influx:
                    influx.write_event(e, now)
                if not args.quiet:
                    k = "r" if e["severity"] == "critical" else "y"
                    print(color(f"[{e['ts'][11:19]}] EVENT {e['type']:<13} {e['busId']}: {e['message']}", k, use_color))
            for b in buses:
                t = b.telemetry(now)
                if tel_w is None:
                    tel_w = csv.DictWriter(tel_f, fieldnames=list(t.keys()))
                    tel_w.writeheader()
                tel_w.writerow(t)
                status = "logged"
                if mqtt_out:
                    mqtt_out.publish(f"{args.topic_prefix}/{t['busId']}/telemetry", t, qos=0)
                    if args.iota_apikey:
                        dev = t["busId"].replace("-", "").lower()
                        mqtt_out.publish(f"/json/{args.iota_apikey}/{dev}/attrs", t, qos=0)
                    status = "MQTT ok"
                if influx:
                    influx.write(t, now)
                if not args.quiet:
                    lvl = t["occupancyLevel"]
                    lvl_c = {"free_seats": "g", "few_seats": "g", "standing": "y", "full": "r"}[lvl]
                    arrow = "→" if t["direction"] == "outbound" else "←"
                    print(f"[{now:%H:%M:%S}] {t['busId']} {arrow} {t['nextStop']:<15} {t['passengers']:>3} pax "
                          f"({t['seated']:>2}+{t['standing']:<2}) {color(f'{LEVEL_TEXT[lvl]:<10}', lvl_c, use_color)} "
                          f"CO₂ {t['co2']:>4}  {t['temperature']:>4}°C  {t['humidity']}%  {t['noise']:>4} dB  "
                          f"{t['speed']:>4} km/h  comfort {t['comfort']}  {color(status, 'dim', use_color)}")
            tel_f.flush()
            ev_f.flush()
            if args.ticks and tick >= args.ticks:
                break
            if args.duration and time.time() - t_real0 > args.duration * 60:
                break
            if not args.dry_run:
                time.sleep(args.interval)
    except KeyboardInterrupt:
        pass
    finally:
        tel_f.close()
        ev_f.close()
        if mqtt_out:
            mqtt_out.close()
        print(f"\nStopped after {tick} messages per bus. CSV files in {args.csv_dir}")


if __name__ == "__main__":
    main()
