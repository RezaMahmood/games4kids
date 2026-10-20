import { defineAdminApi, HttpError, type AdminPlatform } from '@g4k/sdk';
import {
	adminStore,
	applyReview,
	buildReport,
	daysEndingAt,
	isGuid,
	parseActivityInput,
	parsePracticeQuery,
	parseReviewInput,
	parseSettingsInput,
	parseSubmissionQuery,
	PreconditionFailed,
	PROGRESS_DAYS,
	DAY_MS,
	sortKey,
	type Activity,
	type AdminStore,
	type Review,
	type StoredActivity,
	type Submission,
	type SubmissionQuery,
} from '../../data/index.ts';
import manifest from '../../manifest.ts';

const TRANSACTION_LIMIT = 100;
const NO_ACTIVITY = 'There is no such activity.';
const NO_SUBMISSION = 'There is no such copy.';
const CHANGED = 'Someone else changed the activities since you loaded them. Reload to see the latest version, then make your change again.';

const invalid = (problems: readonly string[]) => new HttpError(400, 'invalid', 'The request is not valid.', problems);
const view = ({ activity, etag }: StoredActivity) => ({ ...activity, etag });

type Child = { userId: string; name: string };

async function childrenOf(platform: AdminPlatform<typeof manifest>): Promise<Child[]> {
	return (await platform.roster.list()).map(({ userId, profile }) => ({ userId, name: profile?.displayName ?? 'No name yet' }));
}

function submissionView(submission: Submission, review: Review, names: ReadonlyMap<string, string>) {
	const { id, userId, activityId, activityTitle, bytes, createdAt } = submission;
	const { reviewed, reviewedBy, reviewedAt, note } = review;
	return { id, userId, userName: names.get(userId) ?? 'Unknown child', activityId, activityTitle, bytes, createdAt, reviewed, ...(reviewedBy !== undefined && { reviewedBy }), ...(reviewedAt !== undefined && { reviewedAt }), note };
}

async function page(store: AdminStore, query: SubmissionQuery, names: ReadonlyMap<string, string>) {
	const reviews = await store.reviews();
	const rows = (await store.submissions())
		.map((submission) => ({ key: sortKey(submission.id), submission, review: reviews.get(submission.id) }))
		.filter(({ review }) => !review?.discarded)
		.filter(({ key, submission, review }) =>
			(!query.after || key > query.after) &&
			(!query.userId || submission.userId === query.userId) &&
			(!query.activityId || submission.activityId === query.activityId) &&
			(!query.unreviewed || !review?.reviewed))
		.sort((a, b) => (a.key < b.key ? -1 : 1));
	const shown = rows.slice(0, query.limit);
	return {
		submissions: shown.map(({ submission, review }) => submissionView(submission, review ?? { reviewed: false, discarded: false, note: '' }, names)),
		next: rows.length > query.limit ? (shown.at(-1)?.key ?? null) : null,
	};
}

