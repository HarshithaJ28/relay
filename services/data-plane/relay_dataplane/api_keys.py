"""Tenant API keys.

Format: rly_<prefix>_<secret>, where prefix is 12 hex characters (safe to show in
lists and logs) and secret is 32 random bytes in URL-safe base64. Only the SHA-256
of the whole key is stored; the key itself is shown once, when it is created.
"""

import base64
import hashlib
import re
import secrets
import uuid

import psycopg

KEY_PATTERN = re.compile(r"^rly_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$")
SCOPES = ("events:write", "events:read")


def generate() -> tuple[str, str]:
    """Return (key, prefix) for a new random key."""
    prefix = secrets.token_hex(6)
    secret = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip("=")
    return f"rly_{prefix}_{secret}", prefix


def key_hash(key: str) -> bytes:
    return hashlib.sha256(key.encode()).digest()


def looks_valid(key: str) -> bool:
    return bool(KEY_PATTERN.match(key))


def create(conn: psycopg.Connection, tenant_id: uuid.UUID, name: str = "", scopes=SCOPES) -> tuple[str, str]:
    """Create a key for one tenant (connected as relay_tenant). Returns (key, prefix); store the key now."""
    key, prefix = generate()
    with conn.transaction():
        conn.execute("SELECT set_config('app.tenant_id', %s, true)", (str(tenant_id),))
        conn.execute(
            "INSERT INTO control.api_keys (tenant_id, prefix, key_hash, name, scopes) VALUES (%s, %s, %s, %s, %s)",
            (tenant_id, prefix, key_hash(key), name, list(scopes)),
        )
    return key, prefix
