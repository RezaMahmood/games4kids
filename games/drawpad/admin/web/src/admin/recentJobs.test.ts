import type { DescriptionJob, Job, JobStep, PhotoJob, PhotoStepKey, SceneStepKey } from '../../../../data/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiFailure } from '../api';
import { createRecentJobs, describeJob, jobOutcome, notLive, recentReducer, shouldPoll, type RecentState } from './recentJobs';

const NOW = new Date('2026-10-18T12:00:00Z');
const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();

const photo = (id: string, status: Job['status'], steps: JobStep<PhotoStepKey>[], extra: Partial<PhotoJob> = {}): PhotoJob =>
  ({ id, source: 'photo', status, ahead: 0, createdAt: at(5), width: 30, height: 20, steps, ...extra });
const fox = (id: string, status: Job['status'], steps: JobStep<SceneStepKey>[], extra: Partial<DescriptionJob> = {}): DescriptionJob =>
  ({ id, source: 'description', description: 'a fox asleep under an autumn tree', quality: 'standard', status, ahead: 0, createdAt: at(5), steps, ...extra });
const done = <K extends string>(key: K) => ({ key, state: 'done' as const });
const failed = <K extends string>(key: K, error: JobStep['error']) => ({ key, state: 'failed' as const, error });
const pending = <K extends string>(key: K) => ({ key, state: 'pending' as const });

describe('the Recent uploads list state', () => {
  const a = photo('a', 'done', [done('trace-standard')]);
  const b = fox('b', 'done', [done('prompts'), done('scene-1')]);

  it('starts loading, shows the jobs once loaded, and keeps showing them quietly while it refreshes', () => {
    let state: RecentState = { kind: 'loading' };
    state = recentReducer(state, { type: 'loaded', jobs: [a, b] });
    expect(state).toEqual({ kind: 'ready', jobs: [a, b] });
    expect(recentReducer(state, { type: 'refresh' })).toBe(state);
  });

  it('turns a failed load into an error that keeps the rows it had, and retrying shows Loading again', () => {
    const state = recentReducer({ kind: 'ready', jobs: [a] }, { type: 'failed', message: 'Could not load recent uploads.' });
    expect(state).toEqual({ kind: 'error', message: 'Could not load recent uploads.', jobs: [a] });
    expect(recentReducer(state, { type: 'refresh' })).toEqual({ kind: 'loading' });
    expect(recentReducer({ kind: 'loading' }, { type: 'failed', message: 'x' })).toEqual({ kind: 'error', message: 'x', jobs: [] });
  });

  it('drops a forgotten job from the rows', () => {
    expect(recentReducer({ kind: 'ready', jobs: [a, b] }, { type: 'forget', id: 'a' })).toEqual({ kind: 'ready', jobs: [b] });
  });

  it('polls only while a job is queued or processing', () => {
    expect(shouldPoll({ kind: 'ready', jobs: [a, fox('q', 'queued', [pending('prompts')])] })).toBe(true);
    expect(shouldPoll({ kind: 'ready', jobs: [photo('p', 'processing', [pending('titles')])] })).toBe(true);
    expect(shouldPoll({ kind: 'ready', jobs: [a, b] })).toBe(false);
    expect(shouldPoll({ kind: 'loading' })).toBe(false);
    expect(shouldPoll({ kind: 'error', message: 'x', jobs: [fox('q', 'queued', [])] })).toBe(false);
  });

  it('leaves out jobs that are already items in the upload list', () => {
    expect(notLive([a, b], new Set(['a'])).map((job) => job.id)).toEqual(['b']);
    expect(notLive([a, b], new Set())).toEqual([a, b]);
  });
});

