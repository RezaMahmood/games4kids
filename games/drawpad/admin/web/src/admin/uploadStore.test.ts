import type { DescriptionJob, JobStep, PhotoJob, PhotoStepKey, SceneStepKey } from '../../../../data/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiFailure, type NewPhotoJob } from '../api';
import { waitLabel } from './jobs';
import type { Raster } from '../stencil/types';
import { DEFAULT_TUNING, type ChoosingPhase, type DescriptionItem, type PhotoItem, type ReadyPhase } from './uploadModel';
import { discard, dispatch, forgetJobs, makeOutline, pickScene, queueDescription, queuePhotos, reopenJob, retune, retunePbn, uploadItems } from './uploadStore';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff]);
const photo = { data: new Uint8ClampedArray(30 * 20 * 4).fill(120), width: 30, height: 20 };
const mocks = vi.hoisted(() => ({
  createJob: vi.fn(), redrawJob: vi.fn(), job: vi.fn(), jobImage: vi.fn(), jobPhoto: vi.fn(), deleteJob: vi.fn(), outline: vi.fn(), pbn: vi.fn(),
  /** The raster each downloaded PNG decodes to, so a test can tell the pictures apart. */
  decoded: new Map<Blob, Raster>(),
}));

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: { createJob: mocks.createJob, redrawJob: mocks.redrawJob, job: mocks.job, jobImage: mocks.jobImage, jobPhoto: mocks.jobPhoto, deleteJob: mocks.deleteJob },
}));
vi.mock('../stencil/browser', () => ({
  decodeImage: async () => photo,
  encodeBytes: async () => JPEG,
  decodePng: async (png: Blob) => mocks.decoded.get(png) ?? { data: new Uint8ClampedArray(64 * 64 * 4).fill(255), width: 64, height: 64 },
  outlineInWorker: mocks.outline,
  pbnInWorker: mocks.pbn,
}));

const stepKeys = (j: NewPhotoJob): PhotoStepKey[] => [...j.wants.map((quality) => `trace-${quality}` as const), ...(j.titles ? ['titles' as const] : [])];
const job = (status: PhotoJob['status'], ahead: number, steps: JobStep<PhotoStepKey>[], titles?: string[]): PhotoJob =>
  ({ id: `job${mocks.createJob.mock.calls.length}`, source: 'photo', status, ahead, steps, titles, width: 30, height: 20, createdAt: '2026-10-17T00:00:00Z' });
const pending = (j: NewPhotoJob) => stepKeys(j).map((key): JobStep<PhotoStepKey> => ({ key, state: 'pending' }));
const finished = (j: NewPhotoJob, failed: Partial<Record<PhotoStepKey, JobStep['error']>> = {}) =>
  stepKeys(j).map((key): JobStep<PhotoStepKey> => (failed[key] ? { key, state: 'failed', error: failed[key] } : { key, state: 'done' }));
const lastJob = () => mocks.createJob.mock.lastCall![0] as NewPhotoJob;

// Lets every promise chain started by a timer run to its next timer.
async function wait(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 50; i++) await Promise.resolve();
}
async function waitLong(ms: number) {
  for (let t = 0; t < ms; t += 1000) await wait(1000);
}

const only = () => uploadItems()[0] as PhotoItem;
const label = () => (only().phase as { label?: string }).label;
const readyPhase = () => only().phase as ReadyPhase;

beforeEach(() => {
  vi.useFakeTimers();
  mocks.createJob.mockReset().mockImplementation(async (j: NewPhotoJob) => job('queued', 0, pending(j)));
  mocks.job.mockReset().mockImplementation(async () => job('done', 0, finished(lastJob()), ['Grey Elephant']));
  mocks.jobImage.mockReset().mockResolvedValue(new Blob());
  mocks.jobPhoto.mockReset().mockResolvedValue(new Blob(['jpeg']));
  mocks.outline.mockReset().mockResolvedValue(photo);
  mocks.deleteJob.mockReset().mockResolvedValue(undefined);
  mocks.redrawJob.mockReset().mockImplementation(async (id: string, quality: 'standard' | 'best') =>
    ({ ...job('queued', 0, [...finished(lastJob()), { key: `trace-${quality}`, state: 'pending' }]), id }));
  mocks.pbn.mockReset();
  mocks.decoded.clear();
});

