#!/usr/bin/env bash
# ============================================================
# miiCase — deploy the dashboard.
# Run in Cloud Shell from the repo root:  bash gcp/web/deploy.sh
# Fetches the live API URL + Firebase web config, injects them into a copy of
# index.html, and deploys to Firebase Hosting (miicase-prod.web.app — supports
# a custom miispine.com domain with managed HTTPS) AND the legacy GCS bucket.
# Idempotent; no secrets involved (the Firebase apiKey is a public client id).
# Skip either target with TARGET=firebase or TARGET=gcs.
# ============================================================
set -euo pipefail
PROJECT=${PROJECT:-miicase-prod}
REGION=${REGION:-us-east1}
BUCKET=${BUCKET:-miicase-app-703055817910}

API_URL=$(gcloud run services describe miicase-api --region "$REGION" --project "$PROJECT" --format='value(status.url)')
TOKEN=$(gcloud auth print-access-token)
APPID=$(curl -s -H "Authorization: Bearer $TOKEN" \
  "https://firebase.googleapis.com/v1beta1/projects/$PROJECT/webApps" | jq -r '.apps[0].appId')
CFG=$(curl -s -H "Authorization: Bearer $TOKEN" \
  "https://firebase.googleapis.com/v1beta1/projects/$PROJECT/webApps/$APPID/config")
APIKEY=$(echo "$CFG" | jq -r .apiKey); AUTHDOM=$(echo "$CFG" | jq -r .authDomain)
[ -n "$API_URL" ] && [ "$APIKEY" != "null" ] || { echo "could not resolve API URL / Firebase config"; exit 1; }

TMP=$(mktemp /tmp/miicase-web-XXXX.html)
cp "$(dirname "$0")/index.html" "$TMP"
sed -i "s#^const API_BASE = .*#const API_BASE = \"$API_URL\";#" "$TMP"
sed -i "s#^const FIREBASE_CONFIG = .*#const FIREBASE_CONFIG = { apiKey: \"$APIKEY\", authDomain: \"$AUTHDOM\", projectId: \"$PROJECT\" };#" "$TMP"
# Optional ModMed chart deep link: MM_CHART_URL="https://….ema.md/…/{id}" bash deploy.sh
if [ -n "${MM_CHART_URL:-}" ]; then
  # '|' delimiter: EMA chart URLs contain '#', which would break '#'-delimited sed.
  sed -i "s|^const MM_CHART_URL = .*|const MM_CHART_URL = \"$MM_CHART_URL\";|" "$TMP"
  grep -q "modmed\|ema" "$TMP" || { echo "chart URL injection failed"; exit 1; }
  echo "chart links → $MM_CHART_URL"
fi
grep -q "$API_URL" "$TMP" || { echo "injection failed"; exit 1; }

TARGET=${TARGET:-all}

if [ "$TARGET" = "all" ] || [ "$TARGET" = "gcs" ]; then
  gsutil -h "Cache-Control:no-cache" cp "$TMP" "gs://$BUCKET/index.html"
  echo "deployed → https://storage.googleapis.com/$BUCKET/index.html"
fi

if [ "$TARGET" = "all" ] || [ "$TARGET" = "firebase" ]; then
  if command -v firebase >/dev/null; then
    DIST="$(dirname "$0")/dist"
    mkdir -p "$DIST"
    cp "$TMP" "$DIST/index.html"
    (cd "$(dirname "$0")" && firebase deploy --only hosting --project "$PROJECT" --non-interactive)
    rm -rf "$DIST"
    echo "deployed → https://$PROJECT.web.app (plus any custom domains)"
  else
    echo "firebase CLI not found — skipped Firebase Hosting (npm i -g firebase-tools)"
  fi
fi

rm -f "$TMP"
