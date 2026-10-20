# games4kids

games4kids is a family games portal with one sign-in per child and one front door. It is two apps. The games site is for players only: each game lives under `/g/<id>/` and has its own API. The admin site, on its own origin and Entra registration, is where you invite children, choose their games, revoke access, and run each game's admin screens. The first two games are drawpad and letterjoin.

The design is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). The type sketch it describes is in [docs/sketch/](docs/sketch/). To check the sketch, run `tsc --noEmit --strict -p docs/sketch`.

## Status

The architecture is at revision 7. A child's token can only ever mean "player", and no admin role exists anywhere on the games side. Everyday admin work holds no Graph power. Each change in Entra asks you to sign in again, and the admin app acts as you through on-behalf-of only for 10 minutes after that sign-in, from a dedicated account whose roles limit it to inviting guests and assigning users to the games app. A merge to `main` deploys whatever changed, and rollback is a revert. Each game's tables have one writer each, the player API or the admin API. Your Mac runs bootstrap and one-off data moves, and adding a game needs no Mac step. Every Azure resource carries a `game` tag and the workbook shows usage and cost per game. Content migrates at cutover, and the player-data migration gets built and tested but runs only when the owner says so. Phases 1 and 2 of the build plan are built: `@g4k/sdk`, `@g4k/host` with identity, elevation, drift, typed storage, the three apps, the Azure storage accounts, the OBO `graphAs`, the node and OpenTelemetry adapters, both shells, the portal pages, the members page, and the dev stack. Nothing is deployed.

To check the code, run `npm ci --ignore-scripts && npm run gen && npm run lint && npx tsc -b && npm test` on Node 22.18 or later. To try it, run `npm run dev:fixtures` (the two fixture games) or `npm run dev`, then open the games site on port 4280 and the admin site on 4281, and sign in to the admin site as `admin@example.com`. The fake IdP uses a self-signed certificate on port 4284, so open it once and accept it. `npm run e2e` runs the Playwright check on the same stack, after `npx playwright install chromium`.

## The existing apps stay independent

The drawpad and letterjoin repos, their deployments, their Entra registrations, and their resource groups do not change. The portal gets its own Entra registrations, "games4kids" and "games4kids-admin", and its own resource group `rg-games4kids`. It copies code from the old repos and never calls them. The migration tools only read the old storage accounts. Both old apps keep running.
