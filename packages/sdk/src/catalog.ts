import type { GameId } from './manifest.ts';

/** One home card on the games site. A game appears for a child only when its id is in their member row. */
export type CatalogEntry = {
	readonly id: GameId;
	readonly title: string;
	readonly summary: string;
	readonly icon: string;
	readonly path: `/g/${string}/`;
	/** func-g4k-<id>'s origin. Gen leaves it out; the games-site deploy job and the dev stack fill it in. */
	readonly apiBaseUrl: string;
	/** The game's manifest sets `scoreboard`, so /profile/ offers the child a switch for it. */
	readonly scoreboard?: true;
};

/** One row of the admin site's game list: what a member can be granted, and whether the game has admin pages. */
export type AdminCatalogEntry = {
	readonly id: GameId;
	readonly title: string;
	readonly hasAdmin: boolean;
	readonly path: `/g/${string}/`;
};
