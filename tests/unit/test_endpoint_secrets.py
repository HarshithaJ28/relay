"""AES-256-GCM encryption of endpoint signing secrets, keyrings and rotation (no database)."""

import base64
from datetime import UTC, datetime, timedelta

import pytest

from relay_dataplane import signing
from relay_dataplane.endpoint_secrets import (
    Keyring,
    SecretUnavailable,
    active_secrets,
    generate_signing_secret,
    new_entry,
    reencrypt,
)

K1 = bytes(range(32))
K2 = bytes(range(32, 64))
EP = "0b9b2a4e-6f0c-4a51-9a52-3c1e1f6a1a01"
OTHER_EP = "0b9b2a4e-6f0c-4a51-9a52-3c1e1f6a1a02"
SECRET = "whsec_" + base64.b64encode(b"s" * 32).decode()
NOW = datetime(2026, 11, 13, 12, 0, tzinfo=UTC)


def b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode()


@pytest.fixture
def ring():
    return Keyring({"k1": K1}, "k1")


def test_round_trip_and_fresh_nonce(ring):
    a, b = ring.encrypt(EP, "s1", SECRET), ring.encrypt(EP, "s1", SECRET)
    assert a["ciphertext"] != b["ciphertext"]  # new random nonce each time
    assert SECRET not in a["ciphertext"] and a["key_id"] == "k1" and a["kid"] == "s1"
    assert ring.decrypt(EP, a) == ring.decrypt(EP, b) == SECRET


@pytest.mark.parametrize(
    "change",
    [
        pytest.param(lambda e: e, id="copied to another endpoint"),
        pytest.param(lambda e: {**e, "kid": "s2"}, id="kid relabelled"),
    ],
)
def test_ciphertext_is_bound_to_endpoint_and_kid(ring, change):
    entry = ring.encrypt(EP, "s1", SECRET)
    endpoint = OTHER_EP if change(entry) is entry else EP
    with pytest.raises(SecretUnavailable):
        ring.decrypt(endpoint, change(entry))


def test_any_flipped_byte_is_rejected(ring):
    entry = ring.encrypt(EP, "s1", SECRET)
    raw = base64.b64decode(entry["ciphertext"])
    for i in range(len(raw)):
        tampered = bytearray(raw)
        tampered[i] ^= 0x01
        with pytest.raises(SecretUnavailable):
            ring.decrypt(EP, {**entry, "ciphertext": b64(bytes(tampered))})


@pytest.mark.parametrize(
    "entry",
    [
        {"kid": "s1", "key_id": "k9", "ciphertext": b64(b"x" * 40)},  # unknown master key
        {"kid": "s1", "key_id": "k1", "ciphertext": "not base64!"},
        {"kid": "s1", "key_id": "k1", "ciphertext": b64(b"short")},
        {"kid": "s1", "key_id": "k1", "ciphertext": ""},
        {"kid": "s1", "key_id": "k1"},
        {"kid": 1, "key_id": "k1", "ciphertext": b64(b"x" * 40)},
        {},
    ],
)
def test_bad_entries_raise_secret_unavailable(ring, entry):
    with pytest.raises(SecretUnavailable):
        ring.decrypt(EP, entry)


def test_errors_and_repr_never_contain_key_or_secret(ring):
    entry = ring.encrypt(EP, "s1", SECRET)
    with pytest.raises(SecretUnavailable) as e:
        ring.decrypt(OTHER_EP, entry)
    assert SECRET not in str(e.value)
    shown = repr(ring) + str(ring)
    assert all(form not in shown for form in (b64(K1), repr(K1)[2:-1], K1.hex(), str(list(K1))))
    assert shown.startswith("Keyring(current='k1'")


# ---------------------------------------------------------------- keyrings


def test_parse_keyring_first_key_is_current():
    ring = Keyring.parse(f"k2:{b64(K2)}, k1:{b64(K1)}")
    assert ring.current == "k2" and set(ring.keys) == {"k1", "k2"}
    assert Keyring.parse(f"# rotated 2026-11\nk2:{b64(K2)}\nk1:{b64(K1)}\n").current == "k2"


@pytest.mark.parametrize(
    "text",
    [
        "",
        "k1",
        f"k1:{b64(K1)},k1:{b64(K2)}",  # duplicate id
        f"k1:{b64(b'short')}",  # not 32 bytes
        "k1:@@@",  # not base64
        f"bad id:{b64(K1)}",
        f"{'k' * 33}:{b64(K1)}",
    ],
)
def test_parse_rejects_bad_keyrings(text):
    with pytest.raises(ValueError):
        Keyring.parse(text)


