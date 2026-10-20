import { gaussianBlur } from './blur';
import { RING, connected, isLineEnd, lit, ringRuns, skeletonize } from './lines';
import { toLab } from './quantize';
import { INK, clamp, lerp, newRaster, type Raster } from './types';

export type OutlineOptions = { detail: number };

/** Colour edge strength (Di Zenzo, over blurred Lab) and its direction folded into 4 bins. */
function colourGradient(img: Raster, sigma: number) {
  const { width: w, height: h } = img;
  const n = w * h;
  const lab = toLab(img);
  const planes = [0, 1, 2].map((c) => {
    const plane = new Float32Array(n);
    for (let i = 0; i < n; i++) plane[i] = lab[i * 3 + c]!;
    return gaussianBlur(plane, w, h, sigma);
  });
  const mag = new Float32Array(n);
  const dir = new Uint8Array(n);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      let xx = 0, yy = 0, xy = 0;
      for (const g of planes) {
        const gx = g[i - w + 1]! + 2 * g[i + 1]! + g[i + w + 1]! - g[i - w - 1]! - 2 * g[i - 1]! - g[i + w - 1]!;
        const gy = g[i + w - 1]! + 2 * g[i + w]! + g[i + w + 1]! - g[i - w - 1]! - 2 * g[i - w]! - g[i - w + 1]!;
        xx += gx * gx;
        yy += gy * gy;
        xy += gx * gy;
      }
      mag[i] = Math.sqrt((xx + yy + Math.sqrt((xx - yy) ** 2 + 4 * xy * xy)) / 2) / 8;
      const angle = 0.5 * Math.atan2(2 * xy, xx - yy);
      const ax = Math.abs(Math.cos(angle));
      const ay = Math.abs(Math.sin(angle));
      if (ay <= ax * 0.4142) dir[i] = 0;
      else if (ay >= ax * 2.4142) dir[i] = 2;
      else dir[i] = Math.cos(angle) * Math.sin(angle) > 0 ? 3 : 1;
    }
  }
  return { mag, dir };
}

/** Keeps only pixels that are a local maximum across the edge, so lines are one pixel wide. */
function thinEdges(mag: Float32Array, dir: Uint8Array, w: number, h: number): Float32Array {
  const step = [[1, 0], [1, -1], [0, 1], [1, 1]] as const;
  const out = new Float32Array(mag.length);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const [dx, dy] = step[dir[i]!]!;
      const m = mag[i]!;
      if (m >= mag[i + dy * w + dx]! && m > mag[i - dy * w - dx]!) out[i] = m;
    }
  }
  return out;
}

function quantile(values: Float32Array, q: number): number {
  const picked: number[] = [];
  const stride = Math.max(1, Math.floor(values.length / 200000));
  for (let i = 0; i < values.length; i += stride) if (values[i]! > 0) picked.push(values[i]!);
  picked.sort((a, b) => a - b);
  return picked.length ? picked[Math.min(picked.length - 1, Math.floor(q * picked.length))]! : 0;
}

/** Weak edge pixels survive only when chained to a strong one. */
function hysteresis(edges: Float32Array, w: number, h: number, low: number, high: number): Uint8Array {
  const keep = new Uint8Array(w * h);
  const stack: number[] = [];
  for (let seed = 0; seed < edges.length; seed++) {
    if (keep[seed] || edges[seed]! < high) continue;
    keep[seed] = 1;
    stack.push(seed);
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % w;
      const y = (i - x) / w;
      for (const [dx, dy] of RING) {
        const nx = x + dx;
        const ny = y + dy;
        const n = ny * w + nx;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h || keep[n] || edges[n]! < low) continue;
        keep[n] = 1;
        stack.push(n);
      }
    }
  }
  return keep;
}

/** Canny-style edges. The strong threshold is the `q` quantile of edge strength, but never below `floor` (Lab units). */
function edgeLines(img: Raster, sigma: number, q: number, floor: number) {
  const { width: w, height: h } = img;
  const { mag, dir } = colourGradient(img, sigma);
  const edges = thinEdges(mag, dir, w, h);
  const high = Math.max(floor, quantile(edges, q));
  return { mag, high, line: skeletonize(hysteresis(edges, w, h, high * 0.3, high), w, h) };
}

