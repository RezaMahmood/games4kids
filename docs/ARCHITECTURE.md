# games4kids portal architecture

This is the design for the games4kids portal, revised five times after owner feedback (see [Revision 6](#revision-6-entra-changes-run-as-you)). Nothing is built or deployed yet. The type sketch in [`docs/sketch/`](sketch/) is the contract this prose describes, and `tsc --noEmit --strict -p docs/sketch` checks it, including the negatives in [`isolation.check.ts`](sketch/isolation.check.ts).

## Recommendation

You asked whether the admin app could change Entra as you, instead of holding rights of its own. It can, and that removes every standing Entra right from the portal. The `/admin/` pages get a token for a second registration, `games4kids-admin`, and the admin app exchanges it for a Graph token through OAuth 2.0 on-behalf-of (OBO). Graph then acts as you, within three delegated scopes and your own role, only while you are signed in. The app authenticates with its managed identity as a federated credential, so it holds no secret, and no extra licence or directory role is needed.

Revision 5 stands otherwise. Each game's pipeline moves only that game's pins, `web-release` deploys the one Static Web App from the pins, and each game runs in its own Function app, `func-g4k-<id>`. A versioned shell and SDK are the only contract between a game and the platform.

The cost is that Entra changes and the drift check work only while you are signed in to `/admin/`, and that during your session a compromised admin app could do whatever those three scopes allow you.

## Problem

Two finished games, drawpad and letterjoin, need one front door, one sign-in, and one admin, with more games later. drawpad is Preact with Vite, keyed by Entra `oid`. letterjoin is vanilla ES modules, keyed by email. Both use MSAL against one tenant and a Functions API that validates its own JWTs. You also need cost by game, and to change one game without redeploying the others.

The old repos, deployments, and registrations stay as they are. The portal gets its own registrations and resource group `rg-games4kids` in West Europe. Players are invite only, with one sign-in per child for every game. Every deploy goes through a pipeline.

## Where each action runs

People and access change only in `/admin/`, and the Entra calls there run as you. Azure resources, code, and redirect URIs change only through GitHub Actions. Your Mac creates the two registrations and the six identities, grants their rights, and runs one-off data moves, and nothing on it is per game.

| | Mac (bootstrap only) | Admin portal, `/admin/` | Pipelines |
| --- | --- | --- | --- |
| People and access | Your own account's assignment to games4kids, so you can sign in | Invite with games and roles, change access, revoke, view and fix drift | Nothing |
| Entra | Both registrations, their scopes, and Graph consent for your account. The six user-assigned identities and their federated credentials, including `id-g4k-obo` on games4kids-admin. `id-g4k-infra`'s scoped Application Administrator role | Guests and their games4kids assignment, as you through OBO | Redirect URIs on games4kids |
| Azure | `rg-games4kids`, the identities' Azure roles, your migration data roles | Nothing | Shared Bicep, one Bicep deployment per game, each game app's system-assigned identity and its roles, tags, the workbook |
| GitHub | Environments, reviewers, and variables (ids and `BOOTSTRAP_ADMINS`, no secrets), through `gh` | Nothing | Nothing |
| Code | Nothing | Nothing | Each game's app and pages, the portal app and pages, the admin app, the shell, and the site assembly |
| Data | Content migration at cutover, player-data migration only when you say so | Nothing | Nothing |

The Mac never invites a child or deploys. No pipeline creates a registration or user-assigned identity, or grants a directory role or Graph permission. Nothing that runs without you signed in calls Graph.

## Usage (caller's view)

A game author reads this and nothing else:

```
games/<id>/manifest.ts     export default defineGame({...})              data only
games/<id>/package.json    @g4k/sdk and @g4k/host version ranges
games/<id>/web/            your pages, served at /g/<id>/
games/<id>/api/index.ts    export const createGameApi = defineGameApi(manifest, (platform) => ({ routes }))
games/<id>/infra.bicep     optional: Azure resources only this game uses, each tagged with the `tags` param
Import only @g4k/sdk and '/shell/v1/index.js'. Run npm run dev. Nothing else in the repo lists your game.
```

```js
import { enter } from '/shell/v1/index.js';
const { api, me } = await enter({ game: 'letterjoin' });
const groups = await api.get('activities');
// admin.js
const admin = await enter({ game: 'letterjoin', requires: 'admin' });
```

On the API side, both games' route guards become `Route` objects with `access`, and both user keys become `caller.userId` ([drawpad](sketch/examples/drawpad/api.ts), [letterjoin](sketch/examples/letterjoin/api.ts)). A game writes no auth or telemetry code.

## Shape

### Repo layout

```
games4kids/
	package.json                npm workspaces. gen runs on predev, prebuild, pretest
	eslint.config.js            no @azure/*, @opentelemetry/*, jose, or process.env in games/*/api
	packages/sdk/               @g4k/sdk, the contract: defineGame, defineGameApi, HttpError, Platform, Session
	packages/host/              @g4k/host: createGameApp, createPortalApp, identity, storage, telemetry, adapters/
	shell/                      builds the shell artifact for one major: /shell/v1/index.js and theme.css
	portal/web/                 / (home), /welcome/, /admin/ (invite form, access grid, drift), redirect.html
	portal/api/                 func-g4k-portal entry: createPortalApp
	admin/src/                  func-g4k-admin: admin.ts, graph.ts (OBO and Graph), adapters/. Never imports games/*
	games/drawpad/              manifest.ts, package.json, web/ (Vite + Preact), api/, infra.bicep (Foundry)
	games/letterjoin/           manifest.ts, package.json, web/ (static), api/ (JS, checkJs), infra.bicep (Vision)
	tools/                      gen, dev, changes, release, infra, bootstrap, migrate/content, migrate/player-data (.mjs)
	infra/                      main.bicep (shared), game.bicep (one deployment per game), workbook.json
	dev/                        fake-idp.mjs from letterjoin, generated/games.ts (dev and tests only)
	test/                       conformance.ts, *.test.ts suites, e2e/ (Playwright)
	.github/workflows/          deploy.yml, game.yml, shell.yml, portal.yml, admin.yml, infra.yml, web-release.yml, release.yml
```

### Request flow

1. A child opens `/`, which calls `enter({ game: null })`. With no cached account, the shell calls `loginRedirect`, and Entra signs in only accounts assigned to games4kids.
2. The shell gets a token for `api://<clientId>/access_as_user` and calls `GET /api/portal/me` on `func-g4k-portal`.
3. The portal app verifies the token, and the pure `decide` turns the stored rows into an `Admission`. An invited child's first sign-in claims, and a member with no profile goes to `/welcome/`.
4. Home reads `catalog.json` and draws a card for each game whose `effectiveRole` is not `'none'`.
5. On Draw Pad, `enter({ game: 'drawpad' })` gets a token silently, binds `api` to drawpad's `apiBaseUrl` from the catalog, and starts the play heartbeat.
6. `api.post('drawings', ...)` reaches `func-g4k-drawpad`, which runs the fixed order in [`host.ts`](sketch/host.ts): verify, find the claimed identity, admit, check the role, parse, `run`, and map errors to one shape.

Every game app and the portal app accept the same token and read the member row on every request, so a revoke reaches every game at once.

### Games are pages, released one at a time

The site is one Static Web App on one origin. The portal owns `/`, `/welcome/`, and `/admin/`, and each game is its own documents under `/g/<id>/`, importing its shell major by URL. Moving between games costs a page load and a silent token call, because every path in a tab shares MSAL's session cache, and one game's CSS or pointer handlers never reach another.

Each pipeline publishes what it builds to the `releases` container in the portal account ([`release.ts`](sketch/release.ts)). An `ArtifactRef` names one immutable build by kind, commit sha, digest, and contract. `publishArtifact` writes with `If-None-Match: *`, so a rerun fails only if the digests differ. A `Pin` at `pins/<owner>/<kind>.json` holds the owner's `current` and `previous` artifact, so a rollback is one swap, and an app pin also records the app's origin. Repinning the current artifact does nothing.

`web-release` reads every pin into a `ReleaseManifest`, checks the contract rule, lays out the site, and writes the files no artifact owns: `catalog.json`, `config.json`, `staticwebapp.config.json`, and `release.json`. It deploys, waits for `/release.json` to match, and stores the manifest under `manifests/<run>.json`. A problem fails the run, and the site stays at the last release.

**Two games releasing at once lose nothing.** No pin is shared, because drawpad's pipeline writes only `pins/drawpad/*` and letterjoin's only `pins/letterjoin/*`. Two runs for one owner are serialized by the GitHub concurrency group `release-<owner>` on the job that calls `game.yml` (verified, [reusable workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations)). `web-release` writes no pin and runs in the group `web-release`, where a newer pending run replaces an older pending one (verified, [concurrency](https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/control-the-concurrency-of-workflows-and-jobs)). Nothing is lost, because a run reads the pins when it starts, after every earlier pin write.

### Contracts and versions

The contract is `@g4k/sdk`'s major and minor, covering the shell's browser API, the game API types, the wire error shape, and the portal rows a game app reads. `compatible` in `release.ts` holds the rule. An artifact built against `M.m` can ship when `M` is the current major (the newest pinned shell) or the previous one, and, for pages, the pinned `/shell/vM/` is at minor `m` or later. A game's pages and app share a major, because the shell's `ApiClient` parses that app's errors. `pinArtifact` refuses an incompatible artifact, and `assembleRelease` checks again, because a shell rollback can race a game pin.

A minor only adds, such as an optional field or a route, and replaces `/shell/v1/` in place. Anything else is a major, so `/shell/v2/` ships beside `/shell/v1/`, and the portal app and `@g4k/host` keep both majors until no pin uses the old one. An app refuses a member state it does not know, so an older game app fails closed. A pull request that changes `packages/sdk`, `packages/host`, or `shell/` runs every game's `tsc -b` and conformance against it, and a proposed minor that fails any game is a major.

### One Function app per game

Each game's API runs in its own Flex Consumption app, `func-g4k-<id>`, built from the game's `api/` and a generated entry that calls `createGameApp` from the `@g4k/host` version in its `package.json`. A game receives a `Platform<typeof manifest>` with handles typed from the names it declared, parsed settings, tokens for declared services, and a read-only `roster`. It never receives a credential, a client, or the environment, and `Reply` has no headers. Each game's TS projects reference only `@g4k/sdk`, so importing another game's files fails `tsc -b` (c1 measured TS6307), and ESLint closes the rest.

A throw at startup, or a missing setting, stops only that app. Its pipeline then fails the health check and redeploys the pinned package, so nothing needs containing. Each app's `/health` exists only for that check, and the workbook shows each game's errors.

The portal app, `func-g4k-portal`, serves `me` (which claims a first sign-in), the profile, and health, and knows no game. `me` returns the stored grants, and the shell derives each game's role over the live catalog. The game app's check is authoritative.

### Identity and roles

There are two single-tenant registrations. "games4kids" is the SPA client and the API the game apps and the portal app accept, with redirect URIs `https://<site>/` and `https://<site>/redirect.html` and the scope `access_as_user`. "games4kids-admin" is the admin app's API, with one scope, `admin.manage`, which only the `/admin/` pages request. It pre-authorizes the games4kids client and has no redirect URI. A new game changes neither. The admin app mints a `PortalUserId`, a branded UUID, at invite, and it is the only user key a game sees or stores.

Entry needs two things ([`identity.ts`](sketch/identity.ts)). Assignment required is on for games4kids, and each invited account holds its own assignment, so Entra issues no token to anyone else. Then every app admits only an active `members` row. The admin app writes both lists.

Each portal table has one writer, and RBAC per app and per table enforces it.

| Table | Holds | Writer | Readers |
| --- | --- | --- | --- |
| `members` | state, portal role, grants | admin app | every app |
| `emails` | email to `PortalUserId` and Entra object id | admin app | portal app |
| `identities` | issuer and subject to `PortalUserId` | portal app, at first sign-in | every app |
| `profiles`, `names` | display name and time zone | portal app, on `/welcome/` | admin app, game apps (`profiles`) |

Each fact lives in one table, so nothing has to stay in step. Emails live only in `emails`, which no game app can read, and a game app's code gets a `PortalReader` whose rows have no email field and which has no writer. If a first sign-in reaches a game app before the portal app has claimed it, the game app answers 403 `not_claimed`. The shell's `onRefusal` then calls `me`, which claims, and retries once.

Each manifest declares its role ladder, lowest first. `effectiveRole` gives a portal admin the top rung of every game and anyone else their grant, or `'none'`, so a new game is hidden until you grant it. A game sees `Caller = { userId, displayName, timeZone, role }`.

### The admin app acts as you, only while you are signed in

`func-g4k-admin` serves `/api/admin/*` to the `/admin/` pages ([`admin.ts`](sketch/admin.ts)). It reads the live `catalog.json`, never imports `games/*`, and holds no Graph application permission and no directory role. Each request runs in a fixed order.

1. `verifyAdminToken` accepts only audience games4kids-admin with scope `admin.manage`. OBO exchanges only a token whose audience is the calling app (verified, [OBO flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-on-behalf-of-flow)), so a child's games4kids token is never exchanged.
2. `openAdminSession` requires an active portal admin row, and is the only way to mint an `AdminSession`.
3. `graphAs(session)` is the only way to build an `OboGraph`. On the first Graph call, it posts to the token endpoint with `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`, a client assertion from the app's managed identity, your token as `assertion`, `requested_token_use=on_behalf_of`, and the Graph `.default` scope (verified, same page).

The sketch's negatives prove that Graph needs a session, that a games4kids token cannot open one, and that seeding takes no Graph client.

**No secret.** The app runs as `id-g4k-obo`, a federated identity credential on games4kids-admin with issuer `https://login.microsoftonline.com/<tenant>/v2.0`, the identity's principal id as subject, and audience `api://AzureADTokenExchange`. Only a user-assigned identity qualifies, so bootstrap creates it (verified, [managed identity as a credential](https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation-config-app-trust-managed-identity)). Learn shows that assertion with client credentials, and OBO takes the same `client_assertion`, so OBO with it is inferred, and build phase 6 proves it.

**Three delegated scopes**, consented at bootstrap for your account only (`consentType` `Principal`, verified, [grant](https://learn.microsoft.com/en-us/graph/api/resources/oauth2permissiongrant?view=graph-rest-1.0)):

- `User.Invite.All` creates guests (least privileged, verified, [invitation](https://learn.microsoft.com/en-us/graph/api/invitation-post?view=graph-rest-1.0)).
- `AppRoleAssignment.ReadWrite.All` and `Application.Read.All` together assign (verified, [assign](https://learn.microsoft.com/en-us/graph/api/serviceprincipal-post-approleassignedto?view=graph-rest-1.0)). The first deletes (verified, [delete](https://learn.microsoft.com/en-us/graph/api/serviceprincipal-delete-approleassignedto?view=graph-rest-1.0)), and the second lists for drift (verified, [list](https://learn.microsoft.com/en-us/graph/api/serviceprincipal-list-approleassignedto?view=graph-rest-1.0)).

A delegated call can do only what both the scope and your own permissions allow (verified, [Graph permissions](https://learn.microsoft.com/en-us/graph/permissions-overview)). Your Global Administrator role adds no bound, so the scopes are the bound, and `AppRoleAssignment.ReadWrite.All` reaches app role grants on any API, Graph included (verified, [permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference)). Another portal admin has no consent, so the exchange fails, the admin app answers 403 `entra_forbidden` (inferred error mapping), and grants still work.

**Sign-in again.** If Entra wants more, such as MFA, the token endpoint answers `interaction_required` with `claims` (verified, OBO page). The admin app answers 401 `reauth_required` with the claims, and the shell calls `acquireTokenRedirect` for `admin.manage` with them, back to the same page.

### Onboarding a child

1. On `/admin/` you enter the child's email, a portal role, and a role for each game you tick.
2. The admin app reads or creates the `emails` row, which fixes the `PortalUserId`, so a re-invited child keeps their history. It writes the active `members` row with the grants.
3. Unless the child has signed in, it sends Microsoft's B2B invitation as you and records the object id on the `emails` row.
4. It assigns the account to games4kids as you, retrying after 2, 4, 8, and 16 seconds while Entra replicates a new guest (assumed from drawpad's group adds, guess).
5. The child signs in. The portal app finds the account through `emails`, checks that its object id equals the token's `oid`, and inserts the identity row.
6. `/welcome/` asks for a display name and a time zone, and home shows only the granted games.

Steps 2 to 4 are `invite`, and each is safe to repeat. If your session lapses or Entra asks you to sign in again partway, the rows already written stay, `/admin/` shows the gap as drift, and sending the form again converges. To revoke, the admin app marks the member revoked, so every app refuses the next call, then removes the assignment as you. A revoke cut short leaves drift for a child every app already refuses. `/admin/` compares Graph's assignments with the rows on each load, as you, and **Fix drift** changes only Entra.

### Doors left for other sign-ins and parents

Google and Facebook sign-in are not built. An Entra External ID tenant would join as a second `TrustedIssuer` whose identity rows map to the child's existing `PortalUserId`. You are the parent for now, as portal admin, and `identity.ts` reserves `guardianships` and `policies` tables for a later parent account.

### Data isolation

Each game has its own storage account, `g4k<id><suffix>`, and the portal has `g4kportal<suffix>`, with the suffix from Bicep's `uniqueString(resourceGroup().id)`. Tables, containers, and queues keep their declared names, and game ids are 3 to 16 characters so account names fit Azure's 24.

Isolation is RBAC as well as types. Each game app's identity holds data roles on its own account only, plus Storage Table Data Reader on the `members`, `identities`, and `profiles` tables, which Azure can scope per table (verified, [table RBAC](https://learn.microsoft.com/en-us/azure/storage/tables/authorize-access-azure-active-directory)). So hostile code in drawpad's app cannot read letterjoin's account, any child's email, or write any portal table (inferred from the role scopes). Types and lint catch the honest mistake first.

A joint scoreboard would go through the manifest's reserved `exports`, which admits only `{}` until a hub exists.

### Cost and usage by game

**Tags.** Bicep tags every resource `app=games4kids` and a `game` value: `game=<id>` on a game's storage, Flex plan and app, and `infra.bicep` resources, `game=portal` on the portal account and the portal and admin apps, and `game=shared` on the Static Web App, Log Analytics, and Application Insights. Which Flex resource carries the billing meter is unverified, so plan and app both carry the tag. Tags reach usage records only while applied ([Cost Management data](https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/understand-cost-mgt-data)), so `tools/infra.mjs` fails on a missing tag. Compute cost is exact by tag, because each game's compute is its own app.

**Telemetry** goes to one Application Insights. Every record carries [`GameTelemetry`](sketch/telemetry.ts) `{ game, route, user }`, where `game` is a `GameId` or `portal`, and `user` is the `PortalUserId`, never an email. Each app binds the envelope before `run` ([Functions OpenTelemetry](https://learn.microsoft.com/en-us/azure/azure-functions/opentelemetry-howto)), so a game cannot misreport itself. The shell stamps page views and sends a `game_session` event each minute a game page is visible. Sampling is off, and ingestion is capped at 0.2 GB a day, ten times a guessed volume. At the cap, collection stops until the reset hour ([daily cap](https://learn.microsoft.com/en-us/azure/azure-monitor/logs/daily-cap)), and an alert emails you.

**The workbook**, `infra/workbook.json`, groups every query by `game`, so a new game appears with no edit. It shows players, play minutes, requests, errors, p95 latency, AI calls, and cost by tag, read with a Cost Management POST ([data sources](https://learn.microsoft.com/en-us/azure/azure-monitor/visualize/workbooks-data-sources), [Query Usage](https://learn.microsoft.com/en-us/rest/api/cost-management/query/usage)). Each fact is verified, the combination is untested, and the fallback is a daily cost export.

### Registry and build checks

The folder is the registry. `tools/gen.mjs` scans `games/*/manifest.ts` and fails, listing every problem, on a folder that differs from its id, a duplicate, malformed, or reserved id (`portal`, `shared`, `shell`, `admin`, `welcome`, `api`, `g`), a missing required file, a declared storage name Azure rejects, a `defaultRole` off the ladder, a rung named `none`, or non-empty `exports`. It writes per-game outputs only ([`registry.ts`](sketch/registry.ts)), which are the app entry, the catalog entry, and the Bicep parameters, plus a registry for dev and tests. In production, only `web-release` lists every game, from the pins.

### Adding a game

1. Create `games/<id>/manifest.ts` with `defineGame`, and `package.json` with the `@g4k/sdk` and `@g4k/host` ranges.
2. Add `web/index.html` that imports `/shell/v1/index.js`.
3. Add `api/index.ts` that exports `createGameApi`.
4. Add `infra.bicep` if the game needs its own Azure resources, tagging each with the `tags` param.
5. Run `npm test`. Gen runs first, and conformance covers the new game.
6. Push to `main`. `deploy.yml` calls `game.yml` for that id only: infra after your approval, then app, then web, then `web-release`. No other game builds.
7. In `/admin/`, grant the game to each child who should see it.

No Mac step is needed, because the app's identity is system-assigned and `id-g4k-infra` grants its roles. Role assignments can take up to 30 minutes to propagate (verified, [table RBAC](https://learn.microsoft.com/en-us/azure/storage/tables/authorize-access-azure-active-directory)), so a game's first app job retries a 403 for that long. To retire a game, dispatch `release.yml retire <id>`, which deletes its pins. Its resources and data stay until you delete them.

### Hosting and cost

Everything sits in West Europe, except the Foundry account in Sweden Central.

- Static Web App, Free, which allows 250 MB per environment and 10 apps per subscription (verified, [quotas](https://learn.microsoft.com/en-us/azure/static-web-apps/quotas)).
- Flex Consumption apps on Node 22, one plan each, since Flex allows one app per plan and bills only while code runs (verified, [Flex plan](https://learn.microsoft.com/en-us/azure/azure-functions/flex-consumption-plan)). The portal and admin apps use 512 MB (guess), and each game app 2048 MB unless its manifest says otherwise. drawpad's `maxInstances: 1` runs its Foundry worker serially (verified, same page).
- A storage account per game and one for the portal, with the portal tables and the releases container. Shared keys off, no public blob access.
- Log Analytics, Application Insights, the workbook, and each game's `infra.bicep` resources.

The monthly cost is a guess of 1 to 3 USD before Foundry at 0.015 to 0.048 USD per redraw (drawpad measured).

### Pipelines and deploy identities

`deploy.yml` runs lint, `tsc -b`, and the tests on pull requests and pushes to `main`. `tools/changes.mjs` maps changed paths to owners and layers (`infra`, `app`, `web`), and `deploy.yml` fans out one job per changed owner.

- `game.yml` runs infra (`what-if` on a pull request, deployment `game-<id>` on `main`), app (conformance, publish, deploy, health at this sha, pin), and web (build, publish, pin). If the new app fails health, the job redeploys the pinned package and fails.
- `shell.yml`, `portal.yml`, and `admin.yml` do the same for their owners. A `packages/host` change redeploys the portal and admin apps, and reaches each game on its next release, or at once if you dispatch `deploy.yml` with `games: all`.
- `infra.yml` deploys `infra/main.bicep`, then sets the redirect URIs, writing only a difference.
- `web-release.yml` deploys the site after any web or app pin moves, and `release.yml` rolls a pin back a step or retires a game.

Each deploy identity is user-assigned and federated to its own GitHub environment, which only `main` may deploy to. GitHub holds only ids.

- `id-g4k-infra`, environments `infra` and `infra-plan`. Contributor on `rg-games4kids`, plus Role Based Access Control Administrator with a condition that allows only storage data roles, Cognitive Services User, and Monitoring Metrics Publisher for service principals, Website Contributor for the three app deploy identities, and Contributor for `id-g4k-web`. Application Administrator scoped to the games4kids registration only, for redirect URIs. Learn's example of a role scoped to one registration (`directoryScopeId` `/<object id>`) is Application Administrator, and the assignee can be a service principal (verified, [assign roles](https://learn.microsoft.com/en-us/entra/identity/role-based-access-control/manage-roles-portal)). games4kids-admin is left out, because it has no redirect URI, and a pipeline able to add a credential to it would hold half of what OBO needs.
- `id-g4k-apps` (environment `apps`), `id-g4k-portal-api` (`portal-api`), and `id-g4k-admin-api` (`admin-api`). Website Contributor on their apps, and blob roles on their deployment containers and the releases container.
- `id-g4k-web`, environment `web`. Contributor on the Static Web App, and a blob role on the releases container.

`id-g4k-obo` is the admin app's runtime identity, not a deploy identity, and has no GitHub credential. Shared Bicep grants it write on `members` and `emails` and read on `identities` and `profiles`. It holds no Entra role and no Graph permission.

**One deploy identity for every game app.** A per-game identity would make every new game a Mac step. A shared `id-g4k-apps` runs only workflow code from `main`, which you already review (inferred). For approval per game later, one flexible federated credential matching `environment:apps-*` would cover every game, but those are in preview (verified, [flexible credentials](https://learn.microsoft.com/en-us/entra/workload-id/workload-identities-flexible-federated-identity-credentials)).

`id-g4k-admin-api` deploys the code that runs during your admin sessions, and `id-g4k-infra` can change the games4kids registration, so both environments require your approval, including a new game's first infra run.

### Bootstrap

`tools/bootstrap.mjs` runs under your Owner and Global Administrator sign-in, has no per-game step, and changes nothing on a second run.

1. Create the games4kids registration and service principal, `access_as_user`, and assignment required. Assign your own account, because assignment required would otherwise keep you out of `/admin/`.
2. Create games4kids-admin and its service principal, `admin.manage` with the games4kids client pre-authorized, and the three delegated Graph scopes, consented for your account only.
3. Create the six identities (`id-g4k-infra`, `id-g4k-apps`, `id-g4k-portal-api`, `id-g4k-admin-api`, `id-g4k-web`, `id-g4k-obo`), the GitHub federated credentials, and `id-g4k-obo`'s federated credential on games4kids-admin.
4. Give `id-g4k-infra` Application Administrator scoped to the games4kids registration, and the deploy identities their Azure roles.
5. Create the GitHub environments, reviewers, and variables.

### Bringing the two games in

Each game's web and api folders are copied, minus the auth code the portal now owns. Content migrates at cutover. Player data gets a tool, built and tested, that re-keys each child's rows from the `emails` rows, dry-runs by default, and writes only with `--apply --confirm-player-data`, which the type enforces. Both tools read the old accounts only and insert if absent, so reruns converge ([`migrate.ts`](sketch/migrate.ts)).

### Stay a monorepo

Each game depends only on `@g4k/sdk`, `@g4k/host`, and the shell URL, and ships through `game.yml` by id. Moving one to its own repo means publishing the two packages, calling `game.yml` from that repo, and one federated credential on the Mac. I would split when a second person owns a game, or when CI for unrelated games slows every change. Neither is true today.

### Local dev and tests

`npm run dev` starts letterjoin's fake IdP, which also signs `admin.manage` tokens and answers the OBO grant, a fake Graph, a telemetry sink, and one node process that serves the portal, admin, and every game app through `serveWithNode`, with the real `verifyToken`. Storage is memory or Azurite, one account per owner.

[`conformance`](sketch/conformance.ts) runs per game, `boundaries` proves forbidden imports fail `tsc -b`, and `release` covers reruns, concurrent pins, rollback, and `compatible`.

## Synthesis decision

Three designs went to a bakeoff. c1 mounted games in shadow roots of one SPA, c2 used iframes and a Function app per game, and c3 co-hosted pages on one host. c3 scored highest and is the base, because only it brings letterjoin in without a rewrite. It took c1's identity model and c2's conformance suite.

### Earlier revisions

Revision 2 moved to West Europe and added Entra assignment, the migrations, and pipelines. Revision 3 moved invites, grants, and revokes into `/admin/` on a separate admin app. Revision 4 added cost by game, a storage account per game, and direct assignment, because the tenant has no P1. Revision 5 shipped each game alone, with its own artifacts, pins, and Function app, taken from c2 without its iframes.

### Revision 6: Entra changes run as you

- Deleted first: `id-g4k-graph` with its `User.Invite.All` application permission, the scoped Cloud Application Administrator assignments, the bootstrap spike and its fallbacks (P1, app-only `AppRoleAssignment.ReadWrite.All`, the role tenant-wide), the Graph call in cold-start seeding, and the portal health aggregation.
- A second registration, games4kids-admin, and OBO make every Entra change run as you, from `/admin/` only, with `id-g4k-obo` as a secretless credential.
- `id-g4k-infra` holds Application Administrator scoped to the games4kids registration.
- Emails moved out of `members` into `emails`, so no game app can read one, by RBAC or by type.

## Tradeoffs accepted

Each item names the cost, then what it buys.

- A page load between games, for zero coupling between game runtimes.
- One Function app and plan per game, for a deploy, crash, or bad dependency in one game reaching no other.
- A cold start per game app, for scale to zero with no idle bill.
- A `@g4k/host` fix that reaches each game only on its next release or a dispatch, for releases that never rebuild other games.
- Two shell majors live until the last game moves, for breaking changes that never force every game at once.
- One site deploy for every release, so a bad assembly could break every page, for one origin. The checks and the stored previous manifest bound that.
- A telemetry cap that can blind a day, alerted and marked, for a bounded bill.
- Entra changes only while you are signed in to `/admin/`, for no standing Entra right anywhere in the portal. A lapse mid-invite leaves drift that one more send fixes.
- During your session, a compromised admin app can act as you within the three scopes, including app role grants on any API, for nothing to steal outside a session.
- A pipeline identity that can change any setting of the games4kids registration, for redirect URIs without the Mac.
- Two lists of who may enter, for Entra refusing anyone you have not invited.
- An approval click per infra or admin-api deploy, for deploys without the Mac.
- Player history waiting in the old apps, for no change to the old resource groups.

## Alternatives considered

- **One game host and one deploy of everything (revision 4).** One identity reached every game's data, a hang in one game slowed all, and every deploy shipped every game.
- **Runtime composition, such as module federation.** Games would share one document, with its global CSS, pointer handlers, viewport meta, and dependency versions. letterjoin has no bundler to federate.
- **Iframes (c2).** Silent token calls inside an iframe fail when third-party cookies are blocked (verified, [third-party cookies](https://learn.microsoft.com/en-us/entra/identity-platform/reference-third-party-cookies-spas)).
- **A Static Web App per game, on its own origin.** Each origin has its own MSAL cache, and Safari blocks the third-party cookies that silent sign-in across origins needs (verified, same page), so each game's first visit per tab would bounce through Entra (inferred). Free also allows 10 apps per subscription (verified, [quotas](https://learn.microsoft.com/en-us/azure/static-web-apps/quotas)).
- **A standing admin identity with Graph rights (revision 5).** It needed an application permission and a scoped role whose app-only use Learn does not document, so bootstrap had to probe it, with only worse fallbacks.
- **Azure Front Door routing paths to per-game origins.** The Standard base fee is 35 USD a month (verified list price, [pricing](https://azure.microsoft.com/en-us/pricing/details/frontdoor/)), more than ten times the portal's guessed bill.
- **The shell as an npm package per game.** letterjoin would need a bundler, and a shell fix would need every game rebuilt.

## Open questions and risks

- Would you use `/admin/` from a second account holding only the roles the three calls list, such as Guest Inviter and an app-assignment role? Your session would then reach less than your Global Administrator account does.
- A custom domain fixed at bootstrap would let the Mac write the redirect URIs once, and the pipeline would hold no Entra right. Do you want one?
- Should another adult ever run Entra steps? Today only your account has the Graph consent, and adding one is a Mac step.
- Are cold starts acceptable on the iPad? An always-ready instance removes them for a baseline charge (guess, a few USD a month per app).
- Can the workbook query Cost Management on this Pay-As-You-Go subscription? Untested.
- Is 0.2 GB a day right? It is a guess until a week of real use.
- The migrations run on your Mac because a pipeline would need read roles on the old storage accounts. Do you accept that?
- drawpad keeps a fallback object-id lookup needing `User.Read.All`. Is it ever needed?
- Would a parent join as a guest or wait for External ID?

## Build plan

Each phase starts only when the previous phase's named check is green.

1. **Scaffold, `@g4k/host`, identity, and telemetry.** Done when the unit suites and fixture conformance pass, including `not_claimed` and the fixture's id on every telemetry record.
2. **Shell, portal pages, portal app, and admin app.** Done when `admin.test` passes, including a `reauth_required` mid-invite that converges after re-sign-in, and Playwright on the dev stack covers an invite with one game, the claim, home showing only that game, and a revoke.
3. **Release tooling.** Done when `release.test` passes and a dev assembly after a fixture-only change leaves every other game's files hash-identical.
4. **drawpad port.** Done when its Vitest suite, conformance, and a Playwright smoke reaching `time_up` pass.
5. **letterjoin port.** Done when its `node --test` suite, conformance, and Playwright e2e at `/g/letterjoin/` pass.
6. **Bootstrap.** Done when a second run changes nothing, the deployed admin app lists assignments as you through OBO, and a pull request runs the shared and per-game what-if.
7. **Pipelines and the workbook.** Done when a push to `games/letterjoin/web` releases only letterjoin and leaves drawpad's files hash-identical, a fixture game ships with no Mac step, a fixture app that fails health rolls back alone, the infra job rewrites the redirect URIs with its scoped role, and the workbook shows both games. Cost tiles are checked 72 hours later.
8. **Onboarding and content.** Done when a family member invited from `/admin/` sees only their granted games, and a second content apply writes nothing.
9. **Player-data migration, not applied.** Done when `migrate.test` passes and a dry run reports counts and unmapped keys. Applying waits for your word.

## Next implementation step

Write `packages/host` identity, `createGameApp`, and telemetry against their tests, with the node adapter and the fake IdP, so the admission matrix, `not_claimed`, and telemetry stamping are green before any game is copied in. Then write `release.ts`'s pure `compatible` and `assembleRelease` against `release.test`.
