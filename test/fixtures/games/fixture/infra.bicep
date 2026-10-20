targetScope = 'resourceGroup'

param tags object
param location string
param storageAccountName string
param playPrincipalId string
param adminPrincipalId string
param queues array

output playSettings object = { FIXTURE_ACCOUNT: storageAccountName }
output adminSettings object = { ACCOUNT: storageAccountName }
output received object = {
  tags: tags
  location: location
  playPrincipalId: playPrincipalId
  adminPrincipalId: adminPrincipalId
  queues: queues
}
