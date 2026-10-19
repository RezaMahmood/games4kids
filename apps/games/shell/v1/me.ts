import type { Me, PortalUserId, Profile } from '@g4k/sdk';
import { asDisplayEmail, asGameId, asPortalUserId, fieldsOf } from '../../../shared/ids.ts';

function parseProfile(raw: unknown): Profile | null {
	const { displayName, timeZone } = fieldsOf(raw);
	return typeof displayName === 'string' && typeof timeZone === 'string' ? { displayName, timeZone } : null;
}

export function parseMe(raw: unknown): Me | null {
	const fields = fieldsOf(raw);
	switch (fields['state']) {
		case 'not-invited':
			return { state: 'not-invited', email: asDisplayEmail(fields['email']) };
		case 'no-profile':
			return { state: 'no-profile' };
		case 'active': {
			const userId = asPortalUserId(fields['userId']);
			const profile = parseProfile(fields['profile']);
			const games = Array.isArray(fields['games']) ? fields['games'].flatMap((id) => asGameId(id) ?? []) : [];
			return userId && profile ? { state: 'active', userId, profile, games } : null;
		}
		default:
			return null;
	}
}

export function parseCaller(raw: unknown): { readonly userId: PortalUserId; readonly profile: Profile } | null {
	const userId = asPortalUserId(fieldsOf(raw)['userId']);
	const profile = parseProfile(raw);
	return userId && profile ? { userId, profile } : null;
}
