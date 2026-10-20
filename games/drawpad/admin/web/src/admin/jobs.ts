import type { Job, JobStepKey, RedrawQuality } from '../../../../data/types';
import { api, ApiFailure, type JobImageKey, type NewJob, type NewPhotoJob } from '../api';
import { decodePng, encodeBytes } from '../stencil/browser';
import type { Raster } from '../stencil/types';
import type { RedrawKey } from './uploadModel';

const POLL_MS = 3000;
const SLOW_POLL_MS = 5000;
const SLOW_AFTER_MS = 60_000;
const GIVE_UP_MS = 10 * 60_000;

/** Which steps leave a PNG to download, so a new step kind cannot be added without saying. */
const DRAWS: Record<JobStepKey, boolean> = {
  titles: false,
  'trace-standard': true,
  'trace-best': true,
  prompts: false,
  'scene-1': true,
  'scene-2': true,
  'scene-3': true,
};
const draws = (key: JobStepKey): key is JobImageKey => DRAWS[key];

export const QUALITY: Record<RedrawKey, RedrawQuality> = { 'trace-standard': 'standard', 'trace-best': 'best' };

/** What the admin is told while a job is on the server: its place in the queue, then that the AI is at work. */
export function waitLabel(job: Job): string {
  if (job.status !== 'queued') return job.source === 'photo' ? 'Redrawing with AI, about a minute' : 'Drawing 3 pictures with AI, about 2 minutes';
  if (job.ahead === 0) return 'Waiting for its turn, next up';
  return `Waiting for its turn, ${job.ahead} ahead`;
}

/** Each picture that came back, why each step that did not failed, and the title ideas if they came. */
export type JobResult = {
  jobId: string;
  images: Partial<Record<JobImageKey, Raster>>;
  failures: Partial<Record<JobStepKey, Error>>;
  titles?: string[];
};

/** The upload job body for these AI redraws of a photo, and title ideas if wanted. */
export async function photoJob(photo: Raster, keys: RedrawKey[], titles: boolean): Promise<NewPhotoJob> {
  const wants = keys.map((key) => QUALITY[key]);
  return { source: 'photo', photo: await encodeBytes(photo, 'image/jpeg'), width: photo.width, height: photo.height, wants, titles };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Queues the job, waits for the server to finish it, and fetches every picture it drew. `onWait` hears each poll,
 * the first one straight after the job is queued. Resolves null as soon as `alive` turns false, so a discarded item
 * stops polling. Throws when the job cannot be queued or the server loses it.
 */
export async function runJob(body: NewJob, onWait: (job: Job) => void, alive: () => boolean): Promise<JobResult | null> {
  return waitJob(await api.createJob(body), onWait, alive);
}

/** runJob for a job the server has already queued. */
export async function waitJob(queued: Job, onWait: (job: Job) => void, alive: () => boolean): Promise<JobResult | null> {
  const started = Date.now();
  let job = queued;
  while (job.status !== 'done') {
    onWait(job);
    if (!alive()) return null;
    const waited = Date.now() - started;
    if (waited >= GIVE_UP_MS) {
      const late = new Error('The AI took longer than 10 minutes.');
      return { jobId: job.id, images: {}, failures: Object.fromEntries(job.steps.map((step) => [step.key, late])) };
    }
    await sleep(waited < SLOW_AFTER_MS ? POLL_MS : SLOW_POLL_MS);
    if (!alive()) return null;
    // A dropped connection or a server hiccup is worth another poll; a job the server says is gone is not.
    const polled = job;
    job = await api.job(job.id).catch((e) => {
      if (e instanceof ApiFailure && e.status < 500) throw e;
      return polled;
    });
  }

  const result = await collect(job);
  return alive() ? result : null;
}

/** Fetches every picture a finished job drew, and records why each step that did not finish failed. */
export async function collect(settled: Job): Promise<JobResult> {
  const result: JobResult = { jobId: settled.id, images: {}, failures: {}, titles: settled.titles };
  await Promise.all(settled.steps.map(async ({ key, state, error }) => {
    if (state !== 'done') {
      result.failures[key] = new ApiFailure(0, error ?? 'redraw_failed', '');
    } else if (draws(key)) {
      try {
        result.images[key] = await decodePng(await api.jobImage(settled.id, key));
      } catch (e) {
        result.failures[key] = e instanceof Error ? e : new Error('Could not open the AI picture.');
      }
    }
  }));
  return result;
}