afterEach(() => {
  for (const item of uploadItems()) dispatch({ type: 'discard', id: item.id });
  vi.clearAllTimers();
  vi.useRealTimers();
});

async function readyItem() {
  queuePhotos([new File(['x'], 'IMG_1.jpg', { type: 'image/jpeg' })]);
  await wait();
  await wait(3000);
  expect(only().phase.kind).toBe('ready');
}

describe('uploading photos through the AI queue', () => {
  it('queues one job per photo, for the AI outline the default tuning needs plus title ideas', async () => {
    queuePhotos([new File(['x'], 'a.jpg', { type: 'image/jpeg' }), new File(['y'], 'b.jpg', { type: 'image/jpeg' })]);
    await wait();
    expect(mocks.createJob).toHaveBeenCalledTimes(2);
    expect(mocks.createJob).toHaveBeenCalledWith({
      source: 'photo', photo: JPEG, width: 30, height: 20, titles: true,
      wants: ['standard'],
    });
  });

  it('says where the photo is in the queue, then that the AI is at work, then shows it ready with title ideas', async () => {
    mocks.createJob.mockImplementation(async (j: NewPhotoJob) => job('queued', 2, pending(j)));
    mocks.job
      .mockImplementationOnce(async () => job('queued', 0, pending(lastJob())))
      .mockImplementationOnce(async () => job('processing', 0, pending(lastJob())));
    queuePhotos([new File(['x'], 'IMG_1.jpg', { type: 'image/jpeg' })]);
    await wait();
    expect(label()).toBe('Waiting for its turn, 2 ahead');
    await wait(3000);
    expect(label()).toBe('Waiting for its turn, next up');
    await wait(3000);
    expect(label()).toBe('Redrawing with AI, about a minute');
    expect(mocks.jobImage).not.toHaveBeenCalled();
    await wait(3000);
    expect(mocks.jobImage.mock.calls).toEqual([['job1', 'trace-standard']]);
    expect(only()).toMatchObject({ title: 'Grey Elephant', suggestions: ['Grey Elephant'], tuning: DEFAULT_TUNING, phase: { kind: 'ready', error: null } });
    expect(Object.keys(readyPhase().redraws)).toEqual(['trace-standard']);
  });

  it('falls back to the classic outline when the AI step failed, and says why', async () => {
    mocks.job.mockImplementation(async () => job('done', 0, finished(lastJob(), { 'trace-standard': 'redraw_refused' }), ['Elephant']));
    await readyItem();
    expect(only().tuning).toMatchObject({ outline: 'classic' });
    expect(readyPhase().error).toBe('The AI outline did not work, so this shows the Classic outline. (redraw_refused). The AI service declined this photo. Use the free option instead.');
    expect(mocks.jobImage).not.toHaveBeenCalled();
    expect(mocks.outline).toHaveBeenCalledWith(photo, DEFAULT_TUNING.detail);
  });

  it('polls more slowly after a minute and gives up after ten, using the free outputs', async () => {
    mocks.job.mockImplementation(async () => job('processing', 0, pending(lastJob())));
    queuePhotos([new File(['x'], 'IMG_1.jpg', { type: 'image/jpeg' })]);
    await wait();
    await waitLong(61_000);
    expect(mocks.job).toHaveBeenCalledTimes(20);
    await waitLong(10_000);
    expect(mocks.job).toHaveBeenCalledTimes(22);
    await waitLong(9 * 60_000);
    expect(only().tuning).toMatchObject({ outline: 'classic' });
    expect(readyPhase().error).toContain('The AI took longer than 10 minutes.');
    const polls = mocks.job.mock.calls.length;
    await waitLong(30_000);
    expect(mocks.job).toHaveBeenCalledTimes(polls);
  });

  it('stops polling and fetching once the photo is removed', async () => {
    mocks.job.mockImplementation(async () => job('queued', 3, pending(lastJob())));
    queuePhotos([new File(['x'], 'IMG_1.jpg', { type: 'image/jpeg' })]);
    await wait();
    await wait(3000);
    dispatch({ type: 'discard', id: only().id });
    mocks.job.mockImplementation(async () => job('done', 0, finished(lastJob())));
    await waitLong(30_000);
    expect(mocks.job).toHaveBeenCalledTimes(1);
    expect(mocks.jobImage).not.toHaveBeenCalled();
    expect(uploadItems()).toEqual([]);
  });

  it('says plainly when the AI queue is full', async () => {
    mocks.createJob.mockRejectedValue(new ApiFailure(429, 'too_many_jobs', ''));
    queuePhotos([new File(['x'], 'IMG_1.jpg', { type: 'image/jpeg' })]);
    await wait();
    expect(only().phase).toEqual({
      kind: 'failed',
      message: 'Could not send this photo to the AI. (429 too_many_jobs). Too many photos are waiting for the AI. Wait for some to finish, then add this one again.',
    });
  });

  it('shows the classic outline at once when no AI redraw is wanted, and takes the title ideas when they come', async () => {
    const free: PhotoItem = {
      id: 99, source: 'photo', file: new File(['x'], 'IMG_1.jpg'), title: 'IMG 1', titleSource: 'file', suggestions: [], jobIds: [],
      tuning: { ...DEFAULT_TUNING, outline: 'classic' }, phase: { kind: 'waiting' },
    };
    dispatch({ type: 'queued', items: [free] });
    await wait();
    expect(only().phase.kind).toBe('ready');
    expect(only().suggestions).toEqual([]);
    expect(mocks.createJob).toHaveBeenCalledWith(expect.objectContaining({ wants: [], titles: true }));
    await wait(3000);
    expect(only()).toMatchObject({ title: 'Grey Elephant', suggestions: ['Grey Elephant'] });
  });
});

