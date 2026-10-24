@description('Globally unique Azure Web PubSub service name.')
param serviceName string

@description('Azure region for Web PubSub.')
param location string

@description('Web PubSub hub shared by the server and mobile clients.')
param hubName string = 'curb'

resource service 'Microsoft.SignalRService/webPubSub@2023-02-01' = {
  name: serviceName
  location: location
  sku: {
    name: 'Standard_S1'
    tier: 'Standard'
    capacity: 1
  }
  properties: {
    disableAadAuth: false
    disableLocalAuth: false
    publicNetworkAccess: 'Enabled'
    tls: {
      clientCertEnabled: false
    }
  }
}

resource hub 'Microsoft.SignalRService/webPubSub/hubs@2023-02-01' = {
  parent: service
  name: hubName
  properties: {
    anonymousConnectPolicy: 'Deny'
    eventHandlers: []
  }
}

output serviceId string = service.id
output endpoint string = 'https://${service.properties.hostName}'
output hubName string = hub.name

@secure()
output connectionString string = service.listKeys().primaryConnectionString
