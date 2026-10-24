#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
template_file="$repo_root/infra/main.bicep"
deployment_name="${AZURE_DEPLOYMENT_NAME:-curb-demo}"
resource_group="${AZURE_RESOURCE_GROUP:-curb-demo-rg}"
location="${AZURE_LOCATION:-westus2}"
resource_prefix="${CURB_RESOURCE_PREFIX:-curb-demo}"
cors_allowed_origins="${CURB_CORS_ALLOWED_ORIGINS:-http://localhost:8081,http://localhost:19006}"
output_file="${CURB_DEPLOY_OUTPUT_FILE:-$repo_root/infra/.env.deployment}"

require_command() {
  local command_name="$1"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "deploy: required command is missing: $command_name" >&2
    exit 2
  fi
}

require_env() {
  local variable_name="$1"
  if [[ -z "${!variable_name:-}" ]]; then
    echo "deploy: required environment variable is missing: $variable_name" >&2
    exit 2
  fi
}

for command_name in az curl git python3; do
  require_command "$command_name"
done

for variable_name in \
  ANTHROPIC_API_KEY \
  PAYMENT_SERVICE_TOKEN \
  AGENTVERSE_API_KEY \
  CDP_API_KEY_ID \
  CDP_API_KEY_SECRET \
  CDP_WALLET_SECRET \
  CDP_DRIVER_WALLET_ID \
  CDP_OWNER_WALLET_ADDRESS \
  X402_FACILITATOR_URL \
  BASE_SEPOLIA_RPC_URL; do
  require_env "$variable_name"
done

export CURB_API_SERVICE_TOKEN="${CURB_API_SERVICE_TOKEN:-$PAYMENT_SERVICE_TOKEN}"

parameters_file="$(mktemp)"
compiled_template="$(mktemp)"
trap 'rm -f "$parameters_file" "$compiled_template"' EXIT
chmod 600 "$parameters_file"

python3 - "$parameters_file" <<'PY'
import json
import os
import sys

path = sys.argv[1]
values = {
    "resourcePrefix": os.environ.get("CURB_RESOURCE_PREFIX", "curb-demo"),
    "corsAllowedOrigins": os.environ.get(
        "CURB_CORS_ALLOWED_ORIGINS",
        "http://localhost:8081,http://localhost:19006",
    ),
    "x402FacilitatorUrl": os.environ["X402_FACILITATOR_URL"],
    "anthropicApiKey": os.environ["ANTHROPIC_API_KEY"],
    "paymentServiceToken": os.environ["PAYMENT_SERVICE_TOKEN"],
    "agentverseApiKey": os.environ["AGENTVERSE_API_KEY"],
    "curbApiServiceToken": os.environ["CURB_API_SERVICE_TOKEN"],
    "cdpApiKeyId": os.environ["CDP_API_KEY_ID"],
    "cdpApiKeySecret": os.environ["CDP_API_KEY_SECRET"],
    "cdpWalletSecret": os.environ["CDP_WALLET_SECRET"],
    "cdpDriverWalletId": os.environ["CDP_DRIVER_WALLET_ID"],
    "cdpOwnerWalletAddress": os.environ["CDP_OWNER_WALLET_ADDRESS"],
    "baseSepoliaRpcUrl": os.environ["BASE_SEPOLIA_RPC_URL"],
}

document = {
    "$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#",
    "contentVersion": "1.0.0.0",
    "parameters": {name: {"value": value} for name, value in values.items()},
}

with open(path, "w", encoding="utf-8") as handle:
    json.dump(document, handle)
PY

echo "deploy: validating Bicep"
az bicep build --file "$template_file" --outfile "$compiled_template" --only-show-errors
az account show --only-show-errors --output none

echo "deploy: ensuring resource group $resource_group"
az group create \
  --name "$resource_group" \
  --location "$location" \
  --only-show-errors \
  --output none

echo "deploy: provisioning shared Azure resources"
az deployment group create \
  --name "$deployment_name" \
  --resource-group "$resource_group" \
  --template-file "$template_file" \
  --parameters "@$parameters_file" \
  --parameters provisionApps=false \
  --only-show-errors \
  --output none

deployment_output() {
  local output_name="$1"
  az deployment group show \
    --name "$deployment_name" \
    --resource-group "$resource_group" \
    --query "properties.outputs.${output_name}.value" \
    --output tsv \
    --only-show-errors
}

registry_name="$(deployment_output registryName)"
registry_login_server="$(deployment_output registryLoginServer)"
image_tag="${CURB_IMAGE_TAG:-$(git -C "$repo_root" rev-parse --short=12 HEAD)}"
api_image="$registry_login_server/curb-api:$image_tag"
payment_image="$registry_login_server/curb-payments:$image_tag"

echo "deploy: building and pushing API image $image_tag"
(
  cd "$repo_root/server"
  az acr build \
    --registry "$registry_name" \
    --image "curb-api:$image_tag" \
    --file Dockerfile \
    --only-show-errors \
    .
)

echo "deploy: building and pushing payment image $image_tag"
(
  cd "$repo_root"
  az acr build \
    --registry "$registry_name" \
    --image "curb-payments:$image_tag" \
    --file payments/Dockerfile \
    --only-show-errors \
    .
)

echo "deploy: deploying always-warm Container Apps"
az deployment group create \
  --name "$deployment_name" \
  --resource-group "$resource_group" \
  --template-file "$template_file" \
  --parameters "@$parameters_file" \
  --parameters \
    provisionApps=true \
    apiImage="$api_image" \
    paymentImage="$payment_image" \
  --only-show-errors \
  --output none

api_url="$(deployment_output apiUrl)"
payment_url="$(deployment_output paymentUrl)"
cosmos_endpoint="$(deployment_output cosmosEndpoint)"
cosmos_database="$(deployment_output cosmosDatabase)"
cosmos_container="$(deployment_output cosmosContainer)"
web_pubsub_hub="$(deployment_output webPubSubHub)"

if [[ -z "$api_url" || -z "$payment_url" ]]; then
  echo "deploy: Container App URLs were not produced" >&2
  exit 1
fi

mkdir -p "$(dirname "$output_file")"
umask 077
{
  printf 'CURB_API_BASE_URL=%s\n' "$api_url"
  printf 'PAYMENT_SERVICE_BASE_URL=%s\n' "$payment_url"
  printf 'EXPO_PUBLIC_API_BASE_URL=%s\n' "$api_url"
  printf 'EXPO_PUBLIC_WEB_PUBSUB_HUB=%s\n' "$web_pubsub_hub"
  printf 'AZURE_COSMOS_ENDPOINT=%s\n' "$cosmos_endpoint"
  printf 'AZURE_COSMOS_DATABASE=%s\n' "$cosmos_database"
  printf 'AZURE_COSMOS_CONTAINER=%s\n' "$cosmos_container"
} >"$output_file"

echo "deploy: API startup performs the idempotent Palace of Fine Arts seed upsert"
echo "deploy: running public smoke suite"
CURB_API_BASE_URL="$api_url" \
PAYMENT_SERVICE_BASE_URL="$payment_url" \
  bash "$repo_root/infra/scripts/smoke.sh"

echo "deploy: complete; non-secret outputs written to $output_file"
