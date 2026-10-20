import type { ReadBlobs, ReadTable, Row, StorageFor, Stored } from '@g4k/sdk';
import type manifest from '../manifest.ts';
import { compareActivities, parseActivity, type Activity } from './activity.ts';
import { DEFAULT_SETTINGS, MAX_DAY_SECONDS, type Settings } from './practice.ts';
import type { Attempt, Result } from './results.ts';
import { NOT_REVIEWED, sortKey, type Review, type Submission } from './submissions.ts';

type Letterjoin = typeof manifest;

export class PreconditionFailed extends Error {}

export type StoredActivity = { activity: Activity; etag: string };

const ACTIVITY = 'activity';
const SETTING = 'setting';
const SETTINGS_ROW = 'app';
const PRACTICE_PREFIX = 'practice-';
const ALL_SUBMISSIONS = 'all';
const REVIEW = 'review';
const COMMON = ['id', 'type', 'title', 'description', 'status', 'order', 'updatedAt'];
const ADD_ATTEMPTS = 5;

type ActivityRow = { partitionKey: string; rowKey: string; type: string; title: string; description: string; status: string; order: number; updatedAt: string; body: string };
type SettingsRow = { partitionKey: string; rowKey: string; dailyPracticeMinutes: number; hardModeDefault?: boolean };
type ResultRow = { partitionKey: string; rowKey: string; score: number; timeMs: number; hard?: boolean; completedAt: string };
type AttemptRow = ResultRow & { activityId: string; level: string; chars: number };
type PracticeRow = { partitionKey: string; rowKey: string; seconds: number };
type SubmissionRow = { partitionKey: string; rowKey: string } & Submission;
type PointerRow = { partitionKey: string; rowKey: string; id: string };
type ReviewRow = { partitionKey: string; rowKey: string; reviewed: boolean; discarded: boolean; note: string; reviewedBy?: string; reviewedAt?: string };

const practiceKey = (userId: string) => `${PRACTICE_PREFIX}${userId}`;
const pointerKey = (activityId: string, id: string) => `${activityId}_${sortKey(id)}`;

function plain<R extends Row>(stored: Stored<R>): R {
	return Object.fromEntries(Object.entries(stored).filter(([name]) => name !== 'etag')) as R;
}

function toRow(activity: Activity): ActivityRow {
	const { id, type, title, description, status, order, updatedAt } = activity;
	const body = Object.fromEntries(Object.entries(activity).filter(([key]) => !COMMON.includes(key)));
	return { partitionKey: ACTIVITY, rowKey: id, type, title, description, status, order, updatedAt, body: JSON.stringify(body) };
}

function toStored(row: Stored<ActivityRow>): StoredActivity {
	const { rowKey: id, type, title, description, status, order, updatedAt, body } = row;
	const parsed = parseActivity({ ...(JSON.parse(body) as object), id, type, title, description, status, order, updatedAt });
	if (!parsed.ok) throw new Error(`stored activity ${id} is invalid: ${parsed.problems.join('; ')}`);
	return { activity: parsed.value, etag: row.etag };
}

function toSettings(row: SettingsRow | undefined): Settings {
	return row ? { dailyPracticeMinutes: row.dailyPracticeMinutes, hardModeDefault: row.hardModeDefault === true } : { ...DEFAULT_SETTINGS };
}

const toSubmission = ({ id, userId, activityId, activityTitle, blobName, bytes, createdAt }: SubmissionRow): Submission => ({ id, userId, activityId, activityTitle, blobName, bytes, createdAt });

const toResult = ({ score, timeMs, hard, completedAt }: ResultRow): Result => ({ score, timeMs, hard: hard === true, completedAt });

const toAttempt = (row: AttemptRow): Attempt => ({
	id: row.rowKey,
	activityId: row.activityId,
	level: row.level as Attempt['level'],
	chars: row.chars,
	score: row.score,
	timeMs: row.timeMs,
	hard: row.hard === true,
	completedAt: row.completedAt,
});

async function bytesAt(blobs: ReadBlobs, path: string): Promise<Uint8Array | undefined> {
	const found = await blobs.get(path);
	return found && found !== 'not-modified' ? found.bytes : undefined;
}

async function activitiesOf(table: ReadTable): Promise<StoredActivity[]> {
	return (await table.inPartition<ActivityRow>(ACTIVITY)).map(toStored).sort((a, b) => compareActivities(a.activity, b.activity));
}

