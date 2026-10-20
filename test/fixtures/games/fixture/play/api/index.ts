import { definePlayApi, HttpError } from '@g4k/sdk';
import { parsePoints, playStore } from '../../data/index.ts';
import manifest from '../../manifest.ts';

export const createPlayApi = definePlayApi(manifest, (platform) => {
	const store = playStore(platform);
	return {
		routes: [
			{
				name: 'levels',
				method: 'GET',
				path: 'levels',
				body: 'none',
				async run() {
					return { status: 200, json: await store.levels() };
				},
			},
			{
				name: 'saveScore',
				method: 'PUT',
				path: 'scores/{levelId}',
				body: 'json',
				async run({ caller, params, body }) {
					const input = parsePoints(body);
					if ('problems' in input) throw new HttpError(400, 'invalid', 'That score is not valid.', input.problems);
					const level = await store.level(params['levelId'] ?? '');
					if (!level) throw new HttpError(404, 'not_found', 'That level is not there.');
					await store.saveScore(caller, { levelId: level.id, points: input.points });
					return { status: 204 };
				},
			},
			{
				name: 'art',
				method: 'GET',
				path: 'art/{name}',
				body: 'none',
				async run({ params, ifNoneMatch }) {
					const art = await store.art(params['name'] ?? '', ifNoneMatch);
					if (art === 'not-modified') return { status: 304 };
					if (!art) throw new HttpError(404, 'not_found', 'That art is not there.');
					return { status: 200, bytes: art.bytes, contentType: art.contentType, etag: art.etag };
				},
			},
			{
				name: 'upload',
				method: 'POST',
				path: 'uploads',
				body: 'png',
				async run({ caller, body }) {
					const id = platform.newId();
					await store.saveUpload(caller, id, body);
					return { status: 201, json: { id } };
				},
			},
		],
	};
});
