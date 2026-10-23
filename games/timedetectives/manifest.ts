import { defineGame } from '@g4k/sdk';

export default defineGame({
	id: 'timedetectives',
	title: 'Time Detectives',
	summary: 'Read a clue from the past, then work out who, where and when.',
	icon: 'icon.svg',
	scoreboard: true,
	storage: {
		tables: { topics: 'admin', rounds: 'admin', attempts: 'play', board: 'play' },
		containers: { pictures: 'admin' },
		queues: { drafts: 'admin-private' },
	},
	play: {
		web: { kind: 'static' },
		settings: {},
		services: [],
	},
	admin: {
		web: { kind: 'static' },
		settings: { FOUNDRY_ENDPOINT: { kind: 'url', optional: true } },
		services: ['cognitiveServices'],
	},
});
