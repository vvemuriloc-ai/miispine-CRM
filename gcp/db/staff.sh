#!/usr/bin/env bash
# ============================================================
# miiCase — grant miiSpine staff access to a Firebase user, from Cloud Shell.
#   bash gcp/db/staff.sh <firebase-uid> <email>
# UID comes from Firebase Console → Authentication → Users (copy icon).
# Same no-prompt plumbing as migrate.sh (Secret Manager + Cloud SQL proxy).
# ============================================================
set -euo pipefail
INSTANCE="miicase-prod:us-east1:miicase-pg"
DBNAME="miicase"
PORT=9471

[ $# -eq 2 ] || { echo "usage: bash gcp/db/staff.sh <firebase-uid> <email>"; exit 1; }
UID_ARG=$1; EMAIL=$2

PW=$(gcloud secrets versions access latest --secret=miicase-db-owner-url \
     | sed -E 's|.*://[^:]+:([^@]+)@.*|\1|')

PROXY=$(command -v cloud-sql-proxy || echo "$HOME/bin/cloud-sql-proxy")
"$PROXY" "$INSTANCE" --port "$PORT" > /tmp/csql-proxy-staff.log 2>&1 &
PROXY_PID=$!
trap 'kill $PROXY_PID 2>/dev/null || true' EXIT
for i in $(seq 1 20); do
  grep -q "ready for new connections" /tmp/csql-proxy-staff.log 2>/dev/null && break
  sleep 1
done

PGPASSWORD="$PW" psql -h 127.0.0.1 -p "$PORT" -U postgres -d "$DBNAME" \
  -v ON_ERROR_STOP=1 \
  -c "select assign_staff('$UID_ARG', '$EMAIL');" \
  -c "select uid, email, is_staff from user_profiles where uid = '$UID_ARG';"
echo "staff access granted: $EMAIL"