async function attemptsSince(table: ReadTable, userId: string, sinceIso: string): Promise<Attempt[]> {
	const rows = (await table.inPartition<AttemptRow>(userId)).map(plain).filter((row) => row.completedAt >= sinceIso);
	return rows.map(toAttempt).sort((a, b) => a.completedAt.localeCompare(b.completedAt) || a.id.localeCompare(b.id));
}

async function settingsOf(table: ReadTable): Promise<Settings> {
	const row = await table.get<SettingsRow>(SETTING, SETTINGS_ROW);
	return toSettings(row && plain(row));
}

export type PlayStore = {
	activities(): Promise<Activity[]>;
	activity(id: string): Promise<Activity | undefined>;
	settings(): Promise<Settings>;
	results(userId: string): Promise<Map<string, Result>>;
	saveResult(userId: string, attempt: Attempt, result: Result): Promise<void>;
	attempts(userId: string, sinceIso: string): Promise<Attempt[]>;
	practiceSeconds(userId: string, day: string): Promise<number>;
	addPractice(userId: string, day: string, seconds: number): Promise<number>;
	addSubmission(submission: Submission, png: Uint8Array): Promise<void>;
	submissionIdsFor(userId: string, activityId: string): Promise<string[]>;
	removeSubmission(id: string): Promise<void>;
};

export function playStore(storage: StorageFor<Letterjoin, 'play'>): PlayStore {
	const { activities, results, attempts, submissions } = storage.tables;
	const images = storage.blobs.submissions;

	async function practiceSeconds(userId: string, day: string): Promise<number> {
		return (await results.get<PracticeRow>(practiceKey(userId), day))?.seconds ?? 0;
	}

	return {
		async activities() {
			return (await activitiesOf(activities)).map(({ activity }) => activity);
		},
		async activity(id) {
			const row = await activities.get<ActivityRow>(ACTIVITY, id);
			return row && toStored(row).activity;
		},
		settings: () => settingsOf(activities),
		async results(userId) {
			const rows = await results.inPartition<ResultRow>(userId);
			return new Map(rows.map((row) => [row.rowKey, toResult(row)]));
		},
		async saveResult(userId, attempt, result) {
			const { id, activityId, level, chars, score, timeMs, hard, completedAt } = attempt;
			await attempts.put({ partitionKey: userId, rowKey: id, activityId, level, chars, score, timeMs, hard, completedAt } satisfies AttemptRow);
			await results.put({ partitionKey: userId, rowKey: attempt.activityId, ...result } satisfies ResultRow);
		},
		attempts: (userId, sinceIso) => attemptsSince(attempts, userId, sinceIso),
		practiceSeconds,
		async addPractice(userId, day, seconds) {
			for (let attempt = 1; ; attempt++) {
				const entry = await results.get<PracticeRow>(practiceKey(userId), day);
				const total = Math.min(MAX_DAY_SECONDS, (entry?.seconds ?? 0) + seconds);
				const row: PracticeRow = { partitionKey: practiceKey(userId), rowKey: day, seconds: total };
				if (entry ? await results.replaceIfMatch(row, entry.etag) : await results.insertIfAbsent(row)) return total;
				if (attempt >= ADD_ATTEMPTS) throw new Error(`practice for ${day} kept changing while it was being saved`);
			}
		},
		async addSubmission(submission, png) {
			await images.put(submission.blobName, png, 'image/png');
			await submissions.put({ partitionKey: ALL_SUBMISSIONS, rowKey: sortKey(submission.id), ...submission } satisfies SubmissionRow);
			await submissions.put({ partitionKey: submission.userId, rowKey: pointerKey(submission.activityId, submission.id), id: submission.id } satisfies PointerRow);
		},
		async submissionIdsFor(userId, activityId) {
			const rows = await submissions.inPartition<PointerRow>(userId);
			return rows.filter((row) => row.rowKey.startsWith(`${activityId}_`)).map((row) => row.id);
		},
		async removeSubmission(id) {
			const row = await submissions.get<SubmissionRow>(ALL_SUBMISSIONS, sortKey(id));
			if (!row) return;
			await images.remove(row.blobName);
			await submissions.remove(row.userId, pointerKey(row.activityId, id));
			await submissions.remove(ALL_SUBMISSIONS, row.rowKey);
		},
	};
}

