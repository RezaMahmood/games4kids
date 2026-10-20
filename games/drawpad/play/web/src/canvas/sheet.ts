import type { PbnData } from '../../../../data/types';
import type { Fills } from './fills';
import { PaintedBitmap } from './paintedBitmap';
import { inscribedRadius, type RegionMap } from './regionMap';
import type { View } from './view';

const NUMBER_INK = '#1F2430';
const NUMBER_MUTED = '#8A8F9C';
const MIN_LABEL_PX = 6;
const MAX_LABEL = 30;
const MIN_LABEL = 8;

type Label = { id: number; colorIndex: number; text: string; x: number; y: number; size: number };

/** The painted sheet with its numbers, drawn at the player's zoom. */
export class Sheet {
  private readonly painted: PaintedBitmap;
  private readonly labels: Label[];

  constructor(data: PbnData, private readonly map: RegionMap, private readonly fills: Fills) {
    this.painted = new PaintedBitmap(map, fills);

    this.labels = data.regions.map((r) => {
      const radius = inscribedRadius(map, Math.round(r.labelX), Math.round(r.labelY), MAX_LABEL);
      return {
        id: r.id,
        colorIndex: r.colorIndex,
        text: String(r.colorIndex + 1),
        x: r.labelX,
        y: r.labelY,
        size: Math.min(MAX_LABEL, Math.max(MIN_LABEL, radius * 1.3)),
      };
    });
  }

  draw(ctx: CanvasRenderingContext2D, view: View, viewport: { w: number; h: number }, dpr: number, selectedColor: number) {
    const { width, height } = this.map;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, viewport.w, viewport.h);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.painted.canvas, view.x, view.y, width * view.scale, height * view.scale);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const label of this.labels) {
      const px = label.size * view.scale;
      if (px < MIN_LABEL_PX || this.fills.filled.has(label.id)) continue;
      const selected = label.colorIndex === selectedColor;
      ctx.font = `${selected ? 800 : 700} ${px}px 'Atkinson Hyperlegible', sans-serif`;
      ctx.fillStyle = selected ? NUMBER_INK : NUMBER_MUTED;
      ctx.fillText(label.text, view.x + label.x * view.scale, view.y + label.y * view.scale);
    }
  }

  /** Redraws these regions from the fills, after the fills changed them. */
  repaint(ids: Iterable<number>) {
    this.painted.repaint(ids);
  }
}
