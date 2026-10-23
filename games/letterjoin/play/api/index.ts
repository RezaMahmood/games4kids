import { definePlayApi, HttpError } from '@g4k/sdk';
import { buildBoard, daysEndingAt, isGuid, isPng, KEEP_PER_ACTIVITY, MAX_IMAGE_BYTES, newSubmission, parsePracticeInput, parsePracticeQuery, parseBoardInput, parseResultInput, playStore, PROGRESS_DAYS, DAY_MS, toAttempt, type Activity } from '../../data/index.ts';
import manifest from '../../manifest.ts';
import { createVisionReader, ReaderUnavailable } from './reader.ts';

const invalid = (problems: readonly string[]) => new HttpError(400, 'invalid', 'The request is not valid.', problems);
const noActivity = () => new HttpError(404, 'not_found', 'There is no such activity.');

/** The Vision account's pricing tier is a deploy fact that infra.bicep sets, so a read is priced at what the account bills. */
const VISION_MODELS = { F0: 'azure-vision-read-free', S1: 'azure-vision-read' } as const;

function visionModel(tier: keyof typeof VISION_MODELS | undefined) {
	if (!tier) throw new Error('VISION_TIER must be F0 or S1 when VISION_ENDPOINT is set');
	return VISION_MODELS[tier];
}

