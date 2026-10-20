import type { Blob, ReadBlobs, Row, StorageFor, Stored } from '@g4k/sdk';
import type manifest from '../manifest.ts';
import { jobPhotoPath, jobReadyEvent, jobReadyPath } from './job-event.ts';
import {
	CHILD_LIMITS_PK,
	DEFAULT_LIMIT_KEY,
	drawingImagePath,
	fromDrawing,
	fromPicture,
	JOBS_PK,
	PICTURES_PK,
	SETTINGS_PK,
	toDrawing,
	toPicture,
	type DrawingRow,
	type JobRow,
	type LimitRow,
	type PictureRow,
	type UsageRow,
} from './model.ts';
import { localDate, resolveLimitMinutes, usageToday } from './usage.ts';
import type { ChildLimit, DrawingMeta, Limits, Picture, UsageToday } from './types.ts';

type Drawpad = typeof manifest;

export type ImageRead = Blob | 'not-modified' | undefined;

export type Child = { readonly userId: string; readonly timeZone: string };

function plain<R extends Row>(stored: Stored<R>): R {
	return Object.fromEntries(Object.entries(stored).filter(([name]) => name !== 'etag')) as R;
}

const plainAll = <R extends Row>(rows: readonly Stored<R>[]): R[] => rows.map(plain);

async function bytesAt(blobs: ReadBlobs, path: string): Promise<Uint8Array | undefined> {
	const found = await blobs.get(path);
	return found && found !== 'not-modified' ? found.bytes : undefined;
}

export type PlayStore = {
	pictures(): Promise<Picture[]>;
	picture(id: string): Promise<Picture | undefined>;
	pictureFile(path: string, ifNoneMatch: string | undefined): Promise<ImageRead>;
	drawings(userId: string): Promise<DrawingMeta[]>;
	drawing(userId: string, id: string): Promise<DrawingMeta | undefined>;
	saveDrawing(userId: string, drawing: DrawingMeta): Promise<void>;
	drawingImage(userId: string, id: string, ifNoneMatch: string | undefined): Promise<ImageRead>;
	saveDrawingImage(userId: string, id: string, png: Uint8Array): Promise<void>;
	deleteDrawing(userId: string, id: string): Promise<void>;
	/** Today's usage against the child's own limit, else the default limit, else 60 minutes. */
	usage(child: Child, now: Date): Promise<UsageToday>;
	recordUsage(child: Child, now: Date, seconds: number): Promise<UsageToday>;
};

export function playStore(storage: StorageFor<Drawpad, 'play'>): PlayStore {
	const { pictures, settings, drawings, usage } = storage.tables;

	async function limitMinutes(userId: string): Promise<number> {
		const [own, fallback] = await Promise.all([settings.get<LimitRow>(CHILD_LIMITS_PK, userId), settings.get<LimitRow>(SETTINGS_PK, DEFAULT_LIMIT_KEY)]);
		return resolveLimitMinutes(own?.dailyLimitMinutes, fallback?.dailyLimitMinutes);
	}

	const usedSeconds = async (child: Child, now: Date) => (await usage.get<UsageRow>(child.userId, localDate(now, child.timeZone)))?.seconds ?? 0;

	return {
		async pictures() {
			return plainAll(await pictures.inPartition<PictureRow>(PICTURES_PK)).map(toPicture).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
		},
		async picture(id) {
			const row = await pictures.get<PictureRow>(PICTURES_PK, id);
			return row && toPicture(plain(row));
		},
		pictureFile: (path, ifNoneMatch) => storage.blobs.pictures.get(path, ifNoneMatch),
		async drawings(userId) {
			return plainAll(await drawings.inPartition<DrawingRow>(userId)).map(toDrawing).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		},
		async drawing(userId, id) {
			const row = await drawings.get<DrawingRow>(userId, id);
			return row && toDrawing(plain(row));
		},
		saveDrawing: (userId, drawing) => drawings.put(fromDrawing(userId, drawing)),
		drawingImage: (userId, id, ifNoneMatch) => storage.blobs.drawings.get(drawingImagePath(userId, id), ifNoneMatch),
		saveDrawingImage: (userId, id, png) => storage.blobs.drawings.put(drawingImagePath(userId, id), png, 'image/png'),
		async deleteDrawing(userId, id) {
			await storage.blobs.drawings.remove(drawingImagePath(userId, id));
			await drawings.remove(userId, id);
		},
		async usage(child, now) {
			return usageToday(await usedSeconds(child, now), await limitMinutes(child.userId));
		},
		async recordUsage(child, now, seconds) {
			const total = (await usedSeconds(child, now)) + seconds;
			await usage.put({ partitionKey: child.userId, rowKey: localDate(now, child.timeZone), seconds: total } satisfies UsageRow);
			return usageToday(total, await limitMinutes(child.userId));
		},
	};
}

