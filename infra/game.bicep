targetScope = 'resourceGroup'

@description('The game id, equal to its folder under games/.')
param id string
@description('The manifest storage declaration: tables, containers and queues, each name with its owner (play, admin or admin-private). tools/gen.mjs writes it to games/<id>/.gen/params.json.')
param storage object
@allowed([512, 2048, 4096])
param memoryMb int = 2048
@minValue(1)
param maxInstances int = 10
param location string = resourceGroup().location
param tenantId string = tenant().tenantId
param gamesClientId string
param adminIdentityName string = 'id-g4k-admin'
param deployIdentityName string = 'id-g4k-deploy'

var suffix = take(uniqueString(resourceGroup().id), 5)
var tags = { app: 'games4kids', game: id }
var tables = items(storage.tables)
var containers = items(storage.containers)
var queues = items(storage.queues)

var tableDataContributor = '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'
var tableDataReader = '76199698-9eea-4c19-bc75-cec21354c6b6'
var blobDataContributor = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
var blobDataReader = '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1'
var queueDataContributor = '974c5e8b-45b9-4653-ba55-5f855dd0fb88'
var queueDataReader = '19e7f393-937e-4f77-808e-94535e297925'
var portalTablesPlayersRead = ['members', 'identities', 'profiles']

resource adminIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: adminIdentityName
}

resource deployIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: deployIdentityName
}

resource gamesSite 'Microsoft.Web/staticSites@2023-12-01' existing = {
  name: 'swa-g4k-games'
}

resource insights 'Microsoft.Insights/components@2020-02-02' existing = {
  name: 'appi-g4k'
}

resource portalStorage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: 'g4kportal${suffix}'

  resource tableService 'tableServices' existing = {
    name: 'default'
  }
}

resource portalTables 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' existing = [for name in portalTablesPlayersRead: {
  parent: portalStorage::tableService
  name: name
}]

resource account 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: 'g4k${id}${suffix}'
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowSharedKeyAccess: false
    allowBlobPublicAccess: false
    defaultToOAuthAuthentication: true
  }
}

resource tableService 'Microsoft.Storage/storageAccounts/tableServices@2023-05-01' = {
  parent: account
  name: 'default'
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: account
  name: 'default'
}

resource queueService 'Microsoft.Storage/storageAccounts/queueServices@2023-05-01' = {
  parent: account
  name: 'default'
}

resource tableResources 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = [for table in tables: {
  parent: tableService
  name: table.key
}]

resource containerResources 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = [for container in containers: {
  parent: blobService
  name: container.key
}]

resource queueResources 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-05-01' = [for queue in queues: {
  parent: queueService
  name: queue.key
}]

module playApp 'modules/function-app.bicep' = {
  name: 'func-g4k-${id}'
  params: {
    name: 'func-g4k-${id}'
    location: location
    tags: tags
    memoryMb: memoryMb
    maxInstances: maxInstances
    allowedOrigin: 'https://${gamesSite.properties.defaultHostname}'
    hostStorageName: 'g4kshared${suffix}'
    deployPrincipalId: deployIdentity.properties.principalId
    deployIdentityId: deployIdentity.id
    appSettings: {
      APPLICATIONINSIGHTS_CONNECTION_STRING: insights.properties.ConnectionString
      TENANT_ID: tenantId
      GAMES_CLIENT_ID: gamesClientId
      STORAGE_SUFFIX: suffix
    }
  }
}

// The writer of each name gets the contributor role on that name alone, and the other side gets the reader role.
// An admin-private name has no player assignment at all.
resource tableWriters 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for (table, i) in tables: {
  scope: tableResources[i]
  name: guid(tableResources[i].id, table.value == 'play' ? 'play' : 'admin', 'writer')
  properties: {
    principalId: table.value == 'play' ? playApp.outputs.principalId : adminIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', tableDataContributor)
  }
}]

resource tableReaders 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for (table, i) in tables: if (table.value != 'admin-private') {
  scope: tableResources[i]
  name: guid(tableResources[i].id, table.value == 'play' ? 'admin' : 'play', 'reader')
  properties: {
    principalId: table.value == 'play' ? adminIdentity.properties.principalId : playApp.outputs.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', tableDataReader)
  }
}]

resource containerWriters 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for (container, i) in containers: {
  scope: containerResources[i]
  name: guid(containerResources[i].id, container.value == 'play' ? 'play' : 'admin', 'writer')
  properties: {
    principalId: container.value == 'play' ? playApp.outputs.principalId : adminIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobDataContributor)
  }
}]

resource containerReaders 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for (container, i) in containers: if (container.value != 'admin-private') {
  scope: containerResources[i]
  name: guid(containerResources[i].id, container.value == 'play' ? 'admin' : 'play', 'reader')
  properties: {
    principalId: container.value == 'play' ? adminIdentity.properties.principalId : playApp.outputs.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobDataReader)
  }
}]

resource queueWriters 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for (queue, i) in queues: {
  scope: queueResources[i]
  name: guid(queueResources[i].id, queue.value == 'play' ? 'play' : 'admin', 'writer')
  properties: {
    principalId: queue.value == 'play' ? playApp.outputs.principalId : adminIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', queueDataContributor)
  }
}]

resource queueReaders 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for (queue, i) in queues: if (queue.value != 'admin-private') {
  scope: queueResources[i]
  name: guid(queueResources[i].id, queue.value == 'play' ? 'admin' : 'play', 'reader')
  properties: {
    principalId: queue.value == 'play' ? adminIdentity.properties.principalId : playApp.outputs.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', queueDataReader)
  }
}]

resource portalReaders 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for (name, i) in portalTablesPlayersRead: {
  scope: portalTables[i]
  name: guid(portalTables[i].id, 'func-g4k-${id}', tableDataReader)
  properties: {
    principalId: playApp.outputs.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', tableDataReader)
  }
}]

output storageAccountName string = account.name
output location string = location
output playPrincipalId string = playApp.outputs.principalId
output adminPrincipalId string = adminIdentity.properties.principalId
output queues array = map(queues, queue => queue.key)
output defaultHostName string = playApp.outputs.defaultHostName
