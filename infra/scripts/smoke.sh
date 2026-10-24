#!/usr/bin/env bash

set -euo pipefail

api_base_url="${CURB_API_BASE_URL:-${EXPO_PUBLIC_API_BASE_URL:-}}"
payment_base_url="${PAYMENT_SERVICE_BASE_URL:-}"

if [[ -z "$api_base_url" ]]; then
  echo "smoke: CURB_API_BASE_URL (or EXPO_PUBLIC_API_BASE_URL) is required" >&2
  exit 2
fi

if [[ -z "$payment_base_url" ]]; then
  echo "smoke: PAYMENT_SERVICE_BASE_URL is required" >&2
  exit 2
fi

api_base_url="${api_base_url%/}"
payment_base_url="${payment_base_url%/}"

request() {
  curl \
    --fail \
    --silent \
    --show-error \
    --connect-timeout 10 \
    --max-time 30 \
    --retry 4 \
    --retry-all-errors \
    "$@"
}

assert_healthy() {
  local service_name="$1"
  local url="$2"
  local response

  response="$(request "$url")"
  python3 -c '
import json
import sys

service = sys.argv[1]
try:
    payload = json.load(sys.stdin)
except (json.JSONDecodeError, TypeError) as error:
    raise SystemExit(f"smoke: {service} health returned invalid JSON: {error}")

if payload.get("status") not in {"ok", "healthy"}:
    raise SystemExit(f"smoke: {service} health is not healthy")
' "$service_name" <<<"$response"
}

assert_healthy "API" "$api_base_url/health"
assert_healthy "payment service" "$payment_base_url/health"

session_json="$(request \
  --request POST \
  --header 'Content-Type: application/json' \
  --data '{"profile":"driver"}' \
  "$api_base_url/v1/demo/sessions")"

driver_token="$(python3 -c '
import json
import sys

try:
    payload = json.load(sys.stdin)
except (json.JSONDecodeError, TypeError) as error:
    raise SystemExit(f"smoke: driver session returned invalid JSON: {error}")

token = payload.get("token")
user = payload.get("user")
if not isinstance(token, str) or not token:
    raise SystemExit("smoke: driver session did not issue a token")
if not isinstance(user, dict) or user.get("demo_profile") != "driver":
    raise SystemExit("smoke: driver session returned the wrong profile")
print(token)
' <<<"$session_json")"

auth_header="Authorization: Bearer $driver_token"

nearby_json="$(request \
  --header "$auth_header" \
  --get \
  --data-urlencode 'lat=37.8022' \
  --data-urlencode 'lng=-122.4475' \
  --data-urlencode 'radius_m=804.672' \
  "$api_base_url/v1/parking/nearby")"

python3 -c '
import json
import sys

try:
    payload = json.load(sys.stdin)
except (json.JSONDecodeError, TypeError) as error:
    raise SystemExit(f"smoke: nearby returned invalid JSON: {error}")

zone_ids = {item.get("id") for item in payload.get("zones", []) if isinstance(item, dict)}
driveway_ids = {
    item.get("id") for item in payload.get("driveways", []) if isinstance(item, dict)
}
if "seg_baker_bay_1" not in zone_ids:
    raise SystemExit("smoke: nearby did not return seeded Palace of Fine Arts zone seg_baker_bay_1")
if "driveway_demo_1" not in driveway_ids:
    raise SystemExit("smoke: nearby did not return seeded driveway driveway_demo_1")
' <<<"$nearby_json"

negotiate_json="$(request \
  --request POST \
  --header "$auth_header" \
  "$api_base_url/v1/realtime/negotiate")"

python3 -c '
import json
import sys

try:
    payload = json.load(sys.stdin)
except (json.JSONDecodeError, TypeError) as error:
    raise SystemExit(f"smoke: realtime negotiate returned invalid JSON: {error}")

url = payload.get("url")
if not isinstance(url, str) or not url.startswith("wss://"):
    raise SystemExit("smoke: realtime negotiate did not return a wss:// URL")
' <<<"$negotiate_json"

agent_json="$(request \
  --request POST \
  --header "$auth_header" \
  --header 'Content-Type: application/json' \
  --data '{"lat":37.8022,"lng":-122.4475,"radius_m":804.672}' \
  "$api_base_url/v1/agent/parking/search")"

python3 -c '
import json
import sys

try:
    payload = json.load(sys.stdin)
except (json.JSONDecodeError, TypeError) as error:
    raise SystemExit(f"smoke: Agentverse search returned invalid JSON: {error}")

options = payload.get("options")
if not isinstance(options, list):
    raise SystemExit("smoke: Agentverse search did not return an options list")
if len(options) > 3:
    raise SystemExit("smoke: Agentverse search returned more than three options")
' <<<"$agent_json"

echo "smoke: API, payments, seeded nearby, realtime, and Agentverse checks passed"
