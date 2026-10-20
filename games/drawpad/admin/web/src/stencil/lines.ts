/** One-pixel line drawings as 0/1 masks of width * height, shared by the outline and its measurements. */

/** The 8 neighbours in order around a pixel, starting east and turning anticlockwise. */
export const RING = [[1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1], [0, 1], [1, 1]] as const;

export const STEPS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

export const lit = (line: Uint8Array, w: number, h: number, x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && line[y * w + x] === 1;

/** Separate runs of line pixels around a pixel: 1 at a line end, 2 along a line, 3 or more at a junction. */
export function ringRuns(line: Uint8Array, w: number, h: number, i: number): number {
  const x = i % w;
  const y = (i - x) / w;
  let runs = 0;
  for (let k = 0; k < 8; k++) {
    const [ax, ay] = RING[k]!;
    const [bx, by] = RING[(k + 1) % 8]!;
    if (!lit(line, w, h, x + ax, y + ay) && lit(line, w, h, x + bx, y + by)) runs++;
  }
  return runs;
}

/** A line end has one run of neighbours, at most two of them (the end of a staircase has two). */
export function isLineEnd(line: Uint8Array, w: number, h: number, i: number): boolean {
  if (ringRuns(line, w, h, i) !== 1) return false;
  const x = i % w;
  const y = (i - x) / w;
  return RING.filter(([dx, dy]) => lit(line, w, h, x + dx, y + dy)).length <= 2;
}

/** Zhang-Suen thinning of a mask to one-pixel lines. */
export function skeletonize(mask: Uint8Array, w: number, h: number): Uint8Array {
  const s = Uint8Array.from(mask);
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : s[y * w + x]!);
  let live: number[] = [];
  for (let i = 0; i < s.length; i++) if (s[i]) live.push(i);
  for (let changed = true; changed; ) {
    changed = false;
    for (const pass of [0, 1]) {
      const drop: number[] = [];
      for (const i of live) {
        const x = i % w;
        const y = (i - x) / w;
        const p2 = at(x, y - 1), p3 = at(x + 1, y - 1), p4 = at(x + 1, y), p5 = at(x + 1, y + 1);
        const p6 = at(x, y + 1), p7 = at(x - 1, y + 1), p8 = at(x - 1, y), p9 = at(x - 1, y - 1);
        const b = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
        if (b < 2 || b > 6) continue;
        const a = +(!p2 && p3) + +(!p3 && p4) + +(!p4 && p5) + +(!p5 && p6) + +(!p6 && p7) + +(!p7 && p8) + +(!p8 && p9) + +(!p9 && p2);
        if (a !== 1) continue;
        if (pass === 0 ? p2 * p4 * p6 || p4 * p6 * p8 : p2 * p4 * p8 || p2 * p6 * p8) continue;
        drop.push(i);
      }
      for (const i of drop) s[i] = 0;
      if (drop.length) changed = true;
    }
    live = live.filter((i) => s[i]);
  }
  return s;
}

/** Connected groups of pixels where `inside` holds: the label map (-1 outside) and each group's pixels. */
export function connected(w: number, h: number, inside: (i: number) => boolean, steps: readonly (readonly [number, number])[] = RING) {
  const ids = new Int32Array(w * h).fill(-1);
  const groups: number[][] = [];
  for (let seed = 0; seed < ids.length; seed++) {
    if (ids[seed] !== -1 || !inside(seed)) continue;
    const id = groups.length;
    const pixels = [seed];
    ids[seed] = id;
    for (let k = 0; k < pixels.length; k++) {
      const i = pixels[k]!;
      const x = i % w;
      const y = (i - x) / w;
      for (const [dx, dy] of steps) {
        const nx = x + dx;
        const ny = y + dy;
        const n = ny * w + nx;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h || ids[n] !== -1 || !inside(n)) continue;
        ids[n] = id;
        pixels.push(n);
      }
    }
    groups.push(pixels);
  }
  return { ids, groups };
}
