/** games/drawpad/manifest.ts */
import { defineGame } from '../../manifest';

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
		csp: { 'img-src': ['blob:'], 'style-src': ['https://fonts.googleapis.com'], 'font-src': ['https://fonts.gstatic.com'] },
	},
	admin: {
		web: { kind: 'vite' },
		settings: { FOUNDRY_ENDPOINT: { kind: 'url' } },
		services: ['cognitiveServices'],
		csp: { 'img-src': ['blob:'], 'worker-src': ["'self'"], 'style-src': ['https://fonts.googleapis.com'], 'font-src': ['https://fonts.gstatic.com'] },
	},
});
