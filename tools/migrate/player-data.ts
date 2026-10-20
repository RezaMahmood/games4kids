import { createHash } from 'node:crypto';
import { parseEmail, parseEntraObjectId, parsePortalUserId, type Brand, type Email, type EntraObjectId, type PortalUserId, type Row } from '@g4k/sdk';
import { collect, execute, readCounts, planBuilder, snapshotTarget, whole, type Layout, type MigrationReport, type OldAccounts, type PlanBuilder, type Plan, type TargetReader, type TargetSnapshot, type TargetWriter } from './model.ts';

export const PLAYER_DATA = {
	drawpad: { tables: ['drawings', 'usage', 'settings'], containers: ['drawings'] },
	letterjoin: { tables: ['results', 'attempts', 'submissions', 'reviews'], containers: ['submissions'] },
} as const satisfies Layout;

export const ENTRA_ISSUER = 'entra';

export type LetterjoinUserKey = Brand<string, 'LetterjoinUserKey'>;

export const letterjoinUserKey = (email: Email): LetterjoinUserKey => createHash('sha256').update(email).digest('hex') as LetterjoinUserKey;

export type PlayerDataMapping = {
	readonly drawpad: ReadonlyMap<EntraObjectId, PortalUserId>;
	readonly letterjoin: ReadonlyMap<LetterjoinUserKey, PortalUserId>;
};

export type PortalRows = { readonly identities: readonly Row[]; readonly emails: readonly Row[] };

export const NO_PORTAL_ROWS: PortalRows = { identities: [], emails: [] };

export function buildMapping(portal: PortalRows): PlayerDataMapping {
	const drawpad = new Map<EntraObjectId, PortalUserId>();
	for (const row of portal.identities) {
		const bar = row.rowKey.indexOf('|');
		const objectId = bar > 0 && row.rowKey.slice(0, bar) === ENTRA_ISSUER ? parseEntraObjectId(row.rowKey.slice(bar + 1)) : null;
		const userId = parsePortalUserId(row['userId']);
		if (objectId && userId) drawpad.set(objectId, userId);
	}
	const letterjoin = new Map<LetterjoinUserKey, PortalUserId>();
	for (const row of portal.emails) {
		const email = parseEmail(row.rowKey);
		const userId = parsePortalUserId(row['userId']);
		if (email && userId) letterjoin.set(letterjoinUserKey(email), userId);
	}
	return { drawpad, letterjoin };
}

export type PlayerSource = {
	readonly drawpad: { readonly drawings: readonly Row[]; readonly usage: readonly Row[]; readonly profiles: readonly Row[]; readonly drawingFiles: readonly string[] };
	readonly letterjoin: { readonly results: readonly Row[]; readonly attempts: readonly Row[]; readonly submissions: readonly Row[]; readonly submissionFiles: readonly string[] };
};

const USER_KEY = /^[0-9a-f]{64}$/;
const PRACTICE_PREFIX = 'practice-';
const ALL = 'all';
const PROFILES_PK = 'p';
const CHILD_LIMITS_PK = 'child';
const REVIEW_PK = 'review';
const MAX_LIMIT_MINUTES = 24 * 60;

const copy = (row: Row, partitionKey: string, fields: readonly string[]): Row => ({
	partitionKey,
	rowKey: row.rowKey,
	...Object.fromEntries(fields.flatMap((name) => (row[name] === undefined ? [] : [[name, row[name]]]))),
});

const isText = (row: Row, ...fields: string[]) => fields.every((name) => typeof row[name] === 'string');

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function splitPath(path: string): [string, string] | null {
	const slash = path.indexOf('/');
	return slash > 0 && slash < path.length - 1 ? [path.slice(0, slash), path.slice(slash + 1)] : null;
}

