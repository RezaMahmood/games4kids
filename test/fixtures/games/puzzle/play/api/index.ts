import { definePlayApi } from '@g4k/sdk';
import { playStore } from '../../data/index.ts';
import manifest from '../../manifest.ts';

export const createPlayApi = definePlayApi(manifest, (platform) => {
	const store = playStore(platform);
	return {
		routes: [
			{
				name: 'hello',
				method: 'POST',
				path: 'hello',
				body: 'none',
				async run({ caller }) {
					await store.recordPlay(caller);
					return { status: 200, json: { hello: caller.displayName } };
				},
			},
		],
	};
});
