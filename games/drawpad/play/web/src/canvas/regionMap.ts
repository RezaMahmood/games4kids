export type RegionMap = { width: number; height: number; ids: Uint16Array };

export function decodeRegionIds(rgba: ArrayLike<number>): Uint16Array {
  const ids = new Uint16Array(rgba.length / 4);
  for (let i = 0; i < ids.length; i++) ids[i] = rgba[i * 4]! * 256 + rgba[i * 4 + 1]!;
  return ids;
}

export function idAt(map: RegionMap, x: number, y: number): number {
  const px = Math.floor(x);
  const py = Math.floor(y);
  if (px < 0 || py < 0 || px >= map.width || py >= map.height) return 0;
  return map.ids[py * map.width + px]!;
}

// A tap on a thin boundary line should still pick the closest region.
export function regionNear(map: RegionMap, x: number, y: number, reach: number): number {
  const direct = idAt(map, x, y);
  if (direct !== 0) return direct;
  const px = Math.floor(x);
  const py = Math.floor(y);
  let best = 0;
  let bestDist = Infinity;
  for (let cy = py - reach; cy <= py + reach; cy++) {
    for (let cx = px - reach; cx <= px + reach; cx++) {
      const dist = (cx + 0.5 - x) ** 2 + (cy + 0.5 - y) ** 2;
      if (dist >= bestDist) continue;
      const id = idAt(map, cx, cy);
      if (id !== 0) {
        best = id;
        bestDist = dist;
      }
    }
  }
  return best;
}

const DIRECTIONS: readonly (readonly [number, number])[] = [
  [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
];

// Shortest run from (x, y) along 8 directions before leaving the region: a cheap inscribed radius for sizing a label.
export function inscribedRadius(map: RegionMap, x: number, y: number, limit: number): number {
  const id = idAt(map, x, y);
  let radius = limit;
  for (const [dx, dy] of DIRECTIONS) {
    let run = 0;
    while (run < radius && idAt(map, x + dx * (run + 1), y + dy * (run + 1)) === id) run++;
    radius = Math.min(radius, run * Math.hypot(dx, dy));
  }
  return radius;
}