describe('changing an uploaded picture in Review', () => {
  const withBest = (state: 'done' | 'pending' = 'done') => async () => job('done', 0, [...finished(lastJob()), { key: 'trace-best', state }]);

  it('never calls the AI when an outline is chosen, only when the admin asks for one it has never had', async () => {
    await readyItem();
    retune(only().id, { ...only().tuning, outline: 'best' });
    await wait(400);
    expect(mocks.createJob).toHaveBeenCalledTimes(1);
    expect(mocks.redrawJob).not.toHaveBeenCalled();
    expect(readyPhase()).toMatchObject({ regenerating: false });
    expect(readyPhase().redraws['trace-best']).toBeUndefined();

    mocks.job.mockImplementationOnce(async () => job('processing', 0, pending(lastJob()))).mockImplementation(withBest());
    makeOutline(only().id);
    await wait();
    expect(mocks.redrawJob.mock.calls).toEqual([['job1', 'best']]);
    expect(readyPhase().redraws['trace-best']).toEqual({ kind: 'waiting', label: 'Waiting for its turn, next up' });
    await wait(3000);
    expect(readyPhase().redraws['trace-best']).toEqual({ kind: 'waiting', label: 'Redrawing with AI, about a minute' });
    await wait(3000);
    expect(readyPhase()).toMatchObject({ regenerating: false, generated: { tuning: { outline: 'best' } } });

    for (const outline of ['standard', 'best', 'standard'] as const) {
      retune(only().id, { ...only().tuning, outline });
      await wait(400);
      expect(readyPhase()).toMatchObject({ regenerating: false, generated: { tuning: { outline } } });
    }
    expect(mocks.createJob).toHaveBeenCalledTimes(1);
    expect(mocks.redrawJob).toHaveBeenCalledTimes(1);
  });

  it('makes an outline it has again only when asked, from the same job, showing the old one meanwhile', async () => {
    await readyItem();
    makeOutline(only().id);
    makeOutline(only().id);
    await wait();
    expect(mocks.redrawJob.mock.calls).toEqual([['job1', 'standard']]);
    expect(readyPhase().redraws['trace-standard']).toMatchObject({ kind: 'waiting', raster: expect.anything() });
    await wait(3000);
    expect(readyPhase().redraws['trace-standard']).toMatchObject({ kind: 'ready' });
    expect(mocks.createJob).toHaveBeenCalledTimes(1);
  });

  it('retraces the photo in the browser when the classic outline detail changes, with no new job', async () => {
    await readyItem();
    retune(only().id, { ...only().tuning, outline: 'classic' });
    await wait(400);
    retune(only().id, { ...only().tuning, detail: 1 });
    await wait(400);
    expect(mocks.createJob).toHaveBeenCalledTimes(1);
    expect(mocks.redrawJob).not.toHaveBeenCalled();
    expect(mocks.outline).toHaveBeenLastCalledWith(photo, 1);
    expect(readyPhase()).toMatchObject({ regenerating: false, generated: { tuning: { outline: 'classic', detail: 1 } } });
  });

  it('keeps the chosen outline and says why when making it fails, so the admin can try again', async () => {
    await readyItem();
    retune(only().id, { ...only().tuning, outline: 'best' });
    await wait(400);
    mocks.job.mockImplementation(async () => job('done', 0, [...finished(lastJob()), { key: 'trace-best', state: 'failed', error: 'redraw_refused' }]));
    makeOutline(only().id);
    await wait(3000);
    expect(only().tuning.outline).toBe('best');
    expect(readyPhase().redraws['trace-best']).toEqual({
      kind: 'failed', message: 'The AI outline did not work. (redraw_refused). The AI service declined this photo. Use the free option instead.',
    });
  });

  it('says to wait when the photo job is still at work', async () => {
    await readyItem();
    retune(only().id, { ...only().tuning, outline: 'best' });
    await wait(400);
    mocks.redrawJob.mockRejectedValue(new ApiFailure(409, 'job_busy', ''));
    makeOutline(only().id);
    await wait();
    expect(readyPhase().redraws['trace-best']).toEqual({
      kind: 'failed', message: 'The AI outline did not work. (409 job_busy). The AI is still working on this photo. Try again in a minute.',
    });
    expect(mocks.createJob).toHaveBeenCalledTimes(1);
  });

  it('sends the photo in a new job when the server no longer has the old one, and asks that one next time', async () => {
    await readyItem();
    retune(only().id, { ...only().tuning, outline: 'best' });
    await wait(400);
    mocks.redrawJob.mockRejectedValueOnce(new ApiFailure(404, 'not_found', ''));
    mocks.job.mockImplementation(async () => job('done', 0, finished(lastJob())));
    makeOutline(only().id);
    await wait(3000);
    expect(mocks.createJob).toHaveBeenCalledTimes(2);
    expect(lastJob()).toMatchObject({ wants: ['best'], titles: false });
    expect(only().jobIds).toEqual(['job1', 'job2']);
    expect(readyPhase().redraws['trace-best']).toMatchObject({ kind: 'ready' });
    makeOutline(only().id);
    await wait();
    expect(mocks.redrawJob).toHaveBeenLastCalledWith('job2', 'best');
  });

  it('deletes the photo job and everything made from it when the admin discards the photo', async () => {
    await readyItem();
    discard(only().id);
    expect(uploadItems()).toEqual([]);
    expect(mocks.deleteJob.mock.calls).toEqual([['job1']]);
  });
});

