import { defineGame } from '@g4k/sdk';

export default defineGame({
	id: 'letterjoin',
	title: 'Letter Tracing',
	summary: 'Trace letters, words and sentences with the pencil.',
	icon: 'icons/icon-192.png',
	scoreboard: true,
	storage: {
		tables: { activities: 'admin', results: 'play', attempts: 'play', submissions: 'play', reviews: 'admin-private' },
		containers: { submissions: 'play' },
		queues: {},
	},
	play: {
		web: { kind: 'static' },
		settings: { VISION_ENDPOINT: { kind: 'url', optional: true }, VISION_TIER: { kind: 'choice', values: ['F0', 'S1'], optional: true } },
		services: ['cognitiveServices'],
		ai: { handwriting: 'Handwriting reading' },
	},
	admin: {
		web: { kind: 'static' },
		settings: {},
		services: [],
	},
});
