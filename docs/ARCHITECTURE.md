# games4kids portal architecture

This is the design for the games4kids portal at revision 7. Nothing is built or deployed yet. The type sketch in [`docs/sketch/`](sketch/) is the contract this prose describes, and `tsc --noEmit --strict -p docs/sketch` checks it, including the 34 negatives in [`isolation.check.ts`](sketch/isolation.check.ts).

Verified facts were read on Learn, docs.github.com, or through read-only `gh`, and link their source. Inferred facts follow from verified ones. A guess is unchecked.

## Recommendation

Build two apps on two origins. The games site is for players only. Its registration, `games4kids`, defines no admin role, its APIs have no access levels, and a games token can only ever mean "this child may play these games". The admin site is a second Static Web App with its own registration, `games4kids-admin`, its own API audience, and one Function app, `func-g4k-admin`. Everything administrative lives there: members, invites, grants, revokes, Entra, and every game's admin screens. A child's token cannot reach an admin API, and the games origin never holds an admin token, so no game page can act as you.

Inside the admin app, everyday work runs on an `admin.console` token that the backend never exchanges for Graph. Any change in Entra asks you to sign in again in a popup, and the backend runs on-behalf-of (OBO) only while that sign-in is less than 10 minutes old. You administer from a dedicated account that is not a Global Administrator, whose standing limits OBO to inviting guests and assigning users to the games4kids enterprise app (build check B5).

Each game is one folder with a data part, a play part, and an optional admin part. A merge to `main` deploys whatever changed, with no release pins, and rollback is a revert.

The costs are two codebases in one repo, a popup before every Entra change, and a games site that deploys whole, so letterjoin's pages in `main` ship again when drawpad changes the games site.

## Problem

Two finished games, drawpad (Preact with Vite, keyed by Entra `oid`) and letterjoin (vanilla ES modules, keyed by email), need one sign-in per child for every current and future game, invite-only players, per-game access, and per-game cost. The old repos, deployments, and registrations stay as they are. Everything new lives in `rg-games4kids` in West Europe, except the Foundry accounts of drawpad and timedetectives in Sweden Central. An account can deploy only the models its own region lists, even as Global Standard, and West Europe lists no image model (verified, `az cognitiveservices model list --location westeurope`, October 2026). Sweden Central lists `gpt-image-1-mini`, `gpt-image-2` and `gpt-5.4-mini`.

## Where each action runs

People and access change only in the admin app, Azure and code only through GitHub Actions, and your Mac runs bootstrap and one-off data moves.

| | Mac (bootstrap only) | Admin app | Pipelines |
| --- | --- | --- | --- |
| People and access | Your `admins` row | Invite, choose games, revoke, sync Entra | Nothing |
| Entra | Both registrations, their scopes, optional claims, and redirect URIs. The admin account, its two roles, and its Graph consent. Three user-assigned identities and their federated credentials | Guests and their games4kids assignment, as you through OBO after a fresh sign-in | Nothing |
| Azure | `rg-games4kids`, the identities' Azure roles, your migration data roles | Nothing | Everything else, through Bicep |
| GitHub | Environments `infra` and `deploy`, repository variables (ids only), through `gh` | Nothing | Nothing |
| Code | Nothing | Nothing | Both sites and every Function app |
| Data | Content migration at cutover. Player-data migration only when you say so | Pictures, activities, settings, reviews, limits | Nothing |

No pipeline holds an Entra right. Nothing calls Graph without a sign-in from the last 10 minutes.

## Usage (caller's view)

A game author reads this and nothing else:

```
games/<id>/manifest.ts     defineGame: each table, container, and queue with its owner, and what each part needs
games/<id>/data/           row types, parse functions, playStore and adminStore over the game's account
games/<id>/play/web/       player pages, served at /g/<id>/ on the games site
games/<id>/play/api/       export const createPlayApi = definePlayApi(manifest, (platform) => ({ routes }))
games/<id>/admin/web/      admin pages, served at /g/<id>/ on the admin site (optional)
games/<id>/admin/api/      export const createAdminApi = defineAdminApi(manifest, (platform) => ({ routes, workers }))
games/<id>/infra.bicep     optional: Azure resources only this game uses
```

```js
import { enter } from '/shell/v1/index.js';         // a play page, games origin
const { api, me, storage } = await enter({ game: 'letterjoin' });

import { enterAdmin } from '/shell/v1/index.js';    // an admin page, admin origin
const { api } = await enterAdmin({ game: 'letterjoin' });
```

The play part may import the data part. The admin part may import the data part and the play part's pure modules, such as letterjoin's `render.js` for the editor preview. Nothing imports the admin part. TS project references and ESLint enforce this. Every page that waits on a Function app, on the games site and the admin site, greys out with a spinning ring until its first load finishes, because a cold Function app can take many seconds and a blank page looks broken. Its HTML puts `aria-busy="true"` on `<body>` and `inert` on the page's content element, links `/shared/tokens.css` and `/shared/shell.css`, and calls `ready()` (exported by both shells' `/shell/v1/index.js`) once the first data has rendered, whether that load succeeded or failed. A view opened later that is empty until a reply arrives wraps that request in `whileLoading(promise)`, which shows the same overlay if the reply takes longer than 300 ms. `test/loading.test.ts` fails for any page HTML without the overlay. A game writes no auth code ([drawpad](sketch/examples/drawpad/), [letterjoin](sketch/examples/letterjoin/)).

## Shape

### Repo layout

```
games4kids/
	package.json            npm workspaces. gen runs on predev, prebuild, pretest
	packages/sdk/           @g4k/sdk: defineGame, definePlayApi, defineAdminApi, HttpError, types
	packages/host/          @g4k/host: createPlayerApp, createPortalApp, createAdminApp, identity, storage, telemetry
	apps/games/             shell/v1/ (/shell/v1/), pages/ (/, /welcome/, redirect.html), api/ (func-g4k-portal)
	apps/admin/             shell/v1/ (/shell/v1/), pages/ (members, Entra, games), api/ (func-g4k-admin)
	apps/shared/            api-client, msal loader, telemetry and the vendored MSAL, served at /shared/ on both sites
	games/tsconfig.*.json   one project each for every game's data, play api, admin api and generated entries, so a part cannot import one it may not
	games/drawpad/          manifest.ts, data/, play/ (api, web), admin/ (api, web), infra.bicep (Foundry)
	games/letterjoin/       manifest.ts, data/, play/, admin/, infra.bicep (Vision)
	games/timedetectives/   manifest.ts, data/, play/, admin/, infra.bicep (Foundry, Key Vault)
	tools/                  gen, dev, changes, package-app, build-web, site-config, deploy, bootstrap, migrate/content, migrate/player-data (.mjs, with .ts beside those that tests import)
	infra/                  main.bicep (shared), game.bicep (one deployment per game), modules/function-app.bicep, workbook.json
	dev/                    fake-idp.ts, fake-graph.ts, sites.ts, stack.ts (tools/dev.mjs starts it), generated/
	test/                   conformance.ts, *.test.ts, e2e/ (Playwright)
	.github/workflows/      ci.yml, deploy.yml
```

