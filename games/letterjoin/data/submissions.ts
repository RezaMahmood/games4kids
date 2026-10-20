import type { Activity, Parsed } from './activity.ts';
import { isGuid } from './ids.ts';

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const KEEP_PER_ACTIVITY = 3;
export const NOTE_MAX = 500;
export const PAGE_DEFAULT = 20;
export const PAGE_MAX = 50;

const MAX_MS = 0xffff_ffff_ffff;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f]/;
const CURSOR = /^[0-9a-f]{12}_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** An unaided copy: an image of what the child wrote, kept for an admin to look at. It is never scored. */
export type Submission = {
	id: string;
	userId: string;
	activityId: string;
	activityTitle: string;
	blobName: string;
	bytes: number;
	createdAt: string;
};

/** What the admin app writes about a submission. `discarded` hides it, since the image belongs to the player app and stays. */
export type Review = { reviewed: boolean; discarded: boolean; note: string; reviewedBy?: string; reviewedAt?: string };

export type ReviewInput = { reviewed: boolean; note?: string };

export type SubmissionQuery = { userId?: string; activityId?: string; unreviewed?: boolean; after?: string; limit: number };

export const NOT_REVIEWED: Review = { reviewed: false, discarded: false, note: '' };

/** A UUID version 7: the first 48 bits are the creation time in milliseconds, so the id also orders by time. */
export function submissionId(at: Date, random: Uint8Array = crypto.getRandomValues(new Uint8Array(10))): string {
	const r = Array.from(random, (byte) => byte.toString(16).padStart(2, '0')).join('');
	const h = `${at.getTime().toString(16).padStart(12, '0')}7${r.slice(0, 3)}${(8 | (parseInt(r[3] ?? '0', 16) & 3)).toString(16)}${r.slice(4, 19)}`;
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const reversed = (ms: number) => (MAX_MS - ms).toString(16).padStart(12, '0');
const createdMs = (id: string) => parseInt(id.slice(0, 8) + id.slice(9, 13), 16);

/** Ascending order of this key is newest first. It is also the page cursor. */
export const sortKey = (id: string) => `${reversed(createdMs(id))}_${id}`;

export function newSubmission({ userId, activity, bytes, at, random }: { userId: string; activity: Activity; bytes: number; at: Date; random?: Uint8Array }): Submission {
	const id = submissionId(at, random);
	return { id, userId, activityId: activity.id, activityTitle: activity.title, blobName: `${userId}/${id}.png`, bytes, createdAt: at.toISOString() };
}

export function isPng(bytes: Uint8Array): boolean {
	return bytes.length > 33 && PNG_SIGNATURE.every((byte, i) => bytes[i] === byte) && String.fromCharCode(...bytes.subarray(12, 16)) === 'IHDR';
}

export function parseReviewInput(body: unknown): Parsed<ReviewInput> {
	const fields: Record<string, unknown> = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
	const problems: string[] = [];
	if (typeof fields['reviewed'] !== 'boolean') problems.push('reviewed must be true or false');
	let note: string | undefined;
	const rawNote = fields['note'];
	if (rawNote !== undefined) {
		if (typeof rawNote !== 'string') problems.push('note must be text');
		else {
			note = rawNote.replace(/\r\n?/g, '\n').trim();
			if (note.length > NOTE_MAX) problems.push(`note must be at most ${NOTE_MAX} characters`);
			else if (CONTROL.test(note)) problems.push('note must be plain text');
		}
	}
	if (problems.length > 0) return { ok: false, problems };
	return { ok: true, value: { reviewed: fields['reviewed'] as boolean, ...(note !== undefined && { note }) } };
}

/** Who reviewed it and when is stamped only when `reviewed` changes, so sending the same review twice changes nothing. */
export function applyReview(current: Review, input: ReviewInput, reviewer: string, at: Date): Review {
	const kept = { ...(current.reviewedBy !== undefined && { reviewedBy: current.reviewedBy }), ...(current.reviewedAt !== undefined && { reviewedAt: current.reviewedAt }) };
	const stamp = input.reviewed === current.reviewed ? kept : input.reviewed ? { reviewedBy: reviewer, reviewedAt: at.toISOString() } : {};
	return { reviewed: input.reviewed, discarded: current.discarded, ...stamp, note: input.note ?? current.note };
}

export function parseSubmissionQuery(query: URLSearchParams): Parsed<SubmissionQuery> {
	const problems: string[] = [];
	const value: { -readonly [K in keyof SubmissionQuery]: SubmissionQuery[K] } = { limit: PAGE_DEFAULT };
	const userId = query.get('userId');
	if (userId) {
		if (isGuid(userId)) value.userId = userId.toLowerCase();
		else problems.push('userId must be a child id');
	}
	const activityId = query.get('activityId');
	if (activityId) {
		if (isGuid(activityId)) value.activityId = activityId.toLowerCase();
		else problems.push('activityId must be an activity id');
	}
	const unreviewed = query.get('unreviewed');
	if (unreviewed !== null && unreviewed !== 'true' && unreviewed !== 'false') problems.push('unreviewed must be true or false');
	if (unreviewed === 'true') value.unreviewed = true;
	const after = query.get('after');
	if (after !== null) {
		if (CURSOR.test(after)) value.after = after;
		else problems.push('after must be the next value of the previous page');
	}
	const limit = query.get('limit');
	if (limit !== null) {
		const n = Number(limit);
		if (Number.isInteger(n) && n >= 1 && n <= PAGE_MAX) value.limit = n;
		else problems.push(`limit must be a whole number from 1 to ${PAGE_MAX}`);
	}
	return problems.length > 0 ? { ok: false, problems } : { ok: true, value };
}
