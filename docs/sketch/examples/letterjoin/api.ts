/**
 * games/letterjoin/api/index.js stays JavaScript with checkJs; this is its shape in TypeScript. Today's
 * createApi({ authenticate, accessMode, bootstrapAdmins, store, reader }) loses its three auth parameters,
 * `level` becomes `access`, and userKey(caller.email) becomes caller.userId. The reader feeds the
 * readHandwriting route, left out here.
 */
import { defineGameApi, HttpError, type Platform, type Reply } from '../../host';
import manifest from './manifest';

type Letterjoin = typeof manifest;

type Store = {
	getActivity(id: string): Promise<{ activity: { id: string; status: 'live' | 'draft' } } | null>;
	putAttempt(userId: string, attempt: object): Promise<void>;
	putResult(userId: string, activityId: string, result: object): Promise<void>;
};

declare function createTableStore(tables: Platform<Letterjoin>['tables']): Store;
declare function createVisionReader(options: { endpoint: string; getToken: () => Promise<string> }): { read(png: Uint8Array): Promise<{ words: string[] }> };
declare function parseResultInput(body: unknown, activity: object): { ok: true; value: { score: number; timeMs: number; hard: boolean } } | { ok: false; problems: string[] };

export const createGameApi = defineGameApi(manifest, ({ tables, settings, tokens, now }) => {
	const store = createTableStore(tables);
	const reader = settings.VISION_ENDPOINT ? createVisionReader({ endpoint: settings.VISION_ENDPOINT, getToken: tokens.cognitiveServices }) : null;
	return {
		routes: [
			{
				name: 'saveResult',
				method: 'PUT',
				path: 'activities/{id}/result',
				access: 'member',
				body: 'json',
				async run({ caller, params, body }): Promise<Reply> {
					const stored = await store.getActivity(params.id ?? '');
					if (!stored || (stored.activity.status === 'draft' && caller.role !== 'admin')) throw new HttpError(404, 'not_found', 'That activity is not there any more.');
					const parsed = parseResultInput(body, stored.activity);
					if (!parsed.ok) throw new HttpError(400, 'invalid', 'The result could not be saved.', parsed.problems);
					const result = { ...parsed.value, completedAt: now().toISOString() };
					await store.putAttempt(caller.userId, { activityId: stored.activity.id, ...result });
					await store.putResult(caller.userId, stored.activity.id, result);
					return { status: 200, json: result };
				},
			},
		],
	};
});
