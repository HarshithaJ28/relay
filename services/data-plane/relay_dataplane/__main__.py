"""Run one data-plane process:  python -m relay_dataplane {worker|scheduler|reaper|publisher|ingest|retention}

Admin command:  python -m relay_dataplane create-api-key --tenant <uuid> [--name NAME] [--scope SCOPE ...]
(prints the new key once; RELAY_DSN must connect as relay_tenant)

SIGTERM or SIGINT starts a graceful shutdown (a Kubernetes pod stop sends SIGTERM);
a second signal exits at once. The exit code is 0 after a clean shutdown and 2
for a configuration error.
"""

import argparse
import asyncio
import contextlib
import logging
import os
import signal
import sys
import uuid
from datetime import timedelta

import psycopg

from . import api_keys, observability, processes
from .destination import DestinationPolicy
from .endpoint_secrets import Keyring
from .settings import Settings

ROLES = ("worker", "scheduler", "reaper", "publisher", "ingest", "retention")
NO_BROKER = ("ingest", "retention", "create-api-key")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="relay_dataplane", description=__doc__.splitlines()[0])
    parser.add_argument("role", choices=(*ROLES, "create-api-key"))
    parser.add_argument("--tenant", type=uuid.UUID, help="create-api-key: the tenant id")
    parser.add_argument("--name", default="", help="create-api-key: a label for the key")
    parser.add_argument("--scope", action="append", choices=api_keys.SCOPES, help="create-api-key: repeatable")
    args = parser.parse_args(argv)

    observability.setup_logging(os.environ.get("RELAY_LOG_LEVEL", "INFO"))
    observability.setup_tracing(args.role)
    log = logging.getLogger("relay")
    try:
        settings = Settings.from_env(needs_broker=args.role not in NO_BROKER)
        keyring = Keyring.from_env() if args.role == "worker" else None
        policy = DestinationPolicy.from_env() if args.role == "worker" else None
    except (ValueError, OSError) as e:
        log.error("configuration error: %s", e)
        return 2

    if args.role == "create-api-key":
        if args.tenant is None:
            log.error("configuration error: --tenant is required")
            return 2
        with psycopg.connect(settings.dsn, autocommit=True) as conn:
            key, prefix = api_keys.create(conn, args.tenant, args.name, tuple(args.scope or api_keys.SCOPES))
        print(key)  # shown once; only its hash is stored
        log.info("created API key prefix=%s tenant=%s", prefix, args.tenant)
        return 0

    if args.role == "ingest":
        return run_ingest(settings, log)

    async def run() -> None:
        stop = asyncio.Event()
        loop = asyncio.get_running_loop()

        def on_signal(signum: int) -> None:
            if stop.is_set():
                log.warning("second %s: exiting now", signal.Signals(signum).name)
                os._exit(1)
            log.info("%s received: shutting down", signal.Signals(signum).name)
            stop.set()

        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, on_signal, sig)
        processes._log_config(args.role, settings)
        ops = (
            observability.OpsServer(processes.HEALTH, settings.metrics_port)
            if settings.metrics_port
            else contextlib.nullcontext()
        )
        try:
            await ops.__aenter__()
        except OSError as e:  # the port is taken: a configuration problem, not a crash
            raise ValueError(f"cannot serve metrics on port {settings.metrics_port}: {e.strerror}") from None
        try:
            if args.role == "worker":
                await processes.run_worker(settings, stop, keyring, policy)
            else:
                await getattr(processes, f"run_{args.role}")(settings, stop)
        finally:
            await ops.__aexit__(None, None, None)
        log.info("%s stopped", args.role)

    try:
        asyncio.run(run())
    except ValueError as e:  # a configuration problem found at start (for example, retention too short)
        log.error("configuration error: %s", e)
        return 2
    return 0


def run_ingest(settings: Settings, log) -> int:
    import uvicorn
    from psycopg_pool import AsyncConnectionPool

    from .ingest import create_app

    pool = AsyncConnectionPool(
        settings.dsn,
        min_size=1,
        max_size=settings.ingest_pool_size,
        kwargs={"autocommit": True},
        check=AsyncConnectionPool.check_connection,
        open=False,
    )
    limiter = None
    if settings.valkey_url:
        import valkey.asyncio

        from .ratelimit import RateLimiter

        limiter = RateLimiter(
            valkey.asyncio.Valkey.from_url(settings.valkey_url, socket_timeout=1, socket_connect_timeout=1)
        )
    app = create_app(pool, timedelta(hours=settings.idempotency_window_hours), limiter, settings.api_key_cache_seconds)

    processes._log_config("ingest", settings)
    config = uvicorn.Config(
        app,
        host=settings.ingest_host,
        port=settings.ingest_port,
        log_level="warning",
        access_log=False,
        proxy_headers=False,
        timeout_graceful_shutdown=int(settings.shutdown_grace),
    )

    class Server(uvicorn.Server):
        @contextlib.contextmanager
        def capture_signals(self):  # signals are ours, so the exit code is 0 like the other roles
            yield

    server = Server(config)

    async def serve() -> None:
        loop = asyncio.get_running_loop()

        def on_signal(signum: int) -> None:
            if server.should_exit:
                server.force_exit = True
            log.info("%s received: shutting down", signal.Signals(signum).name)
            server.should_exit = True  # stop accepting, finish requests in progress, run lifespan shutdown

        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, on_signal, sig)
        await server.serve()

    asyncio.run(serve())
    log.info("ingest stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
