import { STEPS4, connected, isLineEnd, skeletonize } from './lines';
import type { Raster } from './types';

export type OutlineMetrics = {
  /** Share of the picture covered by ink. */
  ink: number;
  /** Loose line ends on the one-pixel skeleton of the ink. A line that runs into the picture edge is closed by it. */
  endpoints: number;
  /** 8-connected pieces of ink. */
  components: number;
  /** Pieces whose skeleton is shorter than TINY_LENGTH pixels. */
  tiny: number;
  /** Paper areas of at least MIN_REGION of the picture that ink separates from the picture border. */
  enclosed: number;
  /** Share of the picture covered by those enclosed areas. */
  enclosedArea: number;
  /** Enclosed area id at a pixel, or -1 when the pixel is ink, open paper, or a crumb below MIN_REGION. */
  regionAt: (x: number, y: number) => number;
};

const TINY_LENGTH = 25;
const MIN_REGION = 0.002;
const FRAME = 3;

/** Measures what a child colouring the outline meets: loose ends, crumbs, and areas the ink closes off. */
export function measureOutline(img: Raster): OutlineMetrics {
  const { width: w, height: h } = img;
  const ink = new Uint8Array(w * h);
  for (let i = 0; i < ink.length; i++) ink[i] = img.data[i * 4 + 3]! > 128 ? 1 : 0;
  const skeleton = skeletonize(ink, w, h);

  let endpoints = 0;
  for (let y = FRAME; y < h - FRAME; y++) {
    for (let x = FRAME; x < w - FRAME; x++) if (skeleton[y * w + x] && isLineEnd(skeleton, w, h, y * w + x)) endpoints++;
  }

  const pieces = connected(w, h, (i) => ink[i] === 1);
  const tiny = pieces.groups.filter((pixels) => pixels.reduce((n, i) => n + skeleton[i]!, 0) < TINY_LENGTH).length;

  const paper = connected(w, h, (i) => ink[i] === 0, STEPS4);
  const minArea = MIN_REGION * w * h;
  const touchesBorder = (pixels: number[]) => pixels.some((i) => i < w || i >= w * (h - 1) || i % w === 0 || i % w === w - 1);
  const closed = new Set(paper.groups.flatMap((pixels, id) => (pixels.length >= minArea && !touchesBorder(pixels) ? [id] : [])));
  const enclosedPixels = [...closed].reduce((n, id) => n + paper.groups[id]!.length, 0);

  return {
    ink: ink.reduce((n, v) => n + v, 0) / (w * h),
    endpoints,
    components: pieces.groups.length,
    tiny,
    enclosed: closed.size,
    enclosedArea: enclosedPixels / (w * h),
    regionAt: (x, y) => {
      const id = paper.ids[y * w + x]!;
      return closed.has(id) ? id : -1;
    },
  };
}
