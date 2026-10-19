import type { Caller, StorageFor } from '@g4k/sdk';
import type manifest from '../manifest.ts';

export type PlayStore = { recordPlay(caller: Caller): Promise<void> };

export function playStore(storage: StorageFor<typeof manifest, 'play'>): PlayStore {
	return {
		async recordPlay(caller) {
			await storage.tables.plays.put({ partitionKey: caller.userId, rowKey: 'last', name: caller.displayName });
		},
	};
}
