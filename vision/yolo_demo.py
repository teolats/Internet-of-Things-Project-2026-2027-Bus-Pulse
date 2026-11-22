#!/usr/bin/env python3
"""
BusPulse – YOLO on a video (Alpha demo)
=======================================

Two modes, both run on a laptop (CPU is fine) or in Google Colab:

  parking : finds vehicles that stay still inside a zone you draw (bus stop / bus lane)
            for longer than --dwell seconds  ->  "double parking" event
  people  : counts people and estimates seated vs standing from the body keypoints
            (YOLO pose model)  ->  the passenger count the inside camera will send

Privacy: people are blurred in the saved video and snapshots (--no-blur to turn off for debugging).

Install once:
  pip install ultralytics opencv-python paho-mqtt
  (the model weights download automatically the first time)

Examples:
  python yolo_demo.py --mode parking --source street.mp4 --pick-zone --dwell 15
  python yolo_demo.py --mode parking --source street.mp4 --zone "0.55,0.55;0.98,0.55;0.98,0.98;0.45,0.98"
  python yolo_demo.py --mode people  --source cabin.mp4
  python yolo_demo.py --mode parking --source street.mp4 --zone ... --mqtt localhost --bus-id BP-1123 --stop "Πλ. Όλγας"

The parking rule assumes the camera is still: a camera on a pole, a phone on a tripod,
or the bus front camera while the bus is stopped at the stop (GPS speed below ~3 km/h).
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import os
import sys
import time
from collections import defaultdict, deque
from datetime import datetime

VEHICLE_CLASSES = {2: "car", 3: "motorcycle", 5: "bus", 7: "truck"}   # COCO ids
PERSON = 0


# ----------------------------------------------------------------------------- geometry helpers
def parse_zone(text: str, w: int, h: int):
    """'x1,y1;x2,y2;...' in pixels or as fractions of the frame (0–1)."""
    pts = []
    for p in text.split(";"):
        x, y = (float(v) for v in p.split(","))
        if x <= 1 and y <= 1:
            x, y = x * w, y * h
        pts.append((int(x), int(y)))
    if len(pts) < 3:
        raise ValueError("a zone needs at least 3 points")
    return pts


def inside(poly, x, y):
    """Point-in-polygon (ray casting), no OpenCV needed."""
    n, c = len(poly), False
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi + 1e-9) + xi):
            c = not c
        j = i
    return c


# ----------------------------------------------------------------------------- double-parking logic (no YOLO inside: easy to test)
class ParkingDetector:
    """Keeps a short history per tracked vehicle and flags the ones that stand still in the zone."""

    def __init__(self, zone, dwell_s=20.0, still_frac=0.02, diag=1000.0):
        self.zone, self.dwell, self.still_px = zone, dwell_s, still_frac * diag
        self.hist = defaultdict(deque)          # track id -> deque[(t, x, y)]
        self.entered = {}                       # track id -> time it entered the zone
        self.flagged = {}                       # track id -> event dict
        self.last_seen = {}

    def update(self, t, tracks):
        """tracks: list of (track_id, cls_name, conf, x1, y1, x2, y2). Returns (states, new_events)."""
        states, new = {}, []
        for tid, cname, conf, x1, y1, x2, y2 in tracks:
            px, py = (x1 + x2) / 2, y2                 # bottom-centre = where the vehicle touches the road
            self.last_seen[tid] = t
            if not inside(self.zone, px, py):
                self.entered.pop(tid, None)
                self.hist.pop(tid, None)
                states[tid] = "outside"
                continue
            self.entered.setdefault(tid, t)
            h = self.hist[tid]
            h.append((t, px, py))
            while h and t - h[0][0] > self.dwell:
                h.popleft()
            span = t - self.entered[tid]
            moved = max(math.hypot(px - hx, py - hy) for _, hx, hy in h)
            if tid in self.flagged:
                ev = self.flagged[tid]
                ev["durationS"] = round(t - ev["_start"])
                ev["confidence"] = round(max(ev["confidence"], conf), 2)
                states[tid] = "parked"
            elif span >= self.dwell and moved <= self.still_px:
                ev = {"_start": self.entered[tid], "trackId": int(tid), "vehicleClass": cname,
                      "confidence": round(conf, 2), "durationS": round(span)}
                self.flagged[tid] = ev
                new.append(ev)
                states[tid] = "parked"
            else:
                states[tid] = "in_zone"
        return states, new


# ----------------------------------------------------------------------------- seated / standing from keypoints
def posture(kp, box):
    """kp: 17x3 array (x, y, conf) in COCO order. Returns 'standing', 'seated' or 'unknown'."""
    x1, y1, x2, y2 = box
    def p(i):
        return kp[i] if kp is not None and kp[i][2] > 0.4 else None
    sh = [q for q in (p(5), p(6)) if q is not None]
    hp = [q for q in (p(11), p(12)) if q is not None]
    kn = [q for q in (p(13), p(14)) if q is not None]
    if sh and hp and kn:
        sy = sum(q[1] for q in sh) / len(sh)
        hy = sum(q[1] for q in hp) / len(hp)
        ky = sum(q[1] for q in kn) / len(kn)
        torso = max(1.0, hy - sy)
        thigh_drop = (ky - hy) / torso            # ~0.8–1.1 standing, ~0–0.4 seated (thigh roughly horizontal)
        return "standing" if thigh_drop > 0.55 else "seated"
    ratio = (y2 - y1) / max(1.0, (x2 - x1))      # fallback: tall narrow box = standing
    if ratio > 2.2:
        return "standing"
    if ratio < 1.4:
        return "seated"
    return "unknown"


# ----------------------------------------------------------------------------- drawing + privacy
def blur_region(cv2, frame, x1, y1, x2, y2):
    h, w = frame.shape[:2]
    x1, y1, x2, y2 = max(0, int(x1)), max(0, int(y1)), min(w, int(x2)), min(h, int(y2))
    if x2 - x1 > 4 and y2 - y1 > 4:
        roi = frame[y1:y2, x1:x2]
        k = max(15, ((x2 - x1) // 3) | 1)
        frame[y1:y2, x1:x2] = cv2.GaussianBlur(roi, (k, k), 0)


def pick_zone(cv2, frame):
    pts, win = [], "Click the zone corners, ENTER to finish, BACKSPACE to undo"
    def on_mouse(ev, x, y, *_):
        if ev == cv2.EVENT_LBUTTONDOWN:
            pts.append((x, y))
    cv2.namedWindow(win)
    cv2.setMouseCallback(win, on_mouse)
    while True:
        img = frame.copy()
        for i, q in enumerate(pts):
            cv2.circle(img, q, 6, (0, 200, 255), -1)
            if i:
                cv2.line(img, pts[i - 1], q, (0, 200, 255), 2)
        cv2.imshow(win, img)
        k = cv2.waitKey(30) & 0xFF
        if k in (13, 10) and len(pts) >= 3:
            break
        if k == 8 and pts:
            pts.pop()
        if k == 27:
            sys.exit("cancelled")
    cv2.destroyWindow(win)
    w, h = frame.shape[1], frame.shape[0]
    print("Zone (reuse with --zone):", ";".join(f"{x / w:.3f},{y / h:.3f}" for x, y in pts))
    return pts


# ----------------------------------------------------------------------------- MQTT (optional)
def mqtt_client(host):
    if not host:
        return None
    import paho.mqtt.client as mqtt
    hp = host.split(":")
    try:
        c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"buspulse-yolo-{os.getpid()}")
    except AttributeError:
        c = mqtt.Client(client_id=f"buspulse-yolo-{os.getpid()}")
    c.connect(hp[0], int(hp[1]) if len(hp) > 1 else 1883, 30)
    c.loop_start()
    return c


def now_iso():
    return datetime.now().astimezone().isoformat(timespec="seconds")


# ----------------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description="BusPulse YOLO video demo")
    ap.add_argument("--mode", choices=["parking", "people"], required=True)
    ap.add_argument("--source", required=True, help="video file, image folder, RTSP/HTTP URL or 0 for the webcam")
    ap.add_argument("--model", default="", help="default: yolov8n.pt (parking), yolov8n-pose.pt (people)")
    ap.add_argument("--zone", default="", help="'x1,y1;x2,y2;...' pixels or 0–1 fractions (parking mode)")
    ap.add_argument("--pick-zone", action="store_true", help="click the zone on the first frame")
    ap.add_argument("--dwell", type=float, default=20, help="seconds still in the zone before it counts as double parking")
    ap.add_argument("--still", type=float, default=0.02, help="max movement during the dwell, as a fraction of the frame diagonal")
    ap.add_argument("--conf", type=float, default=0.35)
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--every", type=int, default=1, help="process every N-th frame (2 or 3 on slow laptops)")
    ap.add_argument("--out", default="out", help="output folder")
    ap.add_argument("--show", action="store_true", help="show the annotated video while it runs")
    ap.add_argument("--no-blur", action="store_true")
    ap.add_argument("--max-seconds", type=float, default=0)
    ap.add_argument("--mqtt", default="", help="broker host[:port] to publish events, e.g. localhost")
    ap.add_argument("--topic-prefix", default="buspulse/bus")
    ap.add_argument("--bus-id", default="BP-1123")
    ap.add_argument("--line", default="6")
    ap.add_argument("--stop", default="Πλ. Όλγας")
    ap.add_argument("--lat", type=float, default=38.2493)
    ap.add_argument("--lon", type=float, default=21.7370)
    args = ap.parse_args()

    try:
        import cv2
        import numpy as np
        from ultralytics import YOLO
    except ImportError:
        sys.exit("Missing packages: pip install ultralytics opencv-python paho-mqtt")

    model_name = args.model or ("yolov8n.pt" if args.mode == "parking" else "yolov8n-pose.pt")
    model = YOLO(model_name)
    src = int(args.source) if args.source.isdigit() else args.source
    cap = cv2.VideoCapture(src)
    ok, first = cap.read()
    if not ok:
        sys.exit(f"Cannot read video: {args.source}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    h, w = first.shape[:2]
    os.makedirs(os.path.join(args.out, "snapshots"), exist_ok=True)
    out_path = os.path.join(args.out, f"{args.mode}_annotated.mp4")
    writer = cv2.VideoWriter(out_path, cv2.VideoWriter_fourcc(*"mp4v"), fps / args.every, (w, h))
    mq = mqtt_client(args.mqtt)

    zone, det = None, None
    if args.mode == "parking":
        if args.pick_zone:
            zone = pick_zone(cv2, first)
        elif args.zone:
            zone = parse_zone(args.zone, w, h)
        else:   # default: lower-right quarter (kerb side in Greece)
            zone = parse_zone("0.55,0.55;1,0.55;1,1;0.45,1", w, h)
        det = ParkingDetector(zone, args.dwell, args.still, math.hypot(w, h))

    ev_path = os.path.join(args.out, f"{args.mode}_events.csv")
    ev_f = open(ev_path, "w", newline="", encoding="utf-8")
    ev_w = csv.writer(ev_f)
    ev_w.writerow(["video_time_s", "ts", "type", "track_id", "class", "confidence", "duration_s", "passengers", "seated", "standing"])

    print(f"--- BusPulse YOLO demo · {args.mode} ---")
    print(f"model {model_name} · {w}x{h} @ {fps:.0f} fps · every {args.every} frame(s)")
    frame_i, t0, counts = 0, time.time(), deque(maxlen=15)
    frame = first
    last_pub = -999
    while ok:
        if frame_i % args.every == 0:
            vt = frame_i / fps
            if args.mode == "parking":
                r = model.track(frame, persist=True, tracker="bytetrack.yaml", conf=args.conf, imgsz=args.imgsz,
                                classes=list(VEHICLE_CLASSES) + [PERSON], verbose=False)[0]
                tracks, people_boxes = [], []
                if r.boxes is not None and len(r.boxes):
                    ids = r.boxes.id.int().tolist() if r.boxes.id is not None else [None] * len(r.boxes)
                    for b, c, cf, tid in zip(r.boxes.xyxy.tolist(), r.boxes.cls.int().tolist(), r.boxes.conf.tolist(), ids):
                        if c == PERSON:
                            people_boxes.append(b)
                        elif tid is not None:
                            tracks.append((tid, VEHICLE_CLASSES.get(c, "vehicle"), cf, *b))
                states, new = det.update(vt, tracks)
                # draw
                overlay = frame.copy()
                cv2.fillPoly(overlay, [np.array(zone, dtype=np.int32)], (0, 165, 255))
                frame = cv2.addWeighted(overlay, 0.18, frame, 0.82, 0)
                cv2.polylines(frame, [np.array(zone, dtype=np.int32)], True, (0, 165, 255), 2)
                if not args.no_blur:
                    for b in people_boxes:
                        blur_region(cv2, frame, *b)
                for tid, cname, cf, x1, y1, x2, y2 in tracks:
                    st = states.get(tid, "outside")
                    col = {"outside": (180, 180, 180), "in_zone": (0, 200, 255), "parked": (40, 40, 230)}[st]
                    cv2.rectangle(frame, (int(x1), int(y1)), (int(x2), int(y2)), col, 3 if st == "parked" else 2)
                    label = f"{cname} #{tid}"
                    if st == "parked":
                        label = f"DOUBLE PARKED {det.flagged[tid]['durationS']}s"
                    elif st == "in_zone":
                        label += f" {vt - det.entered[tid]:.0f}s"
                    cv2.putText(frame, label, (int(x1), max(18, int(y1) - 8)), cv2.FONT_HERSHEY_SIMPLEX, 0.6, col, 2)
                for ev in new:
                    snap = os.path.join(args.out, "snapshots", f"parking_{ev['trackId']}.jpg")
                    cv2.imwrite(snap, frame)
                    ev_w.writerow([round(vt, 1), now_iso(), "obstruction", ev["trackId"], ev["vehicleClass"], ev["confidence"], ev["durationS"], "", "", ""])
                    print(f"[{vt:7.1f}s] EVENT double parking: {ev['vehicleClass']} #{ev['trackId']} still for {ev['durationS']} s (conf {ev['confidence']})")
                    if mq:
                        msg = {"busId": args.bus_id, "line": args.line, "ts": now_iso(), "type": "obstruction", "severity": "warning",
                               "lat": args.lat, "lon": args.lon, "stop": args.stop, "vehicleClass": ev["vehicleClass"],
                               "confidence": ev["confidence"], "durationS": ev["durationS"], "value": ev["durationS"],
                               "message": f"{ev['vehicleClass'].capitalize()} double-parked at stop {args.stop} (YOLO)"}
                        mq.publish(f"{args.topic_prefix}/{args.bus_id}/event", json.dumps(msg, ensure_ascii=False), qos=1)
                n_park = sum(1 for s in states.values() if s == "parked")
                cv2.rectangle(frame, (0, 0), (w, 36), (51, 42, 16), -1)
                cv2.putText(frame, f"BusPulse  |  vehicles {len(tracks)}  |  in zone {sum(1 for s in states.values() if s != 'outside')}  |  double parked {n_park}",
                            (12, 25), cv2.FONT_HERSHEY_SIMPLEX, 0.65, (255, 255, 255), 2)
            else:
                r = model.predict(frame, conf=args.conf, imgsz=args.imgsz, classes=[PERSON], verbose=False)[0]
                boxes = r.boxes.xyxy.tolist() if r.boxes is not None else []
                kps = r.keypoints.data.tolist() if getattr(r, "keypoints", None) is not None else [None] * len(boxes)
                seated = standing = 0
                for b, kp in zip(boxes, kps):
                    pos = posture(kp, b)
                    seated += pos == "seated"
                    standing += pos == "standing"
                    if not args.no_blur:   # blur the head: keypoints 0–4 (nose, eyes, ears) or the top of the box
                        pts = [q for q in (kp or [])[:5] if q[2] > 0.3]
                        if pts:
                            xs, ys = [q[0] for q in pts], [q[1] for q in pts]
                            pad = max(12, (b[2] - b[0]) * 0.25)
                            blur_region(cv2, frame, min(xs) - pad, min(ys) - pad * 1.4, max(xs) + pad, max(ys) + pad)
                        else:
                            blur_region(cv2, frame, b[0], b[1], b[2], b[1] + (b[3] - b[1]) * 0.22)
                    col = {"standing": (0, 165, 255), "seated": (112, 122, 31), "unknown": (180, 180, 180)}[pos]
                    cv2.rectangle(frame, (int(b[0]), int(b[1])), (int(b[2]), int(b[3])), col, 2)
                    cv2.putText(frame, pos, (int(b[0]), max(18, int(b[1]) - 6)), cv2.FONT_HERSHEY_SIMPLEX, 0.55, col, 2)
                counts.append((len(boxes), seated, standing))
                n = sorted(c[0] for c in counts)[len(counts) // 2]          # median of the last frames = stable count
                cv2.rectangle(frame, (0, 0), (w, 36), (51, 42, 16), -1)
                cv2.putText(frame, f"BusPulse  |  passengers {n}  |  seated {seated}  |  standing {standing}",
                            (12, 25), cv2.FONT_HERSHEY_SIMPLEX, 0.65, (255, 255, 255), 2)
                if vt - last_pub >= 5:                                        # one count every 5 s, like the real camera
                    last_pub = vt
                    ev_w.writerow([round(vt, 1), now_iso(), "passenger_count", "", "person", "", "", n, seated, standing])
                    print(f"[{vt:7.1f}s] passengers {n} (seated {seated}, standing {standing})")
                    if mq:
                        msg = {"busId": args.bus_id, "line": args.line, "ts": now_iso(), "passengers": n, "seated": seated, "standing": standing, "source": "yolo"}
                        mq.publish(f"{args.topic_prefix}/{args.bus_id}/vision", json.dumps(msg), qos=0)
            writer.write(frame)
            if args.show:
                cv2.imshow("BusPulse YOLO", frame)
                if cv2.waitKey(1) & 0xFF == 27:
                    break
        frame_i += 1
        if args.max_seconds and frame_i / fps > args.max_seconds:
            break
        ok, frame = cap.read()

    cap.release()
    writer.release()
    ev_f.close()
    if args.show:
        cv2.destroyAllWindows()
    dt = time.time() - t0
    print(f"\nDone: {frame_i} frames in {dt:.0f} s ({frame_i / max(dt, 1e-6):.1f} fps)")
    print(f"Annotated video : {out_path}")
    print(f"Events / counts : {ev_path}")
    if args.mode == "parking":
        print(f"Double parking  : {len(det.flagged)} vehicle(s)")
    print("Tip: copy the annotated video to web/dashboard/media/yolo_demo.mp4 to play it in the dashboard"
          " (convert with: ffmpeg -i in.mp4 -vcodec libx264 -pix_fmt yuv420p yolo_demo.mp4)")


if __name__ == "__main__":
    main()
