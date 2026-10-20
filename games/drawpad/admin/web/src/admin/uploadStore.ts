import type { DescriptionJob, Job, PhotoJob, RedrawQuality, SceneStepKey } from '../../../../data/types';
import { useEffect, useState } from 'preact/hooks';
import { api, ApiFailure, type NewJob } from '../api';
import { decodeImage, pbnInWorker } from '../stencil/browser';
import type { Raster } from '../stencil/types';
import { generate } from './generate';
import { collect, photoJob, QUALITY, runJob, waitJob, waitLabel, type JobResult } from './jobs';
import { describeFailure, describePromptsFailure } from './messages';
import { jobDate, recentJobs } from './recentJobs';
import {
  DEFAULT_TUNING, readyRedraws, reduce, redrawsNeeded, titleFromDescription, titleFromFile, withoutRedraws,
  type Action, type DescriptionItem, type Item, type PbnTuning, type PhotoItem, type RedrawKey, type Scene, type SceneIndex, type Scenes, type Tuning,
} from './uploadModel';

export const MAX_PHOTO_MB = 30;
const DEBOUNCE_MS = 400;

// Module level so the queue keeps working, and survives, while the admin visits another tab.
let items: Item[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const retuneTimers = new Map<number, ReturnType<typeof setTimeout>>();

export function dispatch(action: Action) {
  items = reduce(items, action);
  listeners.forEach((l) => l());
  startNext();
}

export const uploadItems = (): Item[] => items;

export function useUploadItems(): Item[] {
  const [, setTick] = useState(0);
  useEffect(() => {
    const rerender = () => setTick((n) => n + 1);
    listeners.add(rerender);
    rerender();
    return () => void listeners.delete(rerender);
  }, []);
  return items;
}

// Every photo starts at once so each gets its own place in the server's AI queue, which runs one upload at a time.
// process marks the photo working before its first await, so the dispatch doing that starts the next one.
function startNext() {
  const next = items.find((i): i is PhotoItem => i.source === 'photo' && i.phase.kind === 'waiting');
  if (next) void process(next);
}

/** runJob for an item, noting every job it makes on the item so saving can delete them and Recent uploads can skip them. */
async function runItemJob(id: number, body: NewJob, onWait: (job: Job) => void, alive: () => boolean): Promise<JobResult | null> {
  const track = (jobId: string) => {
    if (!items.find((i) => i.id === id)?.jobIds.includes(jobId)) dispatch({ type: 'jobStarted', id, jobId });
  };
  const result = await runJob(body, (job) => { track(job.id); onWait(job); }, alive);
  if (result) track(result.jobId);
  return result;
}

const inPhase = (id: number, kind: Item['phase']['kind']) => () => items.some((i) => i.id === id && i.phase.kind === kind);

// A failed AI redraw still leaves a picture the admin can review: that output is made the free way, and this says so.
const fellBack = (error: Error) => describeFailure('The AI outline did not work, so this shows the Classic outline.', error);

async function process(item: PhotoItem) {
  const { id } = item;
  const report = (label: string, progress: number) => dispatch({ type: 'progress', id, label, progress });
  report('Opening photo…', 0.1);
  try {
    const photo = await decodeImage(item.file);
    const keys = redrawsNeeded(item.tuning);
    if (keys.length === 0) {
      void suggestTitles(id, photo);
      const generated = await generate(photo, item.tuning, {}, report);
      dispatch({ type: 'loaded', id, photo, generated, redraws: {} });
      return;
    }
    report('Sending to the AI…', 0.2);
    const result = await runItemJob(id, await photoJob(photo, keys, true), (job) => report(waitLabel(job), 0.3), inPhase(id, 'working'));
    if (!result) return;
    if (result.titles) dispatch({ type: 'suggested', id, titles: result.titles });
    const lost = keys.filter((key) => result.failures[key]);
    const generated = await generate(photo, withoutRedraws(item.tuning, lost), result.images, report);
    const error = lost.map((key) => fellBack(result.failures[key]!)).join(' ') || undefined;
    dispatch({ type: 'loaded', id, photo, generated, redraws: result.images, error });
  } catch (e) {
    const message = e instanceof ApiFailure ? describeFailure('Could not send this photo to the AI.', e)
      : e instanceof Error ? e.message : 'Could not make a picture from that photo.';
    dispatch({ type: 'failed', id, message });
  }
}

/** A job just for title ideas, when no output needs an AI redraw. Titles are a nicety, so on any failure the file-derived title just stays. */
async function suggestTitles(id: number, photo: Raster) {
  const result = await photoJob(photo, [], true)
    .then((body) => runItemJob(id, body, () => {}, () => items.some((i) => i.id === id)))
    .catch(() => null);
  if (result?.titles) dispatch({ type: 'suggested', id, titles: result.titles });
}

/** Applies a tuning change from Review and remakes the picture once the admin pauses. */
export function retune(id: number, tuning: Tuning) {
  dispatch({ type: 'tune', id, tuning });
  clearTimeout(retuneTimers.get(id));
  retuneTimers.set(id, setTimeout(() => regenerate(id), DEBOUNCE_MS));
}

/** Remakes a ready picture for its current tuning in the browser. The reducer only asks when the redraw it needs is back. */
function regenerate(id: number) {
  const item = items.find((i) => i.id === id);
  if (item?.source !== 'photo' || item.phase.kind !== 'ready' || !item.phase.regenerating) return;
  const { phase, tuning } = item;
  const { rev } = phase;
  generate(phase.photo, tuning, readyRedraws(phase.redraws)).then(
    (generated) => dispatch({ type: 'regenerated', id, rev, generated }),
    (e) => dispatch({ type: 'regenerateFailed', id, rev, message: describeFailure('Could not update the picture.', e) }),
  );
}

/**
 * Makes the AI outline the current tuning asks for, or makes it again: the one place a photo in Review costs an AI call,
 * and only on the admin's say. Choosing an outline never calls the AI.
 */
export function makeOutline(id: number) {
  const item = items.find((i) => i.id === id);
  if (item?.source !== 'photo' || item.phase.kind !== 'ready') return;
  const [key] = redrawsNeeded(item.tuning);
  if (!key || item.phase.redraws[key]?.kind === 'waiting') return;
  void redraw(id, item.phase.photo, key);
}

async function redraw(id: number, photo: Raster, key: RedrawKey) {
  const wait = (label: string) => dispatch({ type: 'redrawWaiting', id, keys: [key], label });
  wait('Sending to the AI…');
  const onWait = (job: Job) => wait(waitLabel(job));
  const result = await outlineJob(id, photo, key, onWait)
    .catch((e: Error): Pick<JobResult, 'images' | 'failures'> => ({ images: {}, failures: { [key]: e } }));
  if (!result) return;
  const image = result.images[key];
  const error = result.failures[key] ?? (image ? undefined : new Error('The AI outline did not come back.'));
  dispatch({ type: 'redrawn', id, redraws: image ? { [key]: image } : {}, failed: error ? { [key]: describeFailure('The AI outline did not work.', error) } : {} });
  regenerate(id);
}

/**
 * Asks the item's photo job for the outline, so the photo is never uploaded again and the job stays the one cache of
 * everything made from it. A job the server no longer has, such as one past its 7 days, is replaced by a new one.
 */
async function outlineJob(id: number, photo: Raster, key: RedrawKey, onWait: (job: Job) => void): Promise<JobResult | null> {
  const alive = inPhase(id, 'ready');
  const jobId = items.find((i) => i.id === id)?.jobIds.at(-1);
  if (jobId) {
    try {
      return await waitJob(await api.redrawJob(jobId, QUALITY[key]), onWait, alive);
    } catch (e) {
      if (!(e instanceof ApiFailure && e.status === 404)) throw e;
    }
  }
  return runItemJob(id, await photoJob(photo, [key], false), onWait, alive);
}

const looksLikePhoto = (f: File) => f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name);

