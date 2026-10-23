import { parseGameId, type AiCall, type AiModel, type GameId, type GameUsage, type ReadTable, type Row, type Side, type Spend, type Table, type TokensOf } from '@g4k/sdk';
import { costMicroUsd, PRICE_VERSION, PRICES } from './prices.ts';
import type { Telemetry } from './telemetry.ts';

/** A draft must never wait on its own bill, so a write that takes longer is given up and logged. */
export const RECORD_TIMEOUT_MS = 5_000;
/** The first UTC month the ledger holds rows for. A game's spend reads each month from here to now. */
export const LEDGER_START = '2026-10';

export type UsageEntry = {
	/** The app that made the call: the admin app's ledger is a portal table, and each player app's is in its game's account. */
	readonly side: Side;
	readonly id: string;
	readonly at: string;
	readonly game: GameId;
	readonly area: string;
	readonly model: AiModel;
	readonly replyModel?: string;
	readonly item: string;
	readonly group?: string;
	readonly tokens: TokensOf[AiModel];
	readonly microUsd: number;
	readonly priceVersion: string;
};

/** Days, months and years are the admin's, in the UK, so a day is a calendar day in Europe/London. */
export type Period = 'day' | 'month' | 'year';

export type LedgerReader = {
	/** Every row of these games on these Europe/London days, `from` to `to` inclusive, as YYYY-MM-DD. */
	read(games: readonly GameId[], days: { readonly from: string; readonly to: string }): Promise<readonly UsageEntry[]>;
};

export type UsageLedger = LedgerReader & {
	/** One game's view: it records only as this game, only in `areas`, and reads only this game's partitions. */
	forGame<Area extends string>(game: GameId, areas: readonly Area[]): GameUsage<Area>;
};

export type LedgerDeps = {
	/** Whose ledger this is, which names the manifest's `ai` it checks areas against. */
	readonly side: Side;
	readonly now: () => Date;
	readonly newId: () => string;
	readonly telemetry: Pick<Telemetry, 'log' | 'exception'>;
};

const LONDON = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' });

/** The Europe/London calendar day of an instant, as YYYY-MM-DD. */
export function londonDay(at: Date): string {
	const part = (type: string) => LONDON.formatToParts(at).find((one) => one.type === type)?.value ?? '';
	return `${part('year')}-${part('month')}-${part('day')}`;
}

export function periodOf(at: Date, by: Period): string {
	const day = londonDay(at);
	switch (by) {
		case 'day':
			return day;
		case 'month':
			return day.slice(0, 7);
		case 'year':
			return day.slice(0, 4);
	}
}

const utcMonth = (at: Date) => at.toISOString().slice(0, 7);

/** Each YYYY-MM from `from` to `to` inclusive. */
function monthsBetween(from: string, to: string): string[] {
	const months: string[] = [];
	for (let at = new Date(`${from}-01T00:00:00Z`); utcMonth(at) <= to; at.setUTCMonth(at.getUTCMonth() + 1)) months.push(utcMonth(at));
	return months;
}

/**
 * The UTC month partitions that hold every row of these London days. London is UTC or an hour ahead, so a London day
 * starts at its own UTC midnight or at 23:00 UTC the day before, which on the 1st of a month in summer is last month.
 */
export function monthsForDays(from: string, to: string): string[] {
	const hourBefore = new Date(Date.parse(`${from}T00:00:00Z`) - 3_600_000);
	const start = londonDay(hourBefore) === from ? hourBefore : new Date(`${from}T00:00:00Z`);
	return monthsBetween(utcMonth(start), to.slice(0, 7));
}

const partitionOf = (game: GameId, month: string) => `${game}|${month}`;

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isModel = (value: unknown): value is AiModel => typeof value === 'string' && Object.hasOwn(PRICES, value);

/** The token kinds the model bills on, each a whole count, and nothing else. */
function parseTokens(model: AiModel, raw: unknown): TokensOf[AiModel] | undefined {
	if (typeof raw !== 'object' || raw === null) return undefined;
	const kinds = Object.keys(PRICES[model]);
	const counts = kinds.map((kind) => (raw as Record<string, unknown>)[kind]);
	return counts.every(isCount) ? (Object.fromEntries(kinds.map((kind, i) => [kind, counts[i]])) as TokensOf[AiModel]) : undefined;
}

/** A game's call checked as it crosses into the host, since a game could cast its way past the types. */
function parseCall(call: AiCall<string>, areas: ReadonlySet<string>, side: Side): { readonly tokens: TokensOf[AiModel] } | { readonly problems: readonly string[] } {
	const problems: string[] = [];
	const tokens = isModel(call.model) ? parseTokens(call.model, call.tokens) : undefined;
	if (!areas.has(call.area)) problems.push(`area "${call.area}" is not in the manifest's ${side}.ai`);
	if (!isModel(call.model)) problems.push(`model "${call.model}" has no price`);
	else if (!tokens) problems.push(`tokens must be whole counts of ${Object.keys(PRICES[call.model]).join(', ')}`);
	if (typeof call.subject?.item !== 'string' || call.subject.item === '') problems.push('subject.item must be an id');
	if (call.subject?.group !== undefined && typeof call.subject.group !== 'string') problems.push('subject.group must be an id');
	return tokens && problems.length === 0 ? { tokens } : { problems };
}

function entryRow(entry: UsageEntry): Row {
	const { side: _side, id, at, game, tokens, ...rest } = entry;
	return { partitionKey: partitionOf(game, utcMonth(new Date(at))), rowKey: `${at}|${id}`, ...rest, at, tokens: JSON.stringify(tokens) };
}

