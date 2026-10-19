import type { GameId, PortalUserId } from '@g4k/sdk';

/** localStorage keyed `g4k:<game>:<userId>:<key>`, so two games, or two children on one iPad, never share a key. */
export type GameStorage = {
	get(key: string): string | null;
	set(key: string, value: string): void;
	remove(key: string): void;
};

/** Storage can throw (private windows, blocked site data), and a game must still run without it. */
export function createGameStorage(store: Storage, game: GameId | 'portal', user: PortalUserId): GameStorage {
	const keyOf = (key: string) => `g4k:${game}:${user}:${key}`;
	return {
		get(key) {
			try {
				return store.getItem(keyOf(key));
			} catch {
				return null;
			}
		},
		set(key, value) {
			try {
				store.setItem(keyOf(key), value);
			} catch {
				return;
			}
		},
		remove(key) {
			try {
				store.removeItem(keyOf(key));
			} catch {
				return;
			}
		},
	};
}