export function dropShortPieces(line: Uint8Array, w: number, h: number, minLength: number) {
  for (const piece of connected(w, h, (i) => line[i] === 1).groups) if (piece.length < minLength) for (const i of piece) line[i] = 0;
}

/** Mean of `src` over the (2r+1)^2 box around each pixel, clipped at the picture edge. */
function boxMean(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const integral = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += src[y * w + x]!;
      integral[(y + 1) * (w + 1) + x + 1] = integral[y * (w + 1) + x + 1]! + row;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const sum = integral[y1 * (w + 1) + x1]! - integral[y0 * (w + 1) + x1]! - integral[y1 * (w + 1) + x0]! + integral[y0 * (w + 1) + x0]!;
      out[y * w + x] = sum / ((y1 - y0) * (x1 - x0));
    }
  }
  return out;
}

/**
 * Where line ends and junctions crowd together (stamens, seeds, fur) the lines are scribble, not shapes.
 * `crowd` is the share of pixels around that are ends or junctions.
 */
function clutterMask(line: Uint8Array, w: number, h: number, r: number, crowd: number): Uint8Array | null {
  const knots = new Float32Array(w * h);
  for (let i = 0; i < line.length; i++) if (line[i] && ringRuns(line, w, h, i) !== 2) knots[i] = 1;
  const crowded = boxMean(knots, w, h, r).map((v) => (v >= crowd ? 1 : 0));
  const soft = boxMean(boxMean(crowded, w, h, Math.ceil(r / 2)), w, h, Math.ceil(r / 2));
  const mask = new Uint8Array(w * h);
  let any = false;
  for (let i = 0; i < mask.length; i++) {
    if (soft[i]! > 0.5) {
      mask[i] = 1;
      any = true;
    }
  }
  return any ? mask : null;
}

/** Strong edges of a much blurrier copy of the picture, worked out only around the mask. */
function coarseLines(img: Raster, mask: Uint8Array, sigma: number): Uint8Array {
  const { width: w, height: h } = img;
  let x0 = w, y0 = h, x1 = 0, y1 = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const x = i % w;
    const y = (i - x) / w;
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  }
  const margin = Math.ceil(3 * sigma) + 2;
  x0 = Math.max(0, x0 - margin);
  y0 = Math.max(0, y0 - margin);
  x1 = Math.min(w - 1, x1 + margin);
  y1 = Math.min(h - 1, y1 + margin);
  const cw = x1 - x0 + 1;
  const ch = y1 - y0 + 1;
  const crop = newRaster(cw, ch);
  for (let y = 0; y < ch; y++) crop.data.set(img.data.subarray(((y0 + y) * w + x0) * 4, ((y0 + y) * w + x1 + 1) * 4), y * cw * 4);
  const { line } = edgeLines(crop, sigma, 0.9, 1.5);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < ch; y++) out.set(line.subarray(y * cw, (y + 1) * cw), (y0 + y) * w + x0);
  return out;
}

/** Follows a line from one of its ends until a junction, its other end, or `limit` pixels. */
function walk(line: Uint8Array, w: number, h: number, start: number, limit: number) {
  const path = [start];
  const seen = new Set(path);
  const touches = (a: number, b: number) => Math.abs((a % w) - (b % w)) <= 1 && Math.abs(Math.floor(a / w) - Math.floor(b / w)) <= 1;
  while (path.length <= limit) {
    const cur = path[path.length - 1]!;
    const prev = path.length > 1 ? path[path.length - 2]! : -1;
    if (prev !== -1 && ringRuns(line, w, h, cur) >= 3) return { path, stop: 'junction' as const };
    const x = cur % w;
    const y = (cur - x) / w;
    let next = -1;
    let corner = -1;
    for (const [dx, dy] of RING) {
      const n = (y + dy) * w + x + dx;
      if (!lit(line, w, h, x + dx, y + dy) || seen.has(n)) continue;
      // A pixel that also touches the previous one is the inside corner of a staircase, not the way on.
      if (prev !== -1 && touches(n, prev)) corner = n;
      else next = n;
    }
    if (next === -1) next = corner;
    if (next === -1) return { path, stop: 'end' as const };
    path.push(next);
    seen.add(next);
  }
  return { path, stop: 'limit' as const };
}

function lineEnds(line: Uint8Array, w: number, h: number): number[] {
  const ends: number[] = [];
  for (let i = 0; i < line.length; i++) if (line[i] && isLineEnd(line, w, h, i)) ends.push(i);
  return ends;
}

