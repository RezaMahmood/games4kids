import { describe, expect, it, vi } from 'vitest';
import type { PbnResult } from '../stencil/pbn';
import type { Raster } from '../stencil/types';
import { buildPbnPicture } from './newPicture';
import { DEFAULT_PBN_TUNING, type ChoosingPhase, type DescriptionItem } from './uploadModel';

// Names each encoded raster by its size and format, so the payload shows which raster went where.
vi.mock('../stencil/browser', () => ({
  encodeBytes: async (r: Raster, type: string) => new TextEncoder().encode(`${r.width}x${r.height} ${type}`),
}));

const named = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);

const raster = (width: number, height: number): Raster => ({ data: new Uint8ClampedArray(width * height * 4), width, height });
const pbn: PbnResult = {
  pbn: { width: 30, height: 20, palette: ['#FFFFFF', '#000000'], regions: [{ id: 1, colorIndex: 0, labelX: 4, labelY: 4 }] },
  regions: raster(31, 20),
  preview: raster(32, 20),
};
const item: DescriptionItem = {
  id: 1, source: 'description', description: 'a fox', quality: 'standard', title: '  Sleepy Fox ', titleSource: 'ai', suggestions: [], jobIds: ['job1'],
  phase: { kind: 'waiting', label: '' },
};
const phase = (chosen: ChoosingPhase['chosen'], generated: PbnResult | null): ChoosingPhase => ({
  kind: 'choosing', chosen, generated, tuning: DEFAULT_PBN_TUNING, rev: 1, regenerating: false, saving: false, error: null,
  scenes: [{ kind: 'ready', raster: raster(10, 10) }, { kind: 'ready', raster: raster(30, 20) }, { kind: 'failed', error: 'redraw_failed' }],
});

describe('buildPbnPicture', () => {
  it('saves a paint by number only, with the picked AI picture as its original', async () => {
    const built = await buildPbnPicture(item, phase(1, pbn));
    expect({ ...built, original: named(built.original), pbnRegions: named(built.pbnRegions), pbnPreview: named(built.pbnPreview) }).toEqual({
      title: 'Sleepy Fox',
      kinds: ['pbn'],
      width: 30,
      height: 20,
      original: '30x20 image/jpeg',
      pbn: pbn.pbn,
      pbnRegions: '31x20 image/png',
      pbnPreview: '32x20 image/png',
    });
  });

  it('refuses until a picture is picked and its paint by number is made', async () => {
    await expect(buildPbnPicture(item, phase(null, null))).rejects.toThrow('Pick a picture first.');
    await expect(buildPbnPicture(item, phase(1, null))).rejects.toThrow('Pick a picture first.');
  });
});
