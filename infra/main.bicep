targetScope = 'resourceGroup'

@description('West Europe. Static Web Apps Free is offered here.')
param location string = resourceGroup().location
param tenantId string = tenant().tenantId
@description('Client id of the games4kids registration.')
param gamesClientId string
@description('Client id of the games4kids-admin registration.')
param adminClientId string
@description('Object id of the games4kids service principal.')
param gamesPrincipalId string
@description('Object id of the games4kids-admin service principal.')
param adminPrincipalId string
@description('Where the daily cap alert goes.')
param alertEmail string
@description('Made by bootstrap. It is the admin app runtime identity and the credential Entra trusts for the on-behalf-of exchange.')
param adminIdentityName string = 'id-g4k-admin'
@description('Made by bootstrap. GitHub signs in as it in the deploy environment.')
param deployIdentityName string = 'id-g4k-deploy'

var suffix = take(uniqueString(resourceGroup().id), 5)
var tags = { app: 'games4kids', game: 'shared' }
var portalTags = { app: 'games4kids', game: 'portal' }
var adminTags = { app: 'games4kids', game: 'admin' }

var tableDataContributor = '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'
var tableDataReader = '76199698-9eea-4c19-bc75-cec21354c6b6'
var contributor = 'b24988ac-6180-42a0-ab88-20f7382dd24c'
@description('The custom domain of each site. tools/deploy.ts reads the same file.')
var domains = loadJsonContent('domains.json')

resource adminIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: adminIdentityName
}

resource deployIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: deployIdentityName
}

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-g4k'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
    workspaceCapping: { dailyQuotaGb: json('0.16') }
  }
}

resource insights 'Microsoft.Insights/components@2020-02-02' = {
  name: 'appi-g4k'
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logs.id
    RetentionInDays: 30
  }
}

resource alerts 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: 'ag-g4k'
  location: 'global'
  tags: tags
  properties: {
    groupShortName: 'g4k'
    enabled: true
    emailReceivers: [
      {
        name: 'owner'
        emailAddress: alertEmail
        useCommonAlertSchema: true
      }
    ]
  }
}

resource dailyCapReached 'Microsoft.Insights/scheduledQueryRules@2022-06-15' = {
  name: 'alert-g4k-daily-cap'
  location: location
  tags: tags
  properties: {
    displayName: 'Daily data limit reached'
    severity: 2
    enabled: true
    scopes: [logs.id]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT5M'
    criteria: {
      allOf: [
        {
          query: '_LogOperation | where Category =~ "Ingestion" | where Detail contains "OverQuota"'
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: { actionGroups: [alerts.id] }
  }
}

resource workbook 'Microsoft.Insights/workbooks@2023-06-01' = {
  name: guid(resourceGroup().id, 'games4kids-workbook')
  location: location
  tags: tags
  kind: 'shared'
  properties: {
    displayName: 'games4kids usage and cost by game'
    category: 'workbook'
    sourceId: insights.id
    serializedData: replace(loadTextContent('workbook.json'), '__APP_INSIGHTS_ID__', insights.id)
  }
}

resource hostStorage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: 'g4kshared${suffix}'
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

resource portalStorage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: 'g4kportal${suffix}'
  location: location
  tags: portalTags
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowSharedKeyAccess: false
    allowBlobPublicAccess: false
    defaultToOAuthAuthentication: true
  }

  resource tableService 'tableServices' = {
    name: 'default'

    resource members 'tables' = { name: 'members' }
    resource games 'tables' = { name: 'games' }
    resource identities 'tables' = { name: 'identities' }
    resource emails 'tables' = { name: 'emails' }
    resource profiles 'tables' = { name: 'profiles' }
    resource admins 'tables' = { name: 'admins' }
    resource aiusage 'tables' = { name: 'aiusage' }
  }
}

resource gamesSite 'Microsoft.Web/staticSites@2023-12-01' = {
  name: 'swa-g4k-games'
  location: location
  tags: tags
  sku: { name: 'Free', tier: 'Free' }
  properties: {}
}

resource adminSite 'Microsoft.Web/staticSites@2023-12-01' = {
  name: 'swa-g4k-admin'
  location: location
  tags: tags
  sku: { name: 'Free', tier: 'Free' }
  properties: {}
}

// The CNAME at the DNS host must resolve before this deploys. CNAME validation also gives the site a managed certificate.
resource gamesDomain 'Microsoft.Web/staticSites/customDomains@2023-12-01' = {
  parent: gamesSite
  name: domains.games
  properties: { validationMethod: 'cname-delegation' }
}

resource adminDomain 'Microsoft.Web/staticSites/customDomains@2023-12-01' = {
  parent: adminSite
  name: domains.admin
  properties: { validationMethod: 'cname-delegation' }
}

// The default hostnames keep working for invitations already sent and for bookmarks.
var gamesOrigin = 'https://${gamesDomain.name}'
var gamesOrigins = [gamesOrigin, 'https://${gamesSite.properties.defaultHostname}']
var adminOrigins = ['https://${adminDomain.name}', 'https://${adminSite.properties.defaultHostname}']
var telemetry = { APPLICATIONINSIGHTS_CONNECTION_STRING: insights.properties.ConnectionString }

module portalApp 'modules/function-app.bicep' = {
  name: 'func-g4k-portal'
  params: {
    name: 'func-g4k-portal'
    location: location
    tags: portalTags
    memoryMb: 512
    maxInstances: 10
    allowedOrigins: gamesOrigins
    hostStorageName: hostStorage.name
    deployPrincipalId: deployIdentity.properties.principalId
    deployIdentityId: deployIdentity.id
    appSettings: union(telemetry, {
      TENANT_ID: tenantId
      GAMES_CLIENT_ID: gamesClientId
      STORAGE_SUFFIX: suffix
    })
  }
}

module adminApp 'modules/function-app.bicep' = {
  name: 'func-g4k-admin'
  params: {
    name: 'func-g4k-admin'
    location: location
    tags: adminTags
    memoryMb: 2048
    maxInstances: 1
    allowedOrigins: adminOrigins
    hostStorageName: hostStorage.name
    userAssignedIdentityId: adminIdentity.id
    userAssignedClientId: adminIdentity.properties.clientId
    userAssignedPrincipalId: adminIdentity.properties.principalId
    deployPrincipalId: deployIdentity.properties.principalId
    deployIdentityId: deployIdentity.id
    appSettings: union(telemetry, {
      TENANT_ID: tenantId
      ADMIN_CLIENT_ID: adminClientId
      GAMES_PRINCIPAL_ID: gamesPrincipalId
      ADMIN_PRINCIPAL_ID: adminPrincipalId
      GAMES_ORIGIN: gamesOrigin
      STORAGE_SUFFIX: suffix
    })
  }
}

// One writer per table. The portal tables are read by every games-side app, and game.bicep grants those reads per game.
resource membersWriter 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: portalStorage::tableService::members
  name: guid(portalStorage::tableService::members.id, adminIdentity.id, tableDataContributor)
  properties: {
    principalId: adminIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', tableDataContributor)
  }
}

