import type { Email, Row } from '@g4k/sdk';

export type Game = 'drawpad' | 'letterjoin';

/** The old apps' storage, which the migration tools only ever read. */
export const OLD_ACCOUNTS = {
	drawpad: { name: 'stdp2qnzjgj6a3qtq', resourceGroup: 'rg-drawpad' },
	letterjoin: { name: 'stletterjoinul5nga', resourceGroup: 'rg-letterjoin' },
} as const satisfies Readonly<Record<Game, { readonly name: string; readonly resourceGroup: string }>>;

export type SourceBlob = { readonly bytes: Uint8Array; readonly contentType: string };

export type OldTable = { list(): AsyncIterable<Row> };

export type OldContainer = {
	list(prefix: string): AsyncIterable<string>;
	get(path: string): Promise<SourceBlob | undefined>;
};

export type OldAccount = {
	table(name: string): OldTable;
	container(name: string): OldContainer;
};

export type OldAccounts = Readonly<Record<Game, OldAccount>>;

export type TargetReader = {
	tableKeys(game: Game, table: string): Promise<ReadonlySet<string>>;
	blobNames(game: Game, container: string): Promise<ReadonlySet<string>>;
};

export type TargetWriter = TargetReader & {
	insertIfAbsent(game: Game, table: string, row: Row): Promise<boolean>;
	putIfAbsent(game: Game, container: string, path: string, blob: SourceBlob): Promise<boolean>;
};

export type Layout = Readonly<Record<Game, { readonly tables: readonly string[]; readonly containers: readonly string[] }>>;

export type Action =
	| { readonly kind: 'blob'; readonly game: Game; readonly container: string; readonly from: string; readonly to: string }
	| { readonly kind: 'row'; readonly game: Game; readonly table: string; readonly row: Row };

export type Counts = { planned: number; present: number; rejected: number };

export type Rejection = { readonly where: string; readonly reason: string; readonly count: number };

/** `email` is what the old app recorded for the key, so the owner can add that member and run again. */
export type Unmapped = { readonly game: Game; readonly oldKey: string; readonly email: Email | null; readonly rows: number; readonly files: number };

export type Plan = {
	readonly actions: readonly Action[];
	readonly counts: Readonly<Record<string, Counts>>;
	readonly rejected: readonly Rejection[];
	readonly unmapped: readonly Unmapped[];
};

export type Outcome = { written: number; skipped: number; missing: number };

export type MigrationReport = {
	readonly mode: 'dry-run' | 'apply';
	readonly read: Readonly<Record<string, number>>;
	readonly plan: Plan;
	readonly outcomes: Readonly<Record<string, Outcome>>;
};

export function readCounts(source: Readonly<Record<string, Readonly<Record<string, readonly unknown[]>>>>): Record<string, number> {
	return Object.fromEntries(Object.entries(source).flatMap(([game, parts]) => Object.entries(parts).map(([name, items]) => [`${game}/${name}`, items.length])));
}

export const whole = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

export const rowId = (partitionKey: string, rowKey: string) => JSON.stringify([partitionKey, rowKey]);

const SYSTEM_FIELDS = new Set(['etag', 'timestamp']);

export function plainRow(row: Row): Row {
	return Object.fromEntries(Object.entries(row).filter(([name]) => !SYSTEM_FIELDS.has(name) && !name.startsWith('odata.'))) as Row;
}

export async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
	const all: T[] = [];
	for await (const item of items) all.push(item);
	return all;
}

export type TargetSnapshot = {
	hasRow(game: Game, table: string, partitionKey: string, rowKey: string): boolean;
	hasBlob(game: Game, container: string, path: string): boolean;
};

export async function snapshotTarget(reader: TargetReader, layout: Layout): Promise<TargetSnapshot> {
	const tables = new Map<string, ReadonlySet<string>>();
	const containers = new Map<string, ReadonlySet<string>>();
	for (const game of Object.keys(layout) as Game[]) {
		for (const table of layout[game].tables) tables.set(`${game}/${table}`, await reader.tableKeys(game, table));
		for (const container of layout[game].containers) containers.set(`${game}/${container}`, await reader.blobNames(game, container));
	}
	return {
		hasRow: (game, table, partitionKey, rowKey) => tables.get(`${game}/${table}`)?.has(rowId(partitionKey, rowKey)) ?? false,
		hasBlob: (game, container, path) => containers.get(`${game}/${container}`)?.has(path) ?? false,
	};
}

