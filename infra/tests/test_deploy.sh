#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

fake_bin="$test_root/bin"
mkdir -p "$fake_bin"

cat >"$fake_bin/az" <<'FAKE_AZ'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >>"$FAKE_AZ_LOG"

if [[ "$*" == *"deployment group show"* ]]; then
  case "$*" in
    *"properties.outputs.registryName.value"*) printf '%s\n' 'curbdemoregistry' ;;
    *"properties.outputs.registryLoginServer.value"*) printf '%s\n' 'curbdemoregistry.azurecr.io' ;;
    *"properties.outputs.apiAppName.value"*) printf '%s\n' 'curb-demo-api' ;;
    *"properties.outputs.paymentAppName.value"*) printf '%s\n' 'curb-demo-pay' ;;
    *"properties.outputs.apiUrl.value"*) printf '%s\n' 'https://api.example.test' ;;
    *"properties.outputs.paymentUrl.value"*) printf '%s\n' 'https://payments.example.test' ;;
    *"properties.outputs.cosmosEndpoint.value"*) printf '%s\n' 'https://cosmos.example.test:443/' ;;
    *"properties.outputs.cosmosDatabase.value"*) printf '%s\n' 'curb' ;;
    *"properties.outputs.cosmosContainer.value"*) printf '%s\n' 'state' ;;
    *"properties.outputs.webPubSubHub.value"*) printf '%s\n' 'curb' ;;
    *) printf '%s\n' 'unexpected deployment output query' >&2; exit 1 ;;
  esac
fi
FAKE_AZ

cat >"$fake_bin/curl" <<'FAKE_CURL'
#!/usr/bin/env bash
set -euo pipefail

url="${*: -1}"
case "$url" in
  */health) printf '%s\n' '{"status":"ok"}' ;;
  */v1/demo/sessions) printf '%s\n' '{"user":{"demo_profile":"driver"},"token":"test-driver-token"}' ;;
  */v1/parking/nearby) printf '%s\n' '{"zones":[{"id":"seg_baker_bay_1"}],"driveways":[{"id":"driveway_demo_1"}]}' ;;
  */v1/realtime/negotiate) printf '%s\n' '{"url":"wss://example.test/client/hubs/curb"}' ;;
  */v1/agent/parking/search) printf '%s\n' '{"options":[]}' ;;
  *) printf 'unexpected URL: %s\n' "$url" >&2; exit 1 ;;
esac
FAKE_CURL

chmod +x "$fake_bin/az" "$fake_bin/curl"

export PATH="$fake_bin:$PATH"
export FAKE_AZ_LOG="$test_root/az.log"
export CURB_DEPLOY_OUTPUT_FILE="$test_root/deployment.env"
export AZURE_RESOURCE_GROUP='curb-test-rg'
export AZURE_LOCATION='westus2'
export CURB_RESOURCE_PREFIX='curb-test'
export CURB_IMAGE_TAG='test-sha'
export CURB_CORS_ALLOWED_ORIGINS='http://localhost:8081'
export ANTHROPIC_API_KEY='test-anthropic-value'
export PAYMENT_SERVICE_TOKEN='test-payment-value'
export CURB_API_SERVICE_TOKEN='test-api-value'
export AGENTVERSE_API_KEY='test-agentverse-value'
export CDP_API_KEY_ID='test-cdp-id-value'
export CDP_API_KEY_SECRET='test-cdp-key-value'
export CDP_WALLET_SECRET='test-wallet-value'
export CDP_DRIVER_WALLET_ID='test-driver-wallet-value'
export CDP_OWNER_WALLET_ADDRESS='0x1111111111111111111111111111111111111111'
export X402_FACILITATOR_URL='https://facilitator.example.test'
export BASE_SEPOLIA_RPC_URL='https://rpc.example.test/test-token'

run_log="$test_root/run.log"
bash "$repo_root/infra/scripts/deploy.sh" >"$run_log" 2>&1

grep -q '^CURB_API_BASE_URL=https://api.example.test$' "$CURB_DEPLOY_OUTPUT_FILE"
grep -q '^PAYMENT_SERVICE_BASE_URL=https://payments.example.test$' "$CURB_DEPLOY_OUTPUT_FILE"
grep -q '^EXPO_PUBLIC_WEB_PUBSUB_HUB=curb$' "$CURB_DEPLOY_OUTPUT_FILE"
grep -q 'acr build.*--image curb-api:test-sha.*--file Dockerfile.* \.$' "$FAKE_AZ_LOG"
grep -q 'acr build.*--image curb-payments:test-sha.*--file payments/Dockerfile.* \.$' "$FAKE_AZ_LOG"

if grep -E -q 'test-anthropic-value|test-payment-value|test-api-value|test-agentverse-value|test-cdp-key-value|test-wallet-value|rpc\.example\.test/test-token' "$run_log" "$CURB_DEPLOY_OUTPUT_FILE" "$FAKE_AZ_LOG"; then
  echo 'test: deploy exposed a secret' >&2
  exit 1
fi

echo 'test: deploy is repeatable and writes only non-secret outputs'
