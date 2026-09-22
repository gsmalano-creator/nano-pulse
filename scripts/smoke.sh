#!/usr/bin/env bash
# End-to-end check against a running server (defaults to `npm run dev`).
#   ./scripts/smoke.sh [base_url] [api_key]
set -euo pipefail

BASE_URL="${1:-http://localhost:8787}"
API_KEY="${2:-np_test_7bc5c02094886b8a8bd2f1eda2774b1b1e3acde3}"
SLUG="smoke-test-$$"

call() {
	local method="$1" path="$2"
	shift 2
	curl -sS -X "$method" "${BASE_URL}${path}" -H "Authorization: Bearer ${API_KEY}" "$@"
	echo
}

echo "== health =="
curl -sS "${BASE_URL}/health"; echo

echo "== whoami =="
call GET /v1/whoami

echo "== ping (auto-creates monitor, 60s interval / 0s grace) =="
call POST "/v1/ping/${SLUG}?interval=60&grace=0" \
	-H 'content-type: application/json' \
	-d '{"records":42}'

echo "== monitor detail =="
call GET "/v1/monitors/${SLUG}"

echo "== ping reporting failure =="
call POST "/v1/ping/${SLUG}?status=fail"

echo "== ping recovering =="
call POST "/v1/ping/${SLUG}"

echo "== list monitors =="
call GET /v1/monitors

echo "== api keys =="
call GET /v1/keys

echo "== unauthorized (expects 401) =="
curl -sS -o /dev/null -w '%{http_code}\n' -X POST "${BASE_URL}/v1/ping/${SLUG}"

echo "== cleanup =="
call DELETE "/v1/monitors/${SLUG}"

# Admin provisioning is only exercised when a token is supplied:
#   ADMIN_TOKEN=local-admin-token ./scripts/smoke.sh
if [ -n "${ADMIN_TOKEN:-}" ]; then
	echo "== admin: provision a user =="
	curl -sS -X POST "${BASE_URL}/v1/admin/users" \
		-H "Authorization: Bearer ${ADMIN_TOKEN}" \
		-H 'content-type: application/json' \
		-d "{\"email\":\"smoke-${SLUG}@example.com\"}"
	echo
fi
