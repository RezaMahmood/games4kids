import type { Job } from '../../../../data/types';
import { useEffect, useState } from 'preact/hooks';
import { api, ApiFailure } from '../api';
import { waitLabel } from './jobs';
import { describeFailure, describePromptsFailure, describeScenesFailed, READY_TO_PICK, READY_TO_REVIEW } from './messages';

const POLL_MS = 5000;
const DESCRIPTION_SHOWN = 60;

/** The server's jobs of the last 7 days, newest first. `error` keeps the last rows it had so a hiccup does not blank the list. */
export type RecentState =
  | { kind: 'loading' }
  | { kind: 'ready'; jobs: Job[] }
  | { kind: 'error'; message: string; jobs: Job[] };

export type RecentEvent =
  | { type: 'refresh' }
  | { type: 'loaded'; jobs: Job[] }
  | { type: 'failed'; message: string }
  | { type: 'forget'; id: string };

const jobsOf = (state: RecentState): Job[] => (state.kind === 'loading' ? [] : state.jobs);

export function recentReducer(state: RecentState, event: RecentEvent): RecentState {
  switch (event.type) {
    // A refresh of a list already showing stays quiet; only a first load or a retry shows "Loading".
    case 'refresh':
      return state.kind === 'ready' ? state : { kind: 'loading' };
    case 'loaded':
      return { kind: 'ready', jobs: event.jobs };
    case 'failed':
      return { kind: 'error', message: event.message, jobs: jobsOf(state) };
    case 'forget':
      return state.kind === 'loading' ? state : { ...state, jobs: state.jobs.filter((job) => job.id !== event.id) };
  }
}

/** The server still has AI work to do, so the list is worth polling. */
export const shouldPoll = (state: RecentState): boolean => state.kind === 'ready' && state.jobs.some((job) => job.status !== 'done');

/** The server's jobs that are not already an item in this browser's upload list. */
export const notLive = (jobs: Job[], liveJobIds: ReadonlySet<string>): Job[] => jobs.filter((job) => !liveJobIds.has(job.id));

export type JobOutcome = 'working' | 'ready' | 'failed';

/** A finished job is worth reopening when any step came back. The prompts step alone draws nothing to pick. */
export function jobOutcome(job: Job): JobOutcome {
  if (job.status !== 'done') return 'working';
  return job.steps.some((step) => step.state === 'done' && step.key !== 'prompts') ? 'ready' : 'failed';
}

export function ageOf(createdAt: string, now: Date): string {
  const minutes = Math.floor((now.getTime() - Date.parse(createdAt)) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

export const jobDate = (createdAt: string): string => new Date(createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

const shortened = (text: string): string => (text.length <= DESCRIPTION_SHOWN ? text : `${text.slice(0, DESCRIPTION_SHOWN - 1).trimEnd()}…`);

function failureOf(job: Job): string {
  const errors = job.steps.flatMap((step): string[] => (step.state === 'failed' ? [step.error ?? 'redraw_failed'] : []));
  if (job.source === 'photo') return describeFailure('The AI could not redraw this photo.', new ApiFailure(0, errors[0] ?? 'redraw_failed', ''));
  const prompts = job.steps.find((step) => step.key === 'prompts');
  if (prompts?.state === 'failed') return describePromptsFailure(new ApiFailure(0, prompts.error ?? 'scene_failed', ''));
  return describeScenesFailed(errors);
}

export type JobRow = {
  id: string;
  kind: 'Photo' | 'Description';
  text: string;
  status: string;
  tone: 'working' | 'ok' | 'bad';
  reviewable: boolean;
  age: string;
};

/** What one row of Recent uploads says, with a job's status worded as it is for the same item in the Processing list. */
export function describeJob(job: Job, now: Date): JobRow {
  const outcome = jobOutcome(job);
  const row = { id: job.id, age: ageOf(job.createdAt, now), reviewable: outcome === 'ready' };
  const kind = job.source === 'photo' ? 'Photo' : 'Description';
  const text = job.source === 'photo' ? job.titles?.[0] ?? jobDate(job.createdAt) : shortened(job.description);
  if (outcome === 'working') return { ...row, kind, text, status: waitLabel(job), tone: 'working' };
  if (outcome === 'failed') return { ...row, kind, text, status: failureOf(job), tone: 'bad' };
  return { ...row, kind, text, status: job.source === 'photo' ? READY_TO_REVIEW : READY_TO_PICK, tone: 'ok' };
}

type Source = { list: () => Promise<Job[]>; remove: (id: string) => Promise<void> };

/**
 * The Recent uploads list, kept at module level like the upload list so it is already there when the admin comes back.
 * It polls while the server has work queued or running and anyone is looking.
 */
export function createRecentJobs(source: Source) {
  let state: RecentState = { kind: 'loading' };
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();

  const apply = (event: RecentEvent) => {
    const next = recentReducer(state, event);
    if (next === state) return;
    state = next;
    listeners.forEach((l) => l());
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = listeners.size > 0 && shouldPoll(state) ? setTimeout(refresh, POLL_MS) : undefined;
  };

  async function refresh() {
    const mine = ++generation;
    clearTimeout(timer);
    apply({ type: 'refresh' });
    try {
      const jobs = await source.list();
      if (mine === generation) apply({ type: 'loaded', jobs });
    } catch (e) {
      if (mine === generation) apply({ type: 'failed', message: describeFailure('Could not load recent uploads.', e) });
    }
    if (mine === generation) schedule();
  }

  /** Deletes a job the admin does not want. A job the server no longer has is gone either way. */
  async function discard(id: string) {
    await source.remove(id).catch((e) => {
      if (!(e instanceof ApiFailure && e.status === 404)) throw e;
    });
    forget(id);
  }

  function forget(id: string) {
    apply({ type: 'forget', id });
    schedule();
  }

  return {
    get: () => state,
    refresh,
    discard,
    forget,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) clearTimeout(timer);
      };
    },
  };
}

export const recentJobs = createRecentJobs({ list: () => api.jobs(), remove: (id) => api.deleteJob(id) });

/** The list's state, refreshed once when the screen opens and again whenever `refreshKey` changes. */
export function useRecentJobs(refreshKey: string): RecentState {
  const [, setTick] = useState(0);
  useEffect(() => recentJobs.subscribe(() => setTick((n) => n + 1)), []);
  useEffect(() => void recentJobs.refresh(), [refreshKey]);
  return recentJobs.get();
}