/**
 * Removes branches up to `maxLength` long that lead nowhere from a junction. Given `scribble`, works only from
 * ends inside it and removes lone strokes too, since only closed shapes are worth keeping there.
 */
export function pruneSpurs(line: Uint8Array, w: number, h: number, maxLength: number, scribble?: Uint8Array) {
  for (let pass = 0; pass < 3; pass++) {
    let removed = false;
    for (const end of lineEnds(line, w, h)) {
      if (!line[end] || (scribble && !scribble[end])) continue;
      const { path, stop } = walk(line, w, h, end, maxLength);
      if (stop === 'limit' || (stop === 'end' && !scribble)) continue;
      for (const i of stop === 'junction' ? path.slice(0, -1) : path) line[i] = 0;
      removed = true;
    }
    if (!removed) return;
  }
}

function drawLine(line: Uint8Array, w: number, x0: number, y0: number, x1: number, y1: number) {
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    line[y0 * w + x0] = 1;
    if (x0 === x1 && y0 === y1) return;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
}

/** Line pixels within `depth` steps along the line from `start`, so an end never bridges back onto its own stroke. */
function ownStroke(line: Uint8Array, w: number, h: number, start: number, depth: number): Set<number> {
  const seen = new Set([start]);
  let frontier = [start];
  for (let d = 0; d < depth && frontier.length; d++) {
    const next: number[] = [];
    for (const i of frontier) {
      const x = i % w;
      const y = (i - x) / w;
      for (const [dx, dy] of RING) {
        const n = (y + dy) * w + x + dx;
        if (lit(line, w, h, x + dx, y + dy) && !seen.has(n)) {
          seen.add(n);
          next.push(n);
        }
      }
    }
    frontier = next;
  }
  return seen;
}

/** Steps on along the strongest gradient until it meets another line: the faint edge that a gap usually hides. */
function followRidge(line: Uint8Array, mag: Float32Array, w: number, h: number, end: number, ux: number, uy: number, own: Set<number>, maxSteps: number, floor: number): number[] | null {
  const path: number[] = [];
  let x = end % w;
  let y = (end - x) / w;
  for (let step = 0; step < maxSteps; step++) {
    let best = -1;
    let bestMag = -1;
    let bx = 0, by = 0;
    for (const [dx, dy] of RING) {
      if ((dx * ux + dy * uy) / Math.hypot(dx, dy) < 0.38) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const n = ny * w + nx;
      if (line[n] && !own.has(n)) return [...path, n];
      if (mag[n]! > bestMag) {
        bestMag = mag[n]!;
        best = n;
        bx = dx;
        by = dy;
      }
    }
    if (best === -1 || bestMag < floor) return null;
    path.push(best);
    x += bx;
    y += by;
    const len = Math.hypot(bx, by);
    const tx = 0.75 * ux + 0.25 * (bx / len);
    const ty = 0.75 * uy + 0.25 * (by / len);
    ux = tx / Math.hypot(tx, ty);
    uy = ty / Math.hypot(tx, ty);
  }
  return null;
}

/** Draws a traced bridge as a straight stroke when it nearly is one, otherwise smoothed, so it reads as drawn. */
function drawBridge(line: Uint8Array, w: number, from: number, path: number[]) {
  const pts = [from, ...path].map((i) => [i % w, Math.floor(i / w)] as const);
  const [x0, y0] = pts[0]!;
  const [x1, y1] = pts[pts.length - 1]!;
  const len = Math.hypot(x1 - x0, y1 - y0) || 1;
  const bulge = Math.max(...pts.map(([x, y]) => Math.abs((x - x0) * (y1 - y0) - (y - y0) * (x1 - x0)) / len));
  if (bulge <= 3) return drawLine(line, w, x0, y0, x1, y1);
  const smooth = pts.map(([x, y], j) => {
    if (j === 0 || j === pts.length - 1) return [x, y] as const;
    const win = pts.slice(Math.max(0, j - 3), j + 4);
    return [Math.round(win.reduce((a, p) => a + p[0], 0) / win.length), Math.round(win.reduce((a, p) => a + p[1], 0) / win.length)] as const;
  });
  for (let j = 1; j < smooth.length; j++) drawLine(line, w, smooth[j - 1]![0], smooth[j - 1]![1], smooth[j]![0], smooth[j]![1]);
}

