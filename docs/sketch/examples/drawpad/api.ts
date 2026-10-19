/**
 * games/drawpad/api/index.ts. Today's route({ requires }) calls become Route objects, storage.ts is deleted in
 * favour of platform handles, and caller.profile.oid becomes caller.userId.
 */
import { defineGameApi, HttpError, type Caller, type Platform, type Table } from '../../host';
import manifest from './manifest';

type Drawpad = typeof manifest;

declare function parseNewDrawing(body: unknown): { pictureId: string; kind: 'outline' | 'numbers' | 'free' };
declare function secondsLeftToday(usage: Table, settings: Table, caller: Caller<Drawpad>, now: Date): Promise<number>;
declare function runStencilJob(platform: Platform<Drawpad>, message: unknown, log: (line: string) => void): Promise<void>;

export const createGameApi = defineGameApi(manifest, (platform) => {
	const { tables } = platform;
	return {
		routes: [
			{
				name: 'createDrawing',
				method: 'POST',
				path: 'drawings',
				access: 'player',
				body: 'json',
				async run({ caller, body, now }) {
					const { pictureId, kind } = parseNewDrawing(body);
					if (caller.role !== 'admin' && (await secondsLeftToday(tables.usage, tables.settings, caller, now)) <= 0) {
						throw new HttpError(403, 'time_up', 'That is all the drawing time for today.');
					}
					const picture = await tables.pictures.get<{ partitionKey: string; rowKey: string; kinds: string }>('picture', pictureId);
					if (!picture || !picture.kinds.split(',').includes(kind)) throw new HttpError(404, 'not_found', 'That picture is not in the library.');
					const drawing = { id: platform.newId(), pictureId, kind, status: 'in-progress', createdAt: now.toISOString(), updatedAt: now.toISOString() };
					await tables.drawings.put({ partitionKey: caller.userId, rowKey: drawing.id, ...drawing });
					return { status: 201, json: drawing };
				},
			},
		],
		workers: [{ queue: 'stencil-jobs', run: (message, { log }) => runStencilJob(platform, message, log) }],
	};
});
