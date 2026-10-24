import { isRecord, type Parsed } from './parse.ts';

export const DAY_MS = 24 * 60 * 60 * 1000;
export const BOARD_DAYS = 7;

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_PROBLEM = "day must be the device's date as YYYY-MM-DD, within a day of today";

/** A child who switched the board on. `since` is when, and their days count from that one on. */
export type BoardEntry = { userId: string; name: string; timeZone: string; since: string };
/** A child's best single game on one of their local days. */
export type DailyBest = { day: string; points: number };
export type BoardChild = BoardEntry & { bests: readonly DailyBest[] };
export type BoardLine = { name: string; me: boolean; points: number[]; total: number };
export type Board = { days: string[]; children: BoardLine[] };

/** The calendar day in the child's own zone, so each child's day rolls over at their midnight. */
export function localDate(at: Date, timeZone: string): string {
	return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/** Every time zone is within a day of UTC, so a day further from the server's date comes from a wrong device clock and is refused. */
export function parseDayQuery(query: URLSearchParams, now: Date): Parsed<string> {
	const raw = query.get('day');
	const match = raw === null ? null : DAY.exec(raw);
	if (!match || raw === null) return { ok: false, problems: [DAY_PROBLEM] };
	const [y = 0, mo = 0, d = 0] = match.slice(1).map(Number);
	const at = Date.UTC(y, mo - 1, d);
	const real = new Date(at);
	const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
	const valid = real.getUTCFullYear() === y && real.getUTCMonth() === mo - 1 && real.getUTCDate() === d && Math.abs(at - today) <= DAY_MS;
	return valid ? { ok: true, value: raw } : { ok: false, problems: [DAY_PROBLEM] };
}

export function daysEndingAt(day: string, count = BOARD_DAYS): string[] {
	const [y = 0, m = 0, d = 0] = day.split('-').map(Number);
	return Array.from({ length: count }, (_, i) => new Date(Date.UTC(y, m - 1, d - (count - 1 - i))).toISOString().slice(0, 10));
}

export function parseBoardInput(body: unknown): Parsed<boolean> {
	const on = isRecord(body) ? body['on'] : undefined;
	return typeof on === 'boolean' ? { ok: true, value: on } : { ok: false, problems: ['on must be true or false'] };
}

/**
 * Each child's daily bests over the days. A child counts from the day they switched the board on, that whole day
 * included, since a day's best is one number and cannot be split at the switch. The result never carries a userId.
 */
export function buildBoard(input: { days: string[]; viewerId: string; children: readonly BoardChild[] }): Board {
	const lines = input.children
		.map((child) => {
			const from = localDate(new Date(child.since), child.timeZone);
			const points = input.days.map((day) => (day >= from ? (child.bests.find((best) => best.day === day)?.points ?? 0) : 0));
			return { userId: child.userId, name: child.name, me: child.userId === input.viewerId, points, total: points.reduce((sum, p) => sum + p, 0) };
		})
		.filter((line) => line.total > 0)
		.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId));
	return { days: input.days, children: lines.map(({ name, me, points, total }) => ({ name, me, points, total })) };
}