/**
 * Closes gaps so shapes hold paint: each loose end first follows the faint edge it was on, then, failing
 * that, bridges straight to the nearest line ahead of it within `radius`.
 */
function closeGaps(line: Uint8Array, mag: Float32Array, floor: number, w: number, h: number, radius: number, ridge: number) {
  const ends = lineEnds(line, w, h);
  const isEnd = new Set(ends);
  const ahead = Math.cos((50 * Math.PI) / 180);
  for (const end of ends) {
    if (!isLineEnd(line, w, h, end)) continue;
    const { path } = walk(line, w, h, end, 10);
    if (path.length < 4) continue;
    const ex = end % w;
    const ey = (end - ex) / w;
    const back = path[path.length - 1]!;
    const len = Math.hypot(ex - (back % w), ey - Math.floor(back / w));
    const ux = (ex - (back % w)) / len;
    const uy = (ey - Math.floor(back / w)) / len;
    const own = ownStroke(line, w, h, end, Math.ceil(Math.max(radius, ridge) * 1.5));
    const traced = followRidge(line, mag, w, h, end, ux, uy, own, Math.ceil(ridge), floor);
    if (traced) {
      drawBridge(line, w, end, traced);
      continue;
    }
    let best = -1;
    let bestScore = Infinity;
    const r = Math.ceil(radius);
    for (let y = Math.max(0, ey - r); y <= Math.min(h - 1, ey + r); y++) {
      for (let x = Math.max(0, ex - r); x <= Math.min(w - 1, ex + r); x++) {
        const i = y * w + x;
        if (!line[i] || own.has(i)) continue;
        const d = Math.hypot(x - ex, y - ey);
        const cos = ((x - ex) * ux + (y - ey) * uy) / d;
        if (d > radius || cos < ahead) continue;
        const score = d * (2 - cos) * (isEnd.has(i) ? 0.7 : 1);
        if (score < bestScore) {
          bestScore = score;
          best = i;
        }
      }
    }
    if (best !== -1) drawLine(line, w, ex, ey, best % w, Math.floor(best / w));
  }
}

export function thicken(line: Uint8Array, w: number, h: number): Raster {
  const out = newRaster(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let on = false;
      for (let dy = -1; dy <= 1 && !on; dy++) for (let dx = -1; dx <= 1 && !on; dx++) on = lit(line, w, h, x + dx, y + dy);
      const i = (y * w + x) * 4;
      out.data[i] = INK.r;
      out.data[i + 1] = INK.g;
      out.data[i + 2] = INK.b;
      out.data[i + 3] = on ? 255 : 0;
    }
  }
  return out;
}

/** Colouring-book line art: dark ink on transparent, lines about 3px wide. `detail` runs 0 (bold shapes) to 1 (fine lines). */
export function makeOutline(img: Raster, { detail }: OutlineOptions): Raster {
  const { width: w, height: h } = img;
  const d = clamp(detail, 0, 1);
  const long = Math.max(w, h);
  const size = clamp(long / 1024, 0.25, 1);
  const sigma = lerp(3.2, 1.4, d) * Math.max(size, 0.5);
  const fine = edgeLines(img, sigma, lerp(0.85, 0.55, d), lerp(3, 2, d));
  let line = fine.line;
  dropShortPieces(line, w, h, Math.round(8 * size));

  const clutterRadius = Math.round(14 * Math.max(size, 0.6));
  // 4 (bold) to 9 (detailed) ends or junctions in a 29px square read as scribble.
  const clutter = clutterMask(line, w, h, clutterRadius, lerp(4, 9, d) / 29 ** 2);
  if (clutter) {
    const coarse = coarseLines(img, clutter, Math.max(1.5 * sigma, 7 * Math.max(size, 0.5)));
    for (let i = 0; i < line.length; i++) if (clutter[i]) line[i] = coarse[i]!;
    line = skeletonize(line, w, h);
  }

  pruneSpurs(line, w, h, Math.round(12 * size));
  closeGaps(line, fine.mag, fine.high * 0.15, w, h, 0.03 * long, 0.06 * long);
  if (clutter) pruneSpurs(line, w, h, 4 * clutterRadius, clutter);
  pruneSpurs(line, w, h, Math.round(lerp(60, 15, d) * size));
  dropShortPieces(line, w, h, Math.round(lerp(90, 30, d) * size));
  return thicken(line, w, h);
}