describe('what a row says', () => {
  it('names a photo by its first title idea, or by its date, and a description by its text', () => {
    expect(describeJob(photo('a', 'done', [done('trace-standard'), done('titles')], { titles: ['Grey Elephant', 'Zoo Giant'] }), NOW)).toMatchObject({ kind: 'Photo', text: 'Grey Elephant' });
    expect(describeJob(photo('a', 'done', [done('trace-standard')], { createdAt: '2026-10-17T12:00:00Z' }), NOW)).toMatchObject({ kind: 'Photo', text: '17 Oct' });
    expect(describeJob(fox('b', 'done', [done('scene-1')]), NOW)).toMatchObject({ kind: 'Description', text: 'a fox asleep under an autumn tree' });
    const long = describeJob(fox('b', 'done', [done('scene-1')], { description: 'x'.repeat(100) }), NOW);
    expect(long.text).toBe(`${'x'.repeat(59)}…`);
  });

  it('words a queued or running job like the same item in the Processing list', () => {
    expect(describeJob(photo('a', 'queued', [pending('trace-standard')], { ahead: 2 }), NOW)).toMatchObject({ status: 'Waiting for its turn, 2 ahead', tone: 'working', reviewable: false });
    expect(describeJob(photo('a', 'processing', [pending('trace-standard')]), NOW).status).toBe('Redrawing with AI, about a minute');
    expect(describeJob(fox('b', 'queued', [pending('prompts')], { ahead: 0 }), NOW).status).toBe('Waiting for its turn, next up');
    expect(describeJob(fox('b', 'processing', [done('prompts'), pending('scene-1')]), NOW).status).toBe('Drawing 3 pictures with AI, about 2 minutes');
  });

  it('offers Review for a finished job with something to show, worded like a live item', () => {
    expect(describeJob(photo('a', 'done', [done('trace-standard')]), NOW)).toMatchObject({ status: 'Ready to review', tone: 'ok', reviewable: true });
    expect(describeJob(fox('b', 'done', [done('prompts'), failed('scene-1', 'redraw_failed'), done('scene-2')]), NOW)).toMatchObject({ status: 'Ready to pick a picture', reviewable: true });
  });

  it('says a finished job failed, and why, when nothing came back', () => {
    const refused = describeJob(photo('a', 'done', [failed('trace-standard', 'redraw_refused')]), NOW);
    expect(refused).toMatchObject({ tone: 'bad', reviewable: false });
    expect(refused.status).toContain('The AI service declined this photo.');
    const unsuitable = describeJob(fox('b', 'done', [failed('prompts', 'scene_refused'), failed('scene-1', 'redraw_failed')]), NOW);
    expect(unsuitable).toMatchObject({ tone: 'bad', reviewable: false, status: "The AI's safety check refused this description. Try describing the picture another way." });
    expect(describeJob(fox('b', 'done', [done('prompts'), failed('scene-1', 'redraw_refused'), failed('scene-2', 'redraw_failed')]), NOW).status)
      .toBe("None of the 3 pictures could be drawn. The AI's safety check refused this picture.");
    expect(jobOutcome(fox('b', 'done', [done('prompts'), failed('scene-1', 'redraw_failed')]))).toBe('failed');
  });

  it.each([
    [0, 'just now'],
    [1, '1 min ago'],
    [59, '59 min ago'],
    [60, '1 h ago'],
    [23 * 60 + 59, '23 h ago'],
    [24 * 60, '1 day ago'],
    [3 * 24 * 60, '3 days ago'],
    [-5, 'just now'],
  ])('says a job made %i minutes ago was made "%s"', (minutes, text) => {
    expect(describeJob(photo('a', 'done', [done('titles')], { createdAt: at(minutes) }), NOW).age).toBe(text);
  });
});