describe('making paint by number from a description', () => {
  const SCENES = ['scene-1', 'scene-2', 'scene-3'] as const;
  const scene = (width: number): Raster => ({ data: new Uint8ClampedArray(width * width * 4), width, height: width });
  const drawings = { 'scene-1': scene(11), 'scene-2': scene(12), 'scene-3': scene(13) };
  const sceneJob = (status: DescriptionJob['status'], steps: Partial<Record<SceneStepKey, JobStep['error'] | 'pending'>> = {}, titles?: string[]): DescriptionJob => ({
    id: 'job7', source: 'description', description: 'a fox asleep', quality: 'best', status, ahead: 0, createdAt: '2026-10-18T00:00:00Z', titles,
    steps: (['prompts', ...SCENES] as const).map((key): JobStep<SceneStepKey> => {
      const state = steps[key];
      if (state === 'pending' || (status !== 'done' && state === undefined)) return { key, state: 'pending' };
      return state ? { key, state: 'failed', error: state } : { key, state: 'done' };
    }),
  });
  const described = () => uploadItems()[0] as DescriptionItem;
  const choosing = () => described().phase as ChoosingPhase;

  beforeEach(() => {
    mocks.createJob.mockImplementation(async () => sceneJob('queued'));
    mocks.job.mockImplementation(async () => sceneJob('done', {}, ['Sleepy Fox', 'Autumn Nap']));
    mocks.jobImage.mockImplementation(async (_id: string, key: (typeof SCENES)[number]) => {
      const png = new Blob([key]);
      mocks.decoded.set(png, drawings[key]);
      return png;
    });
  });

  async function pictures() {
    queueDescription('a fox asleep', 'best');
    await wait();
    await wait(3000);
    expect(described().phase.kind).toBe('choosing');
  }

  it('sends the description, says where it is in the queue, then offers the three pictures with title ideas', async () => {
    mocks.job.mockImplementationOnce(async () => sceneJob('processing', { 'scene-2': 'pending', 'scene-3': 'pending' }));
    queueDescription('a fox asleep', 'best');
    await wait();
    expect(mocks.createJob).toHaveBeenCalledWith({ source: 'description', description: 'a fox asleep', quality: 'best' });
    expect(described().phase).toEqual({ kind: 'waiting', label: 'Waiting for its turn, next up' });
    await wait(3000);
    expect(described().phase).toEqual({ kind: 'waiting', label: 'Drawing 3 pictures with AI, about 2 minutes' });
    expect(mocks.jobImage).not.toHaveBeenCalled();
    await wait(3000);
    expect(mocks.jobImage.mock.calls).toEqual(SCENES.map((key) => ['job7', key]));
    expect(described()).toMatchObject({ title: 'Sleepy Fox', suggestions: ['Sleepy Fox', 'Autumn Nap'] });
    expect(choosing()).toMatchObject({
      chosen: null, generated: null,
      scenes: SCENES.map((key) => ({ kind: 'ready', raster: drawings[key] })),
    });
  });

  it('offers the pictures that were drawn and says why the others are missing', async () => {
    mocks.job.mockImplementation(async () => sceneJob('done', { 'scene-2': 'redraw_refused' }));
    await pictures();
    expect(choosing().scenes[1]).toEqual({ kind: 'failed', error: 'redraw_refused' });
    expect(mocks.jobImage.mock.calls).toEqual([['job7', 'scene-1'], ['job7', 'scene-3']]);
  });

  it("says the AI's safety check refused the description, and deletes the job", async () => {
    mocks.job.mockImplementation(async () => sceneJob('done', { prompts: 'scene_refused', 'scene-1': 'redraw_failed', 'scene-2': 'redraw_failed', 'scene-3': 'redraw_failed' }));
    queueDescription('something unsuitable', 'standard');
    await wait();
    await wait(3000);
    expect(described().phase).toEqual({ kind: 'failed', message: "The AI's safety check refused this description. Try describing the picture another way." });
    expect(mocks.deleteJob).toHaveBeenCalledWith('job7');
  });

  it('makes the paint by number from the picked picture at once, and again once the sliders settle', async () => {
    await pictures();
    const first = { pbn: { width: 13, height: 13, palette: ['#FFFFFF'], regions: [] }, regions: scene(13), preview: scene(13) };
    const second = { ...first, pbn: { ...first.pbn, palette: ['#FFFFFF', '#000000'] } };
    mocks.pbn.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    pickScene(described().id, 2);
    expect(mocks.pbn).toHaveBeenCalledWith(drawings['scene-3'], 8, 0.5);
    await wait();
    expect(choosing()).toMatchObject({ chosen: 2, generated: first, regenerating: false });

    retunePbn(described().id, { colors: 10, detail: 0.5 });
    retunePbn(described().id, { colors: 12, detail: 0.75 });
    await wait(399);
    expect(mocks.pbn).toHaveBeenCalledTimes(1);
    await wait(1);
    expect(mocks.pbn).toHaveBeenCalledTimes(2);
    expect(mocks.pbn).toHaveBeenLastCalledWith(drawings['scene-3'], 12, 0.75);
    expect(choosing()).toMatchObject({ generated: second, regenerating: false, tuning: { colors: 12, detail: 0.75 } });
  });

  it('deletes the finished job when the admin discards the pictures', async () => {
    await pictures();
    discard(described().id);
    expect(uploadItems()).toEqual([]);
    expect(mocks.deleteJob).toHaveBeenCalledWith('job7');
  });

  it('stops polling and deletes the job when the description is removed while it waits', async () => {
    mocks.job.mockImplementation(async () => sceneJob('queued'));
    queueDescription('a fox asleep', 'standard');
    await wait();
    discard(described().id);
    await waitLong(30_000);
    expect(mocks.job).not.toHaveBeenCalled();
    expect(mocks.jobImage).not.toHaveBeenCalled();
    expect(mocks.deleteJob).toHaveBeenCalledWith('job7');
  });
});

