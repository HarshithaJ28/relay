"""The signing_secrets column (migration 0004): shape constraints, and what claim_delivery returns."""

import base64
import uuid

import psycopg
import pytest
from psycopg.types.json import Jsonb

from tests.conftest import TEST_KEYRING, TEST_SECRET
from tests.worker.test_worker_core import queue_message

GOOD = {"kid": "s1", "key_id": "k1", "ciphertext": base64.b64encode(b"x" * 40).decode(), "expires_at": None}


@pytest.mark.parametrize(
    "value",
    [
        pytest.param([], id="empty"),
        pytest.param([GOOD, {**GOOD, "kid": "s2"}, {**GOOD, "kid": "s3"}], id="three secrets"),
        pytest.param(GOOD, id="object not array"),
        pytest.param(["whsec_plaintext"], id="string entry"),
        pytest.param([{k: v for k, v in GOOD.items() if k != "ciphertext"}], id="missing ciphertext"),
        pytest.param([{k: v for k, v in GOOD.items() if k != "key_id"}], id="missing key_id"),
        pytest.param([{**GOOD, "kid": 7}], id="numeric kid"),
        pytest.param([GOOD, {"kid": "s2"}], id="second entry incomplete"),
    ],
)
def test_database_rejects_malformed_secret_lists(connect, factory, value):
    tenant = factory.tenant()
    with connect() as c, pytest.raises(psycopg.errors.CheckViolation):
        c.execute(
            "INSERT INTO control.endpoints (tenant_id, url, signing_secrets) VALUES (%s, 'https://x.example', %s)",
            (tenant, Jsonb(value)),
        )


def test_database_accepts_one_or_two_secrets(connect, factory):
    tenant = factory.tenant()
    with connect() as c:
        for value in ([GOOD], [GOOD, {**GOOD, "kid": "s2", "expires_at": "2030-01-01T00:00:00+00:00"}]):
            c.execute(
                "INSERT INTO control.endpoints (tenant_id, url, signing_secrets) VALUES (%s, 'https://x.example', %s)",
                (tenant, Jsonb(value)),
            )


def test_the_old_single_secret_column_is_gone(connect):
    with connect() as c:
        cols = {
            r[0]
            for r in c.execute(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_schema = 'control' AND table_name = 'endpoints'"
            )
        }
    assert "signing_secrets" in cols and "secret_ciphertext" not in cols


def test_claim_returns_ciphertexts_and_endpoint_id_never_plaintext(connect, factory):
    d = factory.delivery()
    body = queue_message(connect, factory, d)
    import json

    m = json.loads(body)
    with connect("relay_worker") as c:
        [row] = c.execute(
            "SELECT * FROM delivery.claim_delivery(%s,%s,%s,%s,'1 minute')",
            (d, m["dispatch_seq"], bytes.fromhex(m["dispatch_token"]), uuid.uuid4().bytes),
        ).fetchall()
    endpoint_id = factory.row(d)["endpoint_id"]
    secrets, payload, returned_endpoint = row[5], row[6], row[7]
    assert payload == {"k": 1} and returned_endpoint == endpoint_id
    assert TEST_SECRET not in str(secrets)
    assert TEST_KEYRING.decrypt(str(endpoint_id), secrets[0]) == TEST_SECRET


def test_worker_role_still_cannot_read_endpoints(connect):
    with connect("relay_worker") as c, pytest.raises(psycopg.errors.InsufficientPrivilege):
        c.execute("SELECT signing_secrets FROM control.endpoints")


def test_new_claim_function_is_not_executable_by_other_roles(connect, factory):
    d = factory.delivery()
    for role in ("relay_scheduler", "relay_publisher", "relay_reaper", "relay_tenant"):
        with connect(role) as c, pytest.raises(psycopg.errors.InsufficientPrivilege):
            c.execute("SELECT * FROM delivery.claim_delivery(%s,1,%s,%s,'1 minute')", (d, b"x" * 16, b"y" * 16))


def test_claim_function_keeps_a_fixed_search_path_and_owner(connect):
    with connect() as c:
        owner, config, definer = c.execute(
            "SELECT pg_get_userbyid(proowner), proconfig, prosecdef FROM pg_proc "
            "WHERE oid = 'delivery.claim_delivery(uuid,int,bytea,bytea,interval)'::regprocedure"
        ).fetchone()
    assert owner == "relay_claims" and definer is True
    assert config == ["search_path=pg_catalog, pg_temp"]
