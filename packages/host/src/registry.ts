import type { CreateAdminApi, CreatePlayApi, GameId, GameManifest } from '@g4k/sdk';
import { requireGameId } from './platform.ts';

export type GameParts<M extends GameManifest> = {
	readonly manifest: M;
	readonly play: CreatePlayApi<M>;
	readonly admin: CreateAdminApi<M> | null;
};

/**
 * One game in dev/generated/games.ts. A list cannot hold each game's own manifest type, so `use` hands the parts
 * back with their types intact to code that is generic over any manifest.
 */
export type RegistryEntry = {
	readonly id: GameId;
	use<R>(visit: <M extends GameManifest>(parts: GameParts<M>) => R): R;
};

export function registryEntry<M extends GameManifest>(parts: GameParts<M>): RegistryEntry {
	return { id: requireGameId(parts.manifest), use: (visit) => visit(parts) };
}
