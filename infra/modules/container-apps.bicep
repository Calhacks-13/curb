@description('Azure region for the Container Apps.')
param location string

@description('Resource ID of the existing Container Apps managed environment.')
param managedEnvironmentId string

@description('User-assigned identity used to pull images from ACR.')
param registryIdentityId string

@description('Azure Container Registry login server.')
param registryServer string

@description('API Container App name.')
param apiAppName string

@description('Payment Container App name.')
param paymentAppName string

@description('Fully qualified API image reference.')
param apiImage string

@description('Fully qualified payment image reference.')
param paymentImage string

@description('Cosmos DB endpoint.')
param cosmosEndpoint string

@description('Cosmos DB database name.')
param cosmosDatabase string

@description('Primary Cosmos container used by the current repository implementation.')
param cosmosContainer string

@secure()
param cosmosKey string

@secure()
param webPubSubConnectionString string

param webPubSubHub string = 'curb'
param corsAllowedOrigins string
param x402FacilitatorUrl string

@secure()
param anthropicApiKey string

@secure()
param paymentServiceToken string

@secure()
param agentverseApiKey string

@secure()
param curbApiServiceToken string

@secure()
param cdpApiKeyId string

@secure()
param cdpApiKeySecret string

@secure()
param cdpWalletSecret string

@secure()
param cdpDriverWalletId string

@secure()
param cdpOwnerWalletAddress string

@secure()
param baseSepoliaRpcUrl string

var managedEnvironmentDefaultDomain = reference(managedEnvironmentId, '2024-03-01').properties.defaultDomain
var apiBaseUrl = 'https://${apiAppName}.${managedEnvironmentDefaultDomain}'
var paymentBaseUrl = 'https://${paymentAppName}.${managedEnvironmentDefaultDomain}'

resource api 'Microsoft.App/containerApps@2024-03-01' = {
  name: apiAppName
  location: location
  identity: {
    type: 'SystemAssigned,UserAssigned'
    userAssignedIdentities: {
      '${registryIdentityId}': {}
    }
  }
  properties: {
    managedEnvironmentId: managedEnvironmentId
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        allowInsecure: false
        targetPort: 8000
        transport: 'auto'
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
      }
      registries: [
        {
          server: registryServer
          identity: registryIdentityId
        }
      ]
      secrets: [
        {
          name: 'anthropic-api-key'
          value: anthropicApiKey
        }
        {
          name: 'cosmos-key'
          value: cosmosKey
        }
        {
          name: 'webpubsub-connection-string'
          value: webPubSubConnectionString
        }
        {
          name: 'payment-service-token'
          value: paymentServiceToken
        }
        {
          name: 'agentverse-api-key'
          value: agentverseApiKey
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'api'
          image: apiImage
          env: [
            {
              name: 'PORT'
              value: '8000'
            }
            {
              name: 'ANTHROPIC_API_KEY'
              secretRef: 'anthropic-api-key'
            }
            {
              name: 'CURB_ANTHROPIC_API_KEY'
              secretRef: 'anthropic-api-key'
            }
            {
              name: 'AZURE_COSMOS_ENDPOINT'
              value: cosmosEndpoint
            }
            {
              name: 'CURB_COSMOS_ENDPOINT'
              value: cosmosEndpoint
            }
            {
              name: 'CURB_COSMOS_KEY'
              secretRef: 'cosmos-key'
            }
            {
              name: 'AZURE_COSMOS_DATABASE'
              value: cosmosDatabase
            }
            {
              name: 'CURB_COSMOS_DATABASE'
              value: cosmosDatabase
            }
            {
              name: 'AZURE_COSMOS_CONTAINER'
              value: cosmosContainer
            }
            {
              name: 'CURB_COSMOS_BLOCKS_CONTAINER'
              value: 'blocks'
            }
            {
              name: 'CURB_COSMOS_SPOTS_CONTAINER'
              value: 'spots'
            }
            {
              name: 'CURB_COSMOS_SIGNS_CONTAINER'
              value: 'signs'
            }
            {
              name: 'AZURE_WEB_PUBSUB_CONNECTION_STRING'
              secretRef: 'webpubsub-connection-string'
            }
            {
              name: 'CURB_WEBPUBSUB_CONNECTION_STRING'
              secretRef: 'webpubsub-connection-string'
            }
            {
              name: 'EXPO_PUBLIC_WEB_PUBSUB_HUB'
              value: webPubSubHub
            }
            {
              name: 'CURB_WEBPUBSUB_HUB'
              value: webPubSubHub
            }
            {
              name: 'PAYMENT_SERVICE_BASE_URL'
              value: paymentBaseUrl
            }
            {
              name: 'PAYMENT_SERVICE_TOKEN'
              secretRef: 'payment-service-token'
            }
            {
              name: 'AGENTVERSE_API_KEY'
              secretRef: 'agentverse-api-key'
            }
            {
              name: 'CORS_ALLOWED_ORIGINS'
              value: corsAllowedOrigins
            }
            {
              name: 'CURB_CORS_ALLOWED_ORIGINS'
              value: corsAllowedOrigins
            }
          ]
          resources: {
            cpu: json('2.0')
            memory: '4Gi'
          }
          probes: [
            {
              type: 'Startup'
              httpGet: {
                path: '/health'
                port: 8000
                scheme: 'HTTP'
              }
              initialDelaySeconds: 10
              periodSeconds: 10
              timeoutSeconds: 5
              failureThreshold: 60
            }
            {
              type: 'Liveness'
              httpGet: {
                path: '/health'
                port: 8000
                scheme: 'HTTP'
              }
              periodSeconds: 30
              timeoutSeconds: 5
              failureThreshold: 3
            }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 2
      }
    }
  }
}

