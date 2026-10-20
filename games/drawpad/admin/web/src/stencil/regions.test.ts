import { describe, expect, it } from 'vitest';
import { buildRegionGraph } from './regions';

/** A 12x12 grid of 5x5 cells, colours alternating over 3 clusters so no two neighbours match. */
function grid() {
  const w = 60;
  const labels = new Uint8Array(w * w);
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) labels[y * w + x] = (Math.floor(x / 5) + 2 * Math.floor(y / 5)) % 3;
  return { labels, w };
}

describe('RegionGraph', () => {
  it('starts with one region per 4-connected same-colour patch', () => {
    const { labels, w } = grid();
    expect(buildRegionGraph(labels, w, w).segmentation().count).toBe(144);
  });

  it('merges the smallest regions until the cap holds', () => {
    const { labels, w } = grid();
    const graph = buildRegionGraph(labels, w, w);
    graph.mergeSmallestUntil(20);
    const seg = graph.segmentation();
    expect(seg.count).toBeLessThanOrEqual(20);
    expect(new Set(seg.ids).size).toBe(seg.count);
  });

  it('joins neighbours that end up the same colour after a merge', () => {
    const w = 30;
    const labels = new Uint8Array(w * 10).fill(0);
    for (let y = 0; y < 10; y++) for (let x = 12; x < 14; x++) labels[y * w + x] = 1;
    const graph = buildRegionGraph(labels, w, 10);
    graph.mergeSmall(100);
    expect(graph.segmentation().count).toBe(1);
  });
});
