import { defineAdminApi, HttpError, type AdminPlatform } from '@g4k/sdk';
import { adminStore, parseTuning, DEFAULT_TUNING, DEFAULT_TUNING_ID, type GameRecord } from '../../data/index.ts';
import manifest from '../../manifest.ts';

const invalid = (problems: readonly string[]) => new HttpError(400, 'invalid', 'The request is not valid.', problems);
const nothingHere = () => new HttpError(404, 'not_found', 'There is nothing here.');

type Child = { userId: string; name: string };

async function childrenOf(platform: AdminPlatform<typeof manifest>): Promise<Child[]> {
	return (await platform.roster.list()).map(({ userId, profile }) => ({ userId, name: profile?.displayName ?? 'No name yet' }));
}

/** The summary columns, in the order the CSV and the metrics table show them. */
export const SUMMARY_COLUMNS = [
	'userId', 'name', 'gameId', 'savedAt', 'startedAt', 'mode', 'tuningId', 'endReason', 'score', 'roundsReached', 'turns', 'correct', 'accuracy',
	'longestStreak', 'medianCongruentMs', 'medianIncongruentMs', 'timeouts', 'hiddenMs', 'pointer', 'viewport',
] as const;

/** Text a spreadsheet would read as a formula, such as a child's name, gets a leading quote so it stays text. */
const csvCell = (value: unknown): string => {
	if (value === null || value === undefined) return '';
	const formula = typeof value === 'string' && /^[=+\-@\t\r]/.test(value);
	const text = formula ? `'${value}` : String(value);
	return formula || /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

export function summariesCsv(games: readonly GameRecord[], names: ReadonlyMap<string, string>): string {
	const lines = games.map((game) => SUMMARY_COLUMNS.map((column) => csvCell(column === 'name' ? (names.get(game.userId) ?? '') : game[column])).join(','));
	return [SUMMARY_COLUMNS.join(','), ...lines].join('\r\n') + '\r\n';
}

export const createAdminApi = defineAdminApi(manifest, (platform) => {
	const store = adminStore(platform);

	async function knownChild(raw: string | undefined): Promise<Child> {
		const child = (await childrenOf(platform)).find((candidate) => candidate.userId === raw);
		if (!child) throw nothingHere();
		return child;
	}

	return {
		routes: [
			{
				name: 'tunings',
				method: 'GET',
				path: 'tuning',
				body: 'none',
				/** Every version, newest first, and which one children play under now. */
				async run() {
					const versions = await store.tunings();
					const current = versions[0] ?? { id: DEFAULT_TUNING_ID, savedAt: '', tuning: DEFAULT_TUNING };
					return { status: 200, json: { current, versions } };
				},
			},
			{
				name: 'saveTuning',
				method: 'POST',
				path: 'tuning',
				body: 'json',
				async run({ body, now }) {
					const parsed = parseTuning(body);
					if (!parsed.ok) throw invalid(parsed.problems);
					return { status: 201, json: await store.saveTuning(parsed.value, now, platform.newId()) };
				},
			},
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
				name: 'childGames',
				method: 'GET',
				path: 'children/{userId}/games',
				body: 'none',
				async run({ params }) {
					const child = await knownChild(params['userId']);
					return { status: 200, json: { child, games: await store.gamesOf(child.userId) } };
				},
			},
			{
				name: 'childGame',
				method: 'GET',
				path: 'children/{userId}/games/{key}',
				body: 'none',
				/** The whole log with the server's mark on each word. */
				async run({ params }) {
					const child = await knownChild(params['userId']);
					const record = (await store.gamesOf(child.userId)).find((game) => game.key === params['key']);
					const game = record && (await store.game(record));
					if (!game) throw nothingHere();
					return { status: 200, json: game };
				},
			},
			{
				name: 'summariesCsv',
				method: 'GET',
				path: 'summaries.csv',
				body: 'none',
				async run() {
					const [games, children] = await Promise.all([store.allGames(), childrenOf(platform)]);
					const csv = summariesCsv(games, new Map(children.map((child) => [child.userId, child.name])));
					return { status: 200, bytes: new TextEncoder().encode(csv), contentType: 'text/csv; charset=utf-8' };
				},
			},
		],
	};
});
