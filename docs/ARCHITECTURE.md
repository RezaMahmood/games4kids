# games4kids portal architecture

This is the design for the games4kids portal, revised twice after owner feedback (see [Revision 3](#revision-3-portal-onboarding-and-the-mac)). Nothing is built or deployed yet. The type sketch in [`docs/sketch/`](sketch/) is the contract this prose describes, and `tsc --noEmit --strict -p docs/sketch` checks it, including the negatives in [`isolation.check.ts`](sketch/isolation.check.ts).

## Problem

Two finished games, drawpad and letterjoin, need one front door, one sign-in, and one admin, with more games later. Below the sign-in they disagree on almost everything. drawpad is Preact with a Vite bundle, keyed by Entra `oid`, with `route({ requires })` and `{ error: code }`. letterjoin is vanilla ES modules that own two HTML pages, keyed by email, with `{ level }` and `{ error: message }`. What they share is the portal's job: MSAL against one tenant, a Functions API that validates its own JWTs behind CORS, storage through a managed identity, config and CSP written at deploy, and OIDC deploys.

The old repos, deployments, Entra registrations, and resource groups stay as they are. The portal gets its own registration "games4kids", its own resource group `rg-games4kids` in West Europe, and its own Static Web App, two Function apps, and storage. Players are invite only, with one sign-in per child for every game. You invite each child and choose their games in the admin portal. Every deploy goes through a pipeline, and the repo keeps one list of games.

## Where each action runs

People and access change only in the admin portal at `/admin/`. Azure resources and code change only through GitHub Actions. Your Mac runs bootstrap and one-off data moves.

| | Mac (bootstrap only) | Admin portal, `/admin/` | Pipelines |
| --- | --- | --- | --- |
| People and access | Nothing | Invite with games and roles, change access, revoke, view and fix drift | Nothing |
| Entra | The games4kids registration and scope, the `games4kids-players` group and its assignment, admin consent for Graph permissions | Guests and group membership, through invites and revokes | SWA redirect URIs |
| Azure | `rg-games4kids`, the user-assigned identities and their federated credentials, the infra identity's roles, your migration data roles | Nothing | Everything in Bicep |
| GitHub | Environments, reviewers, and variables (ids and `BOOTSTRAP_ADMINS`, no secrets), through `gh` | Nothing | Nothing |
| Code | Nothing | Nothing | Both APIs and the site |
| Data | Content migration at cutover, player-data migration only when you say so | Nothing | Nothing |

The Mac never creates a user identity, sends an invite, sets a grant, or deploys. `tools/bootstrap.mjs` applies only the difference from current state, so a second run changes nothing. The migrations run there because a pipeline would need read roles on the old storage accounts (an open question).

## Usage (caller's view)

A game author reads this and nothing else:

```
games/<id>/manifest.ts     export default defineGame({...})              data only
games/<id>/web/            your pages, served at /g/<id>/
games/<id>/api/index.ts    export const createGameApi = defineGameApi(manifest, (platform) => ({ routes }))
games/<id>/infra.bicep     optional: Azure resources only this game uses
Import only @g4k/sdk and '/shell/v1.js'. Run npm run dev. Nothing else in the repo lists your game.
```

letterjoin's header becomes `<portal-bar title="Letter Tracing" back="/">`, with its practice pill and score chip in the `center` slot.

```js
import { enter } from '/shell/v1.js';
const { api, me } = await enter({ game: 'letterjoin' });
const groups = await api.get('activities');
// admin.js
const admin = await enter({ game: 'letterjoin', requires: 'admin' });
```

drawpad's `main.tsx` replaces `boot()` with the same call.

```tsx
const session = await enter<RoleOf<typeof manifest>>({ game: 'drawpad' });
render(<App session={session} />, document.getElementById('app')!);
```

On the API side, drawpad's `route({ requires })` and letterjoin's `level` become `Route` objects with `access`, and both user keys become `caller.userId` ([drawpad](sketch/examples/drawpad/api.ts), [letterjoin](sketch/examples/letterjoin/api.ts)). `platform.tables.pictures` in letterjoin, `access: 'superuser'`, `services: ['storage']`, and a non-empty `exports` are compile errors.

## Shape

### Repo layout

```
games4kids/
	package.json                npm workspaces. gen runs on predev, prebuild, pretest
	tsconfig.json               solution file. References the generated tsconfig.games.json
	eslint.config.js            no @azure/*, jose, or process.env in games/*/api. Graph only in admin/src/graph.ts
	packages/sdk/               @g4k/sdk: defineGame, defineGameApi, HttpError, Platform, Session
	shell/                      builds dist/site/shell/v1.js (MSAL vendored) and theme.css. <portal-bar>
	portal/web/                 / (home), /welcome/, /admin/ (invite form, access grid, drift), redirect.html
	host/src/                   index.ts, host.ts, identity.ts, storage.ts, portal-routes.ts, adapters/
	host/generated/games.ts     gitignored, from tools/gen.mjs
	admin/src/                  admin Function app: admin.ts, graph.ts, adapters/. Never imports games/*
	games/drawpad/              manifest.ts, web/ (Vite + Preact), api/, infra.bicep (Foundry, Event Grid)
	games/letterjoin/           manifest.ts, web/ (static), api/ (JS, checkJs), infra.bicep (Vision F0)
	tools/                      gen, build, dev, site-config, deploy, deploy-guard, changes, infra, bootstrap,
	                            migrate/content, migrate/player-data (all .mjs)
	infra/main.bicep            reads infra/generated/storage.json and games.bicep (gitignored)
	dev/fake-idp.mjs            from letterjoin, unchanged
	test/                       conformance.ts, *.test.ts suites, e2e/ (Playwright)
	.github/workflows/          deploy.yml, then the reusable infra.yml, api.yml, admin-api.yml, web.yml
```

### Request flow

1. A child opens `/`, which calls `enter({ game: null })` from `/shell/v1.js`. With no cached account, the shell calls `loginRedirect` in the top window, and Entra signs in only members of `games4kids-players`.
2. The shell gets a token for `api://<clientId>/access_as_user` and calls `GET /api/portal/me`.
3. The host verifies the token, and the pure `decide` turns the stored rows into an `Admission`. An invited child's first sign-in claims, anyone else is not invited, and a member with no profile goes to `/welcome/`.
4. Home renders cards from `catalog.json` for the games in `me.games`, which holds granted games only.
5. On Draw Pad, `enter({ game: 'drawpad' })` gets a token silently from the shared sessionStorage cache and returns `{ api, me, signOut }` with `me.role` set to `player`.
6. `api.post('drawings', ...)` reaches `host.handle`, which runs the fixed order in [`host.ts`](sketch/host.ts). It verifies, admits, checks `effectiveRole` against `route.access`, parses the body, calls `run` with a `Caller`, maps errors to `{ error, message, problems? }`, and adds CORS for the site origin only.

### Games are pages, not mounts or frames

The site is one Static Web App. The portal owns `/`, `/welcome/`, and `/admin/`. Each game is its own set of documents under `/g/<id>/`, built as `vite` or `static`. Every page imports `/shell/v1.js`, which holds MSAL and `<portal-bar>`. Pages share an origin, so moving between games costs one cached page load and a silent token call. Game admin screens stay in each game, and `/admin/` links to each `adminPath`. One game's pointer handlers, CSS, or viewport meta can never reach another game.

### One host runs every game's API

The game host is one Functions app. `createHost` mounts `/api/portal/*` and each game's routes at `/api/g/<id>/*`. A game receives a `Platform<typeof manifest>` with tables, blobs, and queues typed from the names it declared, parsed settings, tokens for declared services only, a read-only `roster`, `now`, and `newId`. It never receives a credential, a client, the environment, or `@azure/functions`, and `Reply` has no headers, so a game cannot set CORS. Only the adapters import a transport, so one host runs in Functions, the dev stack, and tests.

Each `games/<id>/api` and Vite `web` is a composite TS project that references only `@g4k/sdk`, so importing another game's or the host's files fails `tsc -b` with TS6307, which c1 measured. ESLint closes the rest.

### Startup containment and health

`mountGames` runs `platformFor` and `createGameApi` per game inside its own try/catch, so a game that throws, or lacks a required setting, answers 503 `game_unavailable` while the others mount. `GET /api/portal/health` reports the version and each game's state. A module that throws while it loads is not contained, so CI's conformance suite catches it.

### Identity and roles

There is one single-tenant Entra registration, "games4kids", with SPA redirect URIs `https://<site>/` and `https://<site>/redirect.html` and the scope `access_as_user`. The admin app mints a `PortalUserId`, a branded UUID, at invite. It is the only user key a game sees or stores.

Entry needs two things ([`identity.ts`](sketch/identity.ts)). Entra "assignment required" is on, and the app's one assignment is the security group `games4kids-players`, so Entra issues no token to an account outside it. Then the host admits only an active `portalMembers` row. The admin app writes both lists. Group assignment needs Entra ID P1, which this tenant lacks (see the open questions).

Each portal table has one writer. Table-scoped roles on the admin app's identity enforce its half, and `HostStore`, which has no member writer, enforces the host's.

| Table | Holds | Writer |
| --- | --- | --- |
| `portalMembers` | email, Entra object id, state, portal role, grants | admin app |
| `portalEmails` | email to `PortalUserId` | admin app |
| `portalIdentities` | issuer and subject to `PortalUserId` | host, at first sign-in |
| `portalProfiles`, `portalNames` | display name and time zone | host, on `/welcome/` |

Each manifest declares its role ladder, lowest first, such as drawpad's `['player', 'admin']`. `effectiveRole`, the only function that computes a game role, gives a portal admin the top rung of every game. Anyone else gets their grant, or `'none'` without one, which hides the game, so a new game is visible to no child until you grant it. The manifest's `defaultRole` only pre-selects the role picker. A game sees `Caller = { userId, displayName, timeZone, role }` and nothing about tokens or email.

### The admin app holds Graph, and no game code

`func-g4k-admin` is a second, small Function app that serves only `/api/admin/*` to the `/admin/` pages ([`admin.ts`](sketch/admin.ts)). It verifies the same token audience as the host and requires an active portal admin. It reads games from the generated `catalog.json` and never imports `games/*`, so no game code runs under its identity, and the host's identity holds no Graph permission.

Its user-assigned identity, `id-g4k-graph`, holds the portal's only Graph permissions, `User.Invite.All` and `GroupMember.ReadWrite.All`. Do not grant `AppRoleAssignment.ReadWrite.All`, which assigning each account directly would need. It can assign any app role, Graph's permissions included, to any principal, so the admin app could grant itself control of the tenant.

`GroupMember.ReadWrite.All` can change the members of any group that is not role-assignable. Today that adds two Microsoft 365 groups, "All Company" and "rezamahmood" (measured), whose members read the group's mail and files. With six accounts and code only you deploy, that is acceptable. Give no group an Azure role unless it is role-assignable. The narrower later option is Groups Administrator scoped to an administrative unit holding only `games4kids-players`, untested and possibly needing P1 (guess).

### Onboarding a child

1. On `/admin/` you enter the child's email, a portal role, and, per catalog game, a checkbox and a role picker preset to its `defaultRole`.
2. The admin app reads or creates the `portalEmails` row, which fixes the `PortalUserId`, so a re-invited child keeps their history.
3. It writes the active member row with the role and grants.
4. Unless the child has signed in, it sends Microsoft's B2B invitation, redirecting to the site, and records the returned object id.
5. It adds the account to `games4kids-players`, retrying after 2, 4, 8, and 16 seconds while Entra replicates a new guest, as drawpad's commit 83bc093 does.
6. The child accepts Microsoft's email and signs in. With no identity row, the host finds the member through `portalEmails` by the token's email, checks that its object id equals the token's `oid`, and inserts the identity row. A rerun finds the row and stops.
7. `/welcome/` asks for a display name and a time zone, and home shows only the granted games.

Steps 2 to 5 are `invite`, and each is safe to repeat. A crash after step 2 leaves an email row nothing reads. After step 3 or 4 it leaves an active member with no recorded account, which drift shows as `no-account`. After step 5 it leaves one outside the group, shown as `not-in-group`. Sending the form again converges.

To revoke, the admin app marks the member revoked, then removes the account from the group. An earlier token stays valid for its 60 to 90 minute lifetime, but the host reads the member row on every request, so the next call gets 403 `not_invited`. A crash between the steps leaves `in-group-without-member`.

The access grid shows members by games, and a change touches only grants and roles. Every `GET /api/admin/members` reads the group from Graph and runs `computeDrift` against the member rows. The rows are the intent, so **Fix drift** changes only Entra, and a second click finds nothing to do.

On each cold start the admin app seeds an admin row for each `BOOTSTRAP_ADMINS` entry without one, and adds that account to the group while the row is active.

### Doors left for other sign-ins and parents

Google and Facebook sign-in are not built. An Entra External ID tenant, which can federate with both, would join as a second `TrustedIssuer` whose identity rows map to the child's existing `PortalUserId`. Its tokens prove no group membership and carry no workforce `oid`, so its claim rule waits for that door.

You are the parent for now, as portal admin. A later parent account is a relation, not a role, and `identity.ts` reserves `portalGuardianships` and `portalPolicies` for it. Games would read a policy, such as a daily play limit, as a new `Caller` field.

### Data isolation

All data lives in one storage account. `storage.ts` is the only module with a storage client and names everything `<id><Declared>` or `<id>-<declared>`, with `portal` reserved. `platform.tables` has only the declared keys, and `AzureService` has no storage member, so a game cannot spell another game's data. This is a code boundary, not an RBAC boundary, and `platformFor` is the one place a later per-game account would change.

The door for cross-game features, such as a joint scoreboard, is the manifest's reserved `exports`, which a portal hub would call instead of reading a game's tables. Until a hub exists, the type admits only `{}`.

### Registry and build checks

The folder is the registry. `tools/gen.mjs` scans `games/*/manifest.ts` and writes `host/generated/games.ts`, `tsconfig.games.json`, `catalog.json`, the SWA routes, and `infra/generated/`, all gitignored, before every dev, build, test, and infra run. The build fails, listing every problem, on a folder that differs from its id, a duplicate, malformed, or reserved id (`portal`, `shell`, `admin`, `welcome`, `api`, `g`), a missing required file, a storage name Azure rejects, a `defaultRole` off the ladder, a rung named `none`, or non-empty `exports`.

### Adding a game

1. Create `games/<id>/manifest.ts` with `defineGame`.
2. Add `web/index.html` that imports `/shell/v1.js`.
3. Add `api/index.ts` that exports `createGameApi`.
4. Add `infra.bicep` if the game needs its own Azure resources.
5. Run `npm test`. Gen runs first, and conformance covers the new game.
6. Push to `main`. `deploy.yml` runs infra after your approval, then the APIs, then web, and checks health.
7. In `/admin/`, grant the game to each child who should see it.

This touches one new folder and edits no existing file. It needs no Entra change, no workflow change, and no Mac step.

### Hosting and cost

Everything sits in West Europe, except the Foundry account in Sweden Central.

- Static Web App, Free.
- Two Flex Consumption Function apps on Node 22 with maximum 1 instance. The game host has 2048 MB and a system-assigned identity, and one instance keeps drawpad's Foundry worker serial. `func-g4k-admin` has 512 MB and `id-g4k-graph`.
- One storage account, shared keys off, no public blob access, holding all data and both deployment containers.
- Log Analytics with a 0.1 GB daily cap, Application Insights, and each game's `infra.bicep` resources: drawpad's Foundry and Event Grid, letterjoin's Vision F0.

The monthly cost is a guess of 1 to 3 USD before Foundry calls, at 0.015 to 0.048 USD per redraw (drawpad measured), and before Entra ID P1.

### Pipelines and deploy identities

`deploy.yml` runs lint, `tsc -b`, every test, and letterjoin's deploy guard on pull requests and pushes to `main`. `tools/changes.mjs` maps changed paths and gen output to layers, and `deploy.yml` calls the reusable `infra.yml`, `api.yml`, `admin-api.yml`, and `web.yml` in order, skipping unchanged layers.

1. Infra runs Bicep `what-if` on a pull request and deploys on `main`, so a new game's tables exist before its api ships. Then it sets the SWA redirect URIs, writing only a difference.
2. Api and admin-api run side by side. Each zip-deploys its app, and `tools/deploy.mjs verify` requires health at this commit: every game `ok` on the host, the admin seed done on the admin app.
3. Web builds every page, writes `config.json` with both API origins and CSP, uploads the site, and verifies `/version.json`.

Each layer has its own user-assigned identity, federated to its own GitHub environment, which only `main` may deploy to. GitHub holds no secret, only the client, tenant, and subscription ids, which `azure/login` uses with the job's OIDC token.

- `id-g4k-infra`, environments `infra` and `infra-plan`. Contributor on `rg-games4kids`, plus Role Based Access Control Administrator with a condition that allows only storage data roles, Cognitive Services User, and Monitoring Metrics Publisher for service principals, Website Contributor for `id-g4k-api` and `id-g4k-admin-api`, and Contributor for `id-g4k-web`. It owns the games4kids registration and holds Graph `Application.ReadWrite.OwnedBy`.
- `id-g4k-api` and `id-g4k-admin-api`, environments `api` and `admin-api`. Website Contributor on their app and a blob role on its deployment container.
- `id-g4k-web`, environment `web`. Contributor on the Static Web App, whose deployment token it reads at run time.

`id-g4k-infra` and `id-g4k-admin-api` can both run code as `id-g4k-graph`, so `infra` and `admin-api` require your approval.

Setting redirect URIs in the pipeline trades a second bootstrap run for `Application.ReadWrite.OwnedBy`. It changes only apps the identity owns, but on games4kids it can change anything, and a redirect URI it added could receive a child's token (inferred).

`tools/bootstrap.mjs` does the Mac column, since it needs tenant admin rights no pipeline should hold. It makes `id-g4k-infra` a registration owner and creates `id-g4k-graph`, which Bicep attaches as existing, so consent survives a rebuilt app.

### Bringing the two games in

Each game's web and api folders are copied, minus what the portal now owns, such as drawpad's auth and profile code and letterjoin's `gate.js`, `auth.js`, and `vendor/msal`.

Content migrates at cutover, and player data gets a tested tool that waits for your word. Both only read the old accounts, and both old apps stay live. Every write is insert-if-absent at a key derived from the source, so reruns converge and never overwrite a portal row ([`migrate.ts`](sketch/migrate.ts)).

- `tools/migrate/content.mjs` copies drawpad's pictures and settings tables and pictures container, including accepted AI-generated files, and letterjoin's activities table. drawpad's jobs expire in 7 days and stay.
- `tools/migrate/player-data.mjs` re-keys each game's per-child tables and images, listed in `PLAYER_DATA`. It maps from member rows, so a child is mapped once invited. drawpad's `oid` is the member's Entra object id, and letterjoin's key is `sha256(email)`. The default is a dry-run report with unmapped keys. Writing needs `--apply --confirm-player-data`, and the type admits apply only with the confirmation that flag mints.

### Shared now, and deliberately not

The portal owns sign-in, profiles, members, invites, grants, `<portal-bar>`, the API client, protected-image object URLs, `config.json` and CSP, the error shape, theme tokens, and the dev stack. Play-time limits stay in each game, since drawpad's hard daily limit (403 `time_up`) and letterjoin's soft practice goal are different products.

### Local dev and tests

`npm run dev` starts letterjoin's fake IdP as a trusted issuer, both apps on the node adapter with memory storage or Azurite, a fake Graph, and a site server with SWA headers and Vite. The real `verifyToken` runs.

The root `npm test` runs these suites:

- `identity.test` covers `decide`, including revoked members and a wrong `oid`, `effectiveRole` without a grant, and two racing claims. `host.test` drives the admission matrix through `host.handle`, and `gen.test` covers each `Problem` kind.
- `boundaries.test` proves that game code importing host files, or admin code importing `games/*`, fails `tsc -b`.
- `conformance.test` runs `runGameConformance` per game: 401 without a token, every access floor, `not_entitled` without a grant, declared storage only, and site-only CORS.
- `admin.test` uses the fake Graph for `computeDrift`, a one-click drift fix, the seed, and invites and revokes that crash at each step.
- `migrate.test` and `changes.test` cover the migration modes and the path-to-layer map, and each game keeps its own suite.

## Synthesis decision

Three designs went to a bakeoff. c1 mounted games in shadow roots of one SPA, c2 used iframes and a Function app per game, and c3 co-hosted pages on one host. A cross-judge scored c3 28, c1 25, and c2 18 out of 30. c3 is the base, because only it brings letterjoin in without a rewrite and still gives every game one host, one sign-in, and typed storage.

Grafted in:

- From c1, the identity model: `PortalUserId`, members as the gate, idempotent claims, per-game role ladders, `effectiveRole`, and `TrustedIssuer`. It replaces c3's `oid` key, which tied game data to one identity provider.
- From c1, TS project references, the ESLint bans, and per-game startup containment.
- From c2, per-game conformance and the registry build checks.
- Generated files are gitignored, in place of c3's committed files with a CI diff check.

Declined were per-game storage accounts (c1, c2), since in one process RBAC only stops accidents the typed handles already stop, and Bicep in CI with Owner (c3). c2's iframes stay the recorded next step for hostile third-party games, and c1's shadow-root mount would force a letterjoin port.

### Revision 2: owner feedback

Revision 2 moved to West Europe, added Entra assignment with invites from your laptop, made one sign-in per child explicit, added the migrations, and split pipelines by layer.

### Revision 3: portal onboarding and the Mac

Each change is folded in above as a day-one requirement.

- Invites, grants, revokes, and drift moved from a laptop script to `/admin/`, reversing revision 2. Graph sits on a separate admin app with no game code.
- Entra assignment is one group, because membership needs a far narrower Graph permission than per-account assignment.
- No grant means no access. Earlier revisions let `defaultRole` grant access when read, so a new game appeared for every child.
- Drift is computed live, reversing revision 2's report uploaded from the laptop.
- Each portal table has one writer, and the member row replaces the invites table.
- Bootstrap runs once. Infra sets redirect URIs, and `BOOTSTRAP_ADMINS` replaces `BOOTSTRAP_ADMIN_EMAILS` to carry your object id.
- Deleted: the laptop tools, the Azure CLI authorized client, the `Invite` type, and `drift` on `Admission`.

## Tradeoffs accepted

- We accept a page load between games for zero coupling between game runtimes.
- We accept isolation by types, project references, and lint, not RBAC, for one game host and one api deploy.
- We accept one Node process and one instance for every game, so a hang in one slows all, for drawpad's worker staying serial.
- We accept that every deploy ships every game, with health blocking one that leaves a game unavailable.
- We accept a second Function app and a Graph permission reaching every group that is not role-assignable, for portal onboarding with no Graph where game code runs.
- We accept two lists of who may enter, for Entra refusing anyone you have not invited.
- We accept an approval click per infra or admin-api deploy, and an infra identity that can change anything in `rg-games4kids` and on the registration, for deploys without the Mac.
- We accept player history waiting in the old apps for no change to the old resource groups, and gitignored generated files that every npm entry point regenerates.

## Alternatives considered

- **Entra app roles for game roles.** Each rung of each game would need an app role, and each new game an Entra change.
- **Graph on the game host.** Every game's code would run under an identity that can invite guests and change groups.
- **Assigning each account directly.** It needs the permission the admin app must not hold.
- **Invites from the Mac.** Access would change in two places, and drift would be as fresh as the last script run.
- **One deploy identity for all layers.** A bug in the web job could then change infra.
- **The shell as an npm package bundled into each game.** letterjoin would need a bundler, and the browser would hold one MSAL per game.

## Open questions and risks

- Group assignment needs Entra ID P1 ([Microsoft Learn](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/assign-user-or-group-access-portal)). On 2026-10-19 the tenant's enabled plans were Exchange Online, Windows Store, and To-Do (measured, read-only Graph). Will you buy one licence, a guess of about 6 USD a month? Assigning accounts directly needs the permission refused above, and turning assignment off reverses your directive.
- The migrations run on your Mac because a pipeline would need read roles on the old storage accounts. Do you accept that, or would you rather grant a pipeline those reads?
- Do you own a domain that would let bootstrap set redirect URIs once, so infra needs no Graph permission?
- The invite assumes Graph returns the object id. drawpad keeps a fallback lookup needing `User.Read.All`. Is it ever needed? Untested.
- drawpad's README says the Flex instance cap applies per function group. Recheck it here?
- A game module that throws while it loads takes down every game, and only CI catches it. Is that enough?
- Is `exports` the right door for a joint scoreboard, or should games write events to a portal table?
- Could a Reader-only identity run the pull request what-if? Untested.
- letterjoin deploys its Flex app with Website Contributor alone. Do the api deploy identities need the blob role?
- Could an app outside this repo share the sign-in through `GET /api/portal/me`? Nothing here designs that.
- Would a parent join as a guest in your tenant, or wait for External ID?

## Build plan

Each phase starts only when the previous phase's named check is green.

1. **Scaffold, host, and identity.** Done when `identity.test`, `host.test`, `gen.test`, `boundaries.test`, and fixture conformance pass, and a throwing fixture shows `unavailable`.
2. **Shell, portal pages, and admin app.** Done when `admin.test` passes and Playwright on the dev stack covers an invite with one game, the claim, home showing only that game, a revoke, and the not-invited screen.
3. **drawpad port.** Done when its Vitest suite, conformance, and a Playwright smoke reaching `time_up` pass.
4. **letterjoin port.** Done when its `node --test` suite, conformance, and Playwright e2e at `/g/letterjoin/` pass.
5. **Bootstrap.** Done when a second `tools/bootstrap.mjs` run changes nothing and a pull request runs the infra what-if.
6. **Pipelines.** Done when `changes.test` passes, a web-only push skips infra and both APIs, and a fixture-game push runs every layer in order with each verify passing.
7. **Onboarding and content.** Done when a family member invited from `/admin/` sees only their granted games, drift is empty, a second content apply writes nothing, and the old pictures and activities show on the iPad.
8. **Player-data migration, not applied.** Done when `migrate.test` passes and a dry-run reports counts and unmapped keys. Applying waits for your word.

## Next implementation step

Write `host/src/identity.ts` and `host/src/host.ts` against `test/identity.test.ts` and `test/host.test.ts`, with the node adapter and the fake IdP, so the admission matrix is green before any game is copied in.
