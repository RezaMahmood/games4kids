import { defineGame } from '@g4k/sdk';

export default defineGame({
	id: 'puzzle',
	title: 'Puzzle',
	summary: 'A second fixture, so a test can prove a child sees only the games granted.',
	icon: 'icon.svg',
	storage: {
		tables: { plays: 'play' },
		containers: {},
		queues: {},
	},
	play: {
		web: { kind: 'static' },
		settings: {},
		services: [],
	},
});
