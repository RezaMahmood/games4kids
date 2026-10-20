/** Pixels that touch a different region on their right or below. They become the 1px dark lines (id 0). */
export function boundaryMask(ids: Int32Array, w: number, h: number): Uint8Array {
  const mask = new Uint8Array(ids.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if ((x + 1 < w && ids[i] !== ids[i + 1]) || (y + 1 < h && ids[i] !== ids[i + w])) mask[i] = 1;
    }
  }
  return mask;
}

export type Anchor = { x: number; y: number; /** Distance from the anchor to the nearest region edge, in pixels. */ clearance: number };

const AXIAL = 3;
const DIAGONAL = 4;

/**
 * Where to print a region's number: the interior point furthest from its edge (the pole of inaccessibility,
 * via a 3-4 chamfer distance transform). Among equally far points, the one nearest their centre wins so a
 * rectangle gets its number in the middle rather than at one end of the ridge.
 */
export function labelAnchors(ids: Int32Array, boundary: Uint8Array, w: number, h: number, count: number): (Anchor | null)[] {
  const inf = 1 << 28;
  const dist = new Int32Array(ids.length);
  const reach = (i: number, from: number, step: number, d: number) =>
    Math.min(d, boundary[from] || ids[from] !== ids[i] ? step : dist[from]! + step);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (boundary[i]) continue;
      let d = inf;
      d = x === 0 || y === 0 ? AXIAL : d;
      if (x > 0) d = reach(i, i - 1, AXIAL, d);
      if (y > 0) d = reach(i, i - w, AXIAL, d);
      if (x > 0 && y > 0) d = reach(i, i - w - 1, DIAGONAL, d);
      if (x < w - 1 && y > 0) d = reach(i, i - w + 1, DIAGONAL, d);
      dist[i] = d;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (boundary[i]) continue;
      let d = dist[i]!;
      d = x === w - 1 || y === h - 1 ? Math.min(d, AXIAL) : d;
      if (x < w - 1) d = reach(i, i + 1, AXIAL, d);
      if (y < h - 1) d = reach(i, i + w, AXIAL, d);
      if (x < w - 1 && y < h - 1) d = reach(i, i + w + 1, DIAGONAL, d);
      if (x > 0 && y < h - 1) d = reach(i, i + w - 1, DIAGONAL, d);
      dist[i] = d;
    }
  }

  const peak = new Int32Array(count + 1);
  for (let i = 0; i < ids.length; i++) if (!boundary[i] && dist[i]! > peak[ids[i]!]!) peak[ids[i]!] = dist[i]!;

  const sumX = new Float64Array(count + 1);
  const sumY = new Float64Array(count + 1);
  const n = new Float64Array(count + 1);
  const onRidge = (i: number) => !boundary[i] && dist[i]! >= peak[ids[i]!]! - 1;
  for (let i = 0; i < ids.length; i++) {
    if (!onRidge(i)) continue;
    const id = ids[i]!;
    sumX[id]! += i % w;
    sumY[id]! += Math.floor(i / w);
    n[id]! += 1;
  }

  const best = new Float64Array(count + 1).fill(Infinity);
  const anchors: (Anchor | null)[] = Array.from({ length: count }, () => null);
  for (let i = 0; i < ids.length; i++) {
    if (!onRidge(i)) continue;
    const id = ids[i]!;
    const x = i % w;
    const y = Math.floor(i / w);
    const d = (x - sumX[id]! / n[id]!) ** 2 + (y - sumY[id]! / n[id]!) ** 2;
    if (d < best[id]!) {
      best[id] = d;
      anchors[id - 1] = { x, y, clearance: peak[id]! / AXIAL };
    }
  }
  return anchors;
}
