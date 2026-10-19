/** games/drawpad/manifest.ts */
import { defineGame } from '../../manifest';

export default defineGame({
	id: 'drawpad',
	title: 'Draw Pad',
	summary: 'Colour outlines, paint by numbers, or draw freely.',
	icon: 'icon.svg',
	web: { kind: 'vite' },
	adminPath: '?mode=admin',
	roles: ['player', 'admin'],
	defaultRole: 'player',
	storage: {
		tables: ['pictures', 'drawings', 'usage', 'settings', 'jobs'],
		containers: ['pictures', 'drawings', 'jobs'],
		queues: ['stencil-jobs'],
	},
	settings: { FOUNDRY_ENDPOINT: { kind: 'url' } },
	services: ['cognitiveServices'],
	csp: { 'img-src': ['blob:'], 'worker-src': ["'self'"] },
});
