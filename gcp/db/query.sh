#!/usr/bin/env bash
# ============================================================
# miiCase — run one SQL query against production from Cloud Shell.
#   bash gcp/db/query.sh "select count(*) from cases;"
# Same no-prompt plumbing as migrate.sh (Secret Manager + Cloud SQL proxy).
# ============================================================
set -euo pipefail
INSTANCE="miicase-prod:us-east1:miicase-pg"
DBNAME="miicase"
PORT=9472

[ $# -ge 1 ] || { echo "usage: bash gcp/db/query.sh \"<sql>\""; exit 1; }

PW=$(gcloud secrets versions access latest --secret=miicase-db-owner-url \
     | sed -E 's|.*://[^:]+:([^@]+)@.*|\1|')

PROXY=$(command -v cloud-sql-proxy || echo "$HOME/bin/cloud-sql-proxy")
"$PROXY" "$INSTANCE" --port "$PORT" > /tmp/csql-proxy-q.log 2>&1 &
PROXY_PID=$!
trap 'kill $PROXY_PID 2>/dev/null || true' EXIT
for i in $(seq 1 20); do
  grep -q "ready for new connections" /tmp/csql-proxy-q.log 2>/dev/null && break
  sleep 1
done

PGPASSWORD="$PW" psql -h 127.0.0.1 -p "$PORT" -U postgres -d "$DBNAME" -c "$1"
