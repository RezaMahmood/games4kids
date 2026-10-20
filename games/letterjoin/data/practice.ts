import type { Parsed } from './activity.ts';
import { DAY_MS } from './results.ts';

export const MAX_DAILY_MINUTES = 240;
export const MAX_SEND_SECONDS = 60;
export const MAX_DAY_SECONDS = 24 * 60 * 60;
export const REPORT_DAYS = 7;

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_PROBLEM = "day must be the device's date as YYYY-MM-DD, within a day of today";

export type Settings = { dailyPracticeMinutes: number; hardModeDefault: boolean };
export const DEFAULT_SETTINGS: Settings = { dailyPracticeMinutes: 0, hardModeDefault: false };

/** A child's local calendar day. Every time zone is within a day of UTC, so a day further from the server's date comes from a wrong device clock and is refused. */
export function parseDay(raw: unknown, now: Date): string | null {
	const match = typeof raw === 'string' ? DAY.exec(raw) : null;
	if (!match || typeof raw !== 'string') return null;
	const [y = 0, mo = 0, d = 0] = match.slice(1).map(Number);
	const at = Date.UTC(y, mo - 1, d);
	const real = new Date(at);
	if (real.getUTCFullYear() !== y || real.getUTCMonth() !== mo - 1 || real.getUTCDate() !== d) return null;
	const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
	return Math.abs(at - today) <= DAY_MS ? raw : null;
}

export function parsePracticeInput(body: unknown, now: Date): Parsed<{ day: string; seconds: number }> {
	const fields: Record<string, unknown> = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
	const day = parseDay(fields['day'], now);
	const seconds = fields['seconds'];
	const problems: string[] = [];
	if (!day) problems.push(DAY_PROBLEM);
	if (typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds < 1 || seconds > MAX_SEND_SECONDS) problems.push(`seconds must be a whole number from 1 to ${MAX_SEND_SECONDS}`);
	if (problems.length > 0 || !day) return { ok: false, problems };
	return { ok: true, value: { day, seconds: seconds as number } };
}

export function parsePracticeQuery(query: URLSearchParams, now: Date): Parsed<string> {
	const day = parseDay(query.get('day'), now);
	return day ? { ok: true, value: day } : { ok: false, problems: [DAY_PROBLEM] };
}

export function parseSettingsInput(body: unknown): Parsed<Settings> {
	const fields: Record<string, unknown> = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
	const minutes = fields['dailyPracticeMinutes'];
	const hard = fields['hardModeDefault'] ?? false;
	const problems: string[] = [];
	if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 0 || minutes > MAX_DAILY_MINUTES) {
		problems.push(`dailyPracticeMinutes must be a whole number from 0 to ${MAX_DAILY_MINUTES}; 0 turns it off`);
	}
	if (typeof hard !== 'boolean') problems.push('hardModeDefault must be true or false');
	if (problems.length > 0) return { ok: false, problems };
	return { ok: true, value: { dailyPracticeMinutes: minutes as number, hardModeDefault: hard as boolean } };
}

export function daysEndingAt(day: string, count = REPORT_DAYS): string[] {
	const [y = 0, m = 0, d = 0] = day.split('-').map(Number);
	return Array.from({ length: count }, (_, i) => new Date(Date.UTC(y, m - 1, d - (count - 1 - i))).toISOString().slice(0, 10));
}

export type ChildPractice = { userId: string; name: string; seconds: number[]; totalSeconds: number };
export type PracticeReport = { days: string[]; goalMinutes: number; children: ChildPractice[] };

/** Practice per child for the last few days. Every child on the roster is a row, so a child who did nothing shows as zeros. */
export function buildReport(input: {
	days: string[];
	children: readonly { userId: string; name: string; rows: readonly { day: string; seconds: number }[] }[];
	goalMinutes: number;
}): PracticeReport {
	const children = input.children
		.map(({ userId, name, rows }) => {
			const seconds = input.days.map((day) => rows.filter((row) => row.day === day).reduce((sum, row) => sum + row.seconds, 0));
			return { userId, name, seconds, totalSeconds: seconds.reduce((a, b) => a + b, 0) };
		})
		.sort((a, b) => a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId));
	return { days: input.days, goalMinutes: input.goalMinutes, children };
}
