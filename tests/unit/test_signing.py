import base64
import hashlib
import hmac

import pytest

from relay_dataplane import signing

SECRET = "whsec_" + base64.b64encode(b"0123456789abcdef0123456789abcdef").decode()
OTHER = "whsec_" + base64.b64encode(b"another-secret-another-secret-32b").decode()
BODY = b'{"order":42}'


def independent_signature(secret: str, msg_id: str, ts: int, body: bytes) -> str:
    """Recomputed from the published scheme without calling the module under test."""
    key = base64.b64decode(secret.removeprefix("whsec_"))
    mac = hmac.new(key, f"{msg_id}.{ts}.".encode() + body, hashlib.sha256).digest()
    return "v1," + base64.b64encode(mac).decode()


def test_signature_matches_independent_computation():
    assert signing.sign(SECRET, "msg_1", 1700000000, BODY) == independent_signature(SECRET, "msg_1", 1700000000, BODY)


def test_headers_have_the_three_standard_names():
    h = signing.signed_headers([SECRET], "msg_1", 1700000000, BODY)
    assert set(h) == {"webhook-id", "webhook-timestamp", "webhook-signature"}
    assert h["webhook-signature"].startswith("v1,")


def test_verify_round_trip():
    h = signing.signed_headers([SECRET], "msg_1", 1700000000, BODY)
    assert signing.verify(SECRET, h, BODY, now=1700000010)


def test_verify_rejects_tampered_body_wrong_secret_and_wrong_id():
    h = signing.signed_headers([SECRET], "msg_1", 1700000000, BODY)
    assert not signing.verify(SECRET, h, BODY + b" ", now=1700000010)
    assert not signing.verify(OTHER, h, BODY, now=1700000010)
    assert not signing.verify(SECRET, {**h, "webhook-id": "msg_2"}, BODY, now=1700000010)


def test_verify_enforces_timestamp_tolerance_both_directions():
    h = signing.signed_headers([SECRET], "msg_1", 1700000000, BODY)
    assert signing.verify(SECRET, h, BODY, now=1700000299)
    assert not signing.verify(SECRET, h, BODY, now=1700000301)
    assert not signing.verify(SECRET, h, BODY, now=1699999600)


def test_rotation_sends_two_signatures_and_either_secret_verifies():
    h = signing.signed_headers([SECRET, OTHER], "msg_1", 1700000000, BODY)
    assert len(h["webhook-signature"].split(" ")) == 2
    assert signing.verify(SECRET, h, BODY, now=1700000000)
    assert signing.verify(OTHER, h, BODY, now=1700000000)


def test_missing_headers_fail_closed():
    assert not signing.verify(SECRET, {}, BODY)
    assert not signing.verify(SECRET, {"webhook-id": "m", "webhook-timestamp": "x", "webhook-signature": "v1,a"}, BODY)


@pytest.mark.parametrize("bad", ["plain", "whsec_***not-base64***"])
def test_malformed_secret_is_rejected(bad):
    with pytest.raises(ValueError):
        signing.sign(bad, "m", 1, BODY)
    with pytest.raises(ValueError):
        signing.signed_headers([], "m", 1, BODY)


# Official test vector from the Standard Webhooks repository
# (github.com/standard-webhooks/standard-webhooks, libraries/go/webhook_test.go, TestWebhookSign).
OFFICIAL_SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"  # gitleaks:allow (public test vector)
OFFICIAL_MSG_ID = "msg_p5jXN8AQM9LWM0D4loKWxJek"
OFFICIAL_TS = 1614265330
OFFICIAL_BODY = b'{"test": 2432232314}'
OFFICIAL_SIGNATURE = "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE="


def test_official_standard_webhooks_vector():
    assert signing.sign(OFFICIAL_SECRET, OFFICIAL_MSG_ID, OFFICIAL_TS, OFFICIAL_BODY) == OFFICIAL_SIGNATURE


def test_official_vector_verifies_and_a_near_miss_does_not():
    headers = {"webhook-id": OFFICIAL_MSG_ID, "webhook-timestamp": str(OFFICIAL_TS)}
    ok = {**headers, "webhook-signature": OFFICIAL_SIGNATURE}
    assert signing.verify(OFFICIAL_SECRET, ok, OFFICIAL_BODY, now=OFFICIAL_TS)
    # one character changed (the invalid-signature case in the official Python library tests)
    near = {**headers, "webhook-signature": "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OA="}
    assert not signing.verify(OFFICIAL_SECRET, near, OFFICIAL_BODY, now=OFFICIAL_TS)
