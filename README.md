# BusPulse · Alpha code

IoT Project 13, University of Patras · Theodoros Latsis, Konstantinos Katsantonis

Crowding, ride comfort and double-parking detection for Patras city buses. The sensors are not installed yet,
so this Alpha **simulates the bus** and builds everything after it for real:

```
simulator/bus_simulator.py ──MQTT──► broker ──► FIWARE IoT Agent ► Orion ──► back-end ► InfluxDB ► Grafana
   (later: the Raspberry Pi)          │
                                      └──MQTT over WebSocket──► web/dashboard (Astiko KTEL, city)
                                                              ► web/pwa       (passengers)
vision/yolo_demo.py  (YOLO on a video: double parking, people counting) ──MQTT events──► same broker
```

The simulator publishes exactly the topics and JSON the Raspberry Pi will publish. When the hardware arrives,
the Pi replaces the simulator and nothing downstream changes.

## What is inside

| Folder | What | Owner |
|---|---|---|
| `simulator/` | Python sensor simulator: 6 buses on line 6, passengers, CO₂, temperature, humidity, PM2.5, noise, IMU, GPS, BLE count, events | Konstantinos |
| `web/dashboard/` | Operations dashboard (HTML/CSS/JS): overview, fleet, comfort & air, double parking, reports & AI | Theodoros |
| `web/pwa/` | Passenger progressive web app: arrivals, how full, comfort, seat alert, map, ask | Theodoros |
| `web/shared/` | Data layer shared by both apps (demo simulator in JS + MQTT over WebSocket), routes, config, vendored Leaflet / Chart.js / mqtt.js | both |
| `vision/` | `yolo_demo.py`: YOLO on a video for double parking (zone + dwell time) and people counting (seated / standing) | Theodoros |
| `stack/` | Local copy of the lab stack with Docker: Mosquitto, InfluxDB, Telegraf, Grafana | Konstantinos |
| `tools/` | `local_broker.py`: a pure-Python MQTT broker if you have neither Docker nor the lab broker | — |

## 1 · Open the apps (no install)

```bash
cd web
python -m http.server 8000
```
Open <http://localhost:8000> → **Operations dashboard** or **Passenger app**. Both run on data simulated in the browser
("DEMO DATA" badge). Use a local server rather than double-clicking the file, so the PWA's service worker can register.

Useful address-bar options: `?speed=40` (faster clock), `?start=13.5` (start at 13:30), `#fleet`, `#obstructions`, `#reports`.

## 2 · Live pipeline on your laptop

```bash
# a) a broker: Docker ...
cd stack && docker compose up -d          # Mosquitto 1883 + WebSocket 9001, InfluxDB 8086, Grafana 3000
# ... or without Docker
pip install amqtt && python tools/local_broker.py

# b) the simulated buses
pip install -r simulator/requirements.txt
python simulator/bus_simulator.py --broker localhost --speed 10 --start 07:45

# c) the apps, listening to the broker
#    http://localhost:8000/dashboard/index.html?mode=live&broker=ws://localhost:9001
#    http://localhost:8000/pwa/index.html?mode=live&broker=ws://localhost:9001
```
With the Docker stack, Telegraf writes every message to InfluxDB (`bus_telemetry`, `bus_event`) and Grafana already has the
InfluxDB data source. Example Flux query for a panel:

```flux
from(bucket: "buspulse")
  |> range(start: v.timeRangeStart, stop: v.timeRangeStop)
  |> filter(fn: (r) => r._measurement == "bus_telemetry" and r._field == "co2")
  |> aggregateWindow(every: 1m, fn: mean)
```
Set `grafanaUrl` in `web/shared/config.js` to embed a Grafana panel in the dashboard (Comfort & air view).

Simulator options: `--dry-run` (no broker), `--interval 5` (real seconds between messages), `--speed 10` (time ×10),
`--buses 6`, `--fault-bus BP-1124` (a bus with a ventilation fault, for the CO₂ alerts), `--ticks 100`, `--quiet`.
Every run also writes `simulator/data/telemetry.csv` and `events.csv`.

## 3 · With the lab infrastructure

1. **MQTT**: `python simulator/bus_simulator.py --broker <lab-broker> --port <port> [--username … --password …] [--tls]`.
   The browser apps need the lab broker's WebSocket address: `?mode=live&broker=wss://<lab-broker>/<path>`.
2. **FIWARE IoT Agent (JSON)**: add `--iota-apikey buspulse` and the simulator also publishes to `/json/buspulse/<device>/attrs`
   (device = `bp1121` … `bp1126`). Provision the service group and the devices once:

```bash
curl -X POST "http://<iot-agent>:4041/iot/services" -H "Content-Type: application/json" \
  -H "fiware-service: buspulse" -H "fiware-servicepath: /" \
  -d '{"services":[{"apikey":"buspulse","cbroker":"http://<orion>:1026","entity_type":"Vehicle","resource":""}]}'

curl -X POST "http://<iot-agent>:4041/iot/devices" -H "Content-Type: application/json" \
  -H "fiware-service: buspulse" -H "fiware-servicepath: /" \
  -d '{"devices":[{"device_id":"bp1121","entity_name":"urn:ngsi-ld:Vehicle:BP-1121","entity_type":"Vehicle","transport":"MQTT",
       "attributes":[{"object_id":"passengers","name":"passengers","type":"Integer"},
                     {"object_id":"occupancyLevel","name":"occupancyLevel","type":"Text"},
                     {"object_id":"co2","name":"co2","type":"Number"},
                     {"object_id":"temperature","name":"temperature","type":"Number"},
                     {"object_id":"comfort","name":"comfortScore","type":"Number"}]}]}'

# check the live state in Orion
curl "http://<orion>:1026/v2/entities?type=Vehicle" -H "fiware-service: buspulse" -H "fiware-servicepath: /"
```
   (Some IoT Agent versions listen on `/<apikey>/<device>/attrs` without the `/json` prefix: check the lab's configuration.)
3. **InfluxDB**: either Telegraf as in `stack/telegraf.conf`, an Orion subscription to the back-end, or the simulator directly:
   `--influx-url http://<host>:8086 --influx-token … --influx-org … --influx-bucket buspulse`.
4. **LLM**: set `llm.url` in `web/shared/config.js` to the lab's OpenAI-compatible endpoint; until then the
   assistant answers with built-in rules from the same data.

## 4 · YOLO on a video (double parking and people counting)

Our coach suggested a video from the internet or one we record. YOLO runs **on the laptop** (or Google Colab), not in the browser:

```bash
pip install -r vision/requirements.txt          # ultralytics + OpenCV; the YOLO weights download on first run
cd vision

# double parking: click the stop / bus-lane area on the first frame, then a vehicle that stays still there 15 s is flagged
python yolo_demo.py --mode parking --source street.mp4 --pick-zone --dwell 15 --show

# the same, reusing the zone it printed, and sending the events to the dashboard
python yolo_demo.py --mode parking --source street.mp4 --zone "0.55,0.55;1,0.55;1,1;0.45,1" --mqtt localhost --stop "Πλ. Όλγας"

# people counting, seated vs standing (YOLO pose)
python yolo_demo.py --mode people --source cabin.mp4 --show
```

Output in `vision/out/`: the annotated video, an events CSV, and blurred snapshots. People are blurred by default.

- **Which video**: a still camera works best for double parking: a phone on a tripod or a balcony, filming a bus stop
  or a bus lane for 1–3 minutes while a car stops there. On the real bus we apply the same rule while the bus is stopped
  at the stop (GPS speed near 0), when its front camera is also still. Free stock videos (Pexels, Pixabay) of
  street traffic or of people inside a bus also work; check the licence before showing them.
- **People counting**: film the two of you (and friends who agree) sitting and standing in a room for a minute.
- **Speed**: `yolov8n` on a laptop CPU runs roughly 5–20 frames per second; use `--every 2` or `--every 3` on slow laptops.
  On Google Colab with a GPU, upload the video and run the same command.
- **In the dashboard**: convert the annotated video to H.264 and save it as `web/dashboard/media/yolo_demo.mp4`
  (Double parking view).

## 5 · Message format

Topic `buspulse/bus/<busId>/telemetry`, QoS 0, every 5 s:

```json
{"busId":"BP-1123","line":"6","ts":"2026-11-27T08:12:05+02:00","lat":38.2648,"lon":21.7446,"speed":24.1,"heading":19,
 "direction":"outbound","nextStop":"Αγυιά","nextStopId":"S4","doorsOpen":false,
 "passengers":46,"seated":32,"standing":14,"seats":32,"capacity":95,"occupancyLevel":"standing",
 "co2":1180,"temperature":24.6,"humidity":55,"pm25":14.2,"noise":66.3,"accel":-0.42,"vibration":0.21,
 "harshEvents5min":0,"bleDevices":31,"comfort":3.9}
```

Topic `buspulse/bus/<busId>/event`, QoS 1: `type` is `obstruction`, `harsh_braking`, `road_bump`, `high_co2`, `temperature` or `crowding`,
with `severity`, `lat`, `lon`, `message` and, for double parking, `stop`, `vehicleClass`, `confidence`, `durationS`.

`occupancyLevel`: `free_seats` (≤ 70 % of seats taken) · `few_seats` · `standing` · `full` (> 85 % of capacity).
Comfort 1–5 starts at 5 and loses points for CO₂ above 1,000 ppm, temperature outside 19–26 °C, noise above 70 dB(A),
harsh braking in the last 5 minutes, and standing or full buses (same formula in Python and JavaScript).

## Notes

- All data is synthetic. Stop positions of line 6 are approximate; replace them in `simulator/routes.json` and
  `web/shared/routes.js`.
- The map tiles come from OpenStreetMap and need internet; everything else works offline.
- Privacy by design: no video leaves the bus, people are blurred, the microphone sends only dB values, and Bluetooth
  addresses are hashed with a daily key.
