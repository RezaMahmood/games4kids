import drawingPalette from './drawing-palette.json';
import type { Rgb } from '../scoring';

export type Swatch = { name: string; hex: string; rgb: Rgb };

const words = (key: string) => key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());

export function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export const DRAWING_PALETTE: readonly Swatch[] = Object.entries(drawingPalette).map(([key, hex]) => ({
  name: words(key),
  hex,
  rgb: hexToRgb(hex),
}));
