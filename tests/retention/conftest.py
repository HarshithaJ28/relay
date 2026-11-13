"""The AC-3 test reads events through the ingestion API, so it shares the ingestion fixtures."""

from tests.ingest.conftest import api, make_tenant  # noqa: F401  (pytest fixtures)