export const createAdminApi = defineAdminApi(manifest, (platform) => {
	const store = adminStore(platform);

	async function existing(rawId: string | undefined): Promise<StoredActivity> {
		const found = isGuid(rawId) ? await store.activity(rawId) : undefined;
		if (!found) throw new HttpError(404, 'not_found', NO_ACTIVITY);
		return found;
	}

	async function listAll() {
		return { activities: (await store.activities()).map(view) };
	}

	async function guarded<T>(change: () => Promise<T>): Promise<T> {
		try {
			return await change();
		} catch (error) {
			if (error instanceof PreconditionFailed) throw new HttpError(412, 'changed', CHANGED);
			throw error;
		}
	}

	async function submissionFor(rawId: string | undefined): Promise<Submission> {
		const found = isGuid(rawId) ? await store.submission(rawId.toLowerCase()) : undefined;
		const review = found && (await store.review(found.id));
		if (!found || review?.discarded) throw new HttpError(404, 'not_found', NO_SUBMISSION);
		return found;
	}

	return {
		routes: [
			{
				name: 'children',
				method: 'GET',
				path: 'children',
				body: 'none',
				async run() {
					return { status: 200, json: { children: await childrenOf(platform) } };
				},
			},
			{
				name: 'activities',
				method: 'GET',
				path: 'activities',
				body: 'none',
				async run() {
					return { status: 200, json: await listAll() };
				},
			},
			{
				name: 'createActivity',
				method: 'POST',
				path: 'activities',
				body: 'json',
				async run({ body, now }) {
					const input = parseActivityInput(body);
					if (!input.ok) throw invalid(input.problems);
					const stored = await store.activities();
					if (stored.length >= TRANSACTION_LIMIT) throw new HttpError(409, 'too_many', `The app holds at most ${TRANSACTION_LIMIT} activities. Delete one first.`);
					const order = Math.max(-1, ...stored.map(({ activity }) => activity.order)) + 1;
					const activity: Activity = { ...input.value, id: platform.newId(), order, updatedAt: now.toISOString() };
					return { status: 201, json: view(await store.createActivity(activity)) };
				},
			},
			{
				name: 'orderActivities',
				method: 'PUT',
				path: 'activities/order',
				body: 'json',
				async run({ body }) {
					const ids = typeof body === 'object' && body !== null ? (body as { ids?: unknown }).ids : undefined;
					if (!Array.isArray(ids) || ids.length > TRANSACTION_LIMIT || !ids.every((id) => typeof id === 'string')) {
						throw invalid([`ids must be a list of at most ${TRANSACTION_LIMIT} activity ids`]);
					}
					const wanted = ids as string[];
					const known = new Map((await store.activities()).map(({ activity }) => [activity.id, activity.order]));
					const problems: string[] = [];
					const duplicates = wanted.filter((id, i) => wanted.indexOf(id) !== i);
					if (duplicates.length) problems.push(`ids has duplicates: ${[...new Set(duplicates)].join(', ')}`);
					const unknown = wanted.filter((id) => !known.has(id));
					if (unknown.length) problems.push(`ids has unknown activities: ${unknown.join(', ')}`);
					const missing = [...known.keys()].filter((id) => !wanted.includes(id));
					if (missing.length) problems.push(`ids is missing activities: ${missing.join(', ')}`);
					if (problems.length) throw invalid(problems);
					await guarded(() => store.setOrders(wanted.map((id, order) => ({ id, order })).filter(({ id, order }) => known.get(id) !== order)));
					return { status: 200, json: await listAll() };
				},
			},
			{
				name: 'updateActivity',
				method: 'PUT',
				path: 'activities/{id}',
				body: 'json',
				async run({ params, body, now }) {
					const current = await existing(params['id']);
					const input = parseActivityInput(body);
					if (!input.ok) throw invalid(input.problems);
					const etag = (body as { etag?: unknown }).etag;
					if (typeof etag !== 'string' || etag === '') throw invalid(['etag is required; load the activity before changing it']);
					const activity: Activity = { ...input.value, id: current.activity.id, order: current.activity.order, updatedAt: now.toISOString() };
					return { status: 200, json: view(await guarded(() => store.replaceActivity(activity, etag))) };
				},
			},
			{
				name: 'deleteActivity',
				method: 'DELETE',
				path: 'activities/{id}',
				body: 'none',
				async run({ params }) {
					const id = params['id'];
					if (isGuid(id)) await store.deleteActivity(id);
					return { status: 204 };
				},
			},
			{
				name: 'settings',
				method: 'GET',
				path: 'settings',
				body: 'none',
				async run() {
					return { status: 200, json: await store.settings() };
				},
			},
			{
				name: 'saveSettings',
				method: 'PUT',
				path: 'settings',
				body: 'json',
				async run({ body }) {
					const input = parseSettingsInput(body);
					if (!input.ok) throw invalid(input.problems);
					await store.saveSettings(input.value);
					return { status: 200, json: input.value };
				},
			},
			{
				name: 'practiceReport',
				method: 'GET',
				path: 'practice',
				body: 'none',
				async run({ query, now }) {
					const day = parsePracticeQuery(query, now);
					if (!day.ok) throw invalid(day.problems);
					const days = daysEndingAt(day.value);
					const [{ dailyPracticeMinutes }, children] = await Promise.all([store.settings(), childrenOf(platform)]);
					const rows = await Promise.all(children.map(async (child) => ({ ...child, rows: await store.practiceRows(child.userId, days) })));
					return { status: 200, json: buildReport({ days, children: rows, goalMinutes: dailyPracticeMinutes }) };
				},
			},
			{
				name: 'childProgress',
				method: 'GET',
				path: 'progress/{userId}',
				body: 'none',
				async run({ params, now }) {
					const userId = params['userId'];
					if (!isGuid(userId)) throw new HttpError(404, 'not_found', 'That is not a child.');
					const since = new Date(now.getTime() - PROGRESS_DAYS * DAY_MS).toISOString();
					return { status: 200, json: { attempts: await store.attempts(userId.toLowerCase(), since) } };
				},
			},
			{
				name: 'submissions',
				method: 'GET',
				path: 'submissions',
				body: 'none',
				async run({ query }) {
					const parsed = parseSubmissionQuery(query);
					if (!parsed.ok) throw invalid(parsed.problems);
					const names = new Map((await childrenOf(platform)).map(({ userId, name }) => [userId as string, name]));
					return { status: 200, json: await page(store, parsed.value, names) };
				},
			},
			{
				name: 'submissionImage',
				method: 'GET',
				path: 'submissions/{id}/image',
				body: 'none',
				async run({ params }) {
					const submission = await submissionFor(params['id']);
					const bytes = await store.submissionImage(submission.id);
					if (!bytes) throw new HttpError(404, 'not_found', NO_SUBMISSION);
					return { status: 200, bytes, contentType: 'image/png', cacheControl: 'private, no-store' };
				},
			},
			{
				name: 'reviewSubmission',
				method: 'PATCH',
				path: 'submissions/{id}',
				body: 'json',
				async run({ admin, params, body, now }) {
					const input = parseReviewInput(body);
					if (!input.ok) throw invalid(input.problems);
					const submission = await submissionFor(params['id']);
					const review = applyReview(await store.review(submission.id), input.value, admin.objectId, now);
					await store.saveReview(submission.id, review);
					const names = new Map((await childrenOf(platform)).map(({ userId, name }) => [userId as string, name]));
					return { status: 200, json: submissionView(submission, review, names) };
				},
			},
			{
				name: 'discardSubmission',
				method: 'DELETE',
				path: 'submissions/{id}',
				body: 'none',
				async run({ params }) {
					const id = params['id'];
					const submission = isGuid(id) ? await store.submission(id.toLowerCase()) : undefined;
					if (submission) await store.saveReview(submission.id, { ...(await store.review(submission.id)), discarded: true });
					return { status: 204 };
				},
			},
		],
	};
});
