# games4kids portal architecture

This is the design for the games4kids portal, revised four times after owner feedback (see [Revision 5](#revision-5-games-ship-independently)). Nothing is built or deployed yet. The type sketch in [`docs/sketch/`](sketch/) is the contract this prose describes, and `tsc --noEmit --strict -p docs/sketch` checks it, including the negatives in [`isolation.check.ts`](sketch/isolation.check.ts).

## Recommendation

You asked whether every deploy must ship every game, and whether micro frontends are the answer. Micro frontends at the page level fit, and the design already had them, since each game is its own set of documents under `/g/<id>/` on one origin. Composing games at runtime in one document does not fit. Module federation, iframes, and a site per game all lose, for the reasons in [Alternatives](#alternatives-considered).

Independent deploy is the real change, and it takes two moves. First, each game's pipeline publishes its pages and its API as immutable artifacts and moves only that game's pins. A small `web-release` job then deploys the one Static Web App from the pinned artifacts, so every other game's files ship byte-identical. Second, each game gets its own Function app, `func-g4k-<id>`, with its own identity, so a game's deploy, crash, or bug reaches no other game's compute or data. A versioned shell and SDK are the only contract between a game and the platform.

The cost is one more identity (six instead of five), a cold start per game app, and a platform fix that reaches each game only when that game next ships.

## Problem

Two finished games, drawpad and letterjoin, need one front door, one sign-in, and one admin, with more games later. drawpad is Preact with Vite, keyed by Entra `oid`. letterjoin is vanilla ES modules, keyed by email. Both use MSAL against one tenant, a Functions API that validates its own JWTs, storage through a managed identity, and OIDC deploys, which is the portal's job now. You also need to see which game costs what, and to change one game without redeploying the others.

The old repos, deployments, and registrations stay as they are. The portal gets its own registration "games4kids" and resource group `rg-games4kids` in West Europe. Players are invite only, with one sign-in per child for every game. Every deploy goes through a pipeline, and the repo keeps one list of games.

## Where each action runs

People and access change only in `/admin/`. Azure resources, code, and the registration's settings change only through GitHub Actions. Your Mac creates the deploy and Graph identities, grants their rights, and runs one-off data moves, and nothing on it is per game.

| | Mac (bootstrap only) | Admin portal, `/admin/` | Pipelines |
| --- | --- | --- | --- |
| People and access | Nothing | Invite with games and roles, change access, revoke, view and fix drift | Nothing |
| Entra | The games4kids registration and its settings. The six user-assigned identities, their federated credentials, directory roles, Graph permission, and consent. The spike | Guests and their assignment to games4kids | Redirect URIs on the games4kids registration |
| Azure | `rg-games4kids`, the identities' Azure roles, your migration data roles | Nothing | Shared Bicep, one Bicep deployment per game, each app's system-assigned identity and its roles, tags, the workbook |
| GitHub | Environments, reviewers, and variables (ids and `BOOTSTRAP_ADMINS`, no secrets), through `gh` | Nothing | Nothing |
| Code | Nothing | Nothing | Each game's app and pages, the portal app and pages, the admin app, the shell, and the site assembly |
| Data | Content migration at cutover, player-data migration only when you say so | Nothing | Nothing |

The Mac never creates a user, sends an invite, or deploys. No pipeline creates a registration or a user-assigned identity, or grants a directory role or Graph permission. A game app's identity is system-assigned, so Bicep creates and deletes it with the app.

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

```tsx
const session = await enter<RoleOf<typeof manifest>>({ game: 'drawpad' });
render(<App session={session} />, document.getElementById('app')!);
```

On the API side, both games' route guards become `Route` objects with `access`, and both user keys become `caller.userId` ([drawpad](sketch/examples/drawpad/api.ts), [letterjoin](sketch/examples/letterjoin/api.ts)). A game writes no auth or telemetry code.

## Shape

### Repo layout

```
games4kids/
	package.json                npm workspaces. gen runs on predev, prebuild, pretest
	tsconfig.json               solution file. References the generated tsconfig.games.json
	eslint.config.js            no @azure/*, @opentelemetry/*, jose, or process.env in games/*/api
	packages/sdk/               @g4k/sdk, the contract: defineGame, defineGameApi, HttpError, Platform, Session
	packages/host/              @g4k/host: createGameApp, createPortalApp, identity, storage, telemetry, adapters/
	shell/                      builds the shell artifact for one major: /shell/v1/index.js and theme.css
	portal/web/                 / (home), /welcome/, /admin/ (invite form, access grid, drift), redirect.html
	portal/api/                 func-g4k-portal entry: createPortalApp
	admin/src/                  func-g4k-admin: admin.ts, graph.ts, adapters/. Never imports games/*
	games/drawpad/              manifest.ts, package.json, web/ (Vite + Preact), api/, infra.bicep (Foundry, Event Grid)
	games/letterjoin/           manifest.ts, package.json, web/ (static), api/ (JS, checkJs), infra.bicep (Vision F0)
	tools/                      gen, dev, changes, release, infra, bootstrap, migrate/content, migrate/player-data (.mjs)
	infra/                      main.bicep (shared), game.bicep (one deployment per game), workbook.json
	dev/                        fake-idp.mjs from letterjoin, generated/games.ts (dev and tests only)
	test/                       conformance.ts, *.test.ts suites, e2e/ (Playwright)
	.github/workflows/          deploy.yml, game.yml, shell.yml, portal.yml, admin.yml, infra.yml, web-release.yml, release.yml
```

### Request flow

1. A child opens `/`, which calls `enter({ game: null })` from `/shell/v1/index.js`. With no cached account, the shell calls `loginRedirect`, and Entra signs in only accounts assigned to games4kids.
2. The shell gets a token for `api://<clientId>/access_as_user` and calls `GET /api/portal/me` on `func-g4k-portal`.
3. The portal app verifies the token, and the pure `decide` turns the stored rows into an `Admission`. An invited child's first sign-in claims, and a member with no profile goes to `/welcome/`.
4. Home reads `catalog.json` and draws a card for each game whose `effectiveRole` is not `'none'`.
5. On Draw Pad, `enter({ game: 'drawpad' })` gets a token silently, binds `api` to drawpad's `apiBaseUrl` from the catalog, and starts the play heartbeat.
6. `api.post('drawings', ...)` reaches `func-g4k-drawpad`, which runs the fixed order in [`host.ts`](sketch/host.ts): verify, find the claimed identity, admit, check `effectiveRole` against `route.access`, parse, `run`, map errors to one shape, and add CORS for the site origin.

Every app accepts the same token and reads the member row on every request, so a revoke reaches every game at once.

### Games are pages, released one at a time

The site is one Static Web App on one origin. The portal owns `/`, `/welcome/`, and `/admin/`, and each game is its own set of documents under `/g/<id>/` that imports its shell major by URL. Moving between games costs one cached page load and a silent token call, because every path in a tab shares MSAL's session cache. One game's pointer handlers, CSS, or viewport meta never reach another game.

Each pipeline publishes what it builds to the `releases` container in the portal account ([`release.ts`](sketch/release.ts)). An `ArtifactRef` names one immutable build by kind (`shell`, `site`, `web`, or `app`), commit sha, digest, and the contract it was built against. `publishArtifact` writes with `If-None-Match: *`, so a rerun finds the artifact and fails only if the digests differ. A `Pin` at `pins/<owner>/<kind>.json` holds the owner's `current` and `previous` artifact, so a rollback is one swap, and an app pin also records the app's origin. `pinArtifact` does nothing when the pin already points at the artifact, so a rerun converges.

`web-release` reads every pin into a `ReleaseManifest` (the shells, the portal site and apps, and a `GameRelease` per game with both pins), checks the contract rule, lays out the site, and writes the files no artifact owns: `catalog.json`, `config.json`, `staticwebapp.config.json`, and `release.json`. It deploys, waits for `/release.json` to match, and stores the manifest under `manifests/<run>.json`. A problem fails the run, and the site stays at the last release.

**Two games releasing at once lose nothing.** No pin is shared, because drawpad's pipeline writes only `pins/drawpad/*` and letterjoin's only `pins/letterjoin/*`. Two runs for one owner are serialized by the GitHub concurrency group `release-<owner>` on the job that calls `game.yml` (verified, [reusable workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations)). `web-release` writes no pin and runs in the group `web-release`, where a newer pending run replaces an older pending one (verified, [concurrency](https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/control-the-concurrency-of-workflows-and-jobs)). Nothing is lost, because a run reads the pins when it starts, after every earlier pin write. An ETag-conditional write to one shared manifest would also be safe, but every release would contend for one object, so I removed the shared object instead.

### Contracts and versions

The contract is `@g4k/sdk`'s major and minor. It covers the shell's browser API, the game API types, the wire error shape, and the portal rows a game app reads. Each artifact records the contract it was built against.

`compatible` in `release.ts` holds the rule. An artifact built against `M.m` can ship when `M` is the current major (the newest pinned shell) or the previous one, and, for pages, the pinned `/shell/vM/` is at minor `m` or later. A game's pages and app share a major, because the shell's `ApiClient` parses that app's errors. `pinArtifact` refuses an incompatible artifact, and `assembleRelease` checks again, because a shell rollback can race a game pin.

A minor only adds, such as an optional field, a function, or a route, and replaces `/shell/v1/` in place. Anything else is a major. `/shell/v2/` then ships beside `/shell/v1/`, and the portal app and `@g4k/host` keep both majors' routes and rows until no pin uses the old one. An app refuses a member state it does not know, so an older game app fails closed. A pull request that changes `packages/sdk`, `packages/host`, or `shell/` runs every game's `tsc -b` and conformance against it, and deploys nothing. A change proposed as a minor that fails any game is a major.

### One Function app per game

Each game's API runs in its own Flex Consumption app, `func-g4k-<id>`, built from the game's `api/` and a generated entry that calls `createGameApp` from the `@g4k/host` version in its `package.json`. A game receives a `Platform<typeof manifest>` with tables, blobs, and queues typed from the names it declared, parsed settings, tokens for declared services, a read-only `roster`, `now`, and `newId`. It never receives a credential, a client, or the environment, and `Reply` has no headers, so a game cannot set CORS. Each `games/<id>/api` and Vite `web` is a TS project that references only `@g4k/sdk`, so importing another game's files fails `tsc -b` (c1 measured TS6307), and ESLint closes the rest.

A throw at startup, or a missing setting, stops only that app. Its pipeline then fails the health check and redeploys the pinned package, so nothing needs containing. The portal app's health calls each catalog game's health with a 3-second timeout, for a status strip on `/admin/`.

The portal app, `func-g4k-portal`, serves `me` (which claims a first sign-in), the profile, and health. It knows no game at build time. `me` returns the stored grants, and the shell derives each game's role with `effectiveRole` over the live catalog. The game app's own check is the authoritative one.

### Identity and roles

There is one single-tenant Entra registration, "games4kids", with SPA redirect URIs `https://<site>/` and `https://<site>/redirect.html` and the scope `access_as_user`. A new game adds no redirect URI. The admin app mints a `PortalUserId`, a branded UUID, at invite, and it is the only user key a game sees or stores.

Entry needs two things ([`identity.ts`](sketch/identity.ts)). Entra "assignment required" is on, and each invited account holds its own assignment to the games4kids enterprise app, so Entra issues no token to anyone else. Then every app admits only an active `members` row. The admin app writes both lists. Assigning a group instead would need Entra ID P1, which this tenant lacks (measured).

Each portal table has one writer, and RBAC per app enforces it.

| Table | Holds | Writer | Game apps |
| --- | --- | --- | --- |
| `members` | email, Entra object id, state, portal role, grants | admin app | read |
| `emails` | email to `PortalUserId` | admin app | none |
| `identities` | issuer and subject to `PortalUserId` | portal app, at first sign-in | read |
| `profiles`, `names` | display name and time zone | portal app, on `/welcome/` | `profiles` read |

A game app's code gets a `PortalReader`, which has no writer. If a first sign-in reaches a game app before the portal app has claimed it, the game app answers 403 `not_claimed`. The shell's `onRefusal` then calls `me`, which claims, and retries once.

Each manifest declares its role ladder, lowest first, such as drawpad's `['player', 'admin']`. `effectiveRole` gives a portal admin the top rung of every game and anyone else their grant, or `'none'` without one, so a new game is hidden until you grant it. A game sees `Caller = { userId, displayName, timeZone, role }` and nothing about tokens or email.

### The admin app holds the user rights, and no game code

`func-g4k-admin` serves `/api/admin/*` to the `/admin/` pages ([`admin.ts`](sketch/admin.ts)) and requires an active portal admin. It reads the live `catalog.json`, so a new game appears in the invite form without an admin deploy, and it never imports `games/*`.

Its identity, `id-g4k-graph`, holds two rights from bootstrap. Graph `User.Invite.All` creates guests, and is narrower than the Guest Inviter role ([permissions reference](https://learn.microsoft.com/en-us/entra/identity/role-based-access-control/permissions-reference)). Cloud Application Administrator, scoped to the games4kids service principal only, adds and removes that app's assignments, and reaches no other registration and no data (inferred). Only "some" built-in roles accept a single-resource scope ([assign roles](https://learn.microsoft.com/en-us/entra/identity/role-based-access-control/manage-roles-portal)), and Graph documents the app-only assignment call with `AppRoleAssignment.ReadWrite.All` only ([API page](https://learn.microsoft.com/en-us/graph/api/serviceprincipal-post-approleassignedto?view=graph-rest-1.0)), so bootstrap's spike proves the scoped role first.

### Onboarding a child

1. On `/admin/` you enter the child's email, a portal role, and a role for each game you tick.
2. The admin app reads or creates the `emails` row, which fixes the `PortalUserId`, so a re-invited child keeps their history. It writes the active member row with the grants.
3. Unless the child has signed in, it sends Microsoft's B2B invitation and records the object id.
4. It assigns the account to games4kids, retrying after 2, 4, 8, and 16 seconds while Entra replicates a new guest (assumed from drawpad's group adds, guess).
5. The child signs in. The portal app finds the member through `emails`, checks that its object id equals the token's `oid`, and inserts the identity row.
6. `/welcome/` asks for a display name and a time zone, and home shows only the granted games.

Steps 2 to 4 are `invite`, and each is safe to repeat. A crash leaves drift that `/admin/` shows, and sending the form again converges. To revoke, the admin app marks the member revoked, then removes the assignment, so the next call to any app gets 403 `not_invited` even with a live token. `/admin/` compares Graph's assignments with the member rows on every load, and **Fix drift** changes only Entra.

### Doors left for other sign-ins and parents

Google and Facebook sign-in are not built. An Entra External ID tenant would join as a second `TrustedIssuer` whose identity rows map to the child's existing `PortalUserId`. You are the parent for now, as portal admin, and `identity.ts` reserves `guardianships` and `policies` tables for a later parent account.

### Data isolation

Each game has its own storage account, `g4k<id><suffix>`, and the portal has `g4kportal<suffix>`, with the suffix from Bicep's `uniqueString(resourceGroup().id)`. Tables, containers, and queues keep their declared names, and game ids are 3 to 16 characters so account names fit Azure's 24.

Isolation is now RBAC as well as types. Each game app's identity holds data roles on its own account only, plus Storage Table Data Reader on the `members`, `identities`, and `profiles` tables, which Azure can scope per table (verified, [table RBAC](https://learn.microsoft.com/en-us/azure/storage/tables/authorize-access-azure-active-directory)). So hostile code in drawpad's app cannot read letterjoin's account or write any portal table (inferred from the role scopes). Types and lint still catch the honest mistake first. One gap remains, because reading `members` reveals every child's email.

Cross-game features, such as a joint scoreboard, would go through the manifest's reserved `exports`, which admits only `{}` until a hub exists.

### Cost and usage by game

**Tags.** Bicep tags every resource `app=games4kids` and a `game` value. A game's storage account, Flex plan and app, and `infra.bicep` resources get `game=<id>`. The portal account, the portal app, and the admin app get `game=portal`, matching their telemetry. The Static Web App, Log Analytics, and Application Insights serve everyone and get `game=shared`. Which Flex resource carries the billing meter, plan or app, is unverified, so both carry the tag. Tags reach usage records only while applied ([Cost Management data](https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/understand-cost-mgt-data)), so `tools/infra.mjs` fails on a missing tag. Compute cost is exact by tag, because each game's compute is its own app.

**Telemetry** goes to one Application Insights. Every record carries [`GameTelemetry`](sketch/telemetry.ts) `{ game, route, user }`, where `game` is a `GameId` or `portal`, and `user` is the `PortalUserId`, never an email. Each app binds the envelope before `run` ([Functions OpenTelemetry](https://learn.microsoft.com/en-us/azure/azure-functions/opentelemetry-howto)), so a game cannot misreport itself. The shell stamps page views and sends a `game_session` event each minute a game page is visible. Sampling is off, and ingestion is capped at 0.2 GB a day, about ten times a guessed 10 to 30 MB. At the cap, collection stops until the reset hour ([daily cap](https://learn.microsoft.com/en-us/azure/azure-monitor/logs/daily-cap)), and an alert emails you.

**The workbook**, `infra/workbook.json`, groups every query by `game`, so a new game appears with no edit. It shows players, play minutes, requests, errors, p95 latency, Foundry and Vision calls, and cost by tag, with `portal` and `shared` as their own lines. It reads cost with a Cost Management POST ([data sources](https://learn.microsoft.com/en-us/azure/azure-monitor/visualize/workbooks-data-sources), [Query Usage](https://learn.microsoft.com/en-us/rest/api/cost-management/query/usage)). Each fact is verified, but the combination is untested. The fallback is a daily cost export.

### Registry and build checks

The folder is the registry. `tools/gen.mjs` scans `games/*/manifest.ts` and fails, listing every problem, on a folder that differs from its id, a duplicate, malformed, or reserved id (`portal`, `shared`, `shell`, `admin`, `welcome`, `api`, `g`), a missing required file, a declared storage name Azure rejects, a `defaultRole` off the ladder, a rung named `none`, or non-empty `exports`. It writes per-game outputs only ([`registry.ts`](sketch/registry.ts)), which are the app entry, the catalog entry, and the Bicep parameters, plus a registry for dev and tests. In production, only `web-release` lists every game, from the pins.

### Adding a game

1. Create `games/<id>/manifest.ts` with `defineGame`, and `package.json` with the `@g4k/sdk` and `@g4k/host` ranges.
2. Add `web/index.html` that imports `/shell/v1/index.js`.
3. Add `api/index.ts` that exports `createGameApi`.
4. Add `infra.bicep` if the game needs its own Azure resources, tagging each with the `tags` param.
5. Run `npm test`. Gen runs first, and conformance covers the new game.
6. Push to `main`. `deploy.yml` sees only `games/<id>/**` and calls `game.yml` for that id. Infra deploys `game-<id>` after your approval, then the app job publishes, deploys, and pins, then the web job publishes and pins, and `web-release` ships the site. No other game builds.
7. In `/admin/`, grant the game to each child who should see it.

No Mac step is needed. The app's identity is system-assigned, `id-g4k-infra` grants its roles under its condition, and `id-g4k-apps` and `id-g4k-web` were federated once at bootstrap. Role assignments can take up to 30 minutes to propagate (verified, [table RBAC](https://learn.microsoft.com/en-us/azure/storage/tables/authorize-access-azure-active-directory)), so a game's first app job retries a 403 for that long. To retire a game, dispatch `release.yml retire <id>`, which deletes its pins. Its resources and data stay until you delete them.

### Hosting and cost

Everything sits in West Europe, except the Foundry account in Sweden Central.

- Static Web App, Free, which allows 250 MB per environment and 10 apps per subscription (verified, [quotas](https://learn.microsoft.com/en-us/azure/static-web-apps/quotas)).
- Flex Consumption apps on Node 22, one plan each, since Flex allows one app per plan (verified, [Flex plan](https://learn.microsoft.com/en-us/azure/azure-functions/flex-consumption-plan)). On demand, Flex bills only while code runs (verified, same page), so an idle app costs nothing. `func-g4k-portal` and `func-g4k-admin` use 512 MB (guess). Each `func-g4k-<id>` uses 2048 MB unless its manifest's `hosting` says otherwise. drawpad sets `maxInstances: 1`, which Flex applies per function group, so its Foundry worker runs serially (verified, same page).
- A storage account per game, holding its app's deployment container, and one for the portal, holding the portal tables, the releases container, and the portal and admin deployment containers. Shared keys off, no public blob access.
- Log Analytics, Application Insights, the workbook, and each game's `infra.bicep` resources.

The monthly cost is a guess of 1 to 3 USD, telemetry and a few MB of artifacts per build included, before Foundry at 0.015 to 0.048 USD per redraw (drawpad measured).

### Pipelines and deploy identities

`deploy.yml` runs lint, `tsc -b`, and the tests on pull requests and pushes to `main`. `tools/changes.mjs` maps changed paths to owners and layers. Under `games/<id>/`, `infra.bicep` or a storage or hosting change in the manifest means `infra`, `api/` means `app`, and `web/` means `web`. `deploy.yml` then fans out, one job per changed owner.

- `game.yml` takes `id` and `layers` and runs, in order, infra (`what-if` on a pull request, deployment `game-<id>` on `main`), app (conformance, publish, deploy, health at this sha, pin), and web (build, publish, pin). If the new app fails health, the job redeploys the pinned package and fails.
- `shell.yml`, `portal.yml`, and `admin.yml` do the same for their owners. A `packages/host` change redeploys the portal and admin apps, and reaches each game on its next release, or at once if you dispatch `deploy.yml` with `games: all`.
- `infra.yml` deploys `infra/main.bicep` as deployment `shared`, then sets the redirect URIs, writing only a difference.
- `web-release.yml` deploys the site after any web or app pin moves, and `release.yml` rolls a pin back a step or retires a game.

Each deploy identity is user-assigned and federated to its own GitHub environment, which only `main` may deploy to. GitHub holds only ids.

- `id-g4k-infra`, environments `infra` and `infra-plan`. Contributor on `rg-games4kids`, plus Role Based Access Control Administrator with a condition that allows only storage data roles, Cognitive Services User, and Monitoring Metrics Publisher for service principals, Website Contributor for the three app deploy identities, and Contributor for `id-g4k-web`. Cloud Application Administrator scoped to the games4kids registration, for redirect URIs.
- `id-g4k-apps` (environment `apps`), `id-g4k-portal-api` (`portal-api`), and `id-g4k-admin-api` (`admin-api`). Website Contributor on their apps, and blob roles on those apps' deployment containers and the releases container. Each game's deployment grants `id-g4k-apps` its rights on that game.
- `id-g4k-web`, environment `web`. Contributor on the Static Web App, and a blob role on the releases container.

**One deploy identity for every game app.** A per-game identity or environment needs its own federated credential, which is identity management and belongs to the Mac, so every new game would need a Mac step. A shared `id-g4k-apps` can deploy any game's app, but it runs only workflow code from `main`, which you already review (inferred). If you later want approval per game, one flexible federated credential matching `environment:apps-*` covers every game. Those support user-assigned identities but are in preview (verified, [flexible credentials](https://learn.microsoft.com/en-us/entra/workload-id/workload-identities-flexible-federated-identity-credentials)), so I would not start there.

`id-g4k-infra` and `id-g4k-admin-api` can both run code as `id-g4k-graph`, so their environments require your approval, including a new game's first infra run.

### Bootstrap and the spike

`tools/bootstrap.mjs` runs under your Owner and Global Administrator sign-in and never touches an individual user. It has no per-game step.

1. Create the games4kids registration and service principal, the `access_as_user` scope, and assignment required.
2. Create the six identities (`id-g4k-infra`, `id-g4k-apps`, `id-g4k-portal-api`, `id-g4k-admin-api`, `id-g4k-web`, `id-g4k-graph`), their federated credentials, and the GitHub environments and variables.
3. Run the spike. A throwaway probe registration gets Cloud Application Administrator scoped to the games4kids service principal and registration. With an app-only token, it assigns your account, lists and removes the assignment, and rewrites the redirect URIs unchanged, retrying for ten minutes while roles propagate. Bootstrap then deletes the probe.
4. If the spike passes, give `id-g4k-graph` the role on the service principal and `User.Invite.All` with admin consent, and `id-g4k-infra` the role on the registration.

If Entra refuses the scope or a probe call answers 403, bootstrap stops and prints the fallbacks: one Entra ID P1 licence (a guess of about 6 USD a month) for revision 3's group, `AppRoleAssignment.ReadWrite.All`, which is control of the tenant, or the role tenant-wide, which reaches the old registrations.

### Bringing the two games in

Each game's web and api folders are copied, minus what the portal now owns, such as drawpad's auth code and letterjoin's `gate.js` and `vendor/msal`. Content migrates at cutover. Player data gets a tool, built and tested, that re-keys each child's rows from member rows, dry-runs by default, and writes only with `--apply --confirm-player-data`, which the type enforces. Both tools read the old accounts only and insert if absent, so reruns converge ([`migrate.ts`](sketch/migrate.ts)).

### Stay a monorepo

Each game depends only on `@g4k/sdk`, `@g4k/host`, and the shell URL, and ships through `game.yml` and the release store, which know it by id, not by path. Moving `games/<id>` to its own repo means publishing the two packages to GitHub Packages, calling `game.yml` from the new repo, and adding one federated credential for that repo on the Mac. I would split when a second person owns a game and should not have write access to the others, or when CI for unrelated games slows every change. Neither is true today.

### Local dev and tests

`npm run dev` starts letterjoin's fake IdP, a fake Graph, a telemetry sink, and one node process that serves the portal, admin, and every game app through `serveWithNode`, with the real `verifyToken`. One process is a dev and test convenience only. Storage is memory or Azurite, one account per owner, and a site server points every `apiBaseUrl` at the dev origin.

Beyond unit suites, [`conformance`](sketch/conformance.ts) runs per game, `boundaries` proves forbidden imports fail `tsc -b`, and `release` covers reruns, two owners pinning at once, rollback, and `compatible`.

## Synthesis decision

Three designs went to a bakeoff. c1 mounted games in shadow roots of one SPA, c2 used iframes and a Function app per game, and c3 co-hosted pages on one host. c3 scored highest and is the base, because only it brings letterjoin in without a rewrite. It took c1's identity model and c2's conformance suite. Revision 5 also takes c2's Function app per game, without its iframes.

### Earlier revisions

Revision 2 moved to West Europe and added Entra assignment, the migrations, and pipelines. Revision 3 moved invites, grants, and revokes into `/admin/` on a separate admin app. Revision 4 added cost by game, a storage account per game, and direct assignment, because the tenant has no P1.

### Revision 5: games ship independently

- Deleted first: the single game host, `mountGames`, startup containment, 503 `game_unavailable`, the duration-share compute estimate, and the generated files that listed every game.
- Each game publishes artifacts and moves only its own pins, and `web-release` assembles the site.
- Each game has its own Function app, so isolation is RBAC and compute cost is exact. Portal resources are tagged `game=portal` to match telemetry.
- The shell moves to `/shell/v1/`, and `@g4k/sdk`'s version is the contract.
- The portal app claims identities and returns grants, so no portal deploy follows a new game.
- Game apps use system-assigned identities, because under your rule a user-assigned one comes from the Mac, which would make each new game a Mac step.

## Tradeoffs accepted

Each item names the cost, then what it buys.

- A page load between games, for zero coupling between game runtimes.
- One Function app and plan per game, and one more deploy identity, for a deploy, crash, or bad dependency in one game reaching no other.
- A cold start per game app, and on a first visit possibly one for the portal app too (unmeasured), for scale to zero with no idle bill.
- A `@g4k/host` fix that reaches each game only on its next release or a dispatch, for releases that never rebuild other games.
- Two shell majors live until the last game moves, for breaking changes that never force every game at once.
- One site deploy for every release, so a bad assembly could break every page, for one origin. The checks, the verify, and the stored previous manifest bound that.
- A telemetry cap that can blind a day, alerted and marked, for a bounded bill.
- An admin identity that can change any setting of the games4kids enterprise app, for no Entra right where game code runs.
- Two lists of who may enter, for Entra refusing anyone you have not invited.
- An approval click per infra or admin-api deploy, for deploys without the Mac.
- Player history waiting in the old apps, for no change to the old resource groups.

## Alternatives considered

- **One game host and one deploy of everything (revision 4).** One identity reached every game's data, a hang in one game slowed all, compute cost was an estimate, and every deploy shipped every game. It lost once games must ship alone, and Flex charges nothing for an idle app.
- **Runtime composition, such as module federation.** Games would share one document, with its global CSS, pointer handlers, viewport meta, and dependency versions. letterjoin has no bundler to federate.
- **Iframes (c2).** Silent token calls inside an iframe fail when third-party cookies are blocked (verified, [third-party cookies](https://learn.microsoft.com/en-us/entra/identity-platform/reference-third-party-cookies-spas)), and an iframe on the iPad adds a second viewport and pointer layer (inferred).
- **A Static Web App per game, on its own origin.** Each origin has its own MSAL cache, and silent sign-in through a hidden iframe needs third-party cookies, which Safari blocks by default (verified, same page). So each game's first visit per tab would bounce through Entra (inferred). Each origin also needs redirect URIs, and Free allows 10 apps per subscription (verified, [quotas](https://learn.microsoft.com/en-us/azure/static-web-apps/quotas)).
- **Azure Front Door routing paths to per-game origins.** The Standard base fee is 35 USD a month (verified list price, [pricing](https://azure.microsoft.com/en-us/pricing/details/frontdoor/)), more than ten times the portal's guessed bill.
- **The shell as an npm package per game.** letterjoin would need a bundler, and a shell fix would need every game rebuilt.

## Open questions and risks

- The design depends on the spike. If it fails, which fallback do you take?
- Game apps read `members`, which holds every child's email. Should email live only in `emails`, which game apps cannot read?
- Are cold starts acceptable on the iPad? An always-ready instance removes them for a baseline charge (guess, a few USD a month per app).
- Should a `@g4k/host` change redeploy every game automatically?
- Can the workbook query Cost Management on this Pay-As-You-Go subscription? Untested.
- Is 0.2 GB a day right? The volume behind it is a guess until a week of real use.
- The migrations run on your Mac because a pipeline would need read roles on the old storage accounts. Do you accept that?
- drawpad keeps a fallback object-id lookup needing `User.Read.All`. Is it ever needed?
- Is `exports` the right door for a joint scoreboard, and would a parent join as a guest or wait for External ID?
- Could a Reader-only identity run the what-if?

## Build plan

Each phase starts only when the previous phase's named check is green.

1. **Scaffold, `@g4k/host`, identity, and telemetry.** Done when the unit suites and fixture conformance pass, including `not_claimed` and the fixture's id on every telemetry record.
2. **Shell, portal pages, portal app, and admin app.** Done when `admin.test` passes and Playwright on the dev stack covers an invite with one game, the claim, home showing only that game, and a revoke.
3. **Release tooling.** Done when `release.test` passes and a dev assembly after a fixture-only change leaves every other game's files hash-identical.
4. **drawpad port.** Done when its Vitest suite, conformance, and a Playwright smoke reaching `time_up` pass.
5. **letterjoin port.** Done when its `node --test` suite, conformance, and Playwright e2e at `/g/letterjoin/` pass.
6. **Bootstrap.** Done when the spike passes, a second run changes nothing, and a pull request runs the shared and per-game what-if.
7. **Pipelines and the workbook.** Done when a push to `games/letterjoin/web` releases only letterjoin and leaves drawpad's files hash-identical, a fixture game gets its infra and app with no Mac step, a fixture app that fails health rolls back while the others stay healthy, and the workbook shows both games' players and requests. Cost tiles are checked 72 hours later.
8. **Onboarding and content.** Done when a family member invited from `/admin/` sees only their granted games, a second content apply writes nothing, and the old pictures and activities show on the iPad.
9. **Player-data migration, not applied.** Done when `migrate.test` passes and a dry run reports counts and unmapped keys. Applying waits for your word.

## Next implementation step

Write `packages/host` identity, `createGameApp`, and telemetry against their tests, with the node adapter and the fake IdP, so the admission matrix, `not_claimed`, and telemetry stamping are green before any game is copied in. Then write `release.ts`'s pure `compatible` and `assembleRelease` against `release.test`.