function planDrawpad(source: PlayerSource['drawpad'], mapping: PlayerDataMapping, into: PlanBuilder): void {
	const userOf = (oldKey: string) => {
		const objectId = parseEntraObjectId(oldKey);
		return objectId ? mapping.drawpad.get(objectId) : undefined;
	};

	for (const row of source.drawings) {
		const userId = userOf(row.partitionKey);
		if (!userId) into.unmapped('drawpad', row.partitionKey, 'row');
		else if (!isText(row, 'pictureId', 'kind', 'status', 'createdAt', 'updatedAt')) into.reject('drawpad/drawings', 'a drawing field is missing');
		else into.row('drawpad', 'drawings', copy(row, userId, ['pictureId', 'kind', 'status', 'createdAt', 'updatedAt', 'score', 'filledRegions', 'customFills']));
	}
	for (const row of source.usage) {
		const userId = userOf(row.partitionKey);
		if (!userId) into.unmapped('drawpad', row.partitionKey, 'row');
		else if (!isNumber(row['seconds']) || row['seconds'] < 0) into.reject('drawpad/usage', 'seconds is not a number');
		else into.row('drawpad', 'usage', copy(row, userId, ['seconds']));
	}
	for (const row of source.profiles) {
		if (row.partitionKey !== PROFILES_PK || row['dailyLimitMinutes'] === undefined) continue;
		const userId = userOf(row.rowKey);
		if (!userId) into.unmapped('drawpad', row.rowKey, 'row');
		else if (!whole(row['dailyLimitMinutes'], 0, MAX_LIMIT_MINUTES)) into.reject('drawpad/settings', 'a child limit is not minutes');
		else into.row('drawpad', 'settings', { partitionKey: CHILD_LIMITS_PK, rowKey: userId, dailyLimitMinutes: row['dailyLimitMinutes'] });
	}
	for (const path of source.drawingFiles) {
		const parts = splitPath(path);
		const userId = parts && userOf(parts[0]);
		if (parts && !userId) into.unmapped('drawpad', parts[0], 'file');
		else if (parts && userId) into.blob('drawpad', 'drawings', path, `${userId}/${parts[1]}`);
		else into.reject('drawpad/drawings', 'a file path has no owner folder');
	}
}

function planLetterjoin(source: PlayerSource['letterjoin'], mapping: PlayerDataMapping, into: PlanBuilder): void {
	const userOf = (oldKey: string) => (USER_KEY.test(oldKey) ? mapping.letterjoin.get(oldKey as LetterjoinUserKey) : undefined);

	for (const row of source.results) {
		const practice = row.partitionKey.startsWith(PRACTICE_PREFIX);
		const oldKey = practice ? row.partitionKey.slice(PRACTICE_PREFIX.length) : row.partitionKey;
		if (!USER_KEY.test(oldKey)) {
			into.reject('letterjoin/results', 'partition is not a user key');
			continue;
		}
		const userId = userOf(oldKey);
		if (!userId) into.unmapped('letterjoin', oldKey, 'row');
		else if (practice && isNumber(row['seconds'])) into.row('letterjoin', 'results', copy(row, `${PRACTICE_PREFIX}${userId}`, ['seconds']));
		else if (!practice && isNumber(row['score']) && isNumber(row['timeMs']) && isText(row, 'completedAt')) into.row('letterjoin', 'results', copy(row, userId, ['score', 'timeMs', 'hard', 'completedAt']));
		else into.reject('letterjoin/results', 'a result field is missing');
	}
	for (const row of source.attempts) {
		const userId = userOf(row.partitionKey);
		if (!userId) into.unmapped('letterjoin', row.partitionKey, 'row');
		else if (isText(row, 'activityId', 'level', 'completedAt') && isNumber(row['chars']) && isNumber(row['score']) && isNumber(row['timeMs'])) {
			into.row('letterjoin', 'attempts', copy(row, userId, ['activityId', 'level', 'chars', 'score', 'timeMs', 'hard', 'completedAt']));
		} else into.reject('letterjoin/attempts', 'an attempt field is missing');
	}
	for (const row of source.submissions) {
		if (row.partitionKey !== ALL) {
			const userId = userOf(row.partitionKey);
			if (!userId) into.unmapped('letterjoin', row.partitionKey, 'row');
			else if (isText(row, 'id')) into.row('letterjoin', 'submissions', copy(row, userId, ['id']));
			else into.reject('letterjoin/submissions', 'a pointer row has no id');
			continue;
		}
		const oldKey = row['userKey'];
		const userId = typeof oldKey === 'string' ? userOf(oldKey) : undefined;
		if (!userId) {
			into.unmapped('letterjoin', typeof oldKey === 'string' ? oldKey : '(no user key)', 'row');
			continue;
		}
		if (!isText(row, 'id', 'activityId', 'activityTitle', 'createdAt') || !isNumber(row['bytes'])) {
			into.reject('letterjoin/submissions', 'a submission field is missing');
			continue;
		}
		const id = row['id'] as string;
		into.row('letterjoin', 'submissions', { ...copy(row, ALL, ['id', 'activityId', 'activityTitle', 'bytes', 'createdAt']), userId, blobName: `${userId}/${id}.png` });
		const note = typeof row['note'] === 'string' ? row['note'] : '';
		if (row['reviewed'] === true || note !== '') {
			const reviewedAt = row['reviewed'] === true && typeof row['reviewedAt'] === 'string' ? { reviewedAt: row['reviewedAt'] } : {};
			into.row('letterjoin', 'reviews', { partitionKey: REVIEW_PK, rowKey: id, reviewed: row['reviewed'] === true, discarded: false, note, ...reviewedAt });
		}
	}
	for (const path of source.submissionFiles) {
		const parts = splitPath(path);
		const userId = parts && userOf(parts[0]);
		if (parts && !userId) into.unmapped('letterjoin', parts[0], 'file');
		else if (parts && userId) into.blob('letterjoin', 'submissions', path, `${userId}/${parts[1]}`);
		else into.reject('letterjoin/submissions', 'a file path has no owner folder');
	}
}

