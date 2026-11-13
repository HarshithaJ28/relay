"""Encryption of endpoint signing secrets at rest (AES-256-GCM).

- Master keys come from the environment (RELAY_SECRET_KEYS) or a mounted file
  (RELAY_SECRET_KEYS_FILE, for a Kubernetes Secret). Each key has an id; the
  first listed key encrypts new secrets, and every listed key can decrypt, so
  the master key rotates by adding a new key first and removing the old one
  after the stored secrets are re-encrypted.
- Each ciphertext is bound to its endpoint and secret id through the GCM
  associated data, so a ciphertext copied to another endpoint does not decrypt.
- An endpoint holds one or two signing secrets (two during a rotation). The
  worker signs with every secret that has not expired, so receivers that still
  use the old secret keep verifying while they switch.

Plaintext secrets are never logged and never appear in exception messages.
"""

import base64
import binascii
import os
import re
import secrets
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

NONCE_BYTES = 12
KEY_BYTES = 32
_KEY_ID = re.compile(r"^[A-Za-z0-9_-]{1,32}$")
_AAD_PREFIX = b"relay:endpoint-signing-secret:v1"


class SecretUnavailable(Exception):
    """No usable signing secret: none active, unknown master key, or a ciphertext that does not decrypt."""


@dataclass(frozen=True, repr=False)
class Keyring:
    keys: Mapping[str, bytes]  # key id -> 32-byte AES key
    current: str  # key id used for new encryptions

    def __post_init__(self):
        if self.current not in self.keys:
            raise ValueError("current key id is not in the keyring")
        for key_id, key in self.keys.items():
            if not _KEY_ID.match(key_id):
                raise ValueError(f"invalid key id {key_id!r}")
            if len(key) != KEY_BYTES:
                raise ValueError(f"key {key_id!r} must be {KEY_BYTES} bytes")

    def __repr__(self) -> str:  # never print key material
        return f"Keyring(current={self.current!r}, key_ids={sorted(self.keys)!r})"

    @classmethod
    def parse(cls, text: str) -> "Keyring":
        """Parse "id:base64key" entries separated by commas or newlines; the first is current."""
        keys: dict[str, bytes] = {}
        order: list[str] = []
        for item in re.split(r"[,\n]", text):
            item = item.strip()
            if not item or item.startswith("#"):
                continue
            key_id, sep, encoded = item.partition(":")
            if not sep:
                raise ValueError("keyring entries must look like id:base64key")
            if key_id in keys:
                raise ValueError(f"duplicate key id {key_id!r}")
            try:
                keys[key_id] = base64.b64decode(encoded.strip(), validate=True)
            except binascii.Error:
                raise ValueError(f"key {key_id!r} is not valid base64") from None
            order.append(key_id)
        if not order:
            raise ValueError("keyring is empty")
        return cls(keys, order[0])

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "Keyring":
        env = os.environ if env is None else env
        inline, path = env.get("RELAY_SECRET_KEYS"), env.get("RELAY_SECRET_KEYS_FILE")
        if bool(inline) == bool(path):
            raise ValueError("set exactly one of RELAY_SECRET_KEYS and RELAY_SECRET_KEYS_FILE")
        if path:
            with open(path, encoding="utf-8") as f:
                inline = f.read()
        return cls.parse(inline)

    def encrypt(self, endpoint_id: str, kid: str, plaintext: str) -> dict[str, str]:
        nonce = os.urandom(NONCE_BYTES)
        sealed = AESGCM(self.keys[self.current]).encrypt(nonce, plaintext.encode(), _aad(endpoint_id, kid))
        return {"kid": kid, "key_id": self.current, "ciphertext": base64.b64encode(nonce + sealed).decode()}

    def decrypt(self, endpoint_id: str, entry: Mapping[str, object]) -> str:
        kid, key_id, blob = entry.get("kid"), entry.get("key_id"), entry.get("ciphertext")
        if not (isinstance(kid, str) and isinstance(key_id, str) and isinstance(blob, str)):
            raise SecretUnavailable("malformed secret entry")
        key = self.keys.get(key_id)
        if key is None:
            raise SecretUnavailable(f"secret {kid!r} uses unknown master key {key_id!r}")
        try:
            raw = base64.b64decode(blob, validate=True)
            if len(raw) <= NONCE_BYTES:
                raise ValueError("too short")
            return AESGCM(key).decrypt(raw[:NONCE_BYTES], raw[NONCE_BYTES:], _aad(endpoint_id, kid)).decode()
        except (InvalidTag, ValueError, binascii.Error):
            raise SecretUnavailable(f"secret {kid!r} does not decrypt") from None


def _aad(endpoint_id: str, kid: str) -> bytes:
    return b"\0".join([_AAD_PREFIX, str(endpoint_id).encode(), kid.encode()])


def generate_signing_secret() -> str:
    """A new Standard Webhooks secret: whsec_ + base64 of 32 random bytes."""
    return "whsec_" + base64.b64encode(secrets.token_bytes(32)).decode()


def new_entry(keyring: Keyring, endpoint_id: str, kid: str, secret: str, expires_at: datetime | None = None) -> dict:
    """An encrypted entry for control.endpoints.signing_secrets."""
    entry: dict = keyring.encrypt(endpoint_id, kid, secret)
    entry["expires_at"] = expires_at.isoformat() if expires_at else None
    return entry


def active_secrets(keyring: Keyring, endpoint_id: str, entries: Sequence[Mapping], now: datetime) -> list[str]:
    """Decrypt every entry that has not expired. Raises SecretUnavailable if none is usable."""
    out = []
    for entry in entries:
        expires = entry.get("expires_at")
        if expires is not None:
            try:
                expires_at = datetime.fromisoformat(str(expires))
            except ValueError:
                raise SecretUnavailable(f"secret {entry.get('kid')!r} has an invalid expires_at") from None
            if expires_at.tzinfo is None:
                raise SecretUnavailable(f"secret {entry.get('kid')!r} has expires_at without a time zone")
            if expires_at <= now:
                continue
        out.append(keyring.decrypt(endpoint_id, entry))
    if not out:
        raise SecretUnavailable("endpoint has no active signing secret")
    return out


def reencrypt(keyring: Keyring, endpoint_id: str, entries: Sequence[Mapping]) -> list[dict]:
    """Re-encrypt entries under the current master key (master-key rotation), keeping kid and expiry."""
    out = []
    for entry in entries:
        fresh: dict = keyring.encrypt(endpoint_id, str(entry["kid"]), keyring.decrypt(endpoint_id, entry))
        fresh["expires_at"] = entry.get("expires_at")
        out.append(fresh)
    return out
