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

export type DriftLine = { readonly kind: string; readonly userId: string | null; readonly text: string; readonly alarm: boolean };

/** One plain sentence for each drift the Entra check returns, by the names on this page. */
export function describeDrift(raw: unknown, members: readonly MemberRow[]): readonly DriftLine[] {
	if (!Array.isArray(raw)) return [];
	const nameOf = (userId: unknown) => members.find((member) => member.userId === userId)?.email ?? 'Someone';
	return raw.map((entry): DriftLine => {
		const drift = fieldsOf(entry);
		const kind = typeof drift['kind'] === 'string' ? drift['kind'] : 'unknown';
		const userId = typeof drift['userId'] === 'string' ? drift['userId'] : null;
		const line = (text: string, alarm = false): DriftLine => ({ kind, userId, text, alarm });
		switch (kind) {
			case 'needs-account':
				return line(`${nameOf(userId)} has no Entra account yet. Sync will find or invite one.`);
			case 'not-assigned':
				return line(`${nameOf(userId)} has an account but is not assigned to the games app. Sync will assign them.`);
			case 'wrong-account':
				return line(`${nameOf(userId)} is linked to an Entra account that does not match their address. Sync will link the matching account and remove the old one's access.`);
			case 'ambiguous-account': {
				const names = Array.isArray(drift['userPrincipalNames']) ? drift['userPrincipalNames'].join(', ') : '';
				return line(`${nameOf(userId)} matches more than one Entra account: ${names}. Nothing was changed.`, true);
			}
			case 'account-taken':
				return line(`${nameOf(userId)} matches the Entra account ${nameOf(drift['owner'])} signs in with. Nothing was changed.`, true);
			case 'assigned-revoked':
				return line(`${nameOf(userId)} is revoked but still assigned in Entra. Sync will remove the assignment.`);
			case 'unmanaged':
				return line('Entra has an assignment this page does not manage. It is left alone.');
			case 'admin-app-grant': {
				const grant = fieldsOf(drift['grant']);
				return line(`Alarm: the admin app holds an app role on ${String(grant['resourceDisplayName'] ?? 'another API')}. It should hold none.`, true);
			}
			default:
				return line('Entra reported something this page does not recognise.', true);
		}
	});
}

export const syncBody = (only: string | null) => ({ userId: only });

/**
 * What the page last heard from Entra: nothing until a check or a sync answers. `states` is each member's state when the
 * page asked, because the answer says nothing about a member whose state has changed since.
 */
export type DriftReport = { readonly kind: 'unchecked' } | CheckedReport;
type CheckedReport = { readonly kind: 'checked'; readonly lines: readonly DriftLine[]; readonly states: ReadonlyMap<string, MemberRow['state']> };

/** `asked` is the rows as they stood when the check or sync was sent. */
export function checkedReport(raw: unknown, asked: readonly MemberRow[]): CheckedReport {
	return { kind: 'checked', lines: describeDrift(raw, asked), states: new Map(asked.map((row) => [row.userId, row.state])) };
}

export type Standing = 'active' | 'not-synced' | 'revoked' | 'revoked-sync';

export const STANDING_LABEL: Readonly<Record<Standing, string>> = {
	active: 'Active',
	'not-synced': 'Not synced',
	revoked: 'Revoked',
	'revoked-sync': 'Revoked, sync needed',
};

export const needsSync = (standing: Standing): boolean => standing === 'not-synced' || standing === 'revoked-sync';

const SYNC_FIXES_ACTIVE: ReadonlySet<string> = new Set(['needs-account', 'not-assigned', 'wrong-account']);

export type Filter = 'all' | 'active' | 'revoked' | 'needs-sync';

export const FILTERS: readonly { readonly id: Filter; readonly label: string }[] = [
	{ id: 'all', label: 'All' },
	{ id: 'active', label: 'Active' },
	{ id: 'revoked', label: 'Revoked' },
	{ id: 'needs-sync', label: 'Needs sync' },
];

