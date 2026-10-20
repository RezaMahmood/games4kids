/**
 * tools/changes.mjs. On every push to main, deploy.yml asks this for the targets the commit range touched and runs
 * one job per target. There is no artifact store and no pin: main is the release, and rollback is a revert merged
 * to main, which deploys the same way. Each site deploys whole from main.
 *
 * The rule, first match per path, each changed path adding its targets:
 *   games/<id>/play/**            player-app <id>, games-site
 *   games/<id>/admin/**           admin-app, admin-site
 *   games/<id>/data/**            player-app <id>, games-site, admin-app, admin-site
 *   games/<id>/manifest.ts        infra-game <id>, then everything games/<id>/data/** deploys
 *   games/<id>/infra.bicep        infra-game <id>
 *   apps/games/api/**             portal-app
 *   apps/games/**                 games-site
 *   apps/admin/**                 admin-app, admin-site
 *   apps/shared/**, design/**     games-site, admin-site
 *   packages/host/**              every player-app, portal-app, admin-app
 *   packages/sdk/**               every target
 *   infra/**                      infra-shared
 *   games/<id>/*.bicep            infra-game <id>   (infra.bicep and the modules beside it)
 *   package.json, package-lock.json, tsconfig*.json, tools/{gen,package-app,site-config}.mjs, tools/site-layout.ts
 *                                 every app and both sites
 * A path no row matches (docs, tests, dev, workflows) deploys nothing, and a game folder that no longer exists deploys
 * only the sites.
 * Infra targets run before the app and site targets of the same game. A new games/<id>/ folder therefore creates the
 * game's resources and then deploys both sides, with no Mac step.
 */

import type { GameId } from './manifest';

export type DeployTarget =
	| { readonly kind: 'infra-shared' }
	| { readonly kind: 'infra-game'; readonly game: GameId }
	| { readonly kind: 'player-app'; readonly game: GameId }
	| { readonly kind: 'portal-app' }
	| { readonly kind: 'admin-app' }
	| { readonly kind: 'games-site' }
	| { readonly kind: 'admin-site' };

/** Pure, table-tested against the rule above. Deduplicated, infra first. */
export function targetsFor(changedPaths: readonly string[], games: readonly GameId[]): readonly DeployTarget[] {
	throw new Error('not implemented');
}
