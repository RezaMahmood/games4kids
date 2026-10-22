import { definePlayApi, HttpError } from '@g4k/sdk';
import {
	buildBoard,
	DAY_MS,
	daysEndingAt,
	imageReply,
	isPublished,
	isRecord,
	localDate,
	nothingHere,
	parseAttemptInput,
	parseBoardInput,
	parseConfidence,
	parseDayQuery,
	playStore,
	pointsOn,
	roundId,
	roundView,
	scoreAttempt,
	topicId,
	type BrokenRound,
	type Published,
} from '../../data/index.ts';
import manifest from '../../manifest.ts';

const invalid = (problems: readonly string[]) => new HttpError(400, 'invalid', 'The request is not valid.', problems);
const roundChanged = () => new HttpError(409, 'round_changed', 'This mystery was changed while you were solving it.');

export const createPlayApi = definePlayApi(manifest, (platform) => {
	const store = playStore(platform);

	const skip = (log: (line: string) => void, { id, problems }: BrokenRound) => log(`skipped stored round ${id}, which does not parse: ${problems.join('; ')}`);

	async function published(rawId: string | undefined, log: (line: string) => void): Promise<Published | undefined> {
		const id = roundId(rawId);
		const round = id && (await store.round(id));
		if (round && 'broken' in round) skip(log, round);
		return round && !('broken' in round) && isPublished(round) ? round : undefined;
	}

	async function playable(log: (line: string) => void): Promise<Published[]> {
		const { rounds, broken } = await store.rounds();
		for (const round of broken) skip(log, round);
		return rounds.filter(isPublished);
	}

	return {
		routes: [
			{
				name: 'topics',
				method: 'GET',
				path: 'topics',
				body: 'none',
				async run({ log }) {
					const [topics, rounds] = await Promise.all([store.topics(), playable(log)]);
					const open = new Set(rounds.map((round) => round.topicId));
					return { status: 200, json: { topics: topics.filter((topic) => open.has(topic.id)).map(({ id, title }) => ({ id, title })) } };
				},
			},
			{
				name: 'nextRound',
				method: 'GET',
				path: 'topics/{id}/next',
				body: 'none',
				/** A round from the topic the child has not played yet, at random, or any of them once they have played them all. */
				async run({ caller, params, query, log }) {
					const confidence = parseConfidence(query.get('confidence'));
					if (!confidence) throw invalid(['confidence must be one of lots, bit, easy']);
					const topic = topicId(params['id']);
					const [rounds, played] = await Promise.all([playable(log), store.played(caller.userId)]);
					const candidates = rounds.filter((round) => round.topicId === topic);
					const seen = new Set(played.map((round) => round.roundId));
					const fresh = candidates.filter((round) => !seen.has(round.id));
					const pool = fresh.length > 0 ? fresh : candidates;
					const round = pool[Math.floor(Math.random() * pool.length)];
					if (!round) throw new HttpError(404, 'no_rounds', 'There are no mysteries in that topic yet.');
					return { status: 200, json: roundView(round, confidence) };
				},
			},
			{
				name: 'picture',
				method: 'GET',
				path: 'rounds/{id}/picture',
				body: 'none',
				async run({ params, ifNoneMatch, log }) {
					const round = await published(params['id'], log);
					if (!round?.picture) throw nothingHere();
					return imageReply(await store.picture(round.id, round.picture, ifNoneMatch));
				},
			},
			{
				name: 'saveAttempt',
				method: 'PUT',
				path: 'rounds/{id}/attempts/{attemptId}',
				body: 'json',
				/**
				 * Marks the whole log again, so the score rule lives here and the page's marks are only for feedback. A round an
				 * admin took down, or changed so the log no longer scores, answers round_changed: trying again never helps.
				 */
				async run({ caller, params, body, now, log }) {
					const input = parseAttemptInput(params['attemptId'], body);
					if (!input.ok) throw invalid(input.problems);
					const { attemptId: id, confidence, answers } = input.value;
					const total = async () => pointsOn(localDate(now, caller.timeZone), await store.played(caller.userId), caller.timeZone);
					const repeat = await store.savedAttempt(caller.userId, id);
					if (repeat) return { status: 200, json: { points: repeat.points, right: repeat.right, total: await total() } };
					const round = await published(params['id'], log);
					if (!round) throw roundChanged();
					const marked = scoreAttempt(round.state.content, input.value);
					const sawOlder = isRecord(body) && typeof body['version'] === 'string' && body['version'] !== round.updatedAt;
					if (!marked.ok) throw sawOlder ? roundChanged() : invalid(marked.problems);
					const { points, right } = marked.value;
					const saved = await store.saveAttempt(caller.userId, { id, roundId: round.id, topicId: round.topicId, confidence, answers, points, right, completedAt: now.toISOString() });
					return { status: 200, json: { points: saved.points, right: saved.right, total: await total() } };
				},
			},
			{
				name: 'board',
				method: 'GET',
				path: 'board',
				body: 'none',
				async run({ caller, query, now }) {
					const day = parseDayQuery(query, now);
					if (!day.ok) throw invalid(day.problems);
					const me = await store.refreshBoardEntry(caller.userId, caller.displayName, caller.timeZone);
					if (!me) return { status: 200, json: { optedIn: false } };
					const days = daysEndingAt(day.value);
					// Every zone is within a day of UTC, so rounds from the day before the first one cover each child's local days.
					const floor = new Date(Date.parse(`${days[0]}T00:00:00Z`) - DAY_MS).toISOString();
					const entries = await store.boardEntries();
					const children = await Promise.all(entries.map(async (entry) => ({ ...entry, played: (await store.played(entry.userId)).filter((round) => round.completedAt >= floor) })));
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
		],
	};
});
