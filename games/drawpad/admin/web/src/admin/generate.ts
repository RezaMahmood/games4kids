import { outlineInWorker } from '../stencil/browser';
import { outlineFromRedraw } from '../stencil/redraw';
import type { Raster } from '../stencil/types';
import type { Generated, RedrawKey, Redraws, Tuning } from './uploadModel';

function redrawn(redraws: Redraws, key: RedrawKey): Raster {
  const raster = redraws[key];
  if (!raster) throw new Error('The AI redraw for this picture is missing.');
  return raster;
}

function drawOutline(photo: Raster, tuning: Tuning, redraws: Redraws): Promise<Raster> | Raster {
  if (tuning.outline === 'classic') return outlineInWorker(photo, tuning.detail);
  return outlineFromRedraw(redrawn(redraws, `trace-${tuning.outline}`), photo.width, photo.height);
}

/** Makes the stencil in the browser from the photo and the AI redraw already fetched for it, if the tuning needs one. */
export async function generate(
  photo: Raster,
  tuning: Tuning,
  redraws: Redraws,
  report: (label: string, progress: number) => void = () => {},
): Promise<Generated> {
  report(tuning.outline === 'classic' ? 'Drawing the outline…' : 'Tidying the AI outline…', 0.5);
  return { outline: await drawOutline(photo, tuning, redraws), tuning };
}