### Two sites, two audiences

| | Games site | Admin site |
| --- | --- | --- |
| Static Web App | `swa-g4k-games` | `swa-g4k-admin` |
| Custom domain | `games4kids.rezamahmood.net` | `games4kidsadmin.rezamahmood.net` |
| Registration | games4kids: SPA client and API, scope `access_as_user` | games4kids-admin: SPA client and API, scopes `admin.console` and `admin.elevate` |
| Assigned accounts | Each invited child | Admin accounts only |
| Pages | `/`, `/welcome/`, `/g/<id>/` play pages | `/` (members, Entra), `/games/` (pause a game), `/g/<id>/` game admin pages |
| Backends | `func-g4k-portal`, `func-g4k-<id>` per game | `func-g4k-admin` |

The custom domains live in `infra/domains.json`, which `infra/main.bicep`, `infra/game.bicep` and bootstrap read. Each site keeps its default `*.azurestaticapps.net` hostname too, for invitations already sent and for bookmarks, so every Function app's platform CORS allows both origins, and each registration holds redirect URIs for both. Invitations redeem on the games custom domain (`GAMES_ORIGIN`). The Free plan allows two custom domains per site with a managed certificate (verified, [plans](https://learn.microsoft.com/en-us/azure/static-web-apps/plans)). A domain is added by CNAME validation, so its CNAME must resolve, unproxied, before the infra job that adds it runs.

Both registrations have assignment required on, and neither pre-authorizes a client. On one shared origin and MSAL cache, any game page could silently get an admin token (review C1). Two origins have two caches, and the games shell's config has no admin scope or admin origin at all, which a negative proves.

The player side is one trust domain. Every player app accepts the same audience, so a compromised game app could replay a child's games token against another game's player API until it expires. No admin power is reachable from the games side.

### Player request flow

1. A child opens `/`. With no cached account, the shell calls `loginRedirect`, and Entra signs in only accounts assigned to games4kids.
2. The shell calls `GET /api/portal/me` on `func-g4k-portal`. The app verifies the token, reads the identities, members, profiles, and games rows, and the pure `decide` returns an admission. Not invited draws a screen, no profile goes to `/welcome/`, and an active player gets `me` with their games.
3. Home reads `catalog.json` and draws a card for each game in `me.games`, greyed out and not a link when it is paused. A manifest that sets `scoreboard` has it copied into its catalog row, and `/profile/` shows that game's switch to each child granted it. The page calls the game's own `GET` and `PUT board/me` with the child's games token, because the portal app cannot write a game's tables.
4. On `/g/drawpad/`, `enter({ game: 'drawpad' })` gets a token silently and calls `GET /api/g/drawpad/session` on `func-g4k-drawpad`. Only that app wakes, so a game page costs one cold start, not two (review W7).
5. `api.post('drawings', ...)` runs `createPlayerApp`'s fixed order in [`host.ts`](sketch/host.ts): verify, find, decide with this game's id, parse, `run`, and map errors to one shape.

Every games-side app reads the member row on every request, so a revoke or a removed game takes effect on the next call.

### Admin request flow

1. You sign in to the admin site with the admin account.
2. The admin shell gets an `admin.console` token. `func-g4k-admin` checks audience games4kids-admin, then `openAdminSession` requires an `admins` row for the token's `oid`. Members, grants, revokes, and every game's admin pages run on this session and change rows only.
3. A change in Entra needs an elevation, described next.

### Elevation just in time

Your admin session never carries Graph power. When a task needs Entra, the members page calls `elevated(task)` in [`shell.ts`](sketch/shell.ts):

