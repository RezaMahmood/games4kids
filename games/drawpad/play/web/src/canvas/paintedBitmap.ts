import type { Fills } from './fills';
import { hexToRgb } from './palette';
import type { Rgb } from '../scoring';
import type { RegionMap } from './regionMap';

const BOUNDARY: Rgb = [0x1f, 0x24, 0x30];
const WHITE: Rgb = [255, 255, 255];

/** The sheet without numbers: white regions, dark boundaries, filled regions in their palette colour or the player's own. */
export class PaintedBitmap {
  readonly canvas: HTMLCanvasElement;
  private readonly image: ImageData;

  constructor(private readonly map: RegionMap, private readonly fills: Fills) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = map.width;
    this.canvas.height = map.height;
    this.image = new ImageData(map.width, map.height);
    const px = this.image.data;
    for (let i = 0; i < map.ids.length; i++) {
      const c = map.ids[i] === 0 ? BOUNDARY : WHITE;
      px[i * 4] = c[0];
      px[i * 4 + 1] = c[1];
      px[i * 4 + 2] = c[2];
      px[i * 4 + 3] = 255;
    }
    this.repaint(fills.filled);
  }

  /** Redraws these regions from the fills, after the fills changed them. */
  repaint(ids: Iterable<number>) {
    const lut = new Int32Array(65536).fill(-1);
    const colours: Rgb[] = [];
    for (const id of ids) {
      const hex = this.fills.hexOf(id);
      lut[id] = colours.push(hex ? hexToRgb(hex) : WHITE) - 1;
    }
    const { ids: map } = this.map;
    const px = this.image.data;
    for (let i = 0; i < map.length; i++) {
      const colour = lut[map[i]!]!;
      if (colour < 0) continue;
      const c = colours[colour]!;
      px[i * 4] = c[0];
      px[i * 4 + 1] = c[1];
      px[i * 4 + 2] = c[2];
    }
    this.canvas.getContext('2d')!.putImageData(this.image, 0, 0);
  }
}