resource gamesWriter 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: portalStorage::tableService::games
  name: guid(portalStorage::tableService::games.id, adminIdentity.id, tableDataContributor)
  properties: {
    principalId: adminIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', tableDataContributor)
  }
}

resource identitiesWriter 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: portalStorage::tableService::identities
  name: guid(portalStorage::tableService::identities.id, adminIdentity.id, tableDataContributor)
  properties: {
    principalId: adminIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', tableDataContributor)
  }
}

resource emailsWriter 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: portalStorage::tableService::emails
  name: guid(portalStorage::tableService::emails.id, adminIdentity.id, tableDataContributor)
  properties: {
    principalId: adminIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', tableDataContributor)
  }
}

// The AI cost ledger. Only the admin app calls AI models, so it alone writes and reads it, and no player app gets a role.
resource aiusageWriter 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: portalStorage::tableService::aiusage
  name: guid(portalStorage::tableService::aiusage.id, adminIdentity.id, tableDataContributor)
  properties: {
    principalId: adminIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', tableDataContributor)
  }
}

resource profilesWriter 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: portalStorage::tableService::profiles
  name: guid(portalStorage::tableService::profiles.id, 'func-g4k-portal', tableDataContributor)
  properties: {
    principalId: portalApp.outputs.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', tableDataContributor)
  }
}

resource profilesAdminReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: portalStorage::tableService::profiles
  name: guid(portalStorage::tableService::profiles.id, adminIdentity.id, tableDataReader)
  properties: {
    principalId: adminIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', tableDataReader)
  }
}

resource adminsAdminReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: portalStorage::tableService::admins
  name: guid(portalStorage::tableService::admins.id, adminIdentity.id, tableDataReader)
  properties: {
    principalId: adminIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', tableDataReader)
  }
}

resource membersPortalReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: portalStorage::tableService::members
  name: guid(portalStorage::tableService::members.id, 'func-g4k-portal', tableDataReader)
  properties: {
    principalId: portalApp.outputs.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', tableDataReader)
  }
}

resource gamesPortalReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: portalStorage::tableService::games
  name: guid(portalStorage::tableService::games.id, 'func-g4k-portal', tableDataReader)
  properties: {
    principalId: portalApp.outputs.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', tableDataReader)
  }
}

resource identitiesPortalReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: portalStorage::tableService::identities
  name: guid(portalStorage::tableService::identities.id, 'func-g4k-portal', tableDataReader)
  properties: {
    principalId: portalApp.outputs.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', tableDataReader)
  }
}

resource gamesSiteDeployer 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: gamesSite
  name: guid(gamesSite.id, deployIdentity.id, contributor)
  properties: {
    principalId: deployIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', contributor)
  }
}

resource adminSiteDeployer 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: adminSite
  name: guid(adminSite.id, deployIdentity.id, contributor)
  properties: {
    principalId: deployIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', contributor)
  }
}

output suffix string = suffix
output gamesSiteHostname string = gamesSite.properties.defaultHostname
output adminSiteHostname string = adminSite.properties.defaultHostname
output portalAppHostName string = portalApp.outputs.defaultHostName
output adminAppHostName string = adminApp.outputs.defaultHostName
output applicationInsightsName string = insights.name
output logAnalyticsName string = logs.name