export function queuePhotos(files: File[]) {
  const queued = files.map((file): PhotoItem => {
    const base = { id: nextId++, source: 'photo' as const, file, title: titleFromFile(file.name), titleSource: 'file' as const, suggestions: [], jobIds: [], tuning: DEFAULT_TUNING };
    if (!looksLikePhoto(file)) return { ...base, phase: { kind: 'failed', message: 'That file is not a photo.' } };
    if (file.size > MAX_PHOTO_MB * 1024 * 1024) return { ...base, phase: { kind: 'failed', message: `That photo is bigger than ${MAX_PHOTO_MB} MB.` } };
    return { ...base, phase: { kind: 'waiting' } };
  });
  dispatch({ type: 'queued', items: queued });
}

/**
 * Removes an item, and deletes its jobs with everything the AI made for it, since nothing else will read them. A
 * description still waiting deletes its own job once its polling stops. Best effort.
 */
export function discard(id: number) {
  const item = items.find((i) => i.id === id);
  dispatch({ type: 'discard', id });
  if (item?.source === 'photo' || item?.phase.kind === 'choosing') forgetJobs(item.jobIds);
}

/** Deletes a job nothing will read again, ignoring failure: the server drops jobs after 7 days anyway. */
export function forgetJob(jobId: string) {
  api.deleteJob(jobId).then(() => recentJobs.forget(jobId), () => {});
}

export const forgetJobs = (jobIds: readonly string[]) => jobIds.forEach(forgetJob);

function sceneOf(result: JobResult, key: Exclude<SceneStepKey, 'prompts'>): Scene {
  const raster = result.images[key];
  if (raster) return { kind: 'ready', raster };
  const error = result.failures[key];
  return { kind: 'failed', error: error instanceof ApiFailure ? error.code : 'redraw_failed' };
}

