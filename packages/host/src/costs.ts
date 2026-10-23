import { costView, HttpError, type CostView, type GameId, type Spend } from '@g4k/sdk';
import { LEDGER_START, londonDay, periodOf, type Period, type UsageEntry, type UsageLedger } from './usage.ts';

/** The widest range one report covers, in days. */
export const MAX_RANGE_DAYS = 1096;

export type CostGame = { readonly id: GameId; readonly title: string; readonly areas: Readonly<Record<string, string>> };
export type CostQuery = { readonly by: Period; readonly from: string; readonly to: string };

type AreaCost = CostView & { readonly game: GameId; readonly area: string; readonly label: string };
type GameCost = CostView & { readonly game: GameId; readonly title: string };

export type CostReport = CostQuery & {
	readonly total: CostView;
	readonly games: readonly GameCost[];
	readonly areas: readonly AreaCost[];
	readonly periods: readonly { readonly period: string; readonly total: CostView; readonly games: readonly GameCost[]; readonly areas: readonly AreaCost[] }[];
	readonly priceVersions: readonly string[];
};

const PERIODS: readonly Period[] = ['day', 'month', 'year'];
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

const dayOf = (raw: string): Date | undefined => {
	const at = DAY.test(raw) ? new Date(`${raw}T00:00:00Z`) : undefined;
	return at && !Number.isNaN(at.getTime()) && at.toISOString().startsWith(raw) ? at : undefined;
};
const dayString = (at: Date) => at.toISOString().slice(0, 10);
const shifted = (day: string, days: number) => dayString(new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS));

function firstOfMonthsAgo(day: string, months: number): string {
	const at = new Date(`${day.slice(0, 7)}-01T00:00:00Z`);
	at.setUTCMonth(at.getUTCMonth() - months);
	return dayString(at);
}

const invalid = (...problems: string[]) => new HttpError(400, 'invalid', 'That report is not valid.', problems);

/** The query at the HTTP boundary: `by` is required, the dates are London days, and a missing end falls back to the default range. */
export function parseCostQuery(query: URLSearchParams, now: Date): CostQuery {
	const by = PERIODS.find((one) => one === query.get('by'));
	if (!by) throw invalid('by must be day, month or year.');
	const rawFrom = query.get('from');
	const rawTo = query.get('to');
	const problems = [rawFrom !== null && !dayOf(rawFrom) && 'from must be a date, YYYY-MM-DD.', rawTo !== null && !dayOf(rawTo) && 'to must be a date, YYYY-MM-DD.'].flatMap((one) => (one ? [one] : []));
	if (problems.length > 0) throw invalid(...problems);
	const to = rawTo ?? londonDay(now);
	const earliest = shifted(to, 1 - MAX_RANGE_DAYS);
	const standard = by === 'day' ? shifted(to, -30) : by === 'month' ? firstOfMonthsAgo(to, 11) : `${LEDGER_START}-01`;
	const from = rawFrom ?? (standard < earliest ? earliest : standard);
	if (from > to) throw invalid('from must not be after to.');
	if (from < earliest) throw invalid(`The range must be at most ${MAX_RANGE_DAYS} days.`);
	return { by, from, to };
}

/** Every period label from `from` to `to`, oldest first, so a quiet one still shows as nothing spent. */
function periodsBetween({ by, from, to }: CostQuery): string[] {
	const labels = new Set<string>();
	for (let at = dayOf(from); at && dayString(at) <= to; at = new Date(at.getTime() + DAY_MS)) {
		// Noon UTC is the same calendar day in London, so each stepped date maps to its own London period.
		labels.add(periodOf(new Date(at.getTime() + 12 * 3_600_000), by));
	}
	return [...labels];
}

type Sums = Map<string, Spend>;
const addTo = (sums: Sums, key: string, microUsd: number) => {
	const before = sums.get(key) ?? { microUsd: 0, calls: 0 };
	sums.set(key, { microUsd: before.microUsd + microUsd, calls: before.calls + 1 });
};
const sumOf = (entries: readonly UsageEntry[]): Spend => ({ microUsd: entries.reduce((sum, one) => sum + one.microUsd, 0), calls: entries.length });
const largestFirst = <T extends Spend>(rows: readonly T[]): T[] => [...rows].sort((a, b) => b.microUsd - a.microUsd || b.calls - a.calls);

function breakdown(entries: readonly UsageEntry[], games: readonly CostGame[]): { games: GameCost[]; areas: AreaCost[] } {
	const byGame: Sums = new Map();
	const byArea: Sums = new Map();
	for (const one of entries) {
		addTo(byGame, one.game, one.microUsd);
		addTo(byArea, `${one.game}\n${one.area}`, one.microUsd);
	}
	return {
		games: largestFirst(
			[...byGame].flatMap(([game, spend]) => {
				const found = games.find((one) => one.id === game);
				return found ? [{ game: found.id, title: found.title, ...costView(spend) }] : [];
			}),
		),
		areas: largestFirst(
			[...byArea].flatMap(([key, spend]) => {
				const [game, area = ''] = key.split('\n');
				const found = games.find((one) => one.id === game);
				return found ? [{ game: found.id, area, label: found.areas[area] ?? area, ...costView(spend) }] : [];
			}),
		),
	};
}

/** The ledger rows of every game that bills AI, summed by London period, game and area. Periods run newest first. */
export async function costReport(ledger: UsageLedger, games: readonly CostGame[], query: CostQuery): Promise<CostReport> {
	const entries = await ledger.read(
		games.map((one) => one.id),
		query,
	);
	const inPeriod = new Map<string, UsageEntry[]>();
	for (const one of entries) {
		const period = periodOf(new Date(one.at), query.by);
		inPeriod.set(period, [...(inPeriod.get(period) ?? []), one]);
	}
	const periods = periodsBetween(query)
		.reverse()
		.map((period) => {
			const rows = inPeriod.get(period) ?? [];
			return { period, total: costView(sumOf(rows)), ...breakdown(rows, games) };
		});
	return { ...query, total: costView(sumOf(entries)), ...breakdown(entries, games), periods, priceVersions: [...new Set(entries.map((one) => one.priceVersion))].sort() };
}
