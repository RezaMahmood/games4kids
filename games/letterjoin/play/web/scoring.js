export const TOLERANCE_RATIO = 0.1;
const SAMPLE_STEP = 0.5;
const DIAGONAL = Math.SQRT2;

export function toleranceFor(fontSize) {
  return fontSize * TOLERANCE_RATIO;
}

export function distanceField(mask, width, height) {
  const dist = new Float32Array(width * height);
  for (let i = 0; i < dist.length; i++) dist[i] = mask[i] ? 0 : Infinity;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      let d = dist[i];
      if (x > 0) d = Math.min(d, dist[i - 1] + 1);
      if (y > 0) {
        d = Math.min(d, dist[i - width] + 1);
        if (x > 0) d = Math.min(d, dist[i - width - 1] + DIAGONAL);
        if (x < width - 1) d = Math.min(d, dist[i - width + 1] + DIAGONAL);
      }
      dist[i] = d;
    }
  }
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x;
      let d = dist[i];
      if (x < width - 1) d = Math.min(d, dist[i + 1] + 1);
      if (y < height - 1) {
        d = Math.min(d, dist[i + width] + 1);
        if (x < width - 1) d = Math.min(d, dist[i + width + 1] + DIAGONAL);
        if (x > 0) d = Math.min(d, dist[i + width - 1] + DIAGONAL);
      }
      dist[i] = d;
    }
  }
  return dist;
}

export function resample(strokes) {
  const points = [];
  for (const stroke of strokes) {
    if (stroke.length === 0) continue;
    points.push(stroke[0]);
    for (let i = 1; i < stroke.length; i++) {
      const a = stroke[i - 1];
      const b = stroke[i];
      const steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / SAMPLE_STEP);
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        points.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      }
    }
  }
  return points;
}

export function score({ mask, width, height, strokes, tolerance }) {
  const samples = resample(strokes);
  const targetDist = distanceField(mask, width, height);
  const ink = new Uint8Array(width * height);
  let near = 0;
  for (const p of samples) {
    const x = Math.round(p.x);
    const y = Math.round(p.y);
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    ink[y * width + x] = 1;
    if (targetDist[y * width + x] <= tolerance) near++;
  }
  const inkDist = distanceField(ink, width, height);
  let targetPixels = 0;
  let covered = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    targetPixels++;
    if (inkDist[i] <= tolerance) covered++;
  }
  const coverage = targetPixels ? covered / targetPixels : 0;
  const precision = samples.length ? near / samples.length : 0;
  const sum = coverage + precision;
  const f = sum ? (2 * coverage * precision) / sum : 0;
  return { coverage, precision, score: f * 100 };
}
