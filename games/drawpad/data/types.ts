export type PictureKind = 'trace' | 'pbn';

export type PbnRegion = { id: number; colorIndex: number; labelX: number; labelY: number };

export type PbnData = {
	width: number;
	height: number;
	palette: string[];
	regions: PbnRegion[];
};

export type Picture = {
	id: string;
	title: string;
	kinds: PictureKind[];
	width: number;
	height: number;
	createdAt: string;
};

export type DrawingStatus = 'in-progress' | 'finished';

export type ScoreBreakdown = Record<string, number>;

export type Score = { total: number; stars: 1 | 2 | 3 | 4 | 5; breakdown: ScoreBreakdown };

export type DrawingMeta = {
	id: string;
	pictureId: string;
	kind: PictureKind;
	status: DrawingStatus;
	createdAt: string;
	updatedAt: string;
	score: Score | null;
	filledRegions: number[] | null;
	/** Painted regions that carry the player's own #RRGGBB colour; every key is also in filledRegions. Absent on older drawings. */
	customFills?: Record<number, string>;
};

export type UsageToday = { usedSeconds: number; limitSeconds: number; remainingSeconds: number };

/** One child on the Limits screen: their own limit if the admin set one, else null, with today's usage. */
export type ChildLimit = { userId: string; name: string; dailyLimitMinutes: number | null; usedSecondsToday: number };

export type Limits = { defaultMinutes: number; children: ChildLimit[] };

export type RedrawQuality = 'standard' | 'best';

export type AiErrorCode =
	| 'redraw_refused'
	| 'redraw_failed'
	| 'redraw_unavailable'
	| 'title_refused'
	| 'title_failed'
	| 'scene_refused'
	| 'scene_failed';

/** The codes the pages branch on, on top of the platform's own (invalid, not_found, forbidden). */
export type DrawpadErrorCode = AiErrorCode | 'time_up' | 'too_many_jobs' | 'job_busy';

/** One AI output a photo job can make: a trace redraw at one quality, or the title suggestions. */
export type PhotoStepKey = `trace-${RedrawQuality}` | 'titles';

/** A description job first rewrites the description into three image prompts, then draws each one. */
export type SceneStepKey = 'prompts' | 'scene-1' | 'scene-2' | 'scene-3';

export type JobStepKey = PhotoStepKey | SceneStepKey;

export type JobStepState = 'pending' | 'done' | 'failed';

export type JobStep<K extends JobStepKey = JobStepKey> = { key: K; state: JobStepState; error?: AiErrorCode };

export type JobStatus = 'queued' | 'processing' | 'done';

/** Queued AI work, run one job at a time. `done` means every step finished or failed; read each step for the outcome. */
type JobBase = {
	id: string;
	status: JobStatus;
	/** Jobs waiting ahead of this one, 0 once it is processing or done. */
	ahead: number;
	createdAt: string;
	/** Present once the step that suggests titles is done. */
	titles?: string[];
};

/** AI work for one uploaded photo: tracing redraws and title ideas. */
export type PhotoJob = JobBase & { source: 'photo'; width: number; height: number; steps: JobStep<PhotoStepKey>[] };

/** AI work for one typed description: three pictures to choose from, drawn from three rewrites of the description. */
export type DescriptionJob = JobBase & { source: 'description'; description: string; quality: RedrawQuality; steps: JobStep<SceneStepKey>[] };

export type Job = PhotoJob | DescriptionJob;
