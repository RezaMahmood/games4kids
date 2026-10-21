import type { GameId, Me, PortalUserId, Profile } from '@g4k/sdk';
import { asDisplayEmail, asGameId, asPortalUserId, fieldsOf } from '../../../shared/ids.ts';

function parseProfile(raw: unknown): Profile | null {
	const { displayName, timeZone } = fieldsOf(raw);
	return typeof displayName === 'string' && typeof timeZone === 'string' ? { displayName, timeZone } : null;
}

/** A game whose paused flag is missing or not a boolean is dropped, never shown as playable. */
function parseGame(raw: unknown): { readonly id: GameId; readonly paused: boolean }[] {
	const { id, paused } = fieldsOf(raw);
	const game = asGameId(id);
	return game && typeof paused === 'boolean' ? [{ id: game, paused }] : [];
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
			const games = Array.isArray(fields['games']) ? fields['games'].flatMap(parseGame) : [];
			return userId && profile ? { state: 'active', userId, profile, canRenameToday: fields['canRenameToday'] !== false, games } : null;
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
