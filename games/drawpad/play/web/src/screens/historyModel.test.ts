import { describe, expect, it } from 'vitest';
import type { DrawingMeta } from '../../../../data/types';
import { friendlyDate, visibleDrawings } from './historyModel';

const drawing = (id: string, status: DrawingMeta['status'], updatedAt: string): DrawingMeta => ({
  id, pictureId: 'p', kind: 'trace', status, createdAt: updatedAt, updatedAt, score: null, filledRegions: null,
});

const list = [
  drawing('a', 'in-progress', '2026-10-15T10:00:00Z'),
  drawing('b', 'finished', '2026-10-17T10:00:00Z'),
  drawing('c', 'in-progress', '2026-10-16T10:00:00Z'),
];

describe('history list', () => {
  it('shows everything newest first', () => {
    expect(visibleDrawings(list, 'all').map((d) => d.id)).toEqual(['b', 'c', 'a']);
  });

  it('filters to in progress and to finished', () => {
    expect(visibleDrawings(list, 'open').map((d) => d.id)).toEqual(['c', 'a']);
    expect(visibleDrawings(list, 'done').map((d) => d.id)).toEqual(['b']);
  });

  it('does not reorder the caller list', () => {
    visibleDrawings(list, 'all');
    expect(list.map((d) => d.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('friendly dates', () => {
  const now = new Date(2026, 9, 17, 9, 0);
  const at = (y: number, m: number, d: number, h = 12) => new Date(y, m, d, h).toISOString();

  it('says Today and Yesterday by local calendar day', () => {
    expect(friendlyDate(at(2026, 9, 17, 0), now)).toBe('Today');
    expect(friendlyDate(at(2026, 9, 16, 23), now)).toBe('Yesterday');
  });

  it('shows day and month for older dates, adding the year for other years', () => {
    expect(friendlyDate(at(2026, 9, 12), now)).toBe('12 Oct');
    expect(friendlyDate(at(2025, 11, 25), now)).toBe('25 Dec 2025');
  });
});
