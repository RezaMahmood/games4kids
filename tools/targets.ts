import type { GameId } from '@g4k/sdk';

export type DeployTarget =
	| { readonly kind: 'infra-shared' }
	| { readonly kind: 'infra-game'; readonly game: GameId }
	| { readonly kind: 'player-app'; readonly game: GameId }
	| { readonly kind: 'portal-app' }
	| { readonly kind: 'admin-app' }
	| { readonly kind: 'games-site' }
	| { readonly kind: 'admin-site' };

type Kind = DeployTarget['kind'];
type Emit = Kind | 'every-player-app';

type Rule = { readonly pattern: RegExp; readonly emit: readonly Emit[] };

const SITES: readonly Emit[] = ['games-site', 'admin-site'];
const SIDES: readonly Emit[] = ['player-app', 'games-site', 'admin-app', 'admin-site'];
const APPS_AND_SITES: readonly Emit[] = ['every-player-app', 'portal-app', 'admin-app', ...SITES];
const EVERYTHING: readonly Emit[] = ['infra-shared', 'infra-game', ...APPS_AND_SITES];

export const RULES: readonly Rule[] = [
	{ pattern: /^games\/(?<game>[^/]+)\/play\//, emit: ['player-app', 'games-site'] },
	{ pattern: /^games\/(?<game>[^/]+)\/admin\//, emit: ['admin-app', 'admin-site'] },
	{ pattern: /^games\/(?<game>[^/]+)\/data\//, emit: SIDES },
	{ pattern: /^games\/(?<game>[^/]+)\/manifest\.ts$/, emit: ['infra-game', ...SIDES] },
	{ pattern: /^games\/(?<game>[^/]+)\/[^/]+\.bicep$/, emit: ['infra-game'] },
	{ pattern: /^apps\/games\/api\//, emit: ['portal-app'] },
	{ pattern: /^apps\/games\//, emit: ['games-site'] },
	{ pattern: /^apps\/admin\//, emit: ['admin-app', 'admin-site'] },
	{ pattern: /^(apps\/shared|design)\//, emit: SITES },
	{ pattern: /^packages\/host\//, emit: ['every-player-app', 'portal-app', 'admin-app'] },
	{ pattern: /^packages\/sdk\//, emit: EVERYTHING },
	{ pattern: /^infra\//, emit: ['infra-shared'] },
	{ pattern: /^(package\.json|package-lock\.json|tsconfig(\.base)?\.json|tools\/(gen|package-app|site-config)\.mjs|tools\/site-layout\.ts)$/, emit: APPS_AND_SITES },
];

const ORDER: readonly Kind[] = ['infra-shared', 'infra-game', 'player-app', 'portal-app', 'admin-app', 'games-site', 'admin-site'];

function expand(emit: Emit, game: GameId | undefined, games: readonly GameId[]): readonly DeployTarget[] {
	switch (emit) {
		case 'every-player-app':
			return games.map((id) => ({ kind: 'player-app', game: id }));
		case 'infra-game':
		case 'player-app':
			return (game === undefined ? games : [game]).map((id) => ({ kind: emit, game: id }));
		default:
			return [{ kind: emit }];
	}
}

const keyOf = (target: DeployTarget) => ('game' in target ? `${target.kind}:${target.game}` : target.kind);

const rank = (target: DeployTarget) => ORDER.indexOf(target.kind);

/**
 * Pure. The targets for the changed paths: first matching rule per path, deduplicated, infra before apps before sites,
 * and only for games that still exist (a deleted game's folder redeploys the sites and nothing else).
 * A path no rule matches (docs, tests, dev, workflows) deploys nothing.
 */
export function targetsFor(changedPaths: readonly string[], games: readonly GameId[]): readonly DeployTarget[] {
	const known = new Set<string>(games);
	const found = new Map<string, DeployTarget>();
	for (const path of changedPaths) {
		const rule = RULES.find(({ pattern }) => pattern.test(path));
		if (!rule) continue;
		const game = rule.pattern.exec(path)?.groups?.['game'] as GameId | undefined;
		for (const emit of rule.emit) {
			for (const target of expand(emit, game, games)) {
				if ('game' in target && !known.has(target.game)) continue;
				found.set(keyOf(target), target);
			}
		}
	}
	return [...found.values()].sort((a, b) => rank(a) - rank(b) || keyOf(a).localeCompare(keyOf(b)));
}

export const everything = (games: readonly GameId[]): readonly DeployTarget[] => targetsFor(['packages/sdk/index.ts'], games);

export type Plan = {
	readonly any: boolean;
	readonly infraShared: boolean;
	readonly infraGames: readonly string[];
	readonly apps: readonly string[];
	readonly sites: readonly ('games' | 'admin')[];
};

/** What the workflow's matrices read: infra flags and lists, app names (a game id, `portal` or `admin`) and site names. */
export function planOf(targets: readonly DeployTarget[]): Plan {
	return {
		any: targets.length > 0,
		infraShared: targets.some(({ kind }) => kind === 'infra-shared'),
		infraGames: targets.flatMap((target) => (target.kind === 'infra-game' ? [target.game] : [])),
		apps: targets.flatMap((target) => (target.kind === 'player-app' ? [target.game] : target.kind === 'portal-app' ? ['portal'] : target.kind === 'admin-app' ? ['admin'] : [])),
		sites: targets.flatMap((target) => (target.kind === 'games-site' ? ['games' as const] : target.kind === 'admin-site' ? ['admin' as const] : [])),
	};
}
