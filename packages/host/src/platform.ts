import { randomUUID } from 'node:crypto';
import {
	parseGameId,
	type AdminPlatform,
	type AreaOf,
	type AzureService,
	type GameId,
	type GameManifest,
	type GameUsage,
	type PlayPlatform,
	type Roster,
	type SettingSpec,
	type Settings,
	type Tokens,
} from '@g4k/sdk';
import { storageFor, type Account } from './storage.ts';

export type Env = Readonly<Record<string, string | undefined>>;

/** A token for one Azure service, from the app's managed identity in Azure and a fake in tests. */
export type TokenSource = (service: AzureService) => Promise<string>;

/** Config is parsed once at startup, so a bad id or a missing setting stops the app before it serves anything. */
export function requireGameId(manifest: GameManifest): GameId {
	const id = parseGameId(manifest.id);
	if (typeof id !== 'string') throw new Error(`manifest id: ${id.problem}`);
	return id;
}

function parseSetting(name: string, spec: SettingSpec, raw: string | undefined): string | number | undefined {
	switch (spec.kind) {
		case 'int': {
			if (raw === undefined || raw === '') return spec.default;
			const value = Number(raw);
			if (!Number.isInteger(value) || value < spec.min || value > spec.max) throw new Error(`${name} must be an integer from ${spec.min} to ${spec.max}`);
			return value;
		}
		case 'url':
		case 'string': {
			if (raw === undefined || raw === '') {
				if (spec.optional) return undefined;
				throw new Error(`${name} is required`);
			}
			if (spec.kind === 'url' && !URL.canParse(raw)) throw new Error(`${name} must be a URL`);
			return raw;
		}
	}
}

/** Each setting is read from `${prefix}${name}`. The admin app hosts every game's module, so it prefixes `<ID>_`. */
export function parseSettings<S extends Readonly<Record<string, SettingSpec>>>(specs: S, env: Env, prefix: string): Settings<S> {
	const values = Object.entries(specs).map(([name, spec]) => [name, parseSetting(`${prefix}${name}`, spec, env[`${prefix}${name}`])]);
	return Object.fromEntries(values) as Settings<S>;
}

export function tokensFor<V extends AzureService>(services: readonly V[], source: TokenSource): Tokens<V> {
	return Object.fromEntries(services.map((service) => [service, () => source(service)])) as Tokens<V>;
}

export type PlatformHost = { readonly account: Account; readonly env: Env; readonly tokens: TokenSource; readonly now: () => Date };

export function playPlatform<M extends GameManifest>(manifest: M, game: GameId, host: PlatformHost): PlayPlatform<M> {
	return {
		...storageFor(manifest, 'play', host.account),
		game,
		now: host.now,
		newId: randomUUID,
		settings: parseSettings(manifest.play.settings, host.env, ''),
		tokens: tokensFor(manifest.play.services, host.tokens),
	};
}

const NO_ADMIN_PART = { web: { kind: 'static' }, settings: {}, services: [] } as const;

export function adminPlatform<M extends GameManifest>(manifest: M, game: GameId, host: PlatformHost, roster: Roster, usage: GameUsage<AreaOf<M>>): AdminPlatform<M> {
	const part = manifest.admin ?? NO_ADMIN_PART;
	return {
		...storageFor(manifest, 'admin', host.account),
		game,
		now: host.now,
		newId: randomUUID,
		settings: parseSettings(part.settings, host.env, `${game.toUpperCase()}_`) as AdminPlatform<M>['settings'],
		tokens: tokensFor(part.services, host.tokens) as AdminPlatform<M>['tokens'],
		roster,
		usage,
	};
}

/** The AI areas an admin part declares, which are all `platform.usage.record` takes. */
export const areasOf = <M extends GameManifest>(manifest: M): readonly AreaOf<M>[] => Object.keys(manifest.admin?.ai ?? {}) as AreaOf<M>[];
