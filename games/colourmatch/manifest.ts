import { defineGame } from '@g4k/sdk';

export default defineGame({
	id: 'colourmatch',
	title: 'Colour Match',
	summary: 'Read the colour word and tap its square before the clock runs out. Hard mode asks for the ink instead.',
	icon: 'icon.svg',
	scoreboard: true,
	storage: {
		tables: { tuning: 'admin', games: 'play', board: 'play' },
		containers: { games: 'play' },
		queues: {},
	},
	play: {
		web: { kind: 'static' },
		settings: {},
		services: [],
	},
	admin: {
		web: { kind: 'static' },
		settings: {},
		services: [],
	},
});
