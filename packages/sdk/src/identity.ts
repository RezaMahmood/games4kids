import type { Brand } from './manifest.ts';

/** Minted by the admin app at invite (a UUID). The only user key a game stores. */
export type PortalUserId = Brand<string, 'PortalUserId'>;

/** Lowercased, guest `#EXT#` form unwrapped. Never in a row a games-side app reads, never telemetry. */
export type Email = Brand<string, 'Email'>;

/** A user or guest object id in the workforce tenant. */
export type EntraObjectId = Brand<string, 'EntraObjectId'>;

export type Profile = {
	readonly displayName: string;
	/** IANA zone, chosen on /welcome/. */
	readonly timeZone: string;
};

/** What a play handler knows about the person. A player, nothing more: no token, oid, email, role or admin flag. */
export type Caller = { readonly userId: PortalUserId; readonly displayName: string; readonly timeZone: string };

/** The admin behind an admin-module request. Only the admin app builds one. */
export type AdminCaller = { readonly objectId: EntraObjectId; readonly email: Email };

const EMAIL = /^[a-z0-9.!$%&'*+=^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseEmail(raw: unknown): Email | null {
	if (typeof raw !== 'string') return null;
	const email = raw.trim().toLowerCase();
	return email.length <= 254 && EMAIL.test(email) ? (email as Email) : null;
}

export function parsePortalUserId(raw: unknown): PortalUserId | null {
	return typeof raw === 'string' && GUID.test(raw) ? (raw.toLowerCase() as PortalUserId) : null;
}

export function parseEntraObjectId(raw: unknown): EntraObjectId | null {
	return typeof raw === 'string' && GUID.test(raw) ? (raw.toLowerCase() as EntraObjectId) : null;
}
