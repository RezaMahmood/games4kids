import { fieldsOf } from '../../shared/ids.ts';

export type CostBy = 'day' | 'month' | 'year';
export const COST_BYS: readonly CostBy[] = ['day', 'month', 'year'];

export type Cost = { readonly microUsd: number; readonly calls: number; readonly text: string };
export type AreaCost = Cost & { readonly game: string; readonly area: string; readonly label: string };
export type GameCost = Cost & { readonly game: string; readonly title: string };
export type PeriodCost = { readonly period: string; readonly total: Cost; readonly games: readonly GameCost[]; readonly areas: readonly AreaCost[] };
export type CostReport = { readonly by: CostBy; readonly from: string; readonly to: string; readonly total: Cost; readonly games: readonly GameCost[]; readonly areas: readonly AreaCost[]; readonly periods: readonly PeriodCost[] };

function parseCost(raw: unknown): Cost | null {
	const { microUsd, calls, text } = fieldsOf(raw);
	return typeof microUsd === 'number' && typeof calls === 'number' && typeof text === 'string' ? { microUsd, calls, text } : null;
}

const list = <T>(raw: unknown, one: (entry: Record<string, unknown>) => T | null): T[] => (Array.isArray(raw) ? raw.flatMap((entry) => one(fieldsOf(entry)) ?? []) : []);

const gameCost = (entry: Record<string, unknown>): GameCost | null => {
	const cost = parseCost(entry);
	return cost && typeof entry['game'] === 'string' && typeof entry['title'] === 'string' ? { ...cost, game: entry['game'], title: entry['title'] } : null;
};
const areaCost = (entry: Record<string, unknown>): AreaCost | null => {
	const cost = parseCost(entry);
	return cost && typeof entry['game'] === 'string' && typeof entry['area'] === 'string' && typeof entry['label'] === 'string' ? { ...cost, game: entry['game'], area: entry['area'], label: entry['label'] } : null;
};

/** GET portal/costs. A reply the page cannot read is a failure, not an empty report. */
export function parseCostReport(raw: unknown): CostReport {
	const { by, from, to, total, games, areas, periods } = fieldsOf(raw);
	const sum = parseCost(total);
	const known = COST_BYS.find((one) => one === by);
	if (!known || typeof from !== 'string' || typeof to !== 'string' || !sum) throw new Error('GET costs answered something the page cannot read');
	return {
		by: known,
		from,
		to,
		total: sum,
		games: list(games, gameCost),
		areas: list(areas, areaCost),
		periods: list(periods, (entry): PeriodCost | null => {
			const cost = parseCost(entry['total']);
			return cost && typeof entry['period'] === 'string' ? { period: entry['period'], total: cost, games: list(entry['games'], gameCost), areas: list(entry['areas'], areaCost) } : null;
		}),
	};
}

const UTC_DATE = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-GB', { ...options, timeZone: 'UTC' });
const FORMATS: Record<CostBy, Intl.DateTimeFormat> = {
	day: UTC_DATE({ day: 'numeric', month: 'short', year: 'numeric' }),
	month: UTC_DATE({ month: 'long', year: 'numeric' }),
	year: UTC_DATE({ year: 'numeric' }),
};

/** "2026-10-23" as "23 Oct 2026", "2026-10" as "October 2026", "2026" as "2026". */
export function periodName(period: string, by: CostBy): string {
	const at = new Date(by === 'day' ? `${period}T00:00:00Z` : by === 'month' ? `${period}-01T00:00:00Z` : `${period}-01-01T00:00:00Z`);
	return Number.isNaN(at.getTime()) ? period : FORMATS[by].format(at);
}

export const callsLabel = (calls: number) => `${calls} AI ${calls === 1 ? 'call' : 'calls'}`;
const dayName = (day: string) => UTC_DATE({ day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${day}T00:00:00Z`));

/** "est. $3.12 · 410 AI calls, 1 Oct 2026 to 23 Oct 2026". */
export const totalLine = ({ total, from, to }: CostReport): string => `${total.text} · ${callsLabel(total.calls)}, ${dayName(from)} to ${dayName(to)}`;

/** The width of a period's bar against the dearest period shown, as a whole percent. A period with spend always shows a sliver. */
export function barPercent(microUsd: number, most: number): number {
	if (microUsd <= 0 || most <= 0) return 0;
	return Math.max(2, Math.round((microUsd / most) * 100));
}

