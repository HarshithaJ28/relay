"""TLS for the local test receiver: a throwaway CA and a certificate for HOST."""

import ssl

import pytest
import trustme

HOST = "receiver.relay.test"


@pytest.fixture(scope="session")
def ca():
    return trustme.CA()


@pytest.fixture(scope="session")
def server_ssl(ca):
    ctx = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
    ca.issue_cert(HOST).configure_cert(ctx)
    return ctx


@pytest.fixture(scope="session")
def client_ssl(ca):
    ctx = ssl.create_default_context()
    ca.configure_trust(ctx)
    return ctx
