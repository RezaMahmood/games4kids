import { INK, clamp, newRaster, type Raster } from './types';

// 3x5 digits, one string per row, '#' is ink.
const GLYPHS: Record<string, string[]> = {
  '0': ['###', '# #', '# #', '# #', '###'],
  '1': [' # ', '## ', ' # ', ' # ', '###'],
  '2': ['###', '  #', '###', '#  ', '###'],
  '3': ['###', '  #', '###', '  #', '###'],
  '4': ['# #', '# #', '###', '  #', '  #'],
  '5': ['###', '#  ', '###', '  #', '###'],
  '6': ['###', '#  ', '###', '# #', '###'],
  '7': ['###', '  #', '  #', '  #', '  #'],
  '8': ['###', '# #', '###', '# #', '###'],
  '9': ['###', '# #', '###', '  #', '###'],
};

const NUMBER_INK = { r: 91, g: 96, b: 112 } as const;

export type PreviewLabel = { text: string; x: number; y: number; clearance: number };

function paint(img: Raster, x: number, y: number, c: { r: number; g: number; b: number }) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const i = (y * img.width + x) * 4;
  img.data[i] = c.r;
  img.data[i + 1] = c.g;
  img.data[i + 2] = c.b;
  img.data[i + 3] = 255;
}

function drawNumber(img: Raster, { text, x, y, clearance }: PreviewLabel) {
  const advance = 4;
  const units = text.length * advance - 1;
  const fits = Math.floor((clearance * 2 * 0.9) / Math.hypot(units, 5));
  const scale = clamp(fits, 1, 4);
  const left = Math.round(x - (units * scale) / 2);
  const top = Math.round(y - (5 * scale) / 2);
  for (let ch = 0; ch < text.length; ch++) {
    GLYPHS[text[ch]!]!.forEach((row, gy) => {
      for (let gx = 0; gx < 3; gx++) {
        if (row[gx] !== '#') continue;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) paint(img, left + (ch * advance + gx) * scale + dx, top + gy * scale + dy, NUMBER_INK);
        }
      }
    });
  }
}

/** The uncoloured sheet: white regions, 2px dark lines (so they survive thumbnails) and region numbers. */
export function renderPreview(width: number, height: number, boundary: Uint8Array, labels: PreviewLabel[]): Raster {
  const img = newRaster(width, height);
  img.data.fill(255);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (boundary[i] || (x > 0 && boundary[i - 1]) || (y > 0 && boundary[i - width])) paint(img, x, y, INK);
    }
  }
  for (const label of labels) drawNumber(img, label);
  return img;
}
