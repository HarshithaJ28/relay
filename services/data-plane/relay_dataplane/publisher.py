"""Outbox publisher.

Takes unpublished outbox rows one at a time, publishes each to a RabbitMQ quorum queue with
publisher confirms, and only after the broker confirms clears the raw dispatch
token and sets published_at (AC-1). A crash anywhere leaves the row unpublished
with its token intact, so the next run republishes the SAME token for the SAME
dispatch_seq. Duplicates are possible by design; claim_delivery filters them.

Crash points exist so tests can kill the real process at each window:
  RELAY_CRASH_AT=before_publish | after_publish_before_mark | mid_batch
"""

import asyncio
import json
import os
import sys

import aio_pika
import psycopg

QUEUE = os.environ.get("RELAY_QUEUE", "relay.deliveries")


def _crash(point: str) -> None:
    if os.environ.get("RELAY_CRASH_AT") == point:
        os._exit(137)  # abrupt death: no cleanup, no commit, like SIGKILL


async def declare(channel: aio_pika.abc.AbstractChannel, name: str = QUEUE):
    return await channel.declare_queue(name, durable=True, arguments={"x-queue-type": "quorum"})


def encode(delivery_id, dispatch_seq: int, token: bytes) -> bytes:
    return json.dumps(
        {"delivery_id": str(delivery_id), "dispatch_seq": dispatch_seq, "dispatch_token": token.hex()}
    ).encode()


async def publish_pending(dsn: str, amqp_url: str, queue: str = QUEUE, batch: int = 100) -> int:
    published = 0
    connection = await aio_pika.connect_robust(amqp_url)
    async with connection:
        channel = await connection.channel(publisher_confirms=True)
        await declare(channel, queue)
        with psycopg.connect(dsn, autocommit=False) as db:
            # Lock ONE row at a time. Locking a batch and committing per row would release the
            # locks on the rows not yet published, and a second publisher would send them again.
            while published < batch:
                row = db.execute(
                    "SELECT id, delivery_id, dispatch_seq, dispatch_token FROM delivery.outbox "
                    "WHERE published_at IS NULL ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED"
                ).fetchone()
                if row is None:
                    db.commit()
                    break
                oid, delivery_id, seq, token = row
                _crash("before_publish")
                # With confirms on, this returns only after the broker has accepted
                # (and, for a quorum queue, replicated and persisted) the message.
                await channel.default_exchange.publish(
                    aio_pika.Message(
                        encode(delivery_id, seq, bytes(token)),
                        delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
                        message_id=f"{delivery_id}:{seq}",
                    ),
                    routing_key=queue,
                    mandatory=True,
                )
                _crash("after_publish_before_mark")
                db.execute(
                    "UPDATE delivery.outbox SET published_at = now(), dispatch_token = NULL WHERE id = %s", (oid,)
                )
                db.commit()
                published += 1
                if published == 2:
                    _crash("mid_batch")
    return published


if __name__ == "__main__":
    n = asyncio.run(publish_pending(os.environ["RELAY_DSN"], os.environ["RELAY_AMQP"]))
    print(f"published={n}", file=sys.stderr)
