import type { Blob, Caller, PortalUserId, Row, StorageFor } from '@g4k/sdk';
import type manifest from '../manifest.ts';

type Fixture = typeof manifest;

export type Level = { readonly id: string; readonly title: string };
export type Score = { readonly levelId: string; readonly points: number };

type Parsed<T> = T | { readonly problems: readonly string[] };

function field(raw: unknown, name: string): unknown {
	return typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>)[name] : undefined;
}

export function parseLevel(id: string, raw: unknown): Parsed<Level> {
	const title = field(raw, 'title');
	return typeof title === 'string' && title.length > 0 ? { id, title } : { problems: ['title is required'] };
}

export function parsePoints(raw: unknown): Parsed<{ readonly points: number }> {
	const points = field(raw, 'points');
	return typeof points === 'number' && Number.isInteger(points) && points >= 0 ? { points } : { problems: ['points must be a whole number'] };
}

export function parseNote(raw: unknown): Parsed<{ readonly text: string }> {
	const text = field(raw, 'text');
	return typeof text === 'string' && text.length > 0 ? { text } : { problems: ['text is required'] };
}

const levelOf = (row: Row): Level => ({ id: row.rowKey, title: String(row['title']) });

export type PlayStore = {
	levels(): Promise<readonly Level[]>;
	level(id: string): Promise<Level | undefined>;
	saveScore(caller: Caller, score: Score): Promise<void>;
	saveUpload(caller: Caller, id: string, png: Uint8Array): Promise<void>;
	art(name: string, ifNoneMatch: string | undefined): Promise<Blob | 'not-modified' | undefined>;
};

export function playStore(storage: StorageFor<Fixture, 'play'>): PlayStore {
	return {
		async levels() {
			return (await storage.tables.levels.inPartition('level')).map(levelOf);
		},
		async level(id) {
			const row = await storage.tables.levels.get('level', id);
			return row && levelOf(row);
		},
		async saveScore(caller, score) {
			await storage.tables.scores.put({ partitionKey: caller.userId, rowKey: score.levelId, points: score.points });
		},
		async saveUpload(caller, id, png) {
			await storage.blobs.uploads.put(`${caller.userId}/${id}.png`, png, 'image/png');
		},
		art: (name, ifNoneMatch) => storage.blobs.art.get(name, ifNoneMatch),
	};
}

export type AdminStore = {
	putLevel(level: Level): Promise<void>;
	scores(): Promise<readonly (Score & { readonly userId: PortalUserId })[]>;
	addNote(id: string, text: string): Promise<void>;
	putArt(name: string, jpeg: Uint8Array): Promise<void>;
	note(id: string): Promise<{ readonly text: string; readonly done: boolean } | undefined>;
	finishNote(id: string): Promise<void>;
};

export function adminStore(storage: StorageFor<Fixture, 'admin'>): AdminStore {
	return {
		async putLevel(level) {
			await storage.tables.levels.put({ partitionKey: 'level', rowKey: level.id, title: level.title });
		},
		async scores() {
			const rows = await storage.tables.scores.list();
			return rows.map((row) => ({ userId: row.partitionKey as PortalUserId, levelId: row.rowKey, points: Number(row['points']) }));
		},
		async addNote(id, text) {
			await storage.tables.notes.put({ partitionKey: 'note', rowKey: id, text });
			await storage.queues.jobs.send({ noteId: id });
		},
		putArt: (name, jpeg) => storage.blobs.art.put(name, jpeg, 'image/jpeg'),
		async note(id) {
			const row = await storage.tables.notes.get('note', id);
			return row && { text: String(row['text']), done: row['done'] === true };
		},
		async finishNote(id) {
			const row = await storage.tables.notes.get('note', id);
			if (row) await storage.tables.notes.put({ partitionKey: 'note', rowKey: id, text: String(row['text']), done: true });
		},
	};
}