function parseEntry(row: Row, side: Side): UsageEntry | undefined {
	const [rawGame, month] = row.partitionKey.split('|');
	const game = parseGameId(rawGame ?? '');
	const [at, id] = row.rowKey.split('|');
	const { model, area, item, group, replyModel, microUsd, priceVersion } = row;
	if (typeof game !== 'string' || !month || !at || !id || !isModel(model) || typeof area !== 'string' || typeof item !== 'string' || !isCount(microUsd) || typeof priceVersion !== 'string') return undefined;
	let tokens: TokensOf[AiModel] | undefined;
	try {
		tokens = parseTokens(model, JSON.parse(String(row['tokens'])));
	} catch {
		return undefined;
	}
	if (!tokens) return undefined;
	return {
		side,
		id,
		at,
		game,
		area,
		model,
		item,
		tokens,
		microUsd,
		priceVersion,
		...(typeof group === 'string' && { group }),
		...(typeof replyModel === 'string' && { replyModel }),
	};
}

/** Resolves with why the write was lost, or undefined once it is written. Never rejects, and never waits past RECORD_TIMEOUT_MS. */
async function written(write: Promise<boolean>): Promise<Error | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timedOut = new Promise<Error>((resolve) => {
		timer = setTimeout(() => resolve(new Error(`the write took longer than ${RECORD_TIMEOUT_MS} ms, so it may still land`)), RECORD_TIMEOUT_MS);
	});
	const settled = write.then(
		(inserted) => (inserted ? undefined : new Error('the row key was already taken')),
		(error: unknown) => (error instanceof Error ? error : new Error(String(error))),
	);
	try {
		return await Promise.race([settled, timedOut]);
	} finally {
		clearTimeout(timer);
	}
}

const add = (totals: Map<string, Spend>, key: string, microUsd: number) => {
	const before = totals.get(key) ?? { microUsd: 0, calls: 0 };
	totals.set(key, { microUsd: before.microUsd + microUsd, calls: before.calls + 1 });
};

const rowsOf = async (table: ReadTable, game: GameId, months: readonly string[]) => (await Promise.all(months.map((month) => table.inPartition(partitionOf(game, month))))).flat();

/** Reads a ledger without the right to write it, as the admin app reads each player app's. */
export function ledgerReader(table: ReadTable, side: Side): LedgerReader {
	return {
		async read(games, { from, to }) {
			const months = monthsForDays(from, to);
			const rows = (await Promise.all(games.map((game) => rowsOf(table, game, months)))).flat();
			return rows.flatMap((row) => parseEntry(row, side) ?? []).filter((entry) => {
				const day = londonDay(new Date(entry.at));
				return day >= from && day <= to;
			});
		},
	};
}

/**
 * One app's AI cost ledger: one row per AI request that reported usage, in the partition `<game>|<UTC month>`. The
 * admin app's is the `aiusage` portal table, and a player app's is the PLAY_LEDGER_TABLE in its game's own account.
 * Each has that app as its only writer. Rows are never updated, so every total is a sum over them.
 */
export function usageLedger(table: Table, deps: LedgerDeps): UsageLedger {
	const { side } = deps;
	return {
		...ledgerReader(table, side),
		forGame<Area extends string>(game: GameId, areas: readonly Area[]): GameUsage<Area> {
			const declared = new Set<string>(areas);
			return {
				async record(call) {
					const parsed = parseCall(call, declared, side);
					if ('problems' in parsed) {
						const problems = parsed.problems.join('; ');
						deps.telemetry.log('error', `usage entry refused, ${problems}: ${JSON.stringify({ game, side, ...call })}`);
						deps.telemetry.exception(new Error(`${game} recorded AI usage the ledger refused: ${problems}`));
						return;
					}
					const { area, model, replyModel, subject } = call;
					const entry: UsageEntry = {
						side,
						id: deps.newId(),
						at: deps.now().toISOString(),
						game,
						area,
						model,
						...(typeof replyModel === 'string' && { replyModel }),
						item: subject.item,
						...(subject.group !== undefined && { group: subject.group }),
						tokens: parsed.tokens,
						microUsd: costMicroUsd(call),
						priceVersion: PRICE_VERSION,
					};
					const lost = await written(Promise.resolve().then(() => table.insertIfAbsent(entryRow(entry))));
					if (!lost) return;
					deps.telemetry.log('error', `usage entry lost, ${lost.message}: ${JSON.stringify(entry)}`);
					deps.telemetry.exception(lost);
				},
				async unmetered({ area, model, subject, reason }) {
					const undeclared = declared.has(area) ? '' : `, and area "${area}" is not in the manifest's ${side}.ai`;
					const what = JSON.stringify({ game, side, area, model, ...subject, reason });
					deps.telemetry.log('error', `usage unmetered, a billed call is missing from the ledger${undeclared}: ${what}`);
					deps.telemetry.exception(new Error(`${game} ${area} call to ${model} for ${subject?.item} was billed but reported no usage: ${reason}`));
				},
				async spend() {
					const byGroup = new Map<string, Spend>();
					const byItem = new Map<string, Spend>();
					const rows = await rowsOf(table, game, monthsBetween(LEDGER_START, utcMonth(deps.now())));
					for (const entry of rows.flatMap((row) => parseEntry(row, side) ?? [])) {
						add(byItem, entry.item, entry.microUsd);
						if (entry.group !== undefined) add(byGroup, entry.group, entry.microUsd);
					}
					return { byGroup, byItem };
				},
			};
		},
	};
}