export type JobStore = {
	all(): Promise<JobRow[]>;
	get(id: string): Promise<JobRow | undefined>;
	put(row: JobRow): Promise<void>;
	/** Replaces a row only while it still exists, so a worker never brings back a job an admin deleted. */
	replaceIfPresent(row: JobRow): Promise<boolean>;
	remove(id: string): Promise<void>;
	removeFiles(id: string): Promise<void>;
	file(path: string): Promise<Uint8Array | undefined>;
	fileRead(path: string, ifNoneMatch: string | undefined): Promise<ImageRead>;
	putFile(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
	putPhoto(id: string, jpeg: Uint8Array): Promise<void>;
	/** Writes the job's ready blob, whose BlobCreated event starts the job. Azurite raises no events, so locally the store sends the event itself. */
	signalReady(id: string, now: Date, sendEvent: boolean): Promise<void>;
};

const REPLACE_ATTEMPTS = 3;

export type AdminStore = {
	pictures(): Promise<Picture[]>;
	pictureFile(path: string, ifNoneMatch: string | undefined): Promise<ImageRead>;
	putPictureFile(id: string, file: string, bytes: Uint8Array, contentType: string): Promise<void>;
	pictureFiles(id: string): Promise<string[]>;
	addPicture(picture: Picture): Promise<void>;
	renamePicture(id: string, title: string): Promise<Picture | undefined>;
	deletePicture(id: string): Promise<void>;
	limits(children: readonly { readonly userId: string; readonly name: string; readonly timeZone: string }[], now: Date): Promise<Limits>;
	setChildLimit(userId: string, dailyLimitMinutes: number | null): Promise<void>;
	gallery(): Promise<(DrawingMeta & { userId: string })[]>;
	drawingImage(userId: string, id: string, ifNoneMatch: string | undefined): Promise<ImageRead>;
	jobs: JobStore;
};

export function adminStore(storage: StorageFor<Drawpad, 'admin'>): AdminStore {
	const { pictures, settings, drawings, usage, jobs } = storage.tables;
	const { jobs: jobFiles, pictures: pictureBlobs } = storage.blobs;

	const jobStore: JobStore = {
		async all() {
			return plainAll(await jobs.inPartition<JobRow>(JOBS_PK));
		},
		async get(id) {
			const row = await jobs.get<JobRow>(JOBS_PK, id);
			return row && plain(row);
		},
		put: (row) => jobs.put(row),
		async replaceIfPresent(row) {
			for (let attempt = 0; attempt < REPLACE_ATTEMPTS; attempt++) {
				const current = await jobs.get<JobRow>(JOBS_PK, row.rowKey);
				if (!current) return false;
				if (await jobs.replaceIfMatch(row, current.etag)) return true;
			}
			throw new Error(`job ${row.rowKey} kept changing while it was being saved`);
		},
		remove: (id) => jobs.remove(JOBS_PK, id),
		async removeFiles(id) {
			for (const path of await jobFiles.list(`${id}/`)) await jobFiles.remove(path);
		},
		file: (path) => bytesAt(jobFiles, path),
		fileRead: (path, ifNoneMatch) => jobFiles.get(path, ifNoneMatch),
		putFile: (path, bytes, contentType) => jobFiles.put(path, bytes, contentType),
		putPhoto: (id, jpeg) => jobFiles.put(jobPhotoPath(id), jpeg, 'image/jpeg'),
		async signalReady(id, now, sendEvent) {
			await jobFiles.put(jobReadyPath(id), new Uint8Array(), 'application/octet-stream');
			if (sendEvent) await storage.queues['stencil-jobs'].send(jobReadyEvent(id, now));
		},
	};

	return {
		async pictures() {
			return plainAll(await pictures.inPartition<PictureRow>(PICTURES_PK)).map(toPicture).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
		},
		pictureFile: (path, ifNoneMatch) => pictureBlobs.get(path, ifNoneMatch),
		putPictureFile: (id, file, bytes, contentType) => pictureBlobs.put(`${id}/${file}`, bytes, contentType),
		async pictureFiles(id) {
			return (await pictureBlobs.list(`${id}/`)).map((path) => path.slice(id.length + 1));
		},
		addPicture: (picture) => pictures.put(fromPicture(picture)),
		async renamePicture(id, title) {
			const row = await pictures.get<PictureRow>(PICTURES_PK, id);
			if (!row) return undefined;
			const renamed = { ...toPicture(plain(row)), title };
			return (await pictures.replaceIfMatch(fromPicture(renamed), row.etag)) ? renamed : undefined;
		},
		async deletePicture(id) {
			await pictures.remove(PICTURES_PK, id);
			for (const path of await pictureBlobs.list(`${id}/`)) await pictureBlobs.remove(path);
		},
		async limits(children, now) {
			const [fallback, own] = await Promise.all([settings.get<LimitRow>(SETTINGS_PK, DEFAULT_LIMIT_KEY), settings.inPartition<LimitRow>(CHILD_LIMITS_PK)]);
			const overrides = new Map(own.map((row) => [row.rowKey, row.dailyLimitMinutes]));
			const rows = await Promise.all(
				children.map(async (child): Promise<ChildLimit> => ({
					userId: child.userId,
					name: child.name,
					dailyLimitMinutes: overrides.get(child.userId) ?? null,
					usedSecondsToday: (await usage.get<UsageRow>(child.userId, localDate(now, child.timeZone)))?.seconds ?? 0,
				})),
			);
			return { defaultMinutes: resolveLimitMinutes(undefined, fallback?.dailyLimitMinutes), children: rows };
		},
		async setChildLimit(userId, dailyLimitMinutes) {
			if (dailyLimitMinutes === null) await settings.remove(CHILD_LIMITS_PK, userId);
			else await settings.put({ partitionKey: CHILD_LIMITS_PK, rowKey: userId, dailyLimitMinutes } satisfies LimitRow);
		},
		async gallery() {
			const rows = plainAll(await drawings.list<DrawingRow>());
			return rows.map((row) => ({ ...toDrawing(row), userId: row.partitionKey })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		},
		drawingImage: (userId, id, ifNoneMatch) => storage.blobs.drawings.get(drawingImagePath(userId, id), ifNoneMatch),
		jobs: jobStore,
	};
}
