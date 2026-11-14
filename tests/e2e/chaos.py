"""Chaos receiver: a real HTTPS server that plays a customer's endpoint.

Behaviour is chosen by URL path, so one receiver serves every scenario:
  /ok                 200
  /flaky/<n>          503 for the first n requests of a message, then 200
  /slow-once          the first request of a message outlasts the client timeout, then 200
  /retry-after        429 with Retry-After: 1 for the first request of a message, then 200
  /always/<code>      that status, every time
  /hold/<seconds>     signals `arrived`, waits, then 200 (lets a test act mid-send)
  /down-until/<epoch> 503 until that Unix time, then 200 (an outage that ends)
Every request's Standard Webhooks signature is verified and recorded.
"""

import asyncio
import collections
import ssl
import threading
import time
from dataclasses import dataclass

from aiohttp import web

from relay_dataplane import signing


@dataclass(frozen=True)
class Seen:
    path: str
    message_id: str
    delivery_id: str
    signature_ok: bool
    at: float
    body: bytes = b""


class ChaosReceiver:
    def __init__(self, ssl_context: ssl.SSLContext, secret: str, slow_seconds: float = 3.0):
        self.ssl_context, self.secret, self.slow_seconds = ssl_context, secret, slow_seconds
        self.requests: list[Seen] = []
        self.arrived = threading.Event()
        self._per_message = collections.Counter()
        self._lock = threading.Lock()
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._loop.run_forever, daemon=True)
        self.port = 0

    # ---- lifecycle (the server runs on its own thread and event loop)

    def start(self) -> "ChaosReceiver":
        self._thread.start()
        asyncio.run_coroutine_threadsafe(self._start(), self._loop).result(10)
        return self

    async def _start(self) -> None:
        app = web.Application()
        app.router.add_post("/{tail:.*}", self._handle)
        self._runner = web.AppRunner(app)
        await self._runner.setup()
        site = web.TCPSite(self._runner, "127.0.0.1", 0, ssl_context=self.ssl_context)
        await site.start()
        self.port = site._server.sockets[0].getsockname()[1]

    def stop(self) -> None:
        asyncio.run_coroutine_threadsafe(self._runner.cleanup(), self._loop).result(10)
        self._loop.call_soon_threadsafe(self._loop.stop)
        self._thread.join(5)

    # ---- queries for tests

    def for_message(self, message_id: str) -> list[Seen]:
        with self._lock:
            return [r for r in self.requests if r.message_id == message_id]

    def for_delivery(self, delivery_id: str) -> list[Seen]:
        with self._lock:
            return [r for r in self.requests if r.delivery_id == delivery_id]

    # ---- behaviour

    async def _handle(self, request: web.Request) -> web.Response:
        body = await request.read()
        message_id = request.headers.get("webhook-id", "")
        seen = Seen(
            path=request.path,
            message_id=message_id,
            delivery_id=request.headers.get("relay-delivery-id", ""),
            signature_ok=signing.verify(self.secret, request.headers, body),
            at=time.time(),
            body=body,
        )
        with self._lock:
            self.requests.append(seen)
            self._per_message[(request.path, message_id)] += 1
            nth = self._per_message[(request.path, message_id)]

        parts = request.path.strip("/").split("/")
        kind = parts[0]
        if kind == "ok":
            return web.Response(status=200)
        if kind == "flaky":
            return web.Response(status=503 if nth <= int(parts[1]) else 200)
        if kind == "slow-once":
            if nth == 1:
                await asyncio.sleep(self.slow_seconds)
            return web.Response(status=200)
        if kind == "retry-after":
            return web.Response(status=429, headers={"Retry-After": "1"}) if nth == 1 else web.Response(status=200)
        if kind == "always":
            return web.Response(status=int(parts[1]))
        if kind == "down-until":
            return web.Response(status=503 if time.time() < float(parts[1]) else 200)
        if kind == "hold":
            self.arrived.set()
            await asyncio.sleep(float(parts[1]))
            return web.Response(status=200)
        return web.Response(status=404)