resource payments 'Microsoft.App/containerApps@2024-03-01' = {
  name: paymentAppName
  location: location
  identity: {
    type: 'SystemAssigned,UserAssigned'
    userAssignedIdentities: {
      '${registryIdentityId}': {}
    }
  }
  properties: {
    managedEnvironmentId: managedEnvironmentId
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        allowInsecure: false
        targetPort: 3000
        transport: 'auto'
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
      }
      registries: [
        {
          server: registryServer
          identity: registryIdentityId
        }
      ]
      secrets: [
        {
          name: 'curb-api-service-token'
          value: curbApiServiceToken
        }
        {
          name: 'cdp-api-key-id'
          value: cdpApiKeyId
        }
        {
          name: 'cdp-api-key-secret'
          value: cdpApiKeySecret
        }
        {
          name: 'cdp-wallet-secret'
          value: cdpWalletSecret
        }
        {
          name: 'cdp-driver-wallet-id'
          value: cdpDriverWalletId
        }
        {
          name: 'cdp-owner-wallet-address'
          value: cdpOwnerWalletAddress
        }
        {
          name: 'base-sepolia-rpc-url'
          value: baseSepoliaRpcUrl
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'payments'
          image: paymentImage
          env: [
            {
              name: 'NODE_ENV'
              value: 'production'
            }
            {
              name: 'PORT'
              value: '3000'
            }
            {
              name: 'CURB_API_BASE_URL'
              value: apiBaseUrl
            }
            {
              name: 'CURB_API_SERVICE_TOKEN'
              secretRef: 'curb-api-service-token'
            }
            {
              name: 'CDP_API_KEY_ID'
              secretRef: 'cdp-api-key-id'
            }
            {
              name: 'CDP_API_KEY_SECRET'
              secretRef: 'cdp-api-key-secret'
            }
            {
              name: 'CDP_WALLET_SECRET'
              secretRef: 'cdp-wallet-secret'
            }
            {
              name: 'CDP_DRIVER_WALLET_ID'
              secretRef: 'cdp-driver-wallet-id'
            }
            {
              name: 'CDP_OWNER_WALLET_ADDRESS'
              secretRef: 'cdp-owner-wallet-address'
            }
            {
              name: 'X402_FACILITATOR_URL'
              value: x402FacilitatorUrl
            }
            {
              name: 'BASE_SEPOLIA_RPC_URL'
              secretRef: 'base-sepolia-rpc-url'
            }
          ]
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          probes: [
            {
              type: 'Startup'
              httpGet: {
                path: '/health'
                port: 3000
                scheme: 'HTTP'
              }
              initialDelaySeconds: 5
              periodSeconds: 5
              timeoutSeconds: 3
              failureThreshold: 24
            }
            {
              type: 'Liveness'
              httpGet: {
                path: '/health'
                port: 3000
                scheme: 'HTTP'
              }
              periodSeconds: 30
              timeoutSeconds: 5
              failureThreshold: 3
            }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 2
      }
    }
  }
}

output apiAppName string = api.name
output paymentAppName string = payments.name
output apiUrl string = 'https://${api.properties.configuration.ingress.fqdn}'
output paymentUrl string = 'https://${payments.properties.configuration.ingress.fqdn}'
