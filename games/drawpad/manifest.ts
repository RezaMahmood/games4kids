import { defineGame } from '@g4k/sdk';

export default defineGame({
	id: 'drawpad',
	title: 'Draw Pad',
	summary: 'Colour outlines, paint by numbers, or draw freely.',
	icon: 'icon.svg',
	storage: {
		tables: { pictures: 'admin', settings: 'admin', drawings: 'play', usage: 'play', jobs: 'admin-private' },
		containers: { pictures: 'admin', drawings: 'play', jobs: 'admin-private' },
		queues: { 'stencil-jobs': 'admin-private' },
	},
	play: {
		web: { kind: 'vite' },
		settings: {},
		services: [],
	},
	admin: {
		web: { kind: 'vite' },
		settings: {
			FOUNDRY_ENDPOINT: { kind: 'url', optional: true },
			LOCAL_JOB_EVENTS: { kind: 'int', min: 0, max: 1, default: 0 },
		},
		services: ['cognitiveServices'],
		ai: { titles: 'Photo titles', redraw: 'Photo redraws', 'scene-prompts': 'Scene prompts', scene: 'Scene pictures' },
	},
});
