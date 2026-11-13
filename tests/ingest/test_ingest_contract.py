"""Property-based contract tests: Schemathesis generates requests from the OpenAPI
document (valid and invalid) and checks the API never fails with a 5xx and always
answers with the status codes, content types and bodies the document declares."""

import pytest
import schemathesis
from hypothesis import HealthCheck, settings
from psycopg_pool import AsyncConnectionPool
from schemathesis.specs.openapi.checks import positive_data_acceptance

from relay_dataplane.ingest import create_app

# "Schema-valid data must be accepted" does not hold for one documented rule the schema
# cannot express: event_type must be registered for the tenant (unknown types get 422,
# tested in test_ingest_api.py). Every other check, including no 5xx, stays on.
NOT_EXPRESSIBLE_IN_SCHEMA = [positive_data_acceptance]


@pytest.fixture
def ingest_schema(pg_dsn):
    pool = AsyncConnectionPool(
        f"{pg_dsn} user=relay_tenant", min_size=1, max_size=4, kwargs={"autocommit": True}, open=False
    )
    return schemathesis.openapi.from_asgi("/ingest/v1/openapi.json", create_app(pool))


schema = schemathesis.pytest.from_fixture("ingest_schema")


@schema.parametrize()
@settings(
    max_examples=150,
    deadline=None,
    suppress_health_check=[HealthCheck.function_scoped_fixture, HealthCheck.too_slow, HealthCheck.filter_too_much],
)
def test_api_matches_its_contract_with_a_valid_key(case, tenant):
    case.call_and_validate(headers={"Authorization": f"Bearer {tenant.key}"}, excluded_checks=NOT_EXPRESSIBLE_IN_SCHEMA)


@schema.parametrize()
@settings(
    max_examples=50,
    deadline=None,
    suppress_health_check=[HealthCheck.function_scoped_fixture, HealthCheck.too_slow, HealthCheck.filter_too_much],
)
def test_api_matches_its_contract_without_a_key(case):
    case.call_and_validate()
