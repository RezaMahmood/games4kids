import { describe, expect, it } from 'vitest';
import { isValidId, starsFor } from './ids.ts';
import { jobIdOf, jobReadyEvent } from './job-event.ts';
import { clampHeartbeatSeconds, localDate, resolveLimitMinutes, usageToday } from './usage.ts';

describe('daily limit', () => {
  it('prefers the child override, then the settings default, then 60 minutes', () => {
    expect(resolveLimitMinutes(30, 90)).toBe(30);
    expect(resolveLimitMinutes(0, 90)).toBe(0);
    expect(resolveLimitMinutes(undefined, 90)).toBe(90);
    expect(resolveLimitMinutes(undefined, undefined)).toBe(60);
  });

  it('reports remaining seconds and never goes negative', () => {
    expect(usageToday(600, 60)).toEqual({ usedSeconds: 600, limitSeconds: 3600, remainingSeconds: 3000 });
    expect(usageToday(4000, 60).remainingSeconds).toBe(0);
  });
});

describe('heartbeat', () => {
  it('clamps seconds to 0..90', () => {
    expect(clampHeartbeatSeconds(15)).toBe(15);
    expect(clampHeartbeatSeconds(500)).toBe(90);
    expect(clampHeartbeatSeconds(-4)).toBe(0);
    expect(clampHeartbeatSeconds(7.9)).toBe(7);
  });
});

describe('local date', () => {
  it('uses the zone, not UTC, for the day boundary', () => {
    expect(localDate(new Date('2026-01-10T11:30:00Z'), 'Pacific/Auckland')).toBe('2026-01-11');
    expect(localDate(new Date('2026-01-10T11:30:00Z'), 'UTC')).toBe('2026-01-10');
    expect(localDate(new Date('2026-01-10T03:00:00Z'), 'America/Los_Angeles')).toBe('2026-01-09');
  });

  it('follows the daylight saving offset around the autumn change in New York', () => {
    expect(localDate(new Date('2026-11-01T03:59:00Z'), 'America/New_York')).toBe('2026-10-31');
    expect(localDate(new Date('2026-11-01T04:00:00Z'), 'America/New_York')).toBe('2026-11-01');
    expect(localDate(new Date('2026-11-02T04:59:00Z'), 'America/New_York')).toBe('2026-11-01');
    expect(localDate(new Date('2026-11-02T05:00:00Z'), 'America/New_York')).toBe('2026-11-02');
  });

  it('rolls the day at the spring change in London', () => {
    expect(localDate(new Date('2026-03-28T23:59:00Z'), 'Europe/London')).toBe('2026-03-28');
    expect(localDate(new Date('2026-03-29T23:00:00Z'), 'Europe/London')).toBe('2026-03-30');
    expect(localDate(new Date('2026-03-29T22:59:00Z'), 'Europe/London')).toBe('2026-03-29');
  });
});

describe('ids and stars', () => {
  it('rejects ids that could escape a blob path', () => {
    expect(isValidId('3f2a-9c')).toBe(true);
    expect(isValidId('../x')).toBe(false);
    expect(isValidId('a/b')).toBe(false);
    expect(isValidId('')).toBe(false);
  });

  it('derives stars as max(1, round(total/20))', () => {
    expect([0, 9, 10, 30, 50, 70, 90, 100].map(starsFor)).toEqual([1, 1, 1, 2, 3, 4, 5, 5]);
  });
});

describe('the event that starts a job', () => {
  const event = jobReadyEvent('job-1', new Date('2026-01-10T11:30:00Z'));

  it('reads the job id from the BlobCreated event of a ready blob, as an object or as text', () => {
    expect(jobIdOf(event)).toBe('job-1');
    expect(jobIdOf(JSON.stringify(event))).toBe('job-1');
  });

  it('ignores every other message', () => {
    expect(jobIdOf('not json')).toBeUndefined();
    expect(jobIdOf({ ...event, eventType: 'Microsoft.Storage.BlobDeleted' })).toBeUndefined();
    expect(jobIdOf({ ...event, subject: '/blobServices/default/containers/jobs/blobs/job-1/photo.jpg' })).toBeUndefined();
    expect(jobIdOf({ ...event, subject: '/blobServices/default/containers/drawings/blobs/job-1/ready' })).toBeUndefined();
    expect(jobIdOf(undefined)).toBeUndefined();
  });
});