export function planPlayerData(source: PlayerSource, mapping: PlayerDataMapping, target: TargetSnapshot): Plan {
	const into = planBuilder(target);
	planDrawpad(source.drawpad, mapping, into);
	planLetterjoin(source.letterjoin, mapping, into);
	return into.build();
}

export async function readPlayerSource(from: OldAccounts): Promise<PlayerSource> {
	return {
		drawpad: {
			drawings: await collect(from.drawpad.table('drawings').list()),
			usage: await collect(from.drawpad.table('usage').list()),
			profiles: await collect(from.drawpad.table('profiles').list()),
			drawingFiles: await collect(from.drawpad.container('drawings').list('')),
		},
		letterjoin: {
			results: await collect(from.letterjoin.table('results').list()),
			attempts: await collect(from.letterjoin.table('attempts').list()),
			submissions: await collect(from.letterjoin.table('submissions').list()),
			submissionFiles: await collect(from.letterjoin.container('submissions').list('')),
		},
	};
}

export type PlayerDataConfirmation = Brand<'confirm-player-data', 'PlayerDataConfirmation'>;

export type PlayerDataCommand =
	| { readonly kind: 'dry-run'; readonly refusal: string | null }
	| { readonly kind: 'apply'; readonly confirmation: PlayerDataConfirmation };

export const APPLY_REFUSAL = 'Refusing to write: applying player data needs both --apply and --confirm-player-data, and waits for the owner.';

export function parseConfirmation(argv: readonly string[]): PlayerDataConfirmation | null {
	return argv.includes('--apply') && argv.includes('--confirm-player-data') ? ('confirm-player-data' as PlayerDataConfirmation) : null;
}

export function parseCommand(argv: readonly string[]): PlayerDataCommand {
	const confirmation = parseConfirmation(argv);
	if (confirmation) return { kind: 'apply', confirmation };
	return { kind: 'dry-run', refusal: argv.includes('--apply') || argv.includes('--confirm-player-data') ? APPLY_REFUSAL : null };
}

export type PlayerDataRun =
	| { readonly mode: 'dry-run'; readonly mapping: PlayerDataMapping; readonly target: TargetReader }
	| { readonly mode: 'apply'; readonly mapping: PlayerDataMapping; readonly target: TargetWriter; readonly confirmation: PlayerDataConfirmation };

export async function migratePlayerData(run: PlayerDataRun, from: OldAccounts): Promise<MigrationReport> {
	const source = await readPlayerSource(from);
	const plan = planPlayerData(source, run.mapping, await snapshotTarget(run.target, PLAYER_DATA));
	const read = readCounts(source);
	if (run.mode === 'dry-run') return { mode: 'dry-run', read, plan, outcomes: {} };
	return { mode: 'apply', read, plan, outcomes: await execute(plan, from, run.target) };
}
