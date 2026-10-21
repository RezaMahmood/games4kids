import { LEVELS, type Level, type Parsed } from './activity.ts';
import type { Attempt } from './results.ts';

/** Hard mode is harder, so its results earn this many times the points. The web's scoreboard.js holds the same rule. */
export const HARD_BONUS = 1.2;

/** A child who switched the board on. `since` is when, and only attempts from then on count. */
export type BoardEntry = { userId: string; name: string; timeZone: string; since: string };
export type BoardChild = BoardEntry & { attempts: readonly Attempt[] };
export type BoardLine = { name: string; me: boolean; points: number[]; total: number };
export type Board = { days: string[]; levels: { level: Level; children: BoardLine[] }[] };

/** The calendar day in the child's own zone, so each child's day rolls over at their midnight. */
export function localDate(at: Date, timeZone: string): string {
	return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/** What the scoreboard shows for one attempt: the stored score as the whole number the child saw, times the hard bonus. */
export const pointsFor = ({ score, hard }: { score: number; hard: boolean }): number => Math.round(Math.round(Math.round(score * 10) / 10) * (hard ? HARD_BONUS : 1));

export function parseBoardInput(body: unknown): Parsed<boolean> {
	const on = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['on'] : undefined;
	return typeof on === 'boolean' ? { ok: true, value: on } : { ok: false, problems: ['on must be true or false'] };
}

/**
 * Daily points per child and level. A child's day is their own local day, only attempts from `since` on count, and on each
 * day only the best attempt at each activity counts, so repeating an easy activity adds nothing. The result never carries a userId.
 */
export function buildBoard(input: { days: string[]; viewerId: string; children: readonly BoardChild[] }): Board {
	const column = new Map(input.days.map((day, i) => [day, i]));
	const lines = new Map<Level, (BoardLine & { userId: string })[]>(LEVELS.map((level) => [level, []]));
	for (const child of input.children) {
		const best = new Map<string, { column: number; level: Level; points: number }>();
		for (const attempt of child.attempts) {
			if (attempt.completedAt < child.since) continue;
			const at = column.get(localDate(new Date(attempt.completedAt), child.timeZone));
			if (at === undefined) continue;
			const key = `${at}/${attempt.activityId}`;
			const points = pointsFor(attempt);
			if (points > (best.get(key)?.points ?? -1)) best.set(key, { column: at, level: attempt.level, points });
		}
		for (const level of LEVELS) {
			const points = input.days.map(() => 0);
			for (const entry of best.values()) if (entry.level === level) points[entry.column] = (points[entry.column] ?? 0) + entry.points;
			const total = points.reduce((sum, p) => sum + p, 0);
			if (total > 0) lines.get(level)?.push({ userId: child.userId, name: child.name, me: child.userId === input.viewerId, points, total });
		}
	}
	return {
		days: input.days,
		levels: LEVELS.map((level) => ({
			level,
			children: (lines.get(level) ?? [])
				.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId))
				.map(({ name, me, points, total }) => ({ name, me, points, total })),
		})),
	};
}
