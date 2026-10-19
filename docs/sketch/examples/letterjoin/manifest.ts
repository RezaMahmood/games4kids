/** games/letterjoin/manifest.ts. Settings and practice days keep living in partitions of activities and results. */
import { defineGame } from '../../manifest';

export default defineGame({
	id: 'letterjoin',
	title: 'Letter Tracing',
	summary: 'Trace letters, words and sentences with the pencil.',
	icon: 'icons/icon-192.png',
	web: { kind: 'static' },
	adminPath: 'admin.html',
	roles: ['member', 'admin'],
	defaultRole: 'member',
	storage: {
		tables: ['activities', 'results', 'attempts', 'submissions'],
		containers: ['submissions'],
		queues: [],
	},
	settings: { VISION_ENDPOINT: { kind: 'url', optional: true } },
	services: ['cognitiveServices'],
	csp: { 'img-src': ['data:', 'blob:'] },
});
