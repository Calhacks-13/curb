targetScope = 'resourceGroup'

@description('Short prefix used for deterministic resource names.')
param resourcePrefix string = 'curb-demo'

@description('Azure region for all resources.')
param location string = resourceGroup().location

@description('Deploy Container Apps after the images have been pushed to ACR.')
param provisionApps bool = true

@description('Fully qualified API image. The deploy script overrides this after ACR build.')
param apiImage string = 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest'

@description('Fully qualified payment image. The deploy script overrides this after ACR build.')
param paymentImage string = 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest'

@description('Comma-separated browser origins allowed by the API. Native iOS calls do not require CORS.')
param corsAllowedOrigins string = 'http://localhost:8081,http://localhost:19006'

@description('x402 facilitator URL for Base Sepolia.')
param x402FacilitatorUrl string = 'https://x402.org/facilitator'

@secure()
param anthropicApiKey string = ''

@secure()
param paymentServiceToken string = ''

@secure()
param agentverseApiKey string = ''

@secure()
param curbApiServiceToken string = ''

@secure()
param cdpApiKeyId string = ''

@secure()
param cdpApiKeySecret string = ''

@secure()
param cdpWalletSecret string = ''

@secure()
param cdpDriverWalletId string = ''

@secure()
param cdpOwnerWalletAddress string = ''

@secure()
param baseSepoliaRpcUrl string = ''

var suffix = uniqueString(resourceGroup().id)
var compactPrefix = toLower(replace(resourcePrefix, '-', ''))
var registryName = take('${compactPrefix}${suffix}', 50)
var cosmosAccountName = take('${compactPrefix}-${suffix}', 44)
var webPubSubName = take('${resourcePrefix}-wps-${suffix}', 63)
var managedEnvironmentName = take('${resourcePrefix}-env-${suffix}', 60)
var registryIdentityName = take('${resourcePrefix}-pull-${suffix}', 128)
var apiAppName = take('${resourcePrefix}-api-${suffix}', 32)
var paymentAppName = take('${resourcePrefix}-pay-${suffix}', 32)
var acrPullRoleDefinitionId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: registryName
  location: location
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: false
    publicNetworkAccess: 'Enabled'
    zoneRedundancy: 'Disabled'
  }
}

resource registryIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: registryIdentityName
  location: location
}

resource registryPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, registryIdentity.id, acrPullRoleDefinitionId)
  scope: registry
  properties: {
    principalId: registryIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: acrPullRoleDefinitionId
  }
}

resource managedEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: managedEnvironmentName
  location: location
  properties: {
    zoneRedundant: false
  }
}

module cosmos 'modules/cosmos.bicep' = {
  name: 'curb-cosmos'
  params: {
    accountName: cosmosAccountName
    databaseName: 'curb'
    location: location
  }
}

module pubsub 'modules/pubsub.bicep' = {
  name: 'curb-web-pubsub'
  params: {
    hubName: 'curb'
    location: location
    serviceName: webPubSubName
  }
}

module containerApps 'modules/container-apps.bicep' = if (provisionApps) {
  name: 'curb-container-apps'
  dependsOn: [
    registryPull
  ]
  params: {
    agentverseApiKey: agentverseApiKey
    anthropicApiKey: anthropicApiKey
    apiAppName: apiAppName
    apiImage: apiImage
    baseSepoliaRpcUrl: baseSepoliaRpcUrl
    cdpApiKeyId: cdpApiKeyId
    cdpApiKeySecret: cdpApiKeySecret
    cdpDriverWalletId: cdpDriverWalletId
    cdpOwnerWalletAddress: cdpOwnerWalletAddress
    cdpWalletSecret: cdpWalletSecret
    cosmosContainer: cosmos.outputs.primaryContainerName
    cosmosDatabase: cosmos.outputs.databaseName
    cosmosEndpoint: cosmos.outputs.endpoint
    cosmosKey: cosmos.outputs.primaryKey
    corsAllowedOrigins: corsAllowedOrigins
    curbApiServiceToken: curbApiServiceToken
    location: location
    managedEnvironmentDefaultDomain: managedEnvironment.properties.defaultDomain
    managedEnvironmentId: managedEnvironment.id
    paymentAppName: paymentAppName
    paymentImage: paymentImage
    paymentServiceToken: paymentServiceToken
    registryIdentityId: registryIdentity.id
    registryServer: registry.properties.loginServer
    webPubSubConnectionString: pubsub.outputs.connectionString
    webPubSubHub: pubsub.outputs.hubName
    x402FacilitatorUrl: x402FacilitatorUrl
  }
}

output registryName string = registry.name
output registryLoginServer string = registry.properties.loginServer
output cosmosEndpoint string = cosmos.outputs.endpoint
output cosmosDatabase string = cosmos.outputs.databaseName
output cosmosContainer string = cosmos.outputs.primaryContainerName
output webPubSubHub string = pubsub.outputs.hubName
output apiAppName string = provisionApps ? containerApps!.outputs.apiAppName : apiAppName
output paymentAppName string = provisionApps ? containerApps!.outputs.paymentAppName : paymentAppName
output apiUrl string = provisionApps ? containerApps!.outputs.apiUrl : ''
output paymentUrl string = provisionApps ? containerApps!.outputs.paymentUrl : ''
