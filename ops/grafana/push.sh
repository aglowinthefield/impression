#!/usr/bin/env bash
# Pushes the dashboard and alert rules in this folder to the Impression Grafana
# Cloud stack. Needs IMPRESSION_GRAFANA_URL and IMPRESSION_GRAFANA_TOKEN (a
# service account token). The data sources (impression-pg, fly-prom) and the
# impression-email contact point are set up once by hand and not managed here.
set -euo pipefail
cd "$(dirname "$0")"
: "${IMPRESSION_GRAFANA_URL:?}" "${IMPRESSION_GRAFANA_TOKEN:?}"

api() {
  curl -sf -X "$1" "$IMPRESSION_GRAFANA_URL$2" \
    -H "Authorization: Bearer $IMPRESSION_GRAFANA_TOKEN" \
    -H 'content-type: application/json' -H 'X-Disable-Provenance: true' \
    ${3:+--data "$3"}
}

api POST /api/dashboards/db \
  "$(jq -c '{dashboard: ., folderUid: "impression", overwrite: true}' dreams.json)" >/dev/null
echo "dashboard: $IMPRESSION_GRAFANA_URL/d/impression-dreams"

jq -c '.rules[]' alerts.json | while read -r rule; do
  uid=$(jq -r .uid <<<"$rule")
  api PUT "/api/v1/provisioning/alert-rules/$uid" "$rule" >/dev/null ||
    api POST /api/v1/provisioning/alert-rules "$rule" >/dev/null
  echo "alert: $uid"
done
