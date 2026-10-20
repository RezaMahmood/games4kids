import { defineGame } from '@g4k/sdk';

export default defineGame({
	id: 'fixture',
	title: 'Fixture',
	summary: 'A game that exists to be tested.',
	icon: 'icon.svg',
	storage: {
		tables: { levels: 'admin', scores: 'play', notes: 'admin-private' },
		containers: { art: 'admin', uploads: 'play' },
		queues: { jobs: 'admin-private' },
	},
	play: {
		web: { kind: 'static' },
		settings: { HINTS_URL: { kind: 'url', optional: true } },
		services: [],
		csp: { 'img-src': ['https://cdn.example'] },
	},
	admin: {
		web: { kind: 'static' },
		settings: { MAX_LEVELS: { kind: 'int', min: 1, max: 50, default: 10 } },
		services: [],
		csp: { 'worker-src': ['blob:'] },
	},
});
