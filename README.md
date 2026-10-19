# games4kids

games4kids is a family games portal with one sign-in and one front door. Each game is a self-contained folder that the portal hosts under `/g/<id>/`. The first two games are drawpad and letterjoin.

The design is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). The type sketch it describes is in [docs/sketch/](docs/sketch/). To check the sketch, run `tsc --noEmit --strict -p docs/sketch`.

## Status

This repo holds the architecture only, at revision 4 after owner feedback. You invite children and choose their games in the admin portal. Every infra and app deploy goes through a pipeline per layer with OIDC. Your Mac creates the identities and grants their rights, and runs one-off data moves. Each game has its own storage account, every Azure resource carries a `game` tag, and every telemetry record names its game, so an Azure Workbook shows usage and cost per game. Content migrates at cutover, and the player-data migration gets built and tested but runs only when the owner says so. Nothing is built yet, and nothing is deployed.

## The existing apps stay independent

The drawpad and letterjoin repos, their deployments, their Entra registrations, and their resource groups do not change. The portal gets its own Entra registration "games4kids" and its own resource group `rg-games4kids`. It copies code from the old repos and never calls them. The migration tools only read the old storage accounts. Both old apps keep running.
