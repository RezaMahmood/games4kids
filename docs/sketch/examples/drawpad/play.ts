/** games/drawpad/play/api/index.ts. Today's route({ requires: 'member' }) calls lose `requires`; caller.profile.oid becomes caller.userId. */
import { definePlayApi, HttpError } from '../../host';
import { parseNewDrawing, playStore } from './data';
import manifest from './manifest';

export const createPlayApi = definePlayApi(manifest, (platform) => {
	const store = playStore(platform);
	return {
		routes: [
			{
				name: 'createDrawing',
				method: 'POST',
				path: 'drawings',
				body: 'json',
				async run({ caller, body, now }) {
					const input = parseNewDrawing(body);
					if ('problems' in input) throw new HttpError(400, 'invalid', 'That drawing could not be started.', input.problems);
					if ((await store.secondsLeftToday(caller, now)) <= 0) throw new HttpError(403, 'time_up', 'That is all the drawing time for today.');
					const picture = await store.picture(input.pictureId);
					if (!picture || !picture.kinds.includes(input.kind)) throw new HttpError(404, 'not_found', 'That picture is not in the library.');
					const drawing = { id: platform.newId(), pictureId: picture.id, kind: input.kind, status: 'in-progress' } as const;
					await store.saveDrawing(caller, drawing);
					return { status: 201, json: drawing };
				},
			},
		],
	};
});
