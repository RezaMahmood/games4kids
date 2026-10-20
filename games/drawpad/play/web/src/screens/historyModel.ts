import type { DrawingMeta, PictureKind } from '../../../../data/types';

export type Filter = 'all' | 'open' | 'done';

export function visibleDrawings(drawings: readonly DrawingMeta[], filter: Filter): DrawingMeta[] {
  return drawings
    .filter((d) => filter === 'all' || (filter === 'done') === (d.status === 'finished'))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export const kindLabel = (kind: PictureKind): string => (kind === 'pbn' ? 'Paint by numbers' : 'Freestyle');

const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

export function friendlyDate(iso: string, now: Date): string {
  const when = new Date(iso);
  const days = Math.round((dayStart(now) - dayStart(when)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  const sameYear = when.getFullYear() === now.getFullYear();
  return when.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}

export const thumbnailFile = (mode: PictureKind) => (mode === 'pbn' ? 'pbn-preview.png' : 'outline.png');

/** What a picture is chosen by: the finished, coloured picture for paint by numbers, so the player sees what they will make. */
export const choosingFile = (mode: PictureKind) => (mode === 'pbn' ? 'original.jpg' : 'outline.png');
