/**
 * Compile-time proof of the isolation claims. `tsc --noEmit` passes only if every @ts-expect-error line really
 * is an error, so the negatives are checked as well as the positives.
 */
import { defineGameApi, type Platform } from './host';
import { defineGame } from './manifest';
import type drawpad from './examples/drawpad/manifest';
import type letterjoin from './examples/letterjoin/manifest';
import letterjoinManifest from './examples/letterjoin/manifest';

declare const lj: Platform<typeof letterjoin>;
declare const dp: Platform<typeof drawpad>;

lj.tables.activities.inPartition('activity');
dp.queues['stencil-jobs'].send({ jobId: 'j1' });
dp.blobs.pictures.put('p1/outline.png', new Uint8Array(), 'image/png');
const vision: string | undefined = lj.settings.VISION_ENDPOINT;
const foundry: string = dp.settings.FOUNDRY_ENDPOINT;
void lj.tokens.cognitiveServices();

// @ts-expect-error pictures is drawpad's table, not letterjoin's.
lj.tables.pictures;
// @ts-expect-error portal tables are not reachable by name.
lj.tables['portalMembers'];
// @ts-expect-error letterjoin declared no queues.
lj.queues['stencil-jobs'];
// @ts-expect-error drawpad declared no submissions container.
dp.blobs.submissions;
// @ts-expect-error a setting the manifest did not declare.
dp.settings.VISION_ENDPOINT;

// @ts-expect-error storage is not an AzureService, so there is no storage token.
lj.tokens.storage;
// @ts-expect-error the platform carries no credential.
lj.credential;
// @ts-expect-error the platform carries no environment.
lj.env;
defineGame({
	id: 'sneaky',
	title: 'Sneaky',
	summary: '',
	icon: 'icon.svg',
	web: { kind: 'static' },
	roles: ['member'],
	defaultRole: 'member',
	storage: { tables: [], containers: [], queues: [] },
	settings: {},
	// @ts-expect-error a manifest cannot declare a storage service.
	services: ['storage'],
});

defineGameApi(letterjoinManifest, () => ({
	routes: [
		{
			name: 'promote',
			method: 'POST',
			path: 'promote',
			// @ts-expect-error superuser is not on letterjoin's ladder.
			access: 'superuser',
			body: 'none',
			run: async () => ({ status: 204 }),
		},
	],
}));
defineGame({
	id: 'badladder',
	title: 'Bad ladder',
	summary: '',
	icon: 'icon.svg',
	web: { kind: 'static' },
	roles: ['player', 'admin'],
	// @ts-expect-error the default role must be on the ladder.
	defaultRole: 'owner',
	storage: { tables: [], containers: [], queues: [] },
	settings: {},
	services: [],
});

defineGame({
	id: 'sharer',
	title: 'Sharer',
	summary: '',
	icon: 'icon.svg',
	web: { kind: 'static' },
	roles: ['member'],
	defaultRole: 'member',
	storage: { tables: [], containers: [], queues: [] },
	settings: {},
	services: [],
	// @ts-expect-error exports must be empty until the cross-game hub exists.
	exports: { scoreboard: 'v1' },
});

defineGameApi(letterjoinManifest, () => ({
	routes: [],
	// @ts-expect-error letterjoin declared no stencil-jobs queue.
	workers: [{ queue: 'stencil-jobs', run: async () => {} }],
}));

export { foundry, vision };
