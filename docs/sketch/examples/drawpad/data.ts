/**
 * games/drawpad/data: row types, parse functions and the two stores over drawpad's account. Each store is built from
 * its side's storage view, so the player store has no way to write a picture and the admin store none to write a drawing.
 */
import type { Caller } from '../../identity';
import type { StorageFor } from '../../host';
import type manifest from './manifest';

type Drawpad = typeof manifest;

export type Picture = { readonly id: string; readonly title: string; readonly kinds: readonly ('outline' | 'numbers' | 'free')[] };
export type Drawing = { readonly id: string; readonly pictureId: string; readonly kind: Picture['kinds'][number]; readonly status: 'in-progress' | 'done' };

export declare function parseNewDrawing(body: unknown): { readonly pictureId: string; readonly kind: Drawing['kind'] } | { readonly problems: readonly string[] };
export declare function parseLimit(body: unknown): { readonly dailyLimitMinutes: number | null } | { readonly problems: readonly string[] };

export type PlayStore = {
	picture(id: string): Promise<Picture | undefined>;
	saveDrawing(caller: Caller, drawing: Drawing): Promise<void>;
	/** Per-child limit (settings PK 'child'), else the default row, against today's usage in the child's time zone. */
	secondsLeftToday(caller: Caller, now: Date): Promise<number>;
};

export type AdminStore = {
	putPicture(picture: Picture, files: ReadonlyMap<string, Uint8Array>): Promise<void>;
	setChildLimit(userId: string, dailyLimitMinutes: number | null): Promise<void>;
	gallery(): Promise<readonly (Drawing & { readonly userId: string })[]>;
};

export declare function playStore(storage: StorageFor<Drawpad, 'play'>): PlayStore;
export declare function adminStore(storage: StorageFor<Drawpad, 'admin'>): AdminStore;