describe('the Recent uploads list against the server', () => {
  const POLL = 5000;
  const list = vi.fn();
  const remove = vi.fn();
  const running = fox('r', 'processing', [done('prompts'), pending('scene-1')]);
  const finished = fox('r', 'done', [done('prompts'), done('scene-1')]);
  let recent: ReturnType<typeof createRecentJobs>;
  let stop: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    list.mockReset().mockResolvedValue([]);
    remove.mockReset().mockResolvedValue(undefined);
    recent = createRecentJobs({ list, remove });
    stop = recent.subscribe(() => {});
  });
  afterEach(() => {
    stop();
    vi.useRealTimers();
  });

  it('shows Loading, then the rows', async () => {
    list.mockResolvedValue([finished]);
    const loading = recent.refresh();
    expect(recent.get()).toEqual({ kind: 'loading' });
    await loading;
    expect(recent.get()).toEqual({ kind: 'ready', jobs: [finished] });
  });

  it('polls every 5 seconds while a job runs, and stops once none is queued or processing', async () => {
    list.mockResolvedValueOnce([running]).mockResolvedValue([finished]);
    await recent.refresh();
    expect(list).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(POLL - 1);
    expect(list).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(list).toHaveBeenCalledTimes(2);
    expect(recent.get()).toEqual({ kind: 'ready', jobs: [finished] });
    await vi.advanceTimersByTimeAsync(10 * POLL);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('does not poll when it starts with nothing running, and polls again once a refresh finds a running job', async () => {
    list.mockResolvedValueOnce([finished]).mockResolvedValue([running]);
    await recent.refresh();
    await vi.advanceTimersByTimeAsync(3 * POLL);
    expect(list).toHaveBeenCalledTimes(1);
    await recent.refresh();
    await vi.advanceTimersByTimeAsync(POLL);
    expect(list).toHaveBeenCalledTimes(3);
  });

  it('stops polling when nobody is looking', async () => {
    list.mockResolvedValue([running]);
    await recent.refresh();
    stop();
    await vi.advanceTimersByTimeAsync(3 * POLL);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('says why a load failed, stops polling, and loads again on retry', async () => {
    list.mockResolvedValueOnce([running]).mockRejectedValueOnce(new ApiFailure(500, 'server_error', ''));
    await recent.refresh();
    await vi.advanceTimersByTimeAsync(POLL);
    expect(recent.get()).toEqual({ kind: 'error', message: expect.stringContaining('500 server_error'), jobs: [running] });
    await vi.advanceTimersByTimeAsync(3 * POLL);
    expect(list).toHaveBeenCalledTimes(2);
    list.mockResolvedValue([finished]);
    await recent.refresh();
    expect(recent.get()).toEqual({ kind: 'ready', jobs: [finished] });
  });

  it('keeps the answer of the newest refresh when an older one arrives late', async () => {
    let answerOld!: (jobs: Job[]) => void;
    list.mockReturnValueOnce(new Promise((resolve) => { answerOld = resolve; })).mockResolvedValueOnce([finished]);
    const old = recent.refresh();
    await recent.refresh();
    answerOld([]);
    await old;
    expect(recent.get()).toEqual({ kind: 'ready', jobs: [finished] });
  });

  it('discards a job on the server and drops its row', async () => {
    list.mockResolvedValue([running, photo('p', 'done', [done('trace-standard')])]);
    await recent.refresh();
    await recent.discard('r');
    expect(remove).toHaveBeenCalledWith('r');
    expect(recent.get()).toMatchObject({ kind: 'ready', jobs: [{ id: 'p' }] });
  });

  it('keeps the row and reports it when the server cannot delete the job, but drops one the server no longer has', async () => {
    list.mockResolvedValue([running]);
    await recent.refresh();
    remove.mockRejectedValueOnce(new ApiFailure(500, 'server_error', ''));
    await expect(recent.discard('r')).rejects.toBeInstanceOf(ApiFailure);
    expect(recent.get()).toMatchObject({ kind: 'ready', jobs: [{ id: 'r' }] });
    remove.mockRejectedValueOnce(new ApiFailure(404, 'not_found', ''));
    await recent.discard('r');
    expect(recent.get()).toEqual({ kind: 'ready', jobs: [] });
  });
});
