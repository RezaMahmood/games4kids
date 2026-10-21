import type { CatalogEntry } from '@g4k/sdk';
import { asGameId, fieldsOf } from '../../../shared/ids.ts';
import { getJson } from '../../../shared/json.ts';

/** /config.json on the games site, written at deploy. No admin scope and no admin origin exist in it. */
export type GamesSiteConfig = {
	readonly authority: string;
	readonly clientId: string;
	/** api://<games4kids>/access_as_user */
	readonly scope: string;
	readonly portalApiOrigin: string;
	/** Empty switches telemetry off. */
	readonly telemetryConnectionString: string;
};

const text = (raw: unknown, name: string): string => {
	const value = fieldsOf(raw)[name];
	if (typeof value !== 'string') throw new Error(`config.json needs ${name}`);
	return value;
};

export function parseGamesConfig(raw: unknown): GamesSiteConfig {
	const config: GamesSiteConfig = {
		authority: text(raw, 'authority'),
		clientId: text(raw, 'clientId'),
		scope: text(raw, 'scope'),
		portalApiOrigin: text(raw, 'portalApiOrigin'),
		telemetryConnectionString: text(raw, 'telemetryConnectionString'),
	};
	for (const [name, value] of [['authority', config.authority], ['portalApiOrigin', config.portalApiOrigin]] as const) {
		if (!URL.canParse(value)) throw new Error(`config.json ${name} must be a URL`);
	}
	if (!config.clientId || !config.scope) throw new Error('config.json needs a clientId and a scope');
	return config;
}

export function parseCatalog(raw: unknown): readonly CatalogEntry[] {
	if (!Array.isArray(raw)) throw new Error('catalog.json must be a list');
	return raw.flatMap((entry): CatalogEntry[] => {
		const fields = fieldsOf(entry);
		const id = asGameId(fields['id']);
		const { title, summary, icon, apiBaseUrl } = fields;
		if (!id || typeof title !== 'string' || typeof summary !== 'string' || typeof icon !== 'string' || typeof apiBaseUrl !== 'string' || !URL.canParse(apiBaseUrl)) return [];
		return [{ id, title, summary, icon, path: `/g/${id}/`, apiBaseUrl, ...(fields['scoreboard'] === true ? { scoreboard: true as const } : {}) }];
	});
}

export const loadGamesConfig = async () => parseGamesConfig(await getJson('/config.json'));

export const loadCatalog = async () => parseCatalog(await getJson('/catalog.json'));
