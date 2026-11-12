"""Worker-side use of the guarded database functions."""

import json
import os
from dataclasses import dataclass

import psycopg


@dataclass(frozen=True)
class DispatchMessage:
    delivery_id: str
    dispatch_seq: int
    dispatch_token: bytes


def parse_message(body: bytes) -> DispatchMessage:
    msg = json.loads(body)
    return DispatchMessage(msg["delivery_id"], int(msg["dispatch_seq"]), bytes.fromhex(msg["dispatch_token"]))


CLAIM_SQL = "SELECT * FROM delivery.claim_delivery(%s, %s, %s, %s, %s::interval)"


def claim_from_message(conn: psycopg.Connection, body: bytes, lease_for: str = "60 seconds"):
    """Try to claim the delivery named by a queue message. Returns (row, lease_token) or None.

    None means a stale or duplicate message; the caller just acks it.
    """
    m = parse_message(body)
    lease_token = os.urandom(16)
    rows = conn.execute(CLAIM_SQL, (m.delivery_id, m.dispatch_seq, m.dispatch_token, lease_token, lease_for)).fetchall()
    return (rows[0], lease_token) if rows else None
