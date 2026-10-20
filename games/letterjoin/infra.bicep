targetScope = 'resourceGroup'

@description('The pipeline passes the same parameters to every game module.')
param tags object
// Every game module gets the same parameters. letterjoin keeps its data in the shared game account, and its admin app calls no Azure service.
#disable-next-line no-unused-params
param location string
#disable-next-line no-unused-params
param storageAccountName string
param playPrincipalId string
#disable-next-line no-unused-params
param adminPrincipalId string
#disable-next-line no-unused-params
param queues array

@description('Reading handwriting is in West Europe, where the free tier of AI Vision lives. A subscription may hold one free AI Vision account, so use S1 here, or drop the resource, when another exists.')
param visionLocation string = 'westeurope'
param visionSku string = 'F0'

var visionName = 'cv-letterjoin-${uniqueString(resourceGroup().id)}'
var cognitiveServicesUser = 'a97b65f3-24c7-4388-baec-2e87135dc908'

resource vision 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: visionName
  location: visionLocation
  tags: tags
  kind: 'ComputerVision'
  sku: { name: visionSku }
  properties: {
    customSubDomainName: visionName
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
  }
}

// The player app reads the writing, so it is the only caller. Cognitive Services User is the role that lets a managed identity call the Read feature.
resource playerReads 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: vision
  name: guid(vision.id, playPrincipalId, cognitiveServicesUser)
  properties: {
    principalId: playPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', cognitiveServicesUser)
  }
}

output playSettings object = {
  VISION_ENDPOINT: vision.properties.endpoint
}
output adminSettings object = {}