export type AdminStore = {
	activities(): Promise<StoredActivity[]>;
	activity(id: string): Promise<StoredActivity | undefined>;
	createActivity(activity: Activity): Promise<StoredActivity>;
	replaceActivity(activity: Activity, etag: string): Promise<StoredActivity>;
	deleteActivity(id: string): Promise<void>;
	setOrders(changes: readonly { id: string; order: number }[]): Promise<void>;
	settings(): Promise<Settings>;
	saveSettings(settings: Settings): Promise<void>;
	attempts(userId: string, sinceIso: string): Promise<Attempt[]>;
	practiceRows(userId: string, days: readonly string[]): Promise<{ day: string; seconds: number }[]>;
	submissions(): Promise<Submission[]>;
	submission(id: string): Promise<Submission | undefined>;
	submissionImage(id: string): Promise<Uint8Array | undefined>;
	reviews(): Promise<Map<string, Review>>;
	review(id: string): Promise<Review>;
	saveReview(id: string, review: Review): Promise<void>;
};

const toReview = ({ reviewed, discarded, note, reviewedBy, reviewedAt }: ReviewRow): Review => ({
	reviewed,
	discarded,
	note,
	...(reviewedBy !== undefined && { reviewedBy }),
	...(reviewedAt !== undefined && { reviewedAt }),
});

export function adminStore(storage: StorageFor<Letterjoin, 'admin'>): AdminStore {
	const { activities, attempts, results, submissions, reviews } = storage.tables;

	async function activity(id: string): Promise<StoredActivity | undefined> {
		const row = await activities.get<ActivityRow>(ACTIVITY, id);
		return row && toStored(row);
	}

	async function saved(next: Activity): Promise<StoredActivity> {
		const found = await activity(next.id);
		if (!found) throw new PreconditionFailed(next.id);
		return found;
	}

	return {
		activities: () => activitiesOf(activities),
		activity,
		async createActivity(next) {
			if (!(await activities.insertIfAbsent(toRow(next)))) throw new PreconditionFailed(next.id);
			return saved(next);
		},
		async replaceActivity(next, etag) {
			if (!(await activities.replaceIfMatch(toRow(next), etag))) throw new PreconditionFailed(next.id);
			return saved(next);
		},
		deleteActivity: (id) => activities.remove(ACTIVITY, id),
		async setOrders(changes) {
			const rows = await Promise.all(changes.map(async ({ id, order }) => ({ order, row: await activities.get<ActivityRow>(ACTIVITY, id) })));
			if (rows.some(({ row }) => !row)) throw new PreconditionFailed('an activity is gone');
			for (const { order, row } of rows) {
				if (!row) continue;
				if (!(await activities.replaceIfMatch({ ...plain(row), order }, row.etag))) throw new PreconditionFailed(row.rowKey);
			}
		},
		settings: () => settingsOf(activities),
		saveSettings: (settings) => activities.put({ partitionKey: SETTING, rowKey: SETTINGS_ROW, ...settings } satisfies SettingsRow),
		attempts: (userId, sinceIso) => attemptsSince(attempts, userId, sinceIso),
		async practiceRows(userId, days) {
			const rows = await results.inPartition<PracticeRow>(practiceKey(userId));
			return rows.filter((row) => days.includes(row.rowKey)).map((row) => ({ day: row.rowKey, seconds: row.seconds }));
		},
		async submissions() {
			return (await submissions.inPartition<SubmissionRow>(ALL_SUBMISSIONS)).map(toSubmission);
		},
		async submission(id) {
			const row = await submissions.get<SubmissionRow>(ALL_SUBMISSIONS, sortKey(id));
			return row && toSubmission(row);
		},
		async submissionImage(id) {
			const row = await submissions.get<SubmissionRow>(ALL_SUBMISSIONS, sortKey(id));
			return row && bytesAt(storage.blobs.submissions, row.blobName);
		},
		async reviews() {
			return new Map((await reviews.inPartition<ReviewRow>(REVIEW)).map((row) => [row.rowKey, toReview(row)]));
		},
		async review(id) {
			const row = await reviews.get<ReviewRow>(REVIEW, id);
			return row ? toReview(row) : NOT_REVIEWED;
		},
		saveReview: (id, review) => reviews.put({ partitionKey: REVIEW, rowKey: id, ...review } satisfies ReviewRow),
	};
}
