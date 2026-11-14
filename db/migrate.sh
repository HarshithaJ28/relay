#!/bin/sh
# Apply db/migrations in order, then let each service role log in with its password.
# Runs as a superuser (DATABASE_URL), once per deploy, before the services start.
#
# Each file's "-- migrate:up" section (up to "-- migrate:down", if present) runs in one
# transaction together with the row that records it in relay_schema_migrations, so a file
# is applied completely and exactly once. Applied files are skipped. A role whose
# RELAY_PASSWORD_<NAME> is unset is left unable to log in.
set -eu
: "${DATABASE_URL:?DATABASE_URL is required (a superuser connection URL)}"
DIR="${RELAY_MIGRATIONS_DIR:-/db/migrations}"
export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"
# A dropped connection (for example by a network policy) must fail, not hang.
export PGCONNECT_TIMEOUT="${PGCONNECT_TIMEOUT:-5}"
WAIT="${RELAY_MIGRATE_WAIT_SECONDS:-120}"
q() { psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 "$@"; }

start=$(date +%s)
until err=$(q -c "SELECT 1" 2>&1 >/dev/null); do
  if [ $(($(date +%s) - start)) -ge "$WAIT" ]; then
    echo "database not reachable after ${WAIT}s: $err" >&2
    exit 1
  fi
  sleep 2
done

q -c "CREATE TABLE IF NOT EXISTS public.relay_schema_migrations (
  version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"

for file in "$DIR"/*.sql; do
  version=$(basename "$file" .sql)
  done_already=$(q -At -v v="$version" <<'SQL'
SELECT count(*) FROM public.relay_schema_migrations WHERE version = :'v';
SQL
)
  [ "$done_already" = "1" ] && continue
  echo "applying $version"
  {
    echo "BEGIN;"
    awk '/^-- migrate:down/ { exit } up { print } /^-- migrate:up/ { up = 1 }' "$file"
    echo "RESET ROLE;"
    echo "INSERT INTO public.relay_schema_migrations (version) VALUES (:'v');"
    echo "COMMIT;"
  } | q -v v="$version"
done

for name in TENANT CONTROL SCHEDULER PUBLISHER WORKER REAPER RETENTION OWNER; do
  eval "pw=\${RELAY_PASSWORD_${name}:-}"
  role="relay_$(echo "$name" | tr 'A-Z' 'a-z')"
  if [ -n "$pw" ]; then
    printf '%s\n' "ALTER ROLE :\"role\" LOGIN PASSWORD :'pw';" | q -v role="$role" -v pw="$pw"
    echo "role $role: login enabled"
  fi
done
echo "migrations up to date"
