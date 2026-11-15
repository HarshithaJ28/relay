"""Quorum behaviour of the dispatch queue on a three-node RabbitMQ 3.13 cluster.

This shows what a quorum queue does when nodes stop: confirmed messages survive the loss
of the leader, publishing stops without a majority, and resumes when one comes back. It is
a behaviour test on one machine (three containers, one Docker network), not a claim that a
deployment is highly available: Relay runs RabbitMQ as a single node.
"""

import asyncio
import json
import os
import tempfile
import time
import uuid

import aio_pika
import docker
import pytest

from relay_dataplane import publisher
from tests.conftest import DOCKER_HELP, RABBITMQ_IMAGE

NODES = ("rabbit-1", "rabbit-2", "rabbit-3")
MESSAGES = 200


def _wait(what, attempt, timeout=180):
    deadline = time.time() + timeout
    while True:
        try:
            result = attempt()
            if result:
                return result
        except Exception as e:  # keep trying until the deadline
            last = e
        else:
            last = None
        if time.time() > deadline:
            pytest.fail(f"{what} not reached after {timeout} s (last error: {last})")
        time.sleep(2)


@pytest.fixture(scope="module")
def cluster():
    """Three clustered RabbitMQ nodes; yields {node: container}, {node: amqp url}."""
    try:
        client = docker.from_env()
        client.ping()
    except Exception as e:
        pytest.fail(f"Docker is required for the cluster test ({e}); {DOCKER_HELP}")
    suffix = uuid.uuid4().hex[:8]
    network = client.networks.create(f"relay-quorum-{suffix}")
    confdir = tempfile.mkdtemp(prefix="relay-quorum-")
    with open(os.path.join(confdir, "rabbitmq.conf"), "w") as f:
        f.write("cluster_formation.peer_discovery_backend = classic_config\n")
        for i, node in enumerate(NODES, 1):
            f.write(f"cluster_formation.classic_config.nodes.{i} = rabbit@{node}\n")
        f.write("loopback_users = none\n")
    os.chmod(confdir, 0o755)
    os.chmod(os.path.join(confdir, "rabbitmq.conf"), 0o644)
    containers, urls = {}, {}
    try:
        for node in NODES:
            c = client.containers.run(
                RABBITMQ_IMAGE,
                detach=True,
                name=f"{node}-{suffix}",
                hostname=node,
                network=network.name,
                environment={"RABBITMQ_ERLANG_COOKIE": f"relay-quorum-test-{suffix}"},
                volumes={confdir: {"bind": "/etc/rabbitmq", "mode": "ro"}},
                ports={"5672/tcp": ("127.0.0.1", None)},
            )
            containers[node] = c
        for node, c in containers.items():
            c.reload()
            port = c.attrs["NetworkSettings"]["Ports"]["5672/tcp"][0]["HostPort"]
            urls[node] = f"amqp://guest:guest@127.0.0.1:{port}/"

        def three_running():
            out = containers[NODES[0]].exec_run("rabbitmqctl cluster_status --formatter json", user="rabbitmq")
            if out.exit_code != 0:
                return False
            text = out.output.decode()
            status = json.loads(text[text.index("{") :])
            return len(status.get("running_nodes", [])) == 3

        try:
            _wait("a three-node cluster", three_running)
        except BaseException:
            for node, c in containers.items():
                c.reload()
                tail = c.logs(tail=15).decode(errors="replace")
                print(f"== {node} ({c.status})\n{tail}")
            raise
        yield containers, urls
    finally:
        for c in containers.values():
            c.remove(force=True)
        network.remove()


async def _channel(url):
    connection = await aio_pika.connect_robust(url, timeout=10)
    return connection, await connection.channel(publisher_confirms=True)


async def _publish(channel, queue, count, timeout):
    for i in range(count):
        await asyncio.wait_for(
            channel.default_exchange.publish(
                aio_pika.Message(str(i).encode(), delivery_mode=aio_pika.DeliveryMode.PERSISTENT),
                routing_key=queue,
            ),
            timeout,
        )


# rabbitmqctl runs as the rabbitmq user: run as root before the server starts, it would create
# the Erlang cookie file owned by root, and the server could then not read it.
def _queue_info(container, queue):
    out = container.exec_run("rabbitmqctl list_queues name leader members --formatter json", user="rabbitmq")
    text = out.output.decode()
    for q in json.loads(text[text.index("[") :]):  # JSON may span lines, after any banner
        if q["name"] == queue:
            return q
    return None


def test_quorum_queue_keeps_confirmed_messages_and_needs_a_majority(cluster):
    containers, urls = cluster
    queue = f"relay.quorum-test-{uuid.uuid4().hex[:8]}"

    async def scenario():
        conn, ch = await _channel(urls[NODES[0]])
        await publisher.declare(ch, queue, delivery_limit=5)
        await _publish(ch, queue, MESSAGES, timeout=10)  # every message confirmed by a majority
        await conn.close()

    asyncio.run(scenario())

    info = _wait("the queue on all three nodes", lambda: _queue_info(containers[NODES[0]], queue))
    assert len(info["members"]) == 3
    leader = info["leader"].split("@", 1)[1]
    survivors = [n for n in NODES if n != leader]

    # 1. Stop the leader: the confirmed messages are all still there, under a new leader.
    containers[leader].stop(timeout=5)

    def new_leader():
        q = _queue_info(containers[survivors[0]], queue)
        return q and q["leader"] and not q["leader"].endswith("@" + leader) and q

    moved = _wait("a new leader", new_leader, timeout=60)
    assert moved["leader"].split("@", 1)[1] in survivors

    async def drain():
        conn, ch = await _channel(urls[survivors[0]])
        q = await ch.declare_queue(queue, passive=True)
        assert q.declaration_result.message_count == MESSAGES
        await conn.close()

    asyncio.run(drain())

    # 2. Stop a second node: one of three is no majority, so a publish is never confirmed.
    containers[survivors[1]].stop(timeout=5)

    async def publish_without_majority():
        conn, ch = await _channel(urls[survivors[0]])
        with pytest.raises((asyncio.TimeoutError, aio_pika.exceptions.AMQPError)):
            await _publish(ch, queue, 1, timeout=10)
        await conn.close()

    asyncio.run(publish_without_majority())

    # 3. Bring one back: a majority again, and publishing is confirmed.
    containers[survivors[1]].start()

    async def publish_with_majority():
        conn, ch = await _channel(urls[survivors[0]])
        await _publish(ch, queue, 1, timeout=10)
        await conn.close()
        return True

    def majority_publish():
        return asyncio.run(publish_with_majority())

    _wait("a confirmed publish after the majority returned", majority_publish, timeout=120)
