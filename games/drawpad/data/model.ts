import type { DescriptionJob, DrawingMeta, Job, JobStatus, JobStep, JobStepKey, PhotoStepKey, Picture, PictureKind, RedrawQuality, SceneStepKey } from './types.ts';

export const PICTURES_PK = 'p';
export const SETTINGS_PK = 's';
export const DEFAULT_LIMIT_KEY = 'default';
export const CHILD_LIMITS_PK = 'child';
export const JOBS_PK = 'jobs';

export type PictureRow = { partitionKey: string; rowKey: string; title: string; kinds: string; width: number; height: number; createdAt: string };

export type DrawingRow = {
	partitionKey: string;
	rowKey: string;
	pictureId: string;
	kind: PictureKind;
	status: DrawingMeta['status'];
	createdAt: string;
	updatedAt: string;
	score?: string;
	filledRegions?: string;
	customFills?: string;
};

export type UsageRow = { partitionKey: string; rowKey: string; seconds: number };

export type LimitRow = { partitionKey: string; rowKey: string; dailyLimitMinutes: number };

/** `steps`, `titles` and `prompts` are JSON. `attempts` is the dequeue count of the worker run that last touched the job. */
type JobRowBase = { partitionKey: string; rowKey: string; status: JobStatus; steps: string; titles?: string; createdAt: string; attempts: number };

export type PhotoJobRow = JobRowBase & { source: 'photo'; width: number; height: number };

/** `prompts` holds the three image prompts once the prompts step is done. */
export type DescriptionJobRow = JobRowBase & { source: 'description'; description: string; quality: RedrawQuality; prompts?: string };

export type JobRow = PhotoJobRow | DescriptionJobRow;

export const toPicture = (row: PictureRow): Picture => ({
	id: row.rowKey,
	title: row.title,
	kinds: row.kinds.split(',') as PictureKind[],
	width: row.width,
	height: row.height,
	createdAt: row.createdAt,
});

export const fromPicture = (picture: Picture): PictureRow => ({
	partitionKey: PICTURES_PK,
	rowKey: picture.id,
	title: picture.title,
	kinds: picture.kinds.join(','),
	width: picture.width,
	height: picture.height,
	createdAt: picture.createdAt,
});

export const toDrawing = (row: DrawingRow): DrawingMeta => ({
	id: row.rowKey,
	pictureId: row.pictureId,
	kind: row.kind,
	status: row.status,
	createdAt: row.createdAt,
	updatedAt: row.updatedAt,
	score: row.score ? (JSON.parse(row.score) as DrawingMeta['score']) : null,
	filledRegions: row.filledRegions ? (JSON.parse(row.filledRegions) as number[]) : null,
	...(row.customFills ? { customFills: JSON.parse(row.customFills) as Record<number, string> } : {}),
});

export const fromDrawing = (userId: string, drawing: DrawingMeta): DrawingRow => ({
	partitionKey: userId,
	rowKey: drawing.id,
	pictureId: drawing.pictureId,
	kind: drawing.kind,
	status: drawing.status,
	createdAt: drawing.createdAt,
	updatedAt: drawing.updatedAt,
	...(drawing.score ? { score: JSON.stringify(drawing.score) } : {}),
	...(drawing.filledRegions ? { filledRegions: JSON.stringify(drawing.filledRegions) } : {}),
	...(drawing.customFills ? { customFills: JSON.stringify(drawing.customFills) } : {}),
});

export const drawingImagePath = (userId: string, id: string) => `${userId}/${id}.png`;

export type NewJob =
	| { source: 'photo'; photo: Photo; steps: PhotoStepKey[] }
	| { source: 'description'; description: string; quality: RedrawQuality };

export type Photo = { jpeg: Uint8Array; width: number; height: number };

/** The steps of a description job, in the order the worker runs them. */
export const DESCRIPTION_STEP_KEYS: SceneStepKey[] = ['prompts', 'scene-1', 'scene-2', 'scene-3'];

/** Whether a done step left `<job id>/<step key>.png` in the jobs container. */
export const STEP_WRITES_PNG: Record<JobStepKey, boolean> = {
	'trace-standard': true,
	'trace-best': true,
	titles: false,
	prompts: false,
	'scene-1': true,
	'scene-2': true,
	'scene-3': true,
};

type StepKeys = { photo: PhotoStepKey; description: SceneStepKey };

export const jobSteps = <R extends JobRow>(row: R) => JSON.parse(row.steps) as JobStep<StepKeys[R['source']]>[];

const pending = (keys: JobStepKey[]) => JSON.stringify(keys.map((key): JobStep => ({ key, state: 'pending' })));

export function newJobRow(job: NewJob, rowKey: string, createdAt: string): JobRow {
	const base = { partitionKey: JOBS_PK, rowKey, status: 'queued', createdAt, attempts: 0 } as const;
	switch (job.source) {
		case 'photo':
			return { ...base, source: 'photo', steps: pending(job.steps), width: job.photo.width, height: job.photo.height };
		case 'description':
			return { ...base, source: 'description', steps: pending(DESCRIPTION_STEP_KEYS), description: job.description, quality: job.quality };
	}
}

export function toJob(row: JobRow, ahead: number): Job {
	const base = {
		id: row.rowKey,
		status: row.status,
		ahead,
		createdAt: row.createdAt,
		...(row.titles ? { titles: JSON.parse(row.titles) as string[] } : {}),
	};
	switch (row.source) {
		case 'photo':
			return { ...base, source: 'photo', width: row.width, height: row.height, steps: jobSteps(row) };
		case 'description':
			return { ...base, source: 'description', description: row.description, quality: row.quality, steps: jobSteps(row) } satisfies DescriptionJob;
	}
}
