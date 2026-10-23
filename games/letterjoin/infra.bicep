targetScope = 'resourceGroup'

// Every game module gets the same parameters. letterjoin keeps its data in the shared game account, and its admin app calls no Azure service.
#disable-next-line no-unused-params
param tags object
#disable-next-line no-unused-params
param location string
#disable-next-line no-unused-params
param storageAccountName string
#disable-next-line no-unused-params
param playPrincipalId string
#disable-next-line no-unused-params
param adminPrincipalId string
#disable-next-line no-unused-params
param queues array

// Reading handwriting borrows the old letterjoin's free AI Vision account until its data has moved, because a subscription may hold one free account. tools/bootstrap.mjs --after-first-deploy grants the player app Cognitive Services User on it, since the pipeline has no rights outside rg-games4kids.
var visionEndpoint = 'https://cv-letterjoin-ul5nga.cognitiveservices.azure.com/'
// The account's pricing tier, which prices each read in the cost ledger. Change it to S1 with the account.
var visionTier = 'F0'

output playSettings object = {
  VISION_ENDPOINT: visionEndpoint
  VISION_TIER: visionTier
}
output adminSettings object = {}
