import type { Row } from '@g4k/sdk';
import { collect, execute, readCounts, plainRow, planBuilder, snapshotTarget, whole, type Layout, type MigrationReport, type OldAccounts, type Plan, type PlanBuilder, type TargetReader, type TargetSnapshot, type TargetWriter } from './model.ts';

export const CONTENT = {
	drawpad: { tables: ['pictures', 'settings'], containers: ['pictures'] },
	letterjoin: { tables: ['activities'], containers: [] },
} as const satisfies Layout;

export type ContentSource = {
	readonly drawpad: { readonly pictures: readonly Row[]; readonly settings: readonly Row[]; readonly pictureFiles: readonly string[] };
	readonly letterjoin: { readonly activities: readonly Row[] };
};

export type ContentRules = { activityProblem(row: Row): string | null };

const PICTURES_PK = 'p';
const SETTINGS_PK = 's';
const DEFAULT_LIMIT_KEY = 'default';
const ACTIVITY_PK = 'activity';
const SETTING_PK = 'setting';
const SETTINGS_ROW = 'app';
const KINDS = ['trace', 'pbn'];
const MAX_DIMENSION = 1024;

export function requiredFiles(kinds: readonly string[]): string[] {
	return [...(kinds.includes('trace') ? ['outline.png'] : []), ...(kinds.includes('pbn') ? ['pbn.json', 'pbn-regions.png', 'pbn-preview.png'] : [])];
}

type PictureProblem = { readonly problem: string } | { readonly kinds: string[] };

function pictureKinds(row: Row): PictureProblem {
	const kinds = typeof row['kinds'] === 'string' ? row['kinds'].split(',') : [];
	if (kinds.length === 0 || !kinds.every((kind) => KINDS.includes(kind))) return { problem: 'kinds are not trace or pbn' };
	if (typeof row['title'] !== 'string' || row['title'].trim() === '') return { problem: 'no title' };
	if (!whole(row['width'], 1, MAX_DIMENSION) || !whole(row['height'], 1, MAX_DIMENSION)) return { problem: 'bad size' };
	if (typeof row['createdAt'] !== 'string') return { problem: 'no createdAt' };
	return { kinds };
}

function planPictures(source: ContentSource['drawpad'], into: PlanBuilder): void {
	const filesOf = new Map<string, string[]>();
	for (const path of source.pictureFiles) {
		const slash = path.indexOf('/');
		if (slash <= 0) continue;
		const id = path.slice(0, slash);
		filesOf.set(id, [...(filesOf.get(id) ?? []), path.slice(slash + 1)]);
	}
	const accepted = new Set<string>();
	for (const row of source.pictures) {
		if (row.partitionKey !== PICTURES_PK) {
			into.reject('drawpad/pictures', 'unexpected partition');
			continue;
		}
		const parsed = pictureKinds(row);
		if ('problem' in parsed) {
			into.reject('drawpad/pictures', parsed.problem);
			continue;
		}
		const have = new Set(filesOf.get(row.rowKey) ?? []);
		if (!requiredFiles(parsed.kinds).every((file) => have.has(file))) {
			into.reject('drawpad/pictures', 'a file its kinds need is missing');
			continue;
		}
		accepted.add(row.rowKey);
		for (const file of have) into.blob('drawpad', 'pictures', `${row.rowKey}/${file}`, `${row.rowKey}/${file}`);
		into.row('drawpad', 'pictures', plainRow(row));
	}
	for (const id of filesOf.keys()) if (!accepted.has(id)) into.reject('drawpad/pictures', 'files with no copyable picture row');
}

function planDrawpadSettings(rows: readonly Row[], into: PlanBuilder): void {
	for (const row of rows) {
		if (row.partitionKey === SETTINGS_PK && row.rowKey === DEFAULT_LIMIT_KEY && whole(row['dailyLimitMinutes'], 0, 24 * 60)) {
			into.row('drawpad', 'settings', { partitionKey: SETTINGS_PK, rowKey: DEFAULT_LIMIT_KEY, dailyLimitMinutes: row['dailyLimitMinutes'] });
		} else into.reject('drawpad/settings', 'not the default limit row');
	}
}

function planActivities(rows: readonly Row[], rules: ContentRules, into: PlanBuilder): void {
	for (const row of rows) {
		if (row.partitionKey === ACTIVITY_PK) {
			const problem = rules.activityProblem(row);
			if (problem) into.reject('letterjoin/activities', problem);
			else into.row('letterjoin', 'activities', plainRow(row));
		} else if (row.partitionKey === SETTING_PK && row.rowKey === SETTINGS_ROW && whole(row['dailyPracticeMinutes'], 0, 240)) {
			into.row('letterjoin', 'activities', { partitionKey: SETTING_PK, rowKey: SETTINGS_ROW, dailyPracticeMinutes: row['dailyPracticeMinutes'] });
		} else into.reject('letterjoin/activities', 'unexpected partition or row');
	}
}

export function planContent(source: ContentSource, target: TargetSnapshot, rules: ContentRules): Plan {
	const into = planBuilder(target);
	planPictures(source.drawpad, into);
	planDrawpadSettings(source.drawpad.settings, into);
	planActivities(source.letterjoin.activities, rules, into);
	return into.build();
}

export async function readContentSource(from: OldAccounts): Promise<ContentSource> {
	return {
		drawpad: {
			pictures: await collect(from.drawpad.table('pictures').list()),
			settings: await collect(from.drawpad.table('settings').list()),
			pictureFiles: await collect(from.drawpad.container('pictures').list('')),
		},
		letterjoin: { activities: await collect(from.letterjoin.table('activities').list()) },
	};
}

export type ContentRun = { readonly mode: 'dry-run'; readonly target: TargetReader } | { readonly mode: 'apply'; readonly target: TargetWriter };

export async function migrateContent(run: ContentRun, from: OldAccounts, rules: ContentRules): Promise<MigrationReport> {
	const source = await readContentSource(from);
	const plan = planContent(source, await snapshotTarget(run.target, CONTENT), rules);
	const read = readCounts(source);
	if (run.mode === 'dry-run') return { mode: 'dry-run', read, plan, outcomes: {} };
	return { mode: 'apply', read, plan, outcomes: await execute(plan, from, run.target) };
}
