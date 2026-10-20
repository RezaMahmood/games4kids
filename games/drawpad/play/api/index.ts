import { definePlayApi, HttpError } from '@g4k/sdk';
import { idParam, parseDrawingPatch, parseHeartbeat, parseNewDrawing } from '../../data/parse.ts';
import { IMMUTABLE, imageReply, nothingHere, PICTURE_FILES, REVALIDATE } from '../../data/reply.ts';
import { playStore } from '../../data/stores.ts';
import type { DrawingMeta } from '../../data/types.ts';
import manifest from '../../manifest.ts';

export const createPlayApi = definePlayApi(manifest, (platform) => {
	const store = playStore(platform);

	async function assertTimeLeft(caller: { userId: string; timeZone: string }, now: Date): Promise<void> {
		if ((await store.usage(caller, now)).remainingSeconds <= 0) throw new HttpError(403, 'time_up', 'That is all the drawing time for today.');
	}

	async function ownDrawing(userId: string, rawId: string | undefined): Promise<DrawingMeta> {
		const drawing = await store.drawing(userId, idParam(rawId));
		if (!drawing) throw nothingHere();
		return drawing;
	}

	return {
		routes: [
			{
				name: 'pictures',
				method: 'GET',
				path: 'pictures',
				body: 'none',
				async run() {
					return { status: 200, json: await store.pictures() };
				},
			},
			{
				name: 'pictureFile',
				method: 'GET',
				path: 'pictures/{id}/{file}',
				body: 'none',
				async run({ params, ifNoneMatch }) {
					const id = idParam(params['id']);
					const file = params['file'] ?? '';
					const contentType = PICTURE_FILES.get(file);
					if (!contentType) throw nothingHere();
					return imageReply(await store.pictureFile(`${id}/${file}`, ifNoneMatch), contentType, IMMUTABLE);
				},
			},
			{
				name: 'drawings',
				method: 'GET',
				path: 'drawings',
				body: 'none',
				async run({ caller }) {
					return { status: 200, json: await store.drawings(caller.userId) };
				},
			},
			{
				name: 'createDrawing',
				method: 'POST',
				path: 'drawings',
				body: 'json',
				async run({ caller, body, now }) {
					const { pictureId, kind } = parseNewDrawing(body);
					await assertTimeLeft(caller, now);
					const picture = await store.picture(pictureId);
					if (!picture?.kinds.includes(kind)) throw nothingHere();
					const drawing: DrawingMeta = {
						id: platform.newId(),
						pictureId,
						kind,
						status: 'in-progress',
						createdAt: now.toISOString(),
						updatedAt: now.toISOString(),
						score: null,
						filledRegions: null,
					};
					await store.saveDrawing(caller.userId, drawing);
					return { status: 201, json: drawing };
				},
			},
			{
				name: 'drawingImage',
				method: 'GET',
				path: 'drawings/{id}/image',
				body: 'none',
				async run({ caller, params, now, ifNoneMatch }) {
					const drawing = await ownDrawing(caller.userId, params['id']);
					await assertTimeLeft(caller, now);
					return imageReply(await store.drawingImage(caller.userId, drawing.id, ifNoneMatch), 'image/png', REVALIDATE);
				},
			},
			{
				name: 'saveDrawingImage',
				method: 'POST',
				path: 'drawings/{id}/image',
				body: 'png',
				async run({ caller, params, body }) {
					const drawing = await ownDrawing(caller.userId, params['id']);
					await store.saveDrawingImage(caller.userId, drawing.id, body);
					return { status: 204 };
				},
			},
			{
				name: 'saveDrawing',
				method: 'PUT',
				path: 'drawings/{id}',
				body: 'json',
				async run({ caller, params, body, now }) {
					const row = await ownDrawing(caller.userId, params['id']);
					const patch = parseDrawingPatch(body);
					// A finished drawing can still be edited, but its score and status are final.
					const settled = row.status === 'finished';
					const drawing: DrawingMeta = {
						...row,
						...(!settled && patch.status && { status: patch.status }),
						...(!settled && patch.score && { score: patch.score }),
						...(patch.filledRegions && { filledRegions: patch.filledRegions }),
						...(patch.customFills && { customFills: patch.customFills }),
						updatedAt: now.toISOString(),
					};
					await store.saveDrawing(caller.userId, drawing);
					return { status: 200, json: drawing };
				},
			},
			{
				name: 'deleteDrawing',
				method: 'DELETE',
				path: 'drawings/{id}',
				body: 'none',
				async run({ caller, params }) {
					const drawing = await ownDrawing(caller.userId, params['id']);
					await store.deleteDrawing(caller.userId, drawing.id);
					return { status: 204 };
				},
			},
			{
				name: 'usage',
				method: 'GET',
				path: 'usage',
				body: 'none',
				async run({ caller, now }) {
					return { status: 200, json: await store.usage(caller, now) };
				},
			},
			{
				name: 'heartbeat',
				method: 'POST',
				path: 'usage/heartbeat',
				body: 'json',
				async run({ caller, body, now }) {
					return { status: 200, json: await store.recordUsage(caller, now, parseHeartbeat(body)) };
				},
			},
		],
	};
});
