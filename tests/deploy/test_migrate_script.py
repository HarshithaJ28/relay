"""db/migrate.sh, the deploy-time migration runner: every file once, each in one transaction."""

import os
import shutil
import socket
import subprocess
import time
import uuid
from pathlib import Path

import psycopg
import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "db" / "migrate.sh"
MIGRATIONS = ROOT / "db" / "migrations"


@pytest.fixture
def fresh_db(pg_dsn):
    server = " ".join(kv for kv in pg_dsn.split() if not kv.startswith("dbname="))
    name = f"relay_migrate_{uuid.uuid4().hex[:10]}"
    with psycopg.connect(f"{server} dbname=postgres user=postgres", autocommit=True) as c:
        c.execute(f"CREATE DATABASE {name}")
    yield f"{server} dbname={name} user=postgres"
    with psycopg.connect(f"{server} dbname=postgres user=postgres", autocommit=True) as c:
        c.execute(f"DROP DATABASE IF EXISTS {name} WITH (FORCE)")


def run(dsn, migrations=MIGRATIONS, **env):
    if shutil.which("psql") is None:
        pytest.fail("psql is required for the migration runner tests")
    return subprocess.run(
        ["sh", str(SCRIPT)],
        env={**os.environ, "DATABASE_URL": dsn, "RELAY_MIGRATIONS_DIR": str(migrations), **env},
        capture_output=True,
        text=True,
        timeout=300,
    )


def functions(dsn):
    with psycopg.connect(dsn) as c:
        return c.execute(
            "SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' "
            "FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace "
            "WHERE n.nspname IN ('control', 'delivery') ORDER BY 1"
        ).fetchall()


def test_applies_every_migration_once_and_matches_the_test_schema(fresh_db, pg_dsn):
    first = run(fresh_db, RELAY_PASSWORD_REAPER="a 'quoted\" password")
    assert first.returncode == 0, first.stderr
    names = sorted(p.stem for p in MIGRATIONS.glob("*.sql"))
    assert [line.split()[-1] for line in first.stdout.splitlines() if line.startswith("applying")] == names
    assert "role relay_reaper: login enabled" in first.stdout
    with psycopg.connect(fresh_db) as c:
        recorded = [r[0] for r in c.execute("SELECT version FROM relay_schema_migrations ORDER BY 1")]
    assert recorded == names
    # the same functions as the harness, which applies the files directly
    assert functions(fresh_db) == functions(f"{pg_dsn} user=postgres")

    second = run(fresh_db)
    assert second.returncode == 0, second.stderr
    assert "applying" not in second.stdout


def test_a_failing_migration_leaves_nothing_behind(fresh_db, tmp_path):
    for f in MIGRATIONS.glob("*.sql"):
        shutil.copy(f, tmp_path / f.name)
    broken = tmp_path / "9999_broken.sql"
    broken.write_text("-- migrate:up\nCREATE TABLE public.half_done (x int);\nSELECT 1 / 0;\n-- migrate:down\n")
    failed = run(fresh_db, tmp_path)
    assert failed.returncode != 0
    with psycopg.connect(fresh_db) as c:
        assert c.execute("SELECT to_regclass('public.half_done')").fetchone()[0] is None
        assert c.execute("SELECT count(*) FROM relay_schema_migrations WHERE version = '9999_broken'").fetchone() == (
            0,
        )
    broken.write_text("-- migrate:up\nCREATE TABLE public.half_done (x int);\n-- migrate:down\nDROP TABLE x;\n")
    fixed = run(fresh_db, tmp_path)
    assert fixed.returncode == 0, fixed.stderr
    assert [line for line in fixed.stdout.splitlines() if line.startswith("applying")] == ["applying 9999_broken"]


def test_refuses_to_run_without_a_database_url():
    r = subprocess.run(["sh", str(SCRIPT)], env={"PATH": os.environ["PATH"]}, capture_output=True, text=True)
    assert r.returncode != 0
    assert "DATABASE_URL is required" in r.stderr


def test_gives_up_on_a_database_that_never_answers():
    """A connection that is accepted and then never answered (or dropped, as a network
    policy does) must time out and fail with the reason, not hang the deploy."""
    silent = socket.socket()
    silent.bind(("127.0.0.1", 0))
    silent.listen(16)
    port = silent.getsockname()[1]
    try:
        started = time.monotonic()
        r = subprocess.run(
            ["sh", str(SCRIPT)],
            env={
                **os.environ,
                "DATABASE_URL": f"postgresql://postgres@127.0.0.1:{port}/relay",
                "RELAY_MIGRATE_WAIT_SECONDS": "3",
            },
            capture_output=True,
            text=True,
            timeout=40,
        )
        elapsed = time.monotonic() - started
    finally:
        silent.close()
    assert r.returncode != 0
    assert "database not reachable after 3s" in r.stderr
    assert "timeout" in r.stderr.lower()
    assert elapsed < 30