/** Queues a description for three AI pictures. It starts at once: the server's queue decides when it runs. */
export function queueDescription(description: string, quality: RedrawQuality) {
  const item: DescriptionItem = {
    id: nextId++, source: 'description', description, quality, title: titleFromDescription(description), titleSource: 'description',
    suggestions: [], jobIds: [], phase: { kind: 'waiting', label: 'Sending to the AI…' },
  };
  dispatch({ type: 'queued', items: [item] });
  void drawScenes(item);
}

async function drawScenes({ id, description, quality }: DescriptionItem) {
  let jobId: string | undefined;
  const onWait = (job: Job) => {
    jobId = job.id;
    dispatch({ type: 'sceneWaiting', id, label: waitLabel(job) });
  };
  try {
    const result = await runItemJob(id, { source: 'description', description, quality }, onWait, inPhase(id, 'waiting'));
    if (!result) {
      // Discarded while the AI worked: deleting the job stops any pictures it has not drawn yet.
      if (jobId) forgetJob(jobId);
      return;
    }
    showScenes(id, result);
  } catch (e) {
    dispatch({ type: 'failed', id, message: describeFailure('Could not send this description to the AI.', e) });
  }
}

/** Offers the pictures a description job drew, or says why there are none and deletes the job, which has nothing to show. */
function showScenes(id: number, result: JobResult) {
  if (result.titles) dispatch({ type: 'suggested', id, titles: result.titles });
  const prompts = result.failures.prompts;
  if (prompts) {
    forgetJob(result.jobId);
    return dispatch({ type: 'failed', id, message: describePromptsFailure(prompts) });
  }
  const scenes: Scenes = [sceneOf(result, 'scene-1'), sceneOf(result, 'scene-2'), sceneOf(result, 'scene-3')];
  dispatch({ type: 'drawn', id, scenes });
  if (scenes.every((scene) => scene.kind === 'failed')) forgetJob(result.jobId);
}

/**
 * Opens a finished job from the server's Recent uploads in Review, from what it already drew and with no AI call.
 * Everything is fetched before the item appears, so a failure leaves the list as it was. Resolves to the new item's id.
 */
export async function reopenJob(job: Job): Promise<number> {
  if (job.source === 'description') return reopenDescription(job, await collect(job));
  const [result, photo] = await Promise.all([collect(job), api.jobPhoto(job.id)]);
  return reopenPhoto(job, result, photo);
}

async function reopenPhoto(job: PhotoJob, result: JobResult, blob: Blob): Promise<number> {
  const file = new File([blob], 'photo.jpg', { type: 'image/jpeg' });
  const photo = await decodeImage(file);
  const outline = (['standard', 'best'] as const).find((quality) => result.images[`trace-${quality}`]) ?? 'classic';
  const tuning: Tuning = { ...DEFAULT_TUNING, outline };
  const generated = await generate(photo, tuning, result.images);
  const item: PhotoItem = {
    id: nextId++, source: 'photo', file, title: `Photo ${jobDate(job.createdAt)}`, titleSource: 'file', suggestions: [], jobIds: [job.id], tuning,
    phase: { kind: 'working', label: 'Opening…', progress: 1 },
  };
  dispatch({ type: 'queued', items: [item] });
  dispatch({ type: 'loaded', id: item.id, photo, generated, redraws: result.images });
  if (result.titles) dispatch({ type: 'suggested', id: item.id, titles: result.titles });
  return item.id;
}

function reopenDescription(job: DescriptionJob, result: JobResult): number {
  const item: DescriptionItem = {
    id: nextId++, source: 'description', description: job.description, quality: job.quality, title: titleFromDescription(job.description),
    titleSource: 'description', suggestions: [], jobIds: [job.id], phase: { kind: 'waiting', label: 'Opening…' },
  };
  dispatch({ type: 'queued', items: [item] });
  showScenes(item.id, result);
  return item.id;
}

/** Makes the paint by number for the scene the admin picked, at once. */
export function pickScene(id: number, index: SceneIndex) {
  clearTimeout(retuneTimers.get(id));
  dispatch({ type: 'pick', id, index });
  makePbn(id);
}

/** Applies a colour or detail change and remakes the paint by number once the admin pauses. */
export function retunePbn(id: number, tuning: PbnTuning) {
  dispatch({ type: 'pbnTune', id, tuning });
  clearTimeout(retuneTimers.get(id));
  retuneTimers.set(id, setTimeout(() => makePbn(id), DEBOUNCE_MS));
}

function makePbn(id: number) {
  const item = items.find((i) => i.id === id);
  if (item?.source !== 'description' || item.phase.kind !== 'choosing' || !item.phase.regenerating) return;
  const { chosen, scenes, tuning, rev } = item.phase;
  const scene = chosen === null ? null : scenes[chosen];
  if (scene?.kind !== 'ready') return;
  pbnInWorker(scene.raster, tuning.colors, tuning.detail).then(
    (generated) => dispatch({ type: 'pbnMade', id, rev, generated }),
    (e) => dispatch({ type: 'pbnFailed', id, rev, message: describeFailure('Could not make the paint by number.', e) }),
  );
}
