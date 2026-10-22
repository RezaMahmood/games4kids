import { definePlayApi, HttpError } from '@g4k/sdk';
import {
	buildBoard,
	DAY_MS,
	daysEndingAt,
	imageReply,
	isPublished,
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
	type Published,
} from '../../data/index.ts';
import manifest from '../../manifest.ts';

const invalid = (problems: readonly string[]) => new HttpError(400, 'invalid', 'The request is not valid.', problems);

export const createPlayApi = definePlayApi(manifest, (platform) => {
	const store = playStore(platform);

	async function published(rawId: string | undefined): Promise<Published> {
		const id = roundId(rawId);
		const round = id && (await store.round(id));
		if (!round || !isPublished(round)) throw nothingHere();
		return round;
	}

	return {
		routes: [
			{
				name: 'topics',
				method: 'GET',
				path: 'topics',
				body: 'none',
				async run() {
					const [topics, rounds] = await Promise.all([store.topics(), store.rounds()]);
					const open = new Set(rounds.filter(isPublished).map((round) => round.topicId));
					return { status: 200, json: { topics: topics.filter((topic) => open.has(topic.id)).map(({ id, title }) => ({ id, title })) } };
				},
			},
			{
				name: 'nextRound',
				method: 'GET',
				path: 'topics/{id}/next',
				body: 'none',
				/** A round from the topic the child has not played yet, at random, or any of them once they have played them all. */
				async run({ caller, params, query }) {
					const confidence = parseConfidence(query.get('confidence'));
					if (!confidence) throw invalid(['confidence must be one of lots, bit, easy']);
					const topic = topicId(params['id']);
					const [rounds, played] = await Promise.all([store.rounds(), store.played(caller.userId)]);
					const candidates = rounds.filter(isPublished).filter((round) => round.topicId === topic);
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
				async run({ params, ifNoneMatch }) {
					const round = await published(params['id']);
					return imageReply(await store.picture(round.id, ifNoneMatch));
				},
			},
			{
				name: 'saveAttempt',
				method: 'PUT',
				path: 'rounds/{id}/attempts/{attemptId}',
				body: 'json',
				/** Marks the whole log again, so the score rule lives here and the page's marks are only for feedback. */
				async run({ caller, params, body, now }) {
					const round = await published(params['id']);
					const input = parseAttemptInput(params['attemptId'], body);
					if (!input.ok) throw invalid(input.problems);
					const marked = scoreAttempt(round.state.content, input.value);
					if (!marked.ok) throw invalid(marked.problems);
					const { attemptId: id, confidence, answers } = input.value;
					const saved = await store.saveAttempt(caller.userId, { id, roundId: round.id, topicId: round.topicId, confidence, answers, points: marked.value.points, completedAt: now.toISOString() });
					const total = pointsOn(localDate(now, caller.timeZone), await store.played(caller.userId), caller.timeZone);
					return { status: 200, json: { points: saved.points, right: marked.value.right, total } };
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