def test_keyring_from_env_or_file(tmp_path):
    assert Keyring.from_env({"RELAY_SECRET_KEYS": f"k1:{b64(K1)}"}).current == "k1"
    path = tmp_path / "keys"
    path.write_text(f"k2:{b64(K2)}\nk1:{b64(K1)}\n")
    assert Keyring.from_env({"RELAY_SECRET_KEYS_FILE": str(path)}).current == "k2"
    with pytest.raises(ValueError):
        Keyring.from_env({})
    with pytest.raises(ValueError):
        Keyring.from_env({"RELAY_SECRET_KEYS": f"k1:{b64(K1)}", "RELAY_SECRET_KEYS_FILE": str(path)})


def test_master_key_rotation():
    old = Keyring({"k1": K1}, "k1")
    entry = old.encrypt(EP, "s1", SECRET)

    both = Keyring({"k2": K2, "k1": K1}, "k2")  # first: add the new key as current
    assert both.decrypt(EP, entry) == SECRET  # old ciphertexts still decrypt
    [fresh] = reencrypt(both, EP, [{**entry, "expires_at": None}])  # then: re-encrypt stored secrets
    assert fresh["key_id"] == "k2" and fresh["kid"] == "s1" and fresh["expires_at"] is None

    new_only = Keyring({"k2": K2}, "k2")  # finally: remove the old key
    assert new_only.decrypt(EP, fresh) == SECRET
    with pytest.raises(SecretUnavailable):
        new_only.decrypt(EP, entry)


# ---------------------------------------------------------------- active secrets and signing-secret rotation


def test_two_secrets_during_rotation_are_both_active(ring):
    new = generate_signing_secret()
    entries = [
        new_entry(ring, EP, "s1", SECRET, expires_at=NOW + timedelta(days=1)),
        new_entry(ring, EP, "s2", new),
    ]
    assert active_secrets(ring, EP, entries, NOW) == [SECRET, new]


def test_expired_secrets_are_skipped(ring):
    new = generate_signing_secret()
    entries = [new_entry(ring, EP, "s1", SECRET, expires_at=NOW), new_entry(ring, EP, "s2", new)]
    assert active_secrets(ring, EP, entries, NOW) == [new]


@pytest.mark.parametrize(
    "entries",
    [
        pytest.param([], id="none"),
        pytest.param("all-expired", id="all expired"),
        pytest.param("naive-expiry", id="expiry without time zone"),
        pytest.param("bad-expiry", id="unparseable expiry"),
    ],
)
def test_no_usable_secret_raises(ring, entries):
    if entries == "all-expired":
        entries = [new_entry(ring, EP, "s1", SECRET, expires_at=NOW - timedelta(seconds=1))]
    elif entries == "naive-expiry":
        entries = [{**ring.encrypt(EP, "s1", SECRET), "expires_at": "2030-01-01T00:00:00"}]
    elif entries == "bad-expiry":
        entries = [{**ring.encrypt(EP, "s1", SECRET), "expires_at": "tomorrow"}]
    with pytest.raises(SecretUnavailable):
        active_secrets(ring, EP, entries, NOW)


def test_one_corrupted_secret_fails_the_set(ring):
    """Signing with only the healthy secret would silently break receivers on the other one."""
    good = new_entry(ring, EP, "s1", SECRET)
    bad = {**new_entry(ring, EP, "s2", SECRET), "key_id": "gone"}
    with pytest.raises(SecretUnavailable):
        active_secrets(ring, EP, [good, bad], NOW)


def test_generated_secret_is_a_usable_standard_webhooks_secret():
    s = generate_signing_secret()
    assert s.startswith("whsec_") and len(base64.b64decode(s[6:])) == 32
    assert s != generate_signing_secret()
    headers = signing.signed_headers([s], "msg_1", 1_700_000_000, b"{}")
    assert signing.verify(s, headers, b"{}", now=1_700_000_000)


def test_secrets_encrypted_by_the_control_plane_decrypt_here():
    """The TypeScript control plane writes ciphertexts the Python worker must read (and back)."""
    import json
    import pathlib

    from tests.conftest import TEST_KEYRING

    vectors = json.loads((pathlib.Path(__file__).resolve().parents[1] / "fixtures" / "secret_vectors.json").read_text())
    for origin in ("from_typescript", "from_python"):
        v = vectors[origin]
        assert TEST_KEYRING.decrypt(vectors["endpoint_id"], v["entry"]) == v["plaintext"], origin