const MATCHES: Readonly<Record<Filter, (standing: Standing) => boolean>> = {
	all: () => true,
	active: (standing) => standing === 'active' || standing === 'not-synced',
	revoked: (standing) => standing === 'revoked' || standing === 'revoked-sync',
	'needs-sync': needsSync,
};

/**
 * A sync removes a revoked member's assignment but keeps their link, so a linked revoked member counts as still assigned
 * until Entra answers for them as revoked. A member restored since Entra answered needs a sync to be assigned again.
 */
export function standingOf(row: MemberRow, report: DriftReport): Standing {
	const then = report.kind === 'checked' ? report.states.get(row.userId) : undefined;
	const drift = report.kind === 'checked' && then === row.state ? report.lines.filter((line) => line.userId === row.userId).map((line) => line.kind) : null;
	if (row.state === 'revoked') return row.linked && (drift === null || drift.includes('assigned-revoked')) ? 'revoked-sync' : 'revoked';
	return !row.linked || then === 'revoked' || (drift?.some((kind) => SYNC_FIXES_ACTIVE.has(kind)) ?? false) ? 'not-synced' : 'active';
}

export type GameTitle = { readonly id: string; readonly title: string };

export function gamesSummary(grant: GameGrant, catalog: readonly GameTitle[]): string {
	if (grant.kind === 'all') return 'All games';
	const titles = catalog.filter((game) => grant.ids.includes(game.id)).map((game) => game.title);
	if (titles.length === 0) return 'No games';
	if (titles.length <= 2) return titles.join(', ');
	return `${titles.slice(0, 2).join(', ')} and ${titles.length - 2} more`;
}

export type Listed = { readonly row: MemberRow; readonly standing: Standing; readonly games: string };

/** An alarm outranks a sync because a sync cannot clear it. The page claims agreement only when Entra said nothing at all. */
export type Attention =
	| { readonly kind: 'alarm'; readonly alarms: readonly DriftLine[]; readonly people: number }
	| { readonly kind: 'needs-sync'; readonly people: number }
	| { readonly kind: 'unchecked' }
	| { readonly kind: 'notes'; readonly notes: number }
	| { readonly kind: 'agree' };

export type MembersView = {
	readonly listed: readonly Listed[];
	readonly counts: Readonly<Record<Filter, number>>;
	readonly attention: Attention;
};

const sortName = (row: MemberRow) => (row.displayName ?? row.email).toLocaleLowerCase();

export function membersView(rows: readonly MemberRow[], report: DriftReport, catalog: readonly GameTitle[], query: string, filter: Filter): MembersView {
	const everyone = rows.map((row): Listed => ({ row, standing: standingOf(row, report), games: gamesSummary(row.games, catalog) }));
	const needle = query.trim().toLocaleLowerCase();
	const found = needle === '' ? everyone : everyone.filter(({ row }) => row.email.toLocaleLowerCase().includes(needle) || (row.displayName?.toLocaleLowerCase().includes(needle) ?? false));
	const counts = Object.fromEntries(FILTERS.map(({ id }) => [id, found.filter(({ standing }) => MATCHES[id](standing)).length])) as Record<Filter, number>;
	const listed = found
		.filter(({ standing }) => MATCHES[filter](standing))
		.sort((a, b) => Number(needsSync(b.standing)) - Number(needsSync(a.standing)) || sortName(a.row).localeCompare(sortName(b.row)) || a.row.email.localeCompare(b.row.email));
	const people = everyone.filter(({ standing }) => needsSync(standing)).length;
	return { listed, counts, attention: attentionOf(report, people) };
}

function attentionOf(report: DriftReport, people: number): Attention {
	const alarms = report.kind === 'checked' ? report.lines.filter((line) => line.alarm) : [];
	if (alarms.length > 0) return { kind: 'alarm', alarms, people };
	if (people > 0) return { kind: 'needs-sync', people };
	if (report.kind === 'unchecked') return { kind: 'unchecked' };
	return report.lines.length === 0 ? { kind: 'agree' } : { kind: 'notes', notes: report.lines.length };
}
