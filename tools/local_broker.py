#!/usr/bin/env python3
"""Tiny local MQTT broker for testing without Docker or the lab broker.
   TCP on 1883 (simulator, YOLO script) and WebSocket on 9001 (dashboard, PWA).
   pip install amqtt   then   python tools/local_broker.py
"""
import asyncio
import logging

from amqtt.broker import Broker

CONFIG = {
    "listeners": {
        "default": {"type": "tcp", "bind": "0.0.0.0:1883"},
        "ws-mqtt": {"type": "ws", "bind": "0.0.0.0:9001"},
    },
    "sys_interval": 0,
    "auth": {"allow-anonymous": True, "plugins": ["auth_anonymous"]},
    "topic-check": {"enabled": False},
}


async def main():
    broker = Broker(CONFIG)
    await broker.start()
    print("Local MQTT broker running: mqtt://localhost:1883  ws://localhost:9001  (Ctrl+C to stop)")
    await asyncio.Event().wait()


if __name__ == "__main__":
    logging.basicConfig(level=logging.WARNING)
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
