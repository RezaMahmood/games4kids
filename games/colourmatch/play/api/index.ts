import { definePlayApi, HttpError } from '@g4k/sdk';
import {
	buildBoard,
	daysEndingAt,
	localDate,
	parseBoardInput,
	parseDayQuery,
	parseGameLog,
	playStore,
	replayGame,
	type GameLog,
	type SavedGame,
} from '../../data/index.ts';
import manifest from '../../manifest.ts';

const invalid = (problems: readonly string[]) => new HttpError(400, 'invalid', 'The request is not valid.', problems);

export const createPlayApi = definePlayApi(manifest, (platform) => {
	const store = playStore(platform);

	async function saveNew(userId: string, log: GameLog, now: Date): Promise<SavedGame> {
		const tuning = await store.tuning(log.tuningId);
		if (!tuning) throw new HttpError(404, 'unknown_tuning', 'This game was played under settings the server does not know.');
		const replayed = replayGame(tuning, log);
		if (!replayed.ok) throw invalid(replayed.problems);
		return store.saveGame(userId, log, replayed.value, now);
	}

	return {
		routes: [
			{
				name: 'start',
				method: 'GET',
				path: 'start',
				body: 'none',
				/** The tuning a new game plays under, and its id, which the game's log names so the server marks it by the same rules. */
				async run() {
					const { id, tuning } = await store.currentTuning();
					return { status: 200, json: { tuningId: id, tuning } };
				},
			},
			{
				name: 'saveGame',
				method: 'PUT',
				path: 'games/{gameId}',
				body: 'json',
				/**
				 * Marks the whole game again from its turns and the tuning it names, so no score comes from the page. A game
				 * already saved is answered with what was saved first, whatever the repeat says. The repeat still records the
				 * daily best, so a save whose best failed to write is put right by the retry.
				 */
				async run({ caller, params, body, now }) {
					const parsed = parseGameLog(params['gameId'], body);
					if (!parsed.ok) throw invalid(parsed.problems);
					const log = parsed.value;
					const saved = (await store.savedGame(caller.userId, log.gameId)) ?? (await saveNew(caller.userId, log, now));
					const day = localDate(new Date(saved.savedAt), caller.timeZone);
					const bestToday = await store.recordDailyBest(caller.userId, day, { points: saved.score, gameId: saved.gameId });
					return { status: 200, json: { ...saved, bestToday } };
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
					const entries = await store.boardEntries();
					const children = await Promise.all(entries.map(async (entry) => ({ ...entry, bests: await store.dailyBests(entry.userId, days) })));
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
