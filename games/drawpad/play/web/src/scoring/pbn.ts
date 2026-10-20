import type { Score } from '../../../../data/types';
import { buildScore, share } from './score';

export const PBN_POINTS = { completeness: 80, matching: 20 } as const;

export type PbnInput = {
  regionsTotal: number;
  regionsFilled: number;
  /** Regions painted with their own number's colour. */
  regionsMatched: number;
};

/** Painting every area earns most of the score; following the numbers earns the rest. No colour is ever wrong. */
export function scorePbn(input: PbnInput): Score {
  return buildScore({
    completeness: PBN_POINTS.completeness * share(input.regionsFilled, input.regionsTotal),
    matching: PBN_POINTS.matching * share(input.regionsMatched, input.regionsTotal),
  });
}
