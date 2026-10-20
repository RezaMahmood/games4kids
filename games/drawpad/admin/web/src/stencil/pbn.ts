import type { PbnData, PbnRegion } from '../../../../data/types';
import { boundaryMask, labelAnchors } from './labels';
import { renderPreview, type PreviewLabel } from './preview';
import { bilateral, majority, quantize, rgbToLab, toLab } from './quantize';
import { buildRegionGraph } from './regions';
import { clamp, lerp, newRaster, type Raster } from './types';

export type PbnOptions = { colors: number; detail: number };

export type PbnResult = {
  pbn: PbnData;
  /** `pbn-regions.png` pixels: id = R*256+G, B 0, A 255, boundary lines are id 0. */
  regions: Raster;
  /** `pbn-preview.png` pixels. */
  preview: Raster;
};

export const MAX_REGIONS = 250;

const hex = (r: number, g: number, b: number) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();

/** Mean colour of everything finally painted with each cluster, ordered light to dark so 1 is the lightest. */
function buildPalette(img: Raster, ids: Int32Array, clusterOfId: Uint8Array, k: number) {
  const sum = new Float64Array(k * 3);
  const count = new Float64Array(k);
  for (let i = 0; i < ids.length; i++) {
    const c = clusterOfId[ids[i]! - 1]!;
    sum[c * 3]! += img.data[i * 4]!;
    sum[c * 3 + 1]! += img.data[i * 4 + 1]!;
    sum[c * 3 + 2]! += img.data[i * 4 + 2]!;
    count[c]! += 1;
  }
  const used = Array.from({ length: k }, (_, c) => c)
    .filter((c) => count[c]!)
    .map((c) => {
      const rgb = [0, 1, 2].map((a) => Math.round(sum[c * 3 + a]! / count[c]!)) as [number, number, number];
      return { cluster: c, rgb, lightness: rgbToLab(...rgb)[0] };
    })
    .sort((a, b) => b.lightness - a.lightness || a.cluster - b.cluster);
  const indexOfCluster = new Map(used.map((u, index) => [u.cluster, index]));
  return { palette: used.map((u) => hex(...u.rgb)), indexOfCluster };
}

/**
 * Paint by numbers from a picture-sized raster (long edge already at most 1024). `detail` runs 0 (big shapes)
 * to 1 (small shapes). Never more than MAX_REGIONS regions, and none too thin to hold a number.
 */
export function makePbn(img: Raster, { colors, detail }: PbnOptions): PbnResult {
  const { width: w, height: h } = img;
  const d = clamp(detail, 0, 1);
  const k = clamp(Math.round(colors), 2, 16);
  const size = clamp(Math.sqrt(w * h) / 1024, 0.05, 1);

  const smooth = bilateral(img, 2, lerp(36, 18, d), 2);
  const clusters = majority(quantize(toLab(smooth), k), w, h, k);
  const graph = buildRegionGraph(clusters, w, h);
  graph.mergeSmall(lerp(2200, 450, d) * size * size);

  const measure = () => {
    const seg = graph.segmentation();
    const boundary = boundaryMask(seg.ids, w, h);
    return { seg, boundary, anchors: labelAnchors(seg.ids, boundary, w, h, seg.count) };
  };

  // A number needs room: merge regions whose widest inscribed circle is too small until none are left.
  const minClearance = Math.max(2, lerp(10, 6, d) * size);
  let { seg, boundary, anchors } = measure();
  for (let round = 0; round < 5; round++) {
    const cramped = anchors.flatMap((a, at) => (!a || a.clearance < minClearance ? [seg.nodes[at]!] : []));
    if (!cramped.length) break;
    for (const node of cramped) if (graph.isAlive(node)) graph.mergeIntoNeighbour(node);
    ({ seg, boundary, anchors } = measure());
  }
  if (seg.count > MAX_REGIONS) {
    graph.mergeSmallestUntil(MAX_REGIONS);
    ({ seg, boundary, anchors } = measure());
  }
  const { palette, indexOfCluster } = buildPalette(img, seg.ids, seg.colours, k);

  const regions: PbnRegion[] = [];
  const labels: PreviewLabel[] = [];
  anchors.forEach((anchor, at) => {
    if (!anchor) return;
    const colorIndex = indexOfCluster.get(seg.colours[at]!)!;
    regions.push({ id: at + 1, colorIndex, labelX: anchor.x, labelY: anchor.y });
    labels.push({ text: String(colorIndex + 1), x: anchor.x, y: anchor.y, clearance: anchor.clearance });
  });

  const regionsImage = newRaster(w, h);
  for (let i = 0; i < seg.ids.length; i++) {
    const id = boundary[i] ? 0 : seg.ids[i]!;
    regionsImage.data[i * 4] = id >> 8;
    regionsImage.data[i * 4 + 1] = id & 255;
    regionsImage.data[i * 4 + 3] = 255;
  }

  return {
    pbn: { width: w, height: h, palette, regions },
    regions: regionsImage,
    preview: renderPreview(w, h, boundary, labels),
  };
}
