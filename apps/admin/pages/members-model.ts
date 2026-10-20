import { fieldsOf } from '../../shared/ids.ts';

/** The admin API's grant: every game, including games added later, or the listed ones. */
export type GameGrant = { readonly kind: 'all' } | { readonly kind: 'some'; readonly ids: readonly string[] };

export type MemberRow = {
	readonly userId: string;
	readonly email: string;
	readonly state: 'active' | 'revoked';
	readonly games: GameGrant;
	readonly linked: boolean;
	readonly displayName: string | null;
};

function parseGrant(raw: unknown): GameGrant | null {
	const { kind, ids } = fieldsOf(raw);
	if (kind === 'all') return { kind };
	if (kind === 'some' && Array.isArray(ids)) return { kind, ids: ids.filter((id): id is string => typeof id === 'string') };
	return null;
}

/** GET portal/members. A row the page cannot read is left out rather than shown wrong. */
export function parseMembers(raw: unknown): readonly MemberRow[] {
	if (!Array.isArray(raw)) return [];
	return raw.flatMap((entry): MemberRow[] => {
		const { member, email, objectId, profile } = fieldsOf(entry);
		const { userId, state, games } = fieldsOf(member);
		const grant = parseGrant(games);
		if (typeof userId !== 'string' || typeof email !== 'string' || (state !== 'active' && state !== 'revoked') || !grant) return [];
		const displayName = fieldsOf(profile)['displayName'];
		return [{ userId, email, state, games: grant, linked: typeof objectId === 'string', displayName: typeof displayName === 'string' ? displayName : null }];
	});
}

export type DriftLine = { readonly kind: string; readonly text: string; readonly alarm: boolean };

/** One plain sentence for each drift the Entra check returns, by the names on this page. */
export function describeDrift(raw: unknown, members: readonly MemberRow[]): readonly DriftLine[] {
	if (!Array.isArray(raw)) return [];
	const nameOf = (userId: unknown) => members.find((member) => member.userId === userId)?.email ?? 'Someone';
	return raw.map((entry): DriftLine => {
		const drift = fieldsOf(entry);
		const kind = typeof drift['kind'] === 'string' ? drift['kind'] : 'unknown';
		switch (kind) {
			case 'needs-account':
				return { kind, text: `${nameOf(drift['userId'])} has no Entra account yet. Sync will find or invite one.`, alarm: false };
			case 'not-assigned':
				return { kind, text: `${nameOf(drift['userId'])} has an account but is not assigned to the games app. Sync will assign them.`, alarm: false };
			case 'assigned-revoked':
				return { kind, text: `${nameOf(drift['userId'])} is revoked but still assigned in Entra. Sync will remove the assignment.`, alarm: false };
			case 'unmanaged':
				return { kind, text: 'Entra has an assignment this page does not manage. It is left alone.', alarm: false };
			case 'admin-app-grant': {
				const grant = fieldsOf(drift['grant']);
				return { kind, text: `Alarm: the admin app holds an app role on ${String(grant['resourceDisplayName'] ?? 'another API')}. It should hold none.`, alarm: true };
			}
			default:
				return { kind, text: 'Entra reported something this page does not recognise.', alarm: true };
		}
	});
}

export const syncBody = (only: string | null) => ({ userId: only });
