#!/usr/bin/env bash
# ============================================================
# miiCase — apply a migration to production Cloud SQL from Cloud Shell.
#   bash gcp/db/migrate.sh 0016        (prefix is enough)
#   bash gcp/db/migrate.sh             (lists available migrations)
# Pulls the DB password from Secret Manager, runs the Cloud SQL Auth Proxy
# in the background, applies the file with psql, and shuts the proxy down.
# No password prompts, no pasting.
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/../.."   # repo root
INSTANCE="miicase-prod:us-east1:miicase-pg"
PORT=9470

if [ $# -lt 1 ]; then
  echo "usage: bash gcp/db/migrate.sh <migration prefix, e.g. 0016>"
  echo "available:"; ls gcp/db/migrations/ | sed 's/^/  /'
  exit 1
fi

FILE=$(ls gcp/db/migrations/ | grep "^$1" | head -1 || true)
[ -n "$FILE" ] || { echo "no migration starting with '$1'"; exit 1; }
echo "applying gcp/db/migrations/$FILE ..."

PW=$(gcloud secrets versions access latest --secret=miicase-db-owner-url \
     | sed -E 's|.*://[^:]+:([^@]+)@.*|\1|')

PROXY=$(command -v cloud-sql-proxy || echo "$HOME/bin/cloud-sql-proxy")
"$PROXY" "$INSTANCE" --port "$PORT" > /tmp/csql-proxy.log 2>&1 &
PROXY_PID=$!
trap 'kill $PROXY_PID 2>/dev/null || true' EXIT
for i in $(seq 1 20); do
  grep -q "ready for new connections" /tmp/csql-proxy.log 2>/dev/null && break
  sleep 1
done

PGPASSWORD="$PW" psql -h 127.0.0.1 -p "$PORT" -U postgres -d postgres \
  -v ON_ERROR_STOP=1 -f "gcp/db/migrations/$FILE"
echo "done: $FILE"
