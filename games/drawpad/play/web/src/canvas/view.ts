export type View = { scale: number; x: number; y: number };
export type Frame = { vw: number; vh: number; pw: number; ph: number };
export type Pt = { x: number; y: number };

export const MAX_ZOOM = 6;

export const fitScale = (f: Frame) => Math.min(f.vw / f.pw, f.vh / f.ph);

export function fitView(f: Frame): View {
  const scale = fitScale(f);
  return { scale, x: (f.vw - f.pw * scale) / 2, y: (f.vh - f.ph * scale) / 2 };
}

function clampAxis(offset: number, viewport: number, content: number): number {
  return content <= viewport ? (viewport - content) / 2 : Math.min(0, Math.max(viewport - content, offset));
}

export function clampView(v: View, f: Frame): View {
  const min = fitScale(f);
  const scale = Math.min(min * MAX_ZOOM, Math.max(min, v.scale));
  return { scale, x: clampAxis(v.x, f.vw, f.pw * scale), y: clampAxis(v.y, f.vh, f.ph * scale) };
}

export function toPicture(v: View, sx: number, sy: number): Pt {
  return { x: (sx - v.x) / v.scale, y: (sy - v.y) / v.scale };
}

// Rescales around a screen point so the picture point under it stays put.
export function zoomAbout(v: View, factor: number, at: Pt, f: Frame): View {
  const p = toPicture(v, at.x, at.y);
  const scale = v.scale * factor;
  return clampView({ scale, x: at.x - p.x * scale, y: at.y - p.y * scale }, f);
}

export function pinchView(start: View, from: [Pt, Pt], to: [Pt, Pt], f: Frame): View {
  const d0 = Math.hypot(from[0].x - from[1].x, from[0].y - from[1].y);
  const d1 = Math.hypot(to[0].x - to[1].x, to[0].y - to[1].y);
  const scale = d0 > 0 ? start.scale * (d1 / d0) : start.scale;
  const mid0 = { x: (from[0].x + from[1].x) / 2, y: (from[0].y + from[1].y) / 2 };
  const mid1 = { x: (to[0].x + to[1].x) / 2, y: (to[0].y + to[1].y) / 2 };
  const p = toPicture(start, mid0.x, mid0.y);
  return clampView({ scale, x: mid1.x - p.x * scale, y: mid1.y - p.y * scale }, f);
}
