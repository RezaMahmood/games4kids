targetScope = 'resourceGroup'

@description('The pipeline passes the same parameters to every game module.')
param tags object
param location string
param storageAccountName string
// Every game module gets the same parameters. drawpad's player app calls no Azure service, so it gets no role here.
#disable-next-line no-unused-params
param playPrincipalId string
param adminPrincipalId string
param queues array

@description('Foundry image models are offered in a few regions only, and not in West Europe or North Europe.')
param foundryLocation string = 'swedencentral'
@description('The admin app runtime identity. Bootstrap makes it, and its client id is what the queue trigger signs in as.')
param adminIdentityName string = 'id-g4k-admin'

@description('The model deployments drawpad calls by name: the chat model for titles and prompts, and the two image models. Global Standard, so the account region only decides where the resource lives.')
param deployments array = [
  { name: 'gpt-5.4-mini', model: 'gpt-5.4-mini', version: '2026-03-17', capacity: 50 }
  { name: 'gpt-image-1-mini', model: 'gpt-image-1-mini', version: '2025-10-06', capacity: 1 }
  { name: 'gpt-image-2', model: 'gpt-image-2', version: '2026-04-21', capacity: 1 }
]

var jobQueue = 'stencil-jobs'
var foundryName = 'ai-drawpad-${uniqueString(resourceGroup().id)}'
var cognitiveServicesOpenAIUser = '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'
var storageQueueDataMessageSender = 'c6a89b2d-59bc-44d0-9896-0f6e12d7b80a'

resource adminIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: adminIdentityName
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
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

// The admin app runs the jobs, so it is the only caller. The OpenAI User role has no listKeys, unlike Cognitive Services User.
resource adminCalls 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: foundry
  name: guid(foundry.id, adminPrincipalId, cognitiveServicesOpenAIUser)
  properties: {
    principalId: adminPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', cognitiveServicesOpenAIUser)
  }
}

// Writing a job's empty ready blob, after everything else the job needs, starts the job: Event Grid puts the blob's BlobCreated event on the job queue.
resource storageEvents 'Microsoft.EventGrid/systemTopics@2025-02-15' = {
  name: 'evgt-drawpad-${uniqueString(resourceGroup().id)}'
  location: location
  tags: tags
  identity: { type: 'SystemAssigned' }
  properties: {
    source: storage.id
    topicType: 'Microsoft.Storage.StorageAccounts'
  }
}

// On the account, not the queue: Event Grid checks the identity's access on the destination it names, which is the storage account.
resource eventsQueueSender 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storage
  name: guid(storage.id, storageEvents.id, storageQueueDataMessageSender)
  properties: {
    principalId: storageEvents.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageQueueDataMessageSender)
  }
}

resource jobReady 'Microsoft.EventGrid/systemTopics/eventSubscriptions@2025-02-15' = if (contains(queues, jobQueue)) {
  parent: storageEvents
  name: 'job-ready'
  dependsOn: [eventsQueueSender]
  properties: {
    eventDeliverySchema: 'EventGridSchema'
    filter: {
      includedEventTypes: ['Microsoft.Storage.BlobCreated']
      subjectBeginsWith: '/blobServices/default/containers/jobs/blobs/'
      subjectEndsWith: '/ready'
      isSubjectCaseSensitive: true
    }
    deliveryWithResourceIdentity: {
      identity: { type: 'SystemAssigned' }
      destination: {
        endpointType: 'StorageQueue'
        properties: {
          resourceId: storage.id
          queueName: jobQueue
        }
      }
    }
  }
}

// Upload job photos and AI results are only needed while the admin reviews them.
resource lifecycle 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          name: 'expire-jobs'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: { blobTypes: ['blockBlob'], prefixMatch: ['jobs/'] }
            actions: { baseBlob: { delete: { daysAfterModificationGreaterThan: 7 } } }
          }
        }
      ]
    }
  }
}

output playSettings object = {}
// The pipeline prefixes each name with DRAWPAD_. STORAGE__* is the identity-based connection of the stencil-jobs queue trigger, which the admin app signs in to as id-g4k-admin.
output adminSettings object = {
  FOUNDRY_ENDPOINT: foundry.properties.endpoint
  STORAGE__queueServiceUri: 'https://${storage.name}.queue.${environment().suffixes.storage}'
  STORAGE__credential: 'managedidentity'
  STORAGE__clientId: adminIdentity.properties.clientId
}
