/**
 * games/letterjoin/play/api/index.js stays JavaScript with checkJs; this is its shape. createApi loses authenticate,
 * accessMode and bootstrapAdmins, `level` goes, userKey(caller.email) becomes caller.userId, and drafts are never
 * listed to a player.
 */
import { definePlayApi, HttpError } from '../../host';
import manifest from './manifest';

declare function parseResultInput(body: unknown): { ok: true; value: { score: number; timeMs: number; hard: boolean } } | { ok: false; problems: string[] };

export const createPlayApi = definePlayApi(manifest, ({ tables, now }) => ({
	routes: [
		{
			name: 'saveResult',
			method: 'PUT',
			path: 'activities/{id}/result',
			body: 'json',
			async run({ caller, params, body }) {
				const activity = await tables.activities.get<{ partitionKey: string; rowKey: string; status: string }>('activity', params.id ?? '');
				if (!activity || activity.status !== 'published') throw new HttpError(404, 'not_found', 'That activity is not there any more.');
				const parsed = parseResultInput(body);
				if (!parsed.ok) throw new HttpError(400, 'invalid', 'The result could not be saved.', parsed.problems);
				const result = { ...parsed.value, completedAt: now().toISOString() };
				await tables.results.put({ partitionKey: caller.userId, rowKey: activity.rowKey, ...result });
				return { status: 200, json: result };
			},
		},
	],
}));
