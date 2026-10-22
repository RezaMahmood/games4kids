targetScope = 'resourceGroup'

@description('The pipeline passes the same parameters to every game module.')
param tags object
// Foundry lives in foundryLocation, and the player app and the queue need nothing from this module.
#disable-next-line no-unused-params
param location string
param storageAccountName string
#disable-next-line no-unused-params
param playPrincipalId string
param adminPrincipalId string
#disable-next-line no-unused-params
param queues array

@description('Foundry image models are offered in a few regions only, and not in West Europe or North Europe.')
param foundryLocation string = 'swedencentral'
@description('The admin app runtime identity. Bootstrap makes it, and its client id is what the queue trigger signs in as.')
param adminIdentityName string = 'id-g4k-admin'

@description('The model deployments the drafting worker calls by name: the chat model for the words, the image model for the picture. Global Standard, so the account region only decides where the resource lives.')
param deployments array = [
  { name: 'gpt-5.4-mini', model: 'gpt-5.4-mini', version: '2026-03-17', capacity: 50 }
  { name: 'gpt-image-1-mini', model: 'gpt-image-1-mini', version: '2025-10-06', capacity: 1 }
]

var foundryName = 'ai-timedetectives-${uniqueString(resourceGroup().id)}'
var cognitiveServicesOpenAIUser = '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'

resource adminIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: adminIdentityName
}

resource foundry 'Microsoft.CognitiveServices/accounts@2025-06-01' = {
  name: foundryName
  location: foundryLocation
  tags: tags
  kind: 'AIServices'
  sku: { name: 'S0' }
  properties: {
    customSubDomainName: foundryName
    publicNetworkAccess: 'Enabled'
    disableLocalAuth: true
  }
}

@batchSize(1)
resource models 'Microsoft.CognitiveServices/accounts/deployments@2025-06-01' = [for d in deployments: {
  parent: foundry
  name: d.name
  sku: { name: 'GlobalStandard', capacity: d.capacity }
  properties: {
    model: { format: 'OpenAI', name: d.model, version: d.version }
  }
}]

// The admin app drafts the rounds, so it is the only caller. The OpenAI User role has no listKeys, unlike Cognitive Services User.
resource adminCalls 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: foundry
  name: guid(foundry.id, adminPrincipalId, cognitiveServicesOpenAIUser)
  properties: {
    principalId: adminPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', cognitiveServicesOpenAIUser)
  }
}

output playSettings object = {}
// The pipeline prefixes each name with TIMEDETECTIVES_. STORAGE__* is the identity-based connection of the drafts queue trigger, which the admin app signs in to as id-g4k-admin.
output adminSettings object = {
  FOUNDRY_ENDPOINT: foundry.properties.endpoint
  STORAGE__queueServiceUri: 'https://${storageAccountName}.queue.${environment().suffixes.storage}'
  STORAGE__credential: 'managedidentity'
  STORAGE__clientId: adminIdentity.properties.clientId
}
