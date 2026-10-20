export type Tool = { mode: 'pen' | 'eraser'; color: string; size: number };
export type Point = { x: number; y: number; w: number };

type Stroke = { tool: Tool; points: Point[]; drawn: number };

export const UNDO_LIMIT = 30;

const mid = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

// Apple Pencil pressure swings the width around the chosen size; fingers and mice draw at the chosen size.
export function pressureWidth(e: PointerEvent, size: number): number {
  if (e.pointerType !== 'pen') return size;
  const pressure = e.pressure > 0 ? e.pressure : 0.5;
  return size * (0.4 + 1.2 * pressure);
}

// Quadratic midpoint smoothing: each segment runs midpoint to midpoint with the sample as control point.
function paintSegments(ctx: CanvasRenderingContext2D, s: Stroke, final: boolean) {
  const p = s.points;
  ctx.globalCompositeOperation = s.tool.mode === 'eraser' ? 'destination-out' : 'source-over';
  ctx.strokeStyle = s.tool.color;
  ctx.fillStyle = s.tool.color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (final && p.length === 1) {
    ctx.beginPath();
    ctx.arc(p[0]!.x, p[0]!.y, p[0]!.w / 2, 0, Math.PI * 2);
    ctx.fill();
    s.drawn = 1;
    return;
  }

  const ready = final ? p.length : p.length - 1;
  for (let k = s.drawn; k < ready; k++) {
    const from = k === 0 ? p[0]! : mid(p[k - 1]!, p[k]!);
    const to = k === p.length - 1 ? p[k]! : mid(p[k]!, p[k + 1]!);
    ctx.lineWidth = p[k]!.w;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.quadraticCurveTo(p[k]!.x, p[k]!.y, to.x, to.y);
    ctx.stroke();
  }
  s.drawn = Math.max(s.drawn, ready);
}

function context(canvas: HTMLCanvasElement, scale: number) {
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  return ctx;
}

/**
 * The pen layer in picture coordinates. `base` holds the resumed image plus strokes older than the undo
 * window, `recent` holds the undoable strokes, and the visible canvas is always base plus a replay of recent.
 */
export class PenLayer {
  strokeCount = 0;
  private readonly base: HTMLCanvasElement;
  private readonly baseCtx: CanvasRenderingContext2D;
  private readonly ctx: CanvasRenderingContext2D;
  private recent: Stroke[] = [];
  private current: Stroke | null = null;

  constructor(
    readonly canvas: HTMLCanvasElement,
    readonly width: number,
    readonly height: number,
    private readonly scale: number,
  ) {
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    this.ctx = context(canvas, scale);
    this.base = document.createElement('canvas');
    this.base.width = canvas.width;
    this.base.height = canvas.height;
    this.baseCtx = context(this.base, scale);
  }

  get canUndo() {
    return this.recent.length > 0;
  }

  loadBase(image: CanvasImageSource) {
    this.baseCtx.globalCompositeOperation = 'source-over';
    this.baseCtx.drawImage(image, 0, 0, this.width, this.height);
    this.redraw();
  }

  begin(tool: Tool, first: Point) {
    this.current = { tool, points: [first], drawn: 0 };
    paintSegments(this.ctx, this.current, false);
  }

  extend(point: Point) {
    if (!this.current) return;
    this.current.points.push(point);
    paintSegments(this.ctx, this.current, false);
  }

  end() {
    const stroke = this.current;
    if (!stroke) return;
    this.current = null;
    paintSegments(this.ctx, stroke, true);
    this.recent.push(stroke);
    this.strokeCount++;
    while (this.recent.length > UNDO_LIMIT) {
      paintSegments(this.baseCtx, { ...this.recent.shift()!, drawn: 0 }, true);
    }
  }

  /** Drops the stroke in progress without keeping it, as when a second finger turns a touch into a pinch. */
  cancel() {
    if (!this.current) return;
    this.current = null;
    this.redraw();
  }

  undo() {
    if (!this.recent.pop()) return;
    this.redraw();
  }

  toPictureCanvas(): HTMLCanvasElement {
    const out = document.createElement('canvas');
    out.width = this.width;
    out.height = this.height;
    out.getContext('2d')!.drawImage(this.canvas, 0, 0, this.width, this.height);
    return out;
  }

  private redraw() {
    const { ctx, canvas } = this;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(this.base, 0, 0);
    ctx.restore();
    for (const stroke of this.recent) paintSegments(ctx, { ...stroke, drawn: 0 }, true);
  }
}
