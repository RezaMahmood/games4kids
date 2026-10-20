import { toTraceText, type Activity, type Level } from './activity.ts';
import { isGuid } from './ids.ts';

export const GRACE_MS = 2000;
export const MAX_UNTIMED_MS = 24 * 60 * 60 * 1000;
export const PROGRESS_DAYS = 120;
export const DAY_MS = 24 * 60 * 60 * 1000;

export type Result = { score: number; timeMs: number; hard: boolean; completedAt: string };

export type Attempt = { id: string; activityId: string; level: Level; chars: number; score: number; timeMs: number; hard: boolean; completedAt: string };

export type ScoredAttempt = { attemptId: string; score: number; timeMs: number; hard: boolean };

type Fields = Record<string, unknown>;

/** A hard mode result has no timer, and free writing is slower than tracing, so it is held to the untimed bound whatever the activity's limit. */
export function parseResultInput(body: unknown, activity: Activity): { ok: true; value: ScoredAttempt } | { ok: false; problems: string[] } {
	const fields: Fields = typeof body === 'object' && body !== null ? (body as Fields) : {};
	const { attemptId, score, timeMs } = fields;
	const hard = fields['hard'] === undefined ? false : fields['hard'];
	const problems: string[] = [];
	if (!isGuid(attemptId)) problems.push('attemptId must be a GUID, made once per finished attempt');
	if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 100) problems.push('score must be a number from 0 to 100');
	if (typeof hard !== 'boolean') problems.push('hard must be true or false');
	const maxMs = hard === true || activity.timeLimitSec === null ? MAX_UNTIMED_MS : activity.timeLimitSec * 1000 + GRACE_MS;
	if (typeof timeMs !== 'number' || !Number.isInteger(timeMs) || timeMs < 0 || timeMs > maxMs) problems.push(`timeMs must be a whole number of milliseconds from 0 to ${maxMs}`);
	if (problems.length > 0) return { ok: false, problems };
	return { ok: true, value: { attemptId: (attemptId as string).toLowerCase(), score: Math.round((score as number) * 10) / 10, timeMs: timeMs as number, hard: hard as boolean } };
}

/** What one finished attempt keeps of the activity, copied now so editing or deleting the activity later never rewrites history. */
export function toAttempt(activity: Activity, { attemptId, score, timeMs, hard }: ScoredAttempt, completedAt: string): Attempt {
	const chars = [...toTraceText(activity).replace(/\s/gu, '')].length;
	return { id: attemptId, activityId: activity.id, level: activity.level, chars, score, timeMs, hard, completedAt };
}
