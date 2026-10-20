import type { Score, ScoreBreakdown } from '../../../../data/types';

export function buildScore(breakdown: ScoreBreakdown): Score {
  const rounded: ScoreBreakdown = {};
  let total = 0;
  for (const [key, points] of Object.entries(breakdown)) {
    rounded[key] = Math.round(points);
    total += rounded[key];
  }
  total = Math.min(100, Math.max(0, total));
  const stars = Math.min(5, Math.max(1, Math.round(total / 20))) as Score['stars'];
  return { total, stars, breakdown: rounded };
}

export const share = (part: number, whole: number) => (whole > 0 ? Math.min(1, part / whole) : 0);
