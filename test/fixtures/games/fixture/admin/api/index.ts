import { defineAdminApi, HttpError } from '@g4k/sdk';
import { adminStore, parseLevel, parseNote } from '../../data/index.ts';
import manifest from '../../manifest.ts';

export const createAdminApi = defineAdminApi(manifest, (platform) => {
	const store = adminStore(platform);
	return {
		routes: [
			{
				name: 'putLevel',
				method: 'PUT',
				path: 'levels/{id}',
				body: 'json',
				async run({ params, body }) {
					const level = parseLevel(params['id'] ?? '', body);
					if ('problems' in level) throw new HttpError(400, 'invalid', 'That level is not valid.', level.problems);
					await store.putLevel(level);
					return { status: 204 };
				},
			},
			{
				name: 'scores',
				method: 'GET',
				path: 'scores',
				body: 'none',
				async run() {
					const [scores, players] = await Promise.all([store.scores(), platform.roster.list()]);
					const names = new Map(players.map((player) => [player.userId, player.profile?.displayName ?? 'unknown']));
					return { status: 200, json: scores.map((score) => ({ ...score, name: names.get(score.userId) ?? 'unknown' })) };
				},
			},
			{
				name: 'addNote',
				method: 'POST',
				path: 'notes',
				body: 'json',
				async run({ body }) {
					const note = parseNote(body);
					if ('problems' in note) throw new HttpError(400, 'invalid', 'That note is not valid.', note.problems);
					const id = platform.newId();
					await store.addNote(id, note.text);
					return { status: 201, json: { id } };
				},
			},
		],
	};
});