export const createPlayApi = definePlayApi(manifest, (platform) => {
	const store = playStore(platform);
	const endpoint = platform.settings.VISION_ENDPOINT;
	const reader = endpoint ? createVisionReader({ endpoint, token: platform.tokens.cognitiveServices }) : null;
	const model = endpoint ? visionModel(platform.settings.VISION_TIER) : null;

	async function published(rawId: string | undefined): Promise<Activity> {
		const activity = isGuid(rawId) ? await store.activity(rawId) : undefined;
		if (!activity || activity.status !== 'published') throw noActivity();
		return activity;
	}

	async function practiceReply(userId: string, day: string, seconds = 0) {
		const [{ dailyPracticeMinutes: minutes }, usedSeconds] = await Promise.all([
			store.settings(),
			seconds ? store.addPractice(userId, day, seconds) : store.practiceSeconds(userId, day),
		]);
		return { status: 200, json: { minutes, usedSeconds } } as const;
	}

	return {
		routes: [
			{
				name: 'activities',
				method: 'GET',
				path: 'activities',
				body: 'none',
				async run({ caller }) {
					const [activities, results] = await Promise.all([store.activities(), store.results(caller.userId)]);
					return { status: 200, json: { activities: activities.filter((activity) => activity.status === 'published').map((activity) => ({ ...activity, result: results.get(activity.id) ?? null })) } };
				},
			},
			{
				name: 'saveResult',
				method: 'PUT',
				path: 'activities/{id}/result',
				body: 'json',
				async run({ caller, params, body, now }) {
					const activity = await published(params['id']);
					const parsed = parseResultInput(body, activity);
					if (!parsed.ok) throw invalid(parsed.problems);
					const { score, timeMs, hard } = parsed.value;
					const result = { score, timeMs, hard, completedAt: now.toISOString() };
					await store.saveResult(caller.userId, toAttempt(activity, parsed.value, result.completedAt), result);
					return { status: 200, json: result };
				},
			},
			{
				name: 'progress',
				method: 'GET',
				path: 'progress',
				body: 'none',
				async run({ caller, now }) {
					const since = new Date(now.getTime() - PROGRESS_DAYS * DAY_MS).toISOString();
					return { status: 200, json: { attempts: await store.attempts(caller.userId, since) } };
				},
			},
			{
				name: 'submitCopy',
				method: 'POST',
				path: 'activities/{id}/submission',
				body: 'png',
				async run({ caller, params, body, now }) {
					const activity = await published(params['id']);
					if (activity.mode !== 'traceThenCopy') throw new HttpError(409, 'no_copy', 'This activity does not ask for a copy.');
					if (body.length > MAX_IMAGE_BYTES) throw new HttpError(413, 'too_large', `The image must be at most ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`);
					if (!isPng(body)) throw invalid(['the body must be a PNG image']);
					const submission = newSubmission({ userId: caller.userId, activity, bytes: body.length, at: now });
					await store.addSubmission(submission, body);
					for (const old of (await store.submissionIdsFor(caller.userId, activity.id)).slice(KEEP_PER_ACTIVITY)) await store.removeSubmission(old);
					return { status: 201, json: { id: submission.id, createdAt: submission.createdAt } };
				},
			},
			{
				name: 'readHandwriting',
				method: 'POST',
				path: 'activities/{id}/read',
				body: 'png',
				async run({ caller, params, body }) {
					if (!reader || !model) throw new HttpError(503, 'reader_off', 'Reading handwriting is not switched on.');
					const activityId = params['id'];
					if (!isGuid(activityId)) throw noActivity();
					if (!isPng(body)) throw invalid(['the body must be a PNG image']);
					const billed = () => platform.usage.record({ area: 'handwriting', model, tokens: { transactions: 1 }, subject: { item: activityId, group: caller.userId } });
					try {
						return { status: 200, json: { words: (await reader.read(body, billed)).words } };
					} catch (error) {
						if (error instanceof ReaderUnavailable) throw new HttpError(502, 'reader_unavailable', 'The handwriting reader is not available right now. Try again later.');
						throw error;
					}
				},
			},
			{
				name: 'practice',
				method: 'GET',
				path: 'practice',
				body: 'none',
				async run({ caller, query, now }) {
					const day = parsePracticeQuery(query, now);
					if (!day.ok) throw invalid(day.problems);
					return practiceReply(caller.userId, day.value);
				},
			},
			{
				name: 'addPractice',
				method: 'POST',
				path: 'practice',
				body: 'json',
				async run({ caller, body, now }) {
					const input = parsePracticeInput(body, now);
					if (!input.ok) throw invalid(input.problems);
					return practiceReply(caller.userId, input.value.day, input.value.seconds);
				},
			},
			{
				name: 'board',
				method: 'GET',
				path: 'board',
				body: 'none',
				async run({ caller, query, now }) {
					const day = parsePracticeQuery(query, now);
					if (!day.ok) throw invalid(day.problems);
					const me = await store.refreshBoardEntry(caller.userId, caller.displayName, caller.timeZone);
					if (!me) return { status: 200, json: { optedIn: false } };
					const days = daysEndingAt(day.value);
					// Every zone is within a day of UTC, so attempts from the day before the first one cover each child's local days.
					const floor = new Date(Date.parse(`${days[0]}T00:00:00Z`) - DAY_MS).toISOString();
					const children = await Promise.all((await store.boardEntries()).map(async (entry) => ({ ...entry, attempts: await store.attempts(entry.userId, entry.since > floor ? entry.since : floor) })));
					return { status: 200, json: { optedIn: true, ...buildBoard({ days, viewerId: caller.userId, children }) } };
				},
			},
			{
				name: 'boardMe',
				method: 'GET',
				path: 'board/me',
				body: 'none',
				async run({ caller }) {
					const me = await store.refreshBoardEntry(caller.userId, caller.displayName, caller.timeZone);
					return { status: 200, json: { optedIn: me !== undefined } };
				},
			},
			{
				name: 'setBoard',
				method: 'PUT',
				path: 'board/me',
				body: 'json',
				async run({ caller, body, now }) {
					const on = parseBoardInput(body);
					if (!on.ok) throw invalid(on.problems);
					if (on.value) await store.optIn({ userId: caller.userId, name: caller.displayName, timeZone: caller.timeZone, since: now.toISOString() });
					else await store.optOut(caller.userId);
					return { status: 200, json: { optedIn: on.value } };
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
		],
	};
});