1. The shell creates a second MSAL instance with `cacheLocation: 'memoryStorage'` and calls `acquireTokenPopup` for `admin.elevate` with `prompt: 'login'`. `prompt=login` forces you to enter credentials, negating single sign-on (verified, [OIDC](https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc)). Memory storage clears on navigation and does not support redirect (verified, [MSAL caching](https://learn.microsoft.com/en-us/entra/msal/javascript/browser/caching)), so the elevation uses a popup.
2. The task's requests carry that token. `elevate` in [`admin.ts`](sketch/admin.ts) returns an `Elevation` only when the token has scope `admin.elevate` and its `auth_time` is at most 600 seconds old. Otherwise the app answers 401 with `WWW-Authenticate: Bearer error="insufficient_user_authentication", max_age="600"`, the step-up challenge from RFC 9470 (not an Entra format; only our shell reads it), and the shell reopens the popup once.
3. `graphAs(elevation)` is the only way to build an `OboGraph`, and the Graph token lives for that request only, with no cache across requests.
4. When the task ends, the shell clears and drops the instance.

`auth_time` is not a default claim in v2 access or ID tokens (verified, [access token claims](https://learn.microsoft.com/en-us/entra/identity-platform/access-token-claims-reference), [ID token claims](https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference)). It is an optional JWT claim, and access-token optional claims apply to tokens issued for the API (verified, [optional claims](https://learn.microsoft.com/en-us/entra/identity-platform/optional-claims-reference)). Bootstrap adds it to games4kids-admin's access token, so `auth_time` and `oid` come in the same token and no ID token is needed. That Entra emits it in this access token is inferred, and build check B4 proves it. Entra documents no `max_age` parameter (verified, absent from the [authorize parameters](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)), so the backend measures freshness itself.

If OBO answers `interaction_required` with claims, the app returns 401 with `WWW-Authenticate: Bearer error="insufficient_claims", claims="..."` (verified format, [claims challenge](https://learn.microsoft.com/en-us/entra/identity-platform/claims-challenge)), and the shell passes the claims to the popup.

Freshness belongs to your Entra session, not to one token. For 10 minutes after an elevation, any token the admin origin requests carries the fresh `auth_time`. So the shell binds an elevation to one task, and the server binds it only by time. Binding per task on the server would need an elevations table. With Entra ID P1, Conditional Access authentication context with sign-in frequency "every time" would move this check into Entra, and the backend would check the `acrs` claim (verified claim, access token claims) instead of `auth_time`.

### Who you are when you administer

Bootstrap creates an internal account for administration, not a Global Administrator. It holds one directory role and one ownership:

- **Guest Inviter**, tenant-wide, which invites guests regardless of the "members can invite guests" setting (verified, [Entra roles](https://learn.microsoft.com/en-us/entra/identity/role-based-access-control/permissions-reference)).
- **Owner of the games4kids enterprise application**, meaning its service principal. Ownership is free-tier, with no Entra ID P1 needed. That it needs no licence is inferred from ownership being no licensed feature, and B5 runs in a tenant without P1. Bootstrap first tried Cloud Application Administrator scoped to that service principal (`directoryScopeId` `/<service principal object id>`). A tenant without P1 refuses it with 403 `Authorization_RequestDenied`, "Only companies who have purchased AAD Premium may perform this operation" (observed on the first real run). Entra requires P1 for a role scoped to one app. So the scoped role is gone. That an owner can create and delete an assignment on that service principal through the Graph `appRoleAssignedTo` POST and DELETE is inferred, and build check B5 proves it.

The admin account alone consents, per user (`consentType` `Principal`), to four delegated scopes on games4kids-admin: `User.Invite.All`, `User.ReadBasic.All`, `AppRoleAssignment.ReadWrite.All`, and `Application.Read.All`. `User.ReadBasic.All` is the least privileged scope for listing users (verified, [List users](https://learn.microsoft.com/en-us/graph/api/user-list?view=graph-rest-1.0)). `findUser` filters and selects only `id`, `mail`, and `userPrincipalName`, which that scope's basic profile includes (inferred). It never filters on `otherMails`. An alternate email is not a sign-in, and anyone can hold one, so a match on it once linked a member to the wrong account (observed). A bootstrap re-run moves a tenant that holds `User.Read.All` back to `User.ReadBasic.All`. That the `startswith` filter on `userPrincipalName` works under `User.ReadBasic.All` is untested against a tenant, and B6 proves it. A delegated call does only what both the scope and your roles allow (verified, [Graph permissions](https://learn.microsoft.com/en-us/graph/permissions-overview)). `AppRoleAssignment.ReadWrite.All` alone reaches app role grants on any API, Graph included (verified, [permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference)), so what bounds the account is its ownership, not its scope (review C2). The account can touch only the service principal it owns. Ownership also lets it edit that service principal itself, for example by adding credentials to it or changing `appRoleAssignmentRequired`. That is far narrower than tenant-wide Cloud Application Administrator, which reaches every enterprise application in the tenant.

If B5 fails, the fallback is to administer from your Global Administrator account with the same elevation. The residual risk is that, inside one elevation, a compromised admin backend could grant games4kids-admin's own service principal a Graph application role and then redeem it app-only with its federated credential, outside any sign-in. Either way, the Entra panel lists every app role that service principal holds and shows any as an alarm.

### Identity and access

Each portal table has one writer, enforced by RBAC per app and per table ([`identity.ts`](sketch/identity.ts)).

| Table | Holds | Writer | Readers |
| --- | --- | --- | --- |
| `members` | state, granted game ids or `*` for every game | admin app | portal app, player apps |
| `games` | a row per paused game | admin app | portal app, player apps |
| `identities` | issuer and `oid` to `PortalUserId` | admin app, at invite | portal app, player apps, admin app |
| `emails` | email to `PortalUserId` | admin app | admin app |
| `profiles` | display name, time zone, when the name last changed | portal app, on `/welcome/` and `/profile/` | player apps, admin app |
| `admins` | admin account `oid`, email | bootstrap | admin app |
| `aiusage` | one row per AI request, with its tokens and its estimated cost | admin app | admin app |

The admin app writes the identity row in the same step that learns the object id, so a first sign-in finds a complete row and nothing claims anything (review W9). `decide` admits a known identity with an active member, and a player app also needs `members.games` to grant its game. A grant is either a list of game ids or every game. There is no role anywhere in the games side. `Caller` is `{ userId, displayName, timeZone }`. A new game is hidden until you grant it, unless the member holds every game. GET me lists every registered game for that member, so the portal app is built with the registered ids and redeploys when a manifest changes. Display names stay unique by listing profiles before writing (review cut 6). The portal app also refuses a name that `isKindName` flags, a swear word or an insult from `obscenity` and a short list of our own, with `name_not_allowed`. The check runs on the server, so no client can skip it. A child may rename once a day. A save that changes the name, case included, is refused with 429 `rename_tomorrow` when the row's `renamedAt` falls on today's calendar day in the child's stored time zone. The first name and a save that keeps the name (a time zone change) are no rename and keep `renamedAt`. GET me tells `/profile/` with `canRenameToday` whether a rename is still open, and only the portal app reads or writes `renamedAt`.

The games page on the admin site pauses a game for everyone. A paused game is a `games` row keyed by the game id with `state` `paused`, and making it available again deletes the row. `decide` checks it last, so a child granted a paused game gets `game_paused` and still sees the card on home, greyed out, while a child not granted it gets `not_entitled` and sees nothing.

### Data ownership

Every table, container, and queue has one writer. The manifest declares it, `StorageFor<M, side>` turns it into a writable handle or a read-only one, and Bicep grants the matching data role per table or container (table-scoped roles verified, [table RBAC](https://learn.microsoft.com/en-us/azure/storage/tables/authorize-access-azure-active-directory)).

| Game | Name | Holds | Writer | Other side |
| --- | --- | --- | --- | --- |
| drawpad | `pictures` table and container | the picture library | admin app | player app reads |
| drawpad | `settings` | default daily limit, one row per child's limit | admin app | player app reads |
| drawpad | `drawings` table and container | each child's drawings | player app | admin app reads (gallery) |
| drawpad | `usage` | seconds played per day | player app | admin app reads (limits screen) |
| drawpad | `jobs` table and container, `stencil-jobs` queue | AI picture jobs | admin app | none |
| letterjoin | `activities` | activities, order, and the settings partition | admin app | player app reads |
| letterjoin | `results`, `attempts` | scores, practice-day partitions, attempts | player app | admin app reads (practice, progress) |
| letterjoin | `submissions` table and container | copy-writing submissions | player app | admin app reads (review) |
| letterjoin | `reviews` | reviewed, note, reviewer, time | admin app | none |
| timedetectives | `topics`, `rounds`, `pictures` container | topics, and each round with its AI job state and picture | admin app | player app reads (published rounds only) |
| timedetectives | `attempts`, `board` | each child's finished rounds, and who switched the board on | player app | none |
| timedetectives | `drafts` queue | rounds for the AI to write and draw | admin app | none |

Review state moves out of `submissions` into `reviews`, keyed by submission id, so a review never makes the admin app a second writer. Deleting on the Review tab becomes a `discarded` review that hides the submission. Its image stays in the player-owned container at a few kilobytes each (guess).

### Backends

- **Player apps**, `func-g4k-<id>`. Player routes only, audience games4kids, built from `play/api` and `data`. Flex Consumption, one plan each, 2048 MB unless the manifest says otherwise. Platform CORS for the games origin is the only CORS mechanism, and `Reply` has no headers (review N9).
- **Portal app**, `func-g4k-portal`. `GET me` and `PUT profile` for home, `/welcome/` and `/profile/`, 512 MB, as two named functions over `decide` (review N7). It stays its own app because none of those pages belongs to a game, and no game page calls it. `/profile/` is where a child changes their name later: it sends the stored time zone back with the new name, because `setProfile` replaces the whole row, and the portal bar's name links to it.
- **Admin app**, `func-g4k-admin`. The portal admin routes and every game's admin module, audience games4kids-admin, runtime identity `id-g4k-admin`. Infra caps it at one instance and 2048 MB. Flex applies the maximum instance count to each function group, and the lowest allowed is 1 (verified, [Flex plan](https://learn.microsoft.com/en-us/azure/azure-functions/flex-consumption-plan)).

drawpad's AI picture jobs create content, so their pipeline runs in the admin app. Event Grid puts each BlobCreated event from drawpad's `jobs` container on `stencil-jobs`, and the worker's queue function scales in its own group, capped at one instance with batch size 1, so Foundry sees one redraw at a time. A game declares a worker as `workers: [{ queue, run }]` in `defineAdminApi`. The admin app registers one queue function for it, named `<id>-worker-<queue>`, that reads the game's own storage account through the identity-based connection `<ID>_STORAGE`. The game's `infra.bicep` outputs that connection's three settings (`STORAGE__queueServiceUri`, `STORAGE__credential` and `STORAGE__clientId`), which the pipeline prefixes and merges like any other admin setting. `apps/admin/api/host.json` sets the queue extension to batch size 1, three dequeues. A worker that throws is tried again, and a worker whose last attempt settles its job's steps as failed leaves nothing to poison. A separate worker app would add an app and a plan for one queue whose only writer is already the admin app. The Foundry account stays tagged `game=drawpad`. `id-g4k-admin` gets Cognitive Services OpenAI User on it, role id `5e0bd9bd-7b93-4f28-af87-19fc36ad61bd` (verified, [AI roles](https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles/ai-machine-learning)), which, unlike Cognitive Services User, has no `listKeys`. letterjoin's player app keeps Cognitive Services User on Vision (review N13). Each `infra.bicep` receives the account name, both principal ids, and the queue names (`GameModuleParams`, review W5).

timedetectives drafts the same way, and checks each round the chat model writes before the admin sees it. One request to TypeSafe's Jev model asks 18 questions: whether the full story supports each answer and none of the decoys, and whether the brief or a hint gives an answer away. A clear failure goes back to the chat model once through the retry loop. An uncertain one, or a failure on the last ask, becomes a finding in the draft's `checks`: the form field it is about, the problem, and whether the check was sure. Findings stay through the admin's edits, except one whose field the admin changed, and publishing clears them. A check never fails a round, and one that cannot run sets `checks` to `not-run`. The draft's `notice` is only for a picture the AI could not draw. The API key lives in the game's Key Vault as the secret `typesafe-api-key`, which the operator adds by hand. The admin setting is a Key Vault reference that `id-g4k-admin` resolves, through `keyVaultReferenceIdentity` and Key Vault Secrets User. Until the secret exists the reference text stays in the setting and the check is off.

### Admin screens that move

Read from both repos. Each moves to its game's admin part on the admin site unless noted.

- **drawpad** (`web/src/screens/Admin*.tsx`, `web/src/admin/`, `web/src/stencil/`, `api/src/routes/admin.ts`, `jobs.ts`, `worker.ts`). Upload: a photo or a drawing becomes a library picture, with outlines and paint-by-numbers made in the browser by `stencil/`. AI picture jobs: create, list, view, view a step image, redraw, and delete, plus the Foundry worker. Review of a job's outlines. Library pictures: rename, delete. Gallery: every child's drawings with names. Users: the invite and role parts go to the portal members page, and the per-child daily limit editor with today's usage becomes drawpad's Limits screen.
- **letterjoin** (`web/admin.html`, `admin.js`, the `manage/*` routes). Activities: create, edit with preview, delete, levels, and order. Review: copy-writing submissions, image, review, delete. Practice: the seven-day report. Progress: one child's trends. Settings: daily practice minutes. The Users tab goes to the portal members page.

Gone from the games: drawpad's admin area, letterjoin's `admin.html`, drafts shown to admins, and drawpad's admin bypass of the time limit.

### Onboarding and revoking

1. On the members page, you enter the child's email and tick games. Nothing is ticked by default. `saveMember` (`admin.console`) writes the `emails` row, which fixes the `PortalUserId`, and the active member row.
2. The page asks to sync with Entra. After the popup, `syncEntra` looks up every active member with `findUser` and records an existing account's object id. A user matches when their `mail` equals the email, their `userPrincipalName` equals it, or they are a guest whose UPN encodes it as `<local>_<domain>#EXT#@<tenant domain>`. Every criterion counts the same. One match is the account. No match means a new person, and only a new person gets `POST /invitations`. Two or more matches are ambiguous, and nothing changes until Entra has one. `findUser` is one Graph call per active member for each check or sync. Invites are for guests only, because an address in one of the tenant's verified domains cannot be B2B-invited (inferred, review W1). It writes the identity row and assigns the account to games4kids, retrying after 2, 4, 8, and 16 seconds while Entra replicates a new guest (guess).
3. The child signs in, chooses a name on `/welcome/`, and home shows the granted games.

To revoke, set the member revoked (`admin.console`). Every games-side app refuses the next request. The page then offers a sync, which removes the assignment.

`syncEntra` reads Entra, computes drift, and applies only the difference, so a second run does nothing and a run cut short anywhere converges next time.

| Drift | Fix |
| --- | --- |
| `needs-account`: active member, no identity row | find, else invite; record; assign |
| `not-assigned`: active member Entra refuses | assign |
| `wrong-account`: active member whose identity row names another account than `findUser` finds | unassign the old account; delete its identity row; record the found account; assign it |
| `ambiguous-account`: more than one account matches an active member's email | none; shown as an alarm with each match's UPN |
| `account-taken`: an active member's email finds another member's account | none; shown as an alarm, because one account signs in as one member |
| `assigned-revoked`: revoked member still assigned | unassign |
| `unmanaged`: an assignment with no identity row, such as one bootstrap made | none, ever (review W2) |
| `admin-app-grant`: games4kids-admin's principal holds an app role | none; shown as an alarm |

Viewing drift also needs an elevation, because listing assignments is a Graph call.

### Doors left open

Google and Facebook sign-in would come through an Entra External ID tenant added as a second `TrustedIssuer`, whose identity rows map to the child's existing `PortalUserId`. A parent account would be a reserved `guardianships` row, not a role. A cross-game feature would go through the manifest's reserved `exports`, which admits only `{}` today.

### Cost and usage by game

**Tags.** Bicep tags every resource `app=games4kids` and a `game` value. A game's storage, plan, player app, and `infra.bicep` resources carry `game=<id>`, so each Foundry account carries its own game's tag. The portal account and app carry `game=portal`, the admin app `game=admin`, and both Static Web Apps, Log Analytics, and Application Insights `game=shared`. Admin compute is shared by every game's admin module, drawpad's worker included, and Foundry, the large cost, is exact by tag. Tags reach usage records only while applied ([Cost Management data](https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/understand-cost-mgt-data)), so the infra job fails on a missing tag.

**Telemetry** goes to one Application Insights ([`telemetry.ts`](sketch/telemetry.ts)). A player app's rows carry `cloud_RoleName` `func-g4k-<id>`, because `service.name` defaults to the Function app name (verified, [Functions OpenTelemetry](https://learn.microsoft.com/en-us/azure/azure-functions/opentelemetry-howto)), so code needs no game envelope (review W10). The admin app names every function `<owner>-<name>` and mounts game routes under `api/admin/g/<id>/`, so its rows split by game in KQL. Each shell stamps page views with `game` and sends a `game_session` beat each minute a game page is visible. Each shell also reports browser faults as exceptions: whatever no catch handled, an API call that fails on the network or with a 5xx, and any error a page passes to `report(error)`. A 4xx is an answer, not a fault. On the server, every 5xx and every Entra refusal is recorded. The user is a span attribute, the `PortalUserId`, never an email. Sampling is off, and the daily cap is 0.16 GB, so a 31-day month stays under the 5 GB free grant (review N8, grant not checked on Learn this revision). At the cap, collection stops until the reset hour ([daily cap](https://learn.microsoft.com/en-us/azure/azure-monitor/logs/daily-cap)), and an alert emails you.

**AI cost ledger.** Tags price a game's Foundry account for the month, but not one round or one picture. So each AI request whose reply reports usage is one row in the portal table `aiusage`, which only the admin app writes and no player app can read. A game declares the areas it bills in its manifest's `admin.ai`, with a label for each, and reports a call through `platform.usage.record({ area, model, tokens, subject })`. `AiModel` ties each model to the token kinds it bills on, so a chat model cannot report image tokens, and a game reports tokens and never a price. The host stamps the game id and the time, prices the call from `packages/host/src/prices.ts` (Azure list prices from the Retail Prices API, read 2026-10-23, and TypeSafe's published price), and stores the cost as whole micro-USD with the price version. A model with no price does not compile. Rows sit in the partition `<game>|<UTC month>`, keyed by time, and are never changed, so every figure is a sum over them. `record` never rejects and gives up after 5 seconds, and a lost write is logged with the whole entry. A billed reply whose usage cannot be read has no price to invent, so the game reports it through `platform.usage.unmetered({ area, model, subject, reason })` (`meterTo` binds both outcomes to a subject): no row, but a logged line and an exception naming game, area, model and item for an operator to find in Application Insights. It never rejects either, and the AI work carries on. `platform.usage.spend()` sums one game's rows by item and by group, so a game shows a cost per round and per topic, including rounds deleted since. Days, months and years in any cost report are Europe/London ones, so a London day near a month edge reads two UTC partitions. Every figure says "est.", because Azure bills from its own meters. The admin console's Costs page (`apps/admin/pages/costs/`) reads `GET portal/costs?by=day|month|year[&from=&to=]`, which sums the ledger of every game that declares `admin.ai` by London period, game and area, with the labels from the manifests, over at most 1096 days. letterjoin's Vision reads are not recorded: they run in the player app and bill per transaction. timedetectives bills its chat asks, checks and pictures, and answers `GET costs`.

**The workbook** derives `game` from those names and shows players, play minutes, requests, errors, p95 latency, AI calls, and cost by tag ([Query Usage](https://learn.microsoft.com/en-us/rest/api/cost-management/query/usage)). A new game appears with no edit.

### Hosting and resources

- Two Static Web Apps on Free, which allows 10 apps per subscription and 250 MB per environment (verified, [quotas](https://learn.microsoft.com/en-us/azure/static-web-apps/quotas)).
- Flex Consumption apps on Node 22, one plan each, since Flex allows one app per plan (verified, Flex plan): `func-g4k-portal` (512 MB, guess), one `func-g4k-<id>` per game (2048 MB), and `func-g4k-admin` (2048 MB, one instance).
- `g4kportal<suffix>`, one `g4k<id><suffix>` per game, and `g4kshared<suffix>`, the Functions host and code-package account for every app. The suffix is the first five characters of `uniqueString(resourceGroup().id)`. Shared keys off, no public blob access. The host account holds no game data, because the host needs account-wide blob, queue and table roles that would break one writer per name on any account that does.
- Function app names are `func-g4k-<app>` with `autoGeneratedDomainNameLabelScope: TenantReuse`, so the name only has to be unique in the resource group and the default host name carries a hash.
- Log Analytics, Application Insights, the workbook, the Foundry accounts of drawpad and timedetectives, and letterjoin's Vision account.
- `id-g4k-infra`, `id-g4k-deploy`, and `id-g4k-admin`.

The monthly cost is a guess of 1 to 3 USD before Foundry, at 0.015 to 0.048 USD per redraw (drawpad measured).

### Pipelines and gates

`ci.yml` runs on pull requests: lint, `tsc -b`, every game's unit and conformance suites, `bicep build` and lint, and Playwright on the dev stack. It has no `id-token: write`, so no pull request run can get an Azure token.

`deploy.yml` runs on every push to `main` and on a manual run, and `tools/changes.mjs` maps changed paths to targets by the rule in [`deploy.ts`](sketch/deploy.ts), which `tools/targets.ts` implements as a table. The changed paths run from the last deploy that succeeded to the pushed commit, so the next run also deploys what a cancelled or failed run left out. A game's `play/` redeploys its player app and the games site, its `admin/` the admin app and admin site, and its `data/` or manifest both sides after its infra. A `changes` job and one `build` job, neither with `id-token: write`, compute the targets, run `npm ci --ignore-scripts`, build (`tsc -b`, then each Vite game's pages with `npm run build:web`), and upload one `bundle` artifact: a zip for each app (`tools/package-app.mjs`), each site composed with its placeholders still in place (`tools/site-config.mjs`), the Bicep, each changed game's `params.json`, and `tools/`. The `infra`, `apps` and `sites` jobs run in that order, each only downloading the bundle and calling `tools/deploy.mjs` after `azure/login`, inside an environment, with every action pinned by commit SHA (review W4). A site job installs the Static Web Apps CLI from `tools/swa-cli/package-lock.json` with `--ignore-scripts` before it signs in. Infra jobs print `what-if` to the job summary, deploy in Incremental mode, which deletes nothing, and fail if any resource lacks `app=games4kids` and a `game` tag. The apps job publishes each zip to Kudu, polls the deployment, and then polls that app's `/health`. The sites job reads each Function app's host name and the Application Insights connection string from Azure with the deploy identity, fills `__API_ORIGINS__` and the other placeholders, `config.json` and each game's `apiBaseUrl`, fetches the Static Web App deployment token at run time, uploads, and checks `/config.json`. A manual run deploys every target.

Required reviewers and wait timers (review N12) exist only for public repositories on Free, Pro, and Team plans (verified, [environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)), and branch protection and rulesets answer 403 on this private repo (verified, `gh api`). The same page lists deployment branch policies for private repos only on Pro or Team, yet drawpad and letterjoin, private repos with the same owner, each have an environment `production` with branch policy `main` (verified, `gh api`). So environments `infra` and `deploy` allow only `main`. Each federated credential's subject is the repository's subject prefix plus `:environment:<name>`. This repo issues the immutable form, `repo:RezaMahmood@641491/games4kids@1426024915:environment:<name>` (verified, `gh api repos/RezaMahmood/games4kids/actions/oidc/customization/sub`), not `repo:RezaMahmood/games4kids:environment:<name>`, and bootstrap reads the prefix from that endpoint. Build check B7 proves that a branch run cannot enter either environment. The gate is your merge. Rollback is a revert merged to `main`.

**What independent means now.** Each game's player API deploys alone, and a game's crash or bad dependency reaches no other game's app. Each site deploys whole from `main`. The shell keeps one path, changes only by adding, and any shell change runs every game's tests, so a breaking change fixes the affected games in the same pull request.

**Deploy identities** (review cut 5):

- `id-g4k-infra`, environment `infra`. Contributor on `rg-games4kids`, plus Role Based Access Control Administrator with a condition that allows only storage data roles, Cognitive Services User, Cognitive Services OpenAI User, and Monitoring Metrics Publisher for service principals, and Website Contributor and Contributor for `id-g4k-deploy`. No Entra role. Contributor can still re-enable shared keys or rewrite app settings, so the condition limits role grants, not data access (review cut 7).
- `id-g4k-deploy`, environment `deploy`. Website Contributor on the Function apps and Contributor on the two Static Web Apps. It deploys the admin app's code, which runs during your elevations, so `main` is the root of trust.

### Bootstrap

`tools/bootstrap.mjs` runs under your Owner and Global Administrator sign-in, has no per-game step, and changes nothing on a second run.

1. Create games4kids and its service principal: SPA, `access_as_user`, assignment required, optional claims `email` and `upn` (review N1). Bootstrap finds its registrations by a tag it sets (`games4kids-bootstrap:games` and `games4kids-bootstrap:admin`) and refuses to change any other registration, so drawpad's and letterjoin's stay untouched.
2. Create games4kids-admin and its service principal: SPA, `admin.console` and `admin.elevate`, no pre-authorized client, assignment required, optional claims `auth_time`, `email`, and `upn`, and the four delegated Graph scopes.
3. Create the admin account (only with `--create-admin-account`), give it Guest Inviter, make it an owner of the games4kids enterprise application, assign it to games4kids-admin, and grant its `Principal` consent (review W12). Its `admins` row waits for step 6, because the table is created by the first infra run.
4. Create `id-g4k-infra`, `id-g4k-deploy`, and `id-g4k-admin`, their GitHub federated credentials, `id-g4k-admin`'s federated credential on games4kids-admin, and their Azure roles. A managed identity as a federated credential needs a user-assigned identity (verified, [managed identity as a credential](https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation-config-app-trust-managed-identity)).
5. Create the GitHub environments and repository variables.
6. After the first infra run creates the two Static Web Apps and the portal account, run bootstrap again with `--after-first-deploy`. It writes each registration's SPA redirect URIs for the site's custom domain and its default hostname, addressing `/applications/{objectId}` directly (review N10), writes the admin account's `admins` row, and gives you the data roles `tools/migrate` needs from your Mac: Table and Blob Data Reader on the old drawpad and letterjoin accounts, Table and Blob Data Contributor on the new game accounts, and Table Data Reader on the portal account and every game account, which covers the portal's `emails` and `identities` tables that the migration reads and lets `tools/player-data.mjs` read a child's rows across every table. A role you already hold at or above a scope counts, and an old account that is gone is skipped. It only adds missing redirect URIs and removes none. No pipeline holds an Entra role, so a hostname change, a new custom domain or a recreated site, means running `--after-first-deploy` again from your Mac before anyone can sign in on the new name.

### Bringing the two games in

Each game is split into its three parts, minus the auth code the shells now own.

- **drawpad** (built in phase 4). Play gets Home, Picker, Freestyle, PaintByNumbers, History, `canvas/`, `scoring/` and the usage timer. Admin gets the Upload, Gallery and Limits screens, `admin/`, `stencil/`, `redraw.ts`, `foundry.ts`, and the worker. `profiles`, `names`, `invites`, `graph.ts`, `auth/`, the sign-in and name screens, the lock screen and the top bar brand go. The pages are Preact built with Vite at base `/g/<id>/`, and they import `/shell/v1/index.js` at run time instead of bundling it. The fonts are bundled from `@fontsource`, so the site's `font-src 'self'` holds and the game needs no CSP extension (review N4). The shell's `ApiClient` keeps `keepalive` for heartbeats and gains `request`, which hands the blob cache the raw Response so it can revalidate images with ETags (review N3). A route sees the request's `If-None-Match` as `ctx.ifNoneMatch`, and answers 304 through `ReadBlobs.get`.
  - **Uploads.** A JSON body is capped at 256 KB, so images no longer travel as base64 inside JSON. A route can declare `body: 'png'` or `body: 'jpeg'`, each capped at 4 MB. A picture is made by sending each image file to the picture's new id, then posting its details, which join the library only when every file its kinds need is there. A photo job is one JPEG request whose size, qualities and title wish are in the query.
  - **Limits.** A child's own limit is a `settings` row in partition `child`, and the default is the row `s/default`. The admin app writes both and the player app reads them. The default has no editor yet.
  - **Tests.** drawpad's pure-logic suites (scoring, the stencil, the canvas maths, the upload queue, the usage tracker, the parse functions) keep the Vitest they were written for, scoped to `games/` by `vitest.config.ts`, because they run unchanged. Everything that crosses the platform runs on `node:test` in `test/drawpad.test.ts` over the real apps, memory storage and the fake IdP and Foundry.
- **letterjoin** (built in phase 5) is a re-key, not a copy (review W11). `api.js` and `admin.js` keyed on email throughout, the `users` table and `decideAccess` went, and its tests bound to `createApi` and `startStack` moved to `test/letterjoin.test.ts` over the real apps. Both parts are `static`: plain ES modules served as they are, with no bundler.
  - **Keys.** Results, attempts, practice days and submissions are keyed by `caller.userId`. The admin app reads children from `roster` and shows the name each chose, so no email reaches a letterjoin row, a route or a page. A review stores the admin's object id as `reviewedBy`.
  - **Data.** `activities` holds the activities and, in partition `setting`, the daily practice minutes and the hard mode default. `results` holds a child's results and, in partition `practice-<userId>`, a row per local day. `submissions` keeps one `all` row per copy for the admin's list and a pointer row in the child's partition for the keep-three cap, so the player app stays its only writer. A review is a `reviews` row, and Delete on the Review tab sets `discarded` on it. The image stays in the player-owned container. A row in partition `board` of `results`, keyed by the child, means the child switched the Friends board on, and it holds their name, time zone and the moment they did.
  - **Play API.** Published activities with the caller's result, result PUT, progress, practice get and add, settings, a copy as a PNG, the Friends board (get, and put to switch it on or off), and GET board/me, which reads only whether the child is on it, and handwriting read through Azure AI Vision with the platform's Cognitive Services token. The board is off until a child turns it on, shows only children who did, and counts only their attempts from that moment. It adds each child's best score per activity per local day, in their own time zone, for the last seven days, grouped by the level each attempt was saved with, and it never returns a user id. Drafts are never listed to a player. `VISION_ENDPOINT` is optional, and without it a read answers 503 `reader_off`.
  - **Admin API and pages.** Activities with levels, order and an etag per edit, settings including whether hard mode starts on, the copy review, the practice report and one child's progress. The Users tab is gone, because members live in the portal. The admin site cannot import the play part's files, because a play push deploys only the games site, so `admin/web/` holds byte for byte copies of the eight shared modules and a test fails when they differ.
  - **Storage keys.** The style, size, hard mode, open level and practice clock keys move to the shell's `GameStorage`, so two children on one iPad never share one. A device with no hard mode choice starts from the admin's default.
  - **Dev and tests.** `dev/fake-vision.ts` answers the read feature with no network and wants only a bearer token. The pure-logic suites run unchanged on `node:test` (`test/letterjoin/`), the server rules and routes in `test/letterjoin.test.ts`, and Playwright covers a child tracing an activity at `/g/letterjoin/` and an admin editing it, reviewing the copy and reading the practice report.

Content migrates at cutover. The player-data tool is built and tested, dry-runs by default, and writes only with `--apply --confirm-player-data`, which the type enforces ([`migrate.ts`](sketch/migrate.ts)). It matches each child by email. A drawpad `oid` maps through the email its old `profiles` row recorded to the portal's emails rows, and falls back to the identities rows only when that email is not a member. A letterjoin key is the sha256 of a portal emails row. A dry run counts every unmapped key, and `--show-emails` names the email the old app recorded for each, so the owner can add that member and run again. It turns drawpad's per-child limits into `settings` rows, and moves letterjoin's review fields into `reviews`. It drops drawpad's names and time zones, so each child chooses them again on `/welcome/` (review N6). Both tools read the old accounts only and insert if absent, so reruns converge.

### One repo, two codebases

The games app and the admin app are two codebases sharing each game's data part. A separate admin repo would need the data parts published as packages, versioned against two consumers, which is the contract machinery this revision deletes. Split when a second person owns the admin app or a game, or when CI for unrelated changes slows every merge. Neither is true today.

### Local dev and tests

`npm run dev` starts letterjoin's fake IdP, which signs tokens for both audiences, stamps `auth_time` when its fake popup runs, and answers the OBO grant. It also starts a fake Graph, a fake Foundry that answers drawpad's chat and image calls and a fake Vision that answers letterjoin's handwriting reads, both with no network and no keys, both sites on two ports so they stay two origins, and one node process serving every Function app through `serveWithNode` with the real token checks. Nothing watches a queue in dev, so `deliverQueues` hands each message to its worker in process, one at a time and tried three times like the queue extension. A game's `LOCAL_JOB_EVENTS` setting makes its admin API send the event that Event Grid sends in Azure.

[`conformance.ts`](sketch/conformance.ts) runs a player suite and an admin suite per game. Table tests cover `decide`, `elevate`, `computeDrift`, and `targetsFor`, and `boundaries` proves forbidden imports fail `tsc -b`.

### Adding a game

1. Create `games/<id>/manifest.ts` with an owner for every storage name.
2. Add `data/`, `play/web/`, and `play/api/`, and `admin/` if the game has content to manage. A part with `web: { kind: 'vite' }` has a `vite.config.ts` and a `tsconfig.json` in its `web/` folder. `npm run build:web` builds it to `web/dist/`, and gen adds its project to `tsconfig.games.json`. A manifest `csp` widens the policy on that game's own routes of that site.
3. Add `infra.bicep` if the game needs its own Azure resources, tagging each with the `tags` parameter. It takes `tags`, `location`, `storageAccountName`, `playPrincipalId`, `adminPrincipalId` and `queues`, and may output `playSettings` and `adminSettings`. The pipeline merges the first into the player app and the second, each name prefixed by the upper-case game id, into the admin app, and applies the admin ones again after every shared infra run because Bicep writes that app's settings in full.
4. Run `npm test`. Gen runs first, and both conformance suites cover the new game.
5. Merge. `deploy.yml` creates the game's infra, then deploys its player app, the games site, and, with an admin part, the admin app and admin site. No Mac step.
6. On the members page, tick the game for each child who should see it.

Role assignments can take up to 30 minutes to propagate (verified, table RBAC), so a game's first deploy retries a 403 for that long.

## Revision history

Revision 1 chose co-hosted pages (c3) from a three-way bakeoff. Revisions 2 to 4 added West Europe, assignment required, migrations, pipelines, cost by game, and per-game storage. Revision 5 added artifacts and pins. Revision 6 ran Entra changes as you through OBO.

### Revision 7: two apps, elevation, deploy on merge

Applied from your two directives and the adversarial review:

- Deleted first: pins, artifacts, `ReleaseManifest`, `web-release`, `release.yml`, and contract versions (W8, which makes W3 moot). Role ladders, `requires`, `effectiveRole`, `adminPath`, the `/admin/` hub, and both in-game admin modes. The claim step and `not_claimed` (W9). The `GameTelemetry` envelope (W10). The `names` table (cut 6). Four deploy identities (cut 5). `id-g4k-infra`'s Entra role.
- A second site, registration, and audience for administration (C1, directive B).
- Elevation per Entra task with `prompt=login` and `auth_time` (directive A, N11).
- A dedicated admin account that holds Guest Inviter and owns only the games4kids enterprise application, and an alarm on any app role held by the admin app (C2, W6).
- One writer per game table, `reviews` split from `submissions`, and drawpad's worker in the admin app.
- W1, W2, W4, W5, W7, W11, W12, N1 to N10, N12, and N13 as cited above.

## Tradeoffs accepted

- Two sites, two shells, and two kinds of backend, for no admin power anywhere a child's token reaches.
- A popup and a password before each Entra task, for no Graph power during everyday admin work.
- Elevation bound to a task by the shell and to a 10-minute window by the server, for no elevation state to store.
- A separate admin account to sign in with, for OBO bounded by roles rather than by Global Administrator.
- One trust domain across player apps, for one games token per child.
- Each site deploys whole from `main`, for no release store and rollback by revert.
- A shell that only grows, for no version machinery.
- A Mac rerun after the first infra run, for no Entra right in any pipeline.
- A page load between games and a cold start per game app, for zero coupling between game runtimes and no idle bill.
- A telemetry cap that can blind a day, alerted, for a bill inside the free grant.
- Player history waiting in the old apps, for no change to the old resource groups.

## Alternatives considered

- **One site with an in-app admin role (revision 6).** Every page shared one origin and one MSAL cache, and the games client was pre-authorized for the admin scope, so any game page could silently get a token the admin app accepted (C1). Splitting by path or CSP cannot separate one browser principal.
- **Release pins and artifacts (revision 5).** A second store of truth beside git, a contract rule with two live shell majors, pin races, and rollback blocked by any game pinned ahead of the shell. For one person in one repo, `main` is the release.
- **A standing admin identity with Graph rights (revision 5).** An application permission works with nobody signed in, which directive A rules out.
- **OBO on every admin request (revision 6).** Your Graph power was live for the whole session.
- **Iframes.** Silent token calls in an iframe fail when third-party cookies are blocked (verified, [third-party cookies](https://learn.microsoft.com/en-us/entra/identity-platform/reference-third-party-cookies-spas)).
- **A Static Web App per game.** Each origin has its own MSAL cache, so each game's first visit per tab would bounce through Entra (inferred), and Free allows 10 apps per subscription.
- **Azure Front Door.** The Standard base fee is 35 USD a month (verified list price, [pricing](https://azure.microsoft.com/en-us/pricing/details/frontdoor/)), more than ten times the guessed bill.

## Open questions and risks

- Is a popup per Entra task acceptable on the iPad, or do you want the 10-minute window to cover several tasks? Today the shell discards the elevation after one task.
- Should drift show without elevating? Listing assignments needs Graph, so today the Entra panel elevates to look.
- Are cold starts acceptable? An always-ready instance has no free grant (verified, Flex plan).
- Can the workbook query Cost Management on this Pay-As-You-Go subscription? Untested.
- Is 0.16 GB a day enough? A guess until a week of real use.
- The migrations run on your Mac because a pipeline would need read roles on the old storage accounts. Do you accept that?
- Can a Function app's platform CORS expose `ETag` and `WWW-Authenticate` to the page? Neither is a CORS-safelisted response header, and I found no setting that exposes them (inferred, unchecked). The shell reads the step-up and the claims challenge from the error body, and an image whose ETag it cannot read is fetched again, which the browser's own cache revalidates.
- Does the Functions queue trigger run on `STORAGE__queueServiceUri` with a user-assigned identity, and can it read `stencil-jobs` with the queue-scoped role alone? The extension may create `stencil-jobs-poison`, which that role does not allow. drawpad's worker settles its job on the last attempt, so nothing should poison (inferred, unchecked).
- Resolved: the `id-g4k-infra` role condition allows Storage Queue Data Message Sender (`c6a89b2d-59bc-44d0-9896-0f6e12d7b80a`) for drawpad's Event Grid topic, and bootstrap registers `Microsoft.EventGrid`. A test keeps the condition in step with every `.bicep` under `infra/` and `games/`.
- Would a parent join as a guest or wait for External ID?

## Build plan

Each phase starts only when the previous phase's named check is green.

1. **Scaffold, `@g4k/host`, and identity.** B1: unit suites, `decide`, `elevate`, and `computeDrift` table tests, and both conformance suites on a fixture game pass, including a games token refused by the admin module and a player store that cannot write an admin table.
2. **Both shells, the portal app, the admin app, and the dev stack.** B2: Playwright on the dev stack covers saving a member with one game, a sync in a fake popup, the child seeing only that game, a revoke refused on the next call, and a step-up when `auth_time` is 11 minutes old.
3. **Deploy routing.** B3: `targetsFor` table tests pass for every row of the rule in `deploy.ts`.
4. **drawpad port.** Its Vitest suite, both conformance suites, and Playwright smokes reaching `time_up` on the games site and a finished AI job on the admin site.
5. **letterjoin port.** Its re-keyed `node --test` suite on a new harness, both conformance suites, and its e2e flows at `/g/letterjoin/` on both sites.
6. **Bootstrap.** B4: a token from the elevation popup carries `auth_time`, and a silently refreshed `admin.console` token carries the old value. B5: the admin account, as owner of the games4kids enterprise application, can POST and DELETE an assignment on games4kids and is refused on another app. B6: `findUser` finds one real existing guest under `User.ReadBasic.All` by its mail or its encoded guest UPN, and a sync for that guest sends no invitation. A second bootstrap run changes nothing.
7. **Pipelines and the workbook.** B7: a run from a branch cannot enter `infra` or `deploy`. A push to `games/letterjoin/play` deploys only `func-g4k-letterjoin` and the games site. A fixture game merges and deploys both sides with no Mac step. The workbook shows both games, and cost tiles are checked 72 hours later.
8. **Onboarding and content.** A family member saved on the members page and synced sees only their granted games, and a second content apply writes nothing.
9. **Player-data migration, not applied.** `migrate.test` passes and a dry run reports counts and unmapped keys. Applying waits for your word.

## Next implementation step

Write `packages/host` identity, `createPlayerApp`, `StorageFor`, `verifyAdminToken`, `elevate`, and `graphAs` against their tests with the fake IdP for both audiences, so admission, step-up, and storage ownership are green before any game is copied in.