export function planBuilder(target: TargetSnapshot) {
	const blobs: Action[] = [];
	const rows: Action[] = [];
	const counts = new Map<string, Counts>();
	const rejections = new Map<string, Rejection>();
	const unmapped = new Map<string, Unmapped>();
	const planned = new Set<string>();

	const countsOf = (name: string) => {
		const existing = counts.get(name);
		if (existing) return existing;
		const made: Counts = { planned: 0, present: 0, rejected: 0 };
		counts.set(name, made);
		return made;
	};

	function reject(where: string, reason: string): void {
		countsOf(where).rejected++;
		const key = `${where}\u0000${reason}`;
		const existing = rejections.get(key);
		rejections.set(key, { where, reason, count: (existing?.count ?? 0) + 1 });
	}

	return {
		row(game: Game, table: string, row: Row): void {
			const where = `${game}/${table}`;
			const id = `${where}\u0000${rowId(row.partitionKey, row.rowKey)}`;
			if (planned.has(id)) return reject(where, 'two source rows map to one new key');
			if (target.hasRow(game, table, row.partitionKey, row.rowKey)) {
				countsOf(where).present++;
				return;
			}
			planned.add(id);
			countsOf(where).planned++;
			rows.push({ kind: 'row', game, table, row });
		},
		blob(game: Game, container: string, from: string, to: string): void {
			const where = `${game}/${container}`;
			const id = `${where}\u0000${to}`;
			if (planned.has(id)) return reject(where, 'two source files map to one new path');
			if (target.hasBlob(game, container, to)) {
				countsOf(where).present++;
				return;
			}
			planned.add(id);
			countsOf(where).planned++;
			blobs.push({ kind: 'blob', game, container, from, to });
		},
		reject,
		unmapped(game: Game, oldKey: string, kind: 'row' | 'file', email: Email | null): void {
			const key = `${game}\u0000${oldKey}`;
			const before = unmapped.get(key) ?? { game, oldKey, email, rows: 0, files: 0 };
			unmapped.set(key, kind === 'row' ? { ...before, rows: before.rows + 1 } : { ...before, files: before.files + 1 });
		},
		build(): Plan {
			return {
				actions: [...blobs, ...rows],
				counts: Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b))),
				rejected: [...rejections.values()],
				unmapped: [...unmapped.values()].sort((a, b) => a.game.localeCompare(b.game) || a.oldKey.localeCompare(b.oldKey)),
			};
		},
	};
}

export type PlanBuilder = ReturnType<typeof planBuilder>;

export async function execute(plan: Plan, from: OldAccounts, to: TargetWriter): Promise<Record<string, Outcome>> {
	const outcomes = new Map<string, Outcome>();
	const outcomeOf = (name: string) => {
		const existing = outcomes.get(name);
		if (existing) return existing;
		const made: Outcome = { written: 0, skipped: 0, missing: 0 };
		outcomes.set(name, made);
		return made;
	};
	for (const action of plan.actions) {
		if (action.kind === 'blob') {
			const outcome = outcomeOf(`${action.game}/${action.container}`);
			const blob = await from[action.game].container(action.container).get(action.from);
			if (!blob) outcome.missing++;
			else if (await to.putIfAbsent(action.game, action.container, action.to, blob)) outcome.written++;
			else outcome.skipped++;
		} else {
			const outcome = outcomeOf(`${action.game}/${action.table}`);
			if (await to.insertIfAbsent(action.game, action.table, action.row)) outcome.written++;
			else outcome.skipped++;
		}
	}
	return Object.fromEntries(outcomes);
}

/** Emails stay out of the report unless `showEmails`, so a pasted report names no child. */
export function formatReport(report: MigrationReport, { showEmails = false }: { readonly showEmails?: boolean } = {}): string[] {
	const { plan, outcomes } = report;
	const lines: string[] = [`mode: ${report.mode}`];
	for (const [name, n] of Object.entries(report.read)) lines.push(`old ${name}: ${n} read`);
	const names = Object.keys(plan.counts);
	if (names.length === 0) lines.push('nothing to migrate');
	for (const name of names) {
		const c = plan.counts[name];
		const o = outcomes[name];
		const applied = o ? `, written ${o.written}, skipped ${o.skipped}, missing source ${o.missing}` : '';
		lines.push(`${name}: to write ${c?.planned ?? 0}, already present ${c?.present ?? 0}, rejected ${c?.rejected ?? 0}${applied}`);
	}
	for (const r of plan.rejected) lines.push(`rejected ${r.where} x${r.count}: ${r.reason}`);
	for (const game of ['drawpad', 'letterjoin'] as const) {
		const keys = plan.unmapped.filter((u) => u.game === game);
		if (keys.length === 0) continue;
		lines.push(`${game}: ${keys.length} unmapped keys, ${keys.reduce((n, k) => n + k.rows, 0)} rows and ${keys.reduce((n, k) => n + k.files, 0)} files not migrated`);
		for (const k of keys) {
			const who = showEmails ? (k.email ?? 'no email in the old app') : 'run with --show-emails to see who';
			lines.push(`  unmapped ${k.oldKey.slice(0, 8)}... (${k.rows} rows, ${k.files} files): ${who}`);
		}
	}
	return lines;
}
