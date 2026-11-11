"""Worker-side use of the guarded database functions (the HTTP send is added later)."""
import json
import os

import psycopg


def claim_from_message(conn: psycopg.Connection, body: bytes, lease_for: str = "60 seconds"):
    """Try to claim the delivery named by a queue message. Returns (row, lease_token) or None.

    None means a stale or duplicate message; the caller just acks it.
    """
    msg = json.loads(body)
    lease_token = os.urandom(16)
    rows = conn.execute(
        "SELECT * FROM delivery.claim_delivery(%s, %s, %s, %s, %s::interval)",
        (msg["delivery_id"], msg["dispatch_seq"], bytes.fromhex(msg["dispatch_token"]),
         lease_token, lease_for)).fetchall()
    return (rows[0], lease_token) if rows else None