describe('keeping track of an item\'s jobs', () => {
  it('keeps one job per photo, so saving it deletes everything the AI made for it', async () => {
    await readyItem();
    retune(only().id, { ...only().tuning, outline: 'best' });
    await wait(400);
    mocks.job.mockImplementation(async () => job('done', 0, [...finished(lastJob()), { key: 'trace-best', state: 'done' }]));
    makeOutline(only().id);
    await wait(3000);
    expect(only().jobIds).toEqual(['job1']);
    forgetJobs(only().jobIds);
    expect(mocks.deleteJob.mock.calls).toEqual([['job1']]);
  });

  it('knows a description\'s job as soon as the server has queued it', async () => {
    mocks.createJob.mockImplementation(async () => ({ ...job('queued', 0, []), id: 'job7', source: 'description', description: 'a fox', quality: 'standard' }));
    queueDescription('a fox', 'standard');
    await wait();
    expect((uploadItems()[0] as DescriptionItem).jobIds).toEqual(['job7']);
  });
});

describe('reopening a finished job from the server', () => {
  const drawn = (id: string, steps: JobStep<PhotoStepKey>[], titles?: string[]): PhotoJob =>
    ({ id, source: 'photo', status: 'done', ahead: 0, createdAt: '2026-10-17T12:00:00Z', width: 30, height: 20, steps, titles });
  const done = (...keys: PhotoStepKey[]) => keys.map((key): JobStep<PhotoStepKey> => ({ key, state: 'done' }));

  it('opens a photo in Review from its saved photo and AI outline, with no new job', async () => {
    const id = await reopenJob(drawn('old1', done('trace-best', 'titles'), ['Grey Elephant', 'Zoo Giant']));
    expect(mocks.createJob).not.toHaveBeenCalled();
    expect(mocks.jobPhoto.mock.calls).toEqual([['old1']]);
    expect(mocks.jobImage.mock.calls).toEqual([['old1', 'trace-best']]);
    expect(uploadItems()).toHaveLength(1);
    expect(only()).toMatchObject({
      id, source: 'photo', title: 'Grey Elephant', suggestions: ['Grey Elephant', 'Zoo Giant'], jobIds: ['old1'],
      tuning: { outline: 'best' }, phase: { kind: 'ready', saving: false, error: null },
    });
    expect(Object.keys(readyPhase().redraws)).toEqual(['trace-best']);
    expect(readyPhase().generated.tuning.outline).toBe('best');
  });

  it('prefers the standard AI outline when both came back', async () => {
    await reopenJob(drawn('old1', done('trace-standard', 'trace-best')));
    expect(only().tuning.outline).toBe('standard');
    expect(Object.keys(readyPhase().redraws).sort()).toEqual(['trace-best', 'trace-standard']);
  });

  it('traces the photo the classic way when the job has no AI outline, and names it by its date', async () => {
    await reopenJob(drawn('old1', [{ key: 'trace-standard', state: 'failed', error: 'redraw_refused' }, ...done('titles')]));
    expect(mocks.jobImage).not.toHaveBeenCalled();
    expect(mocks.outline).toHaveBeenCalledWith(photo, DEFAULT_TUNING.detail);
    expect(only()).toMatchObject({ title: 'Photo 17 Oct', tuning: { outline: 'classic' }, phase: { kind: 'ready' } });
  });

  it('leaves the upload list as it was when the photo cannot be fetched', async () => {
    mocks.jobPhoto.mockRejectedValue(new ApiFailure(404, 'not_found', ''));
    await expect(reopenJob(drawn('old1', done('trace-standard')))).rejects.toBeInstanceOf(ApiFailure);
    expect(uploadItems()).toEqual([]);
  });

  it('opens a description with the pictures it drew, to pick from, with no new job and the job kept', async () => {
    const drew: DescriptionJob = {
      id: 'old2', source: 'description', description: 'a fox asleep', quality: 'best', status: 'done', ahead: 0, createdAt: '2026-10-17T12:00:00Z',
      titles: ['Sleepy Fox'],
      steps: [{ key: 'prompts', state: 'done' }, { key: 'scene-1', state: 'done' }, { key: 'scene-2', state: 'failed', error: 'redraw_refused' }, { key: 'scene-3', state: 'done' }],
    };
    const first = { data: new Uint8ClampedArray(11 * 11 * 4), width: 11, height: 11 };
    mocks.jobImage.mockImplementation(async (_id: string, key: string) => {
      const png = new Blob([key]);
      if (key === 'scene-1') mocks.decoded.set(png, first);
      return png;
    });
    const id = await reopenJob(drew);
    expect(mocks.createJob).not.toHaveBeenCalled();
    expect(mocks.deleteJob).not.toHaveBeenCalled();
    expect(mocks.jobImage.mock.calls).toEqual([['old2', 'scene-1'], ['old2', 'scene-3']]);
    expect(uploadItems()[0]).toMatchObject({
      id, source: 'description', description: 'a fox asleep', title: 'Sleepy Fox', jobIds: ['old2'],
      phase: { kind: 'choosing', chosen: null, generated: null, scenes: [{ kind: 'ready', raster: first }, { kind: 'failed', error: 'redraw_refused' }, { kind: 'ready' }] },
    });
  });
});

describe('waitLabel', () => {
  it.each([
    [0, 'Waiting for its turn, next up'],
    [1, 'Waiting for its turn, 1 ahead'],
    [4, 'Waiting for its turn, 4 ahead'],
  ])('%i ahead reads "%s"', (ahead, text) => expect(waitLabel(job('queued', ahead, []))).toBe(text));

  it('says the AI is at work once the job is processing', () => {
    expect(waitLabel(job('processing', 0, []))).toBe('Redrawing with AI, about a minute');
  });

  it('counts what is ahead of a description, then says the three pictures are being drawn', () => {
    const described = (status: DescriptionJob['status'], ahead: number): DescriptionJob =>
      ({ id: 'j', source: 'description', description: 'a fox', quality: 'standard', status, ahead, steps: [], createdAt: '2026-10-18T00:00:00Z' });
    expect(waitLabel(described('queued', 0))).toBe('Waiting for its turn, next up');
    expect(waitLabel(described('queued', 3))).toBe('Waiting for its turn, 3 ahead');
    expect(waitLabel(described('processing', 0))).toBe('Drawing 3 pictures with AI, about 2 minutes');
  });
});
