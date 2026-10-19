/**
 * games/drawpad/admin/api/index.ts. Today's api/admin/* routes and the stencil worker. The worker runs in
 * func-g4k-admin, which infra caps at one instance, with queue batchSize 1, so Foundry sees one redraw at a time.
 */
import { defineAdminApi, HttpError, type AdminPlatform } from '../../host';
import { adminStore, parseLimit } from './data';
import manifest from './manifest';

declare function runStencilJob(platform: AdminPlatform<typeof manifest>, message: unknown, log: (line: string) => void): Promise<void>;

export const createAdminApi = defineAdminApi(manifest, (platform) => {
	const store = adminStore(platform);
	return {
		routes: [
			{
				name: 'setChildLimit',
				method: 'PUT',
				path: 'limits/{userId}',
				body: 'json',
				async run({ params, body }) {
					const input = parseLimit(body);
					if ('problems' in input) throw new HttpError(400, 'invalid', 'That limit is not valid.', input.problems);
					await store.setChildLimit(params.userId ?? '', input.dailyLimitMinutes);
					return { status: 204 };
				},
			},
			{
				name: 'gallery',
				method: 'GET',
				path: 'drawings',
				body: 'none',
				async run() {
					const [drawings, players] = await Promise.all([store.gallery(), platform.roster.list()]);
					const names = new Map(players.map((p) => [p.userId as string, p.profile?.displayName ?? 'unknown']));
					return { status: 200, json: drawings.map((d) => ({ ...d, userName: names.get(d.userId) ?? 'unknown' })) };
				},
			},
		],
		workers: [{ queue: 'stencil-jobs', run: (message, { log }) => runStencilJob(platform, message, log) }],
	};
});
