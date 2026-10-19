import type { AdminCatalogEntry } from '@g4k/sdk';
import { asGameId, fieldsOf } from '../../../shared/ids.ts';
import { getJson } from '../../../shared/json.ts';

/** /config.json on the admin site, written at deploy. */
export type AdminSiteConfig = {
	readonly authority: string;
	readonly clientId: string;
	/** api://<games4kids-admin>/admin.console */
	readonly consoleScope: string;
	/** api://<games4kids-admin>/admin.elevate */
	readonly elevateScope: string;
	readonly adminApiOrigin: string;
	/** Empty switches telemetry off. */
	readonly telemetryConnectionString: string;
};

const text = (raw: unknown, name: string): string => {
	const value = fieldsOf(raw)[name];
	if (typeof value !== 'string' || value === '') throw new Error(`config.json needs ${name}`);
	return value;
};

export function parseAdminConfig(raw: unknown): AdminSiteConfig {
	const config: AdminSiteConfig = {
		authority: text(raw, 'authority'),
		clientId: text(raw, 'clientId'),
		consoleScope: text(raw, 'consoleScope'),
		elevateScope: text(raw, 'elevateScope'),
		adminApiOrigin: text(raw, 'adminApiOrigin'),
		telemetryConnectionString: typeof fieldsOf(raw)['telemetryConnectionString'] === 'string' ? String(fieldsOf(raw)['telemetryConnectionString']) : '',
	};
	if (!URL.canParse(config.authority) || !URL.canParse(config.adminApiOrigin)) throw new Error('config.json authority and adminApiOrigin must be URLs');
	return config;
}

export function parseAdminCatalog(raw: unknown): readonly AdminCatalogEntry[] {
	if (!Array.isArray(raw)) throw new Error('catalog.json must be a list');
	return raw.flatMap((entry): AdminCatalogEntry[] => {
		const { id: rawId, title, hasAdmin } = fieldsOf(entry);
		const id = asGameId(rawId);
		return id && typeof title === 'string' && typeof hasAdmin === 'boolean' ? [{ id, title, hasAdmin, path: `/g/${id}/` }] : [];
	});
}

export const loadAdminConfig = async () => parseAdminConfig(await getJson('/config.json'));

export const loadAdminCatalog = async () => parseAdminCatalog(await getJson('/catalog.json'));
