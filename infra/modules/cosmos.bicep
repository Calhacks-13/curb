@description('Globally unique Cosmos DB account name.')
param accountName string

@description('Azure region for the Cosmos resources.')
param location string

@description('Cosmos DB for NoSQL database name.')
param databaseName string = 'curb'

@description('Container definitions and their partition key paths.')
param containerDefinitions array = [
  {
    name: 'state'
    partitionKey: '/partition_key'
  }
  {
    name: 'observations'
    partitionKey: '/space_id'
  }
  {
    name: 'payments'
    partitionKey: '/booking_id'
  }
  {
    name: 'blocks'
    partitionKey: '/segment_id'
  }
  {
    name: 'spots'
    partitionKey: '/segment_id'
  }
  {
    name: 'signs'
    partitionKey: '/grid_key'
  }
]

resource account 'Microsoft.DocumentDB/databaseAccounts@2024-05-15' = {
  name: accountName
  location: location
  kind: 'GlobalDocumentDB'
  properties: {
    databaseAccountOfferType: 'Standard'
    consistencyPolicy: {
      defaultConsistencyLevel: 'Session'
    }
    locations: [
      {
        locationName: location
        failoverPriority: 0
        isZoneRedundant: false
      }
    ]
    capabilities: [
      {
        name: 'EnableServerless'
      }
    ]
    disableKeyBasedMetadataWriteAccess: true
    enableAutomaticFailover: false
    minimalTlsVersion: 'Tls12'
    publicNetworkAccess: 'Enabled'
  }
}

resource database 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-05-15' = {
  parent: account
  name: databaseName
  properties: {
    resource: {
      id: databaseName
    }
  }
}

resource containers 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-05-15' = [for definition in containerDefinitions: {
  parent: database
  name: definition.name
  properties: {
    resource: {
      id: definition.name
      partitionKey: {
        paths: [
          definition.partitionKey
        ]
        kind: 'Hash'
        version: 2
      }
      indexingPolicy: {
        automatic: true
        indexingMode: 'consistent'
        includedPaths: [
          {
            path: '/*'
          }
        ]
        excludedPaths: [
          {
            path: '/"_etag"/?'
          }
        ]
      }
    }
  }
}]

output accountId string = account.id
output endpoint string = account.properties.documentEndpoint
output databaseName string = database.name
output primaryContainerName string = containerDefinitions[0].name

@secure()
output primaryKey string = account.listKeys().primaryMasterKey
