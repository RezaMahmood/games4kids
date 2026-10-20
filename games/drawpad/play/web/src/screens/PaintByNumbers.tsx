import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { PointerEvent as PreactPointerEvent } from 'preact/compat';
import type { PbnData, Score } from '../../../../data/types';
import { api, drawingImage, pictureFile } from '../api';
import { BlobImage } from '../blobs/BlobImage';
import type { CanvasScreenProps } from '../contracts';
import { createAutosave } from '../canvas/autosave';
import { Fills, type Brush } from '../canvas/fills';
import { FinishResult } from '../canvas/FinishResult';
import { fetchJson, fetchPixels, loadImage, pngBytes } from '../canvas/images';
import { hexToRgb } from '../canvas/palette';
import { PenLayer, pressureWidth, type Point, type Tool } from '../canvas/pen';
import { DEFAULT_PEN_COLOUR, DEFAULT_PEN_SIZE, ERASER_FACTOR, PEN_SIZES, PenRail, penHex, UndoIcon, type PenColour } from '../canvas/PenRail';
import { decodeRegionIds, regionNear, type RegionMap } from '../canvas/regionMap';
import { Sheet } from '../canvas/sheet';
import { useElementSize } from '../canvas/useElementSize';
import { clampView, fitScale, fitView, pinchView, toPicture, zoomAbout, type Frame, type Pt, type View } from '../canvas/view';
import { PBN_POINTS, scorePbn } from '../scoring';
import { ColourWheel } from '../components/ColourWheel';
import { Dialog } from '../components/Dialog';
import '../canvas/canvas.css';

const SAVE_DELAY_MS = 600;
const TAP_SLOP_PX = 10;
const TAP_MAX_MS = 600;
const HIT_REACH_PX = 8;
const ZOOM_STEP = 1.5;
const NOTICE_MS = 1800;
const BURST_MS = 650;
const FIRST_OWN_COLOUR = '#3DA5D9';

type Loaded = { data: PbnData; map: RegionMap; fills: Fills; sheet: Sheet };
type Selection = number | 'mine';
type Notice = { text: string; tone: 'good' | 'bad' };
type Burst = { key: number; x: number; y: number; color: string };

const CheckIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10" /></svg>
);

const PencilIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20l4-1 11-11-3-3L5 16z" /></svg>
);

function readableOn(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#1F2430' : '#FFFFFF';
}

export function PaintByNumbers(props: CanvasScreenProps) {
  const { picture, drawing, onLeave } = props;
  const [loaded, setLoaded] = useState<Loaded | 'loading' | 'error'>('loading');

  useEffect(() => {
    let live = true;
    Promise.all([
      fetchJson<PbnData>(pictureFile(picture.id, 'pbn.json')),
      fetchPixels(pictureFile(picture.id, 'pbn-regions.png')),
    ]).then(
      ([data, pixels]) => {
        if (!live) return;
        const map = { width: pixels.width, height: pixels.height, ids: decodeRegionIds(pixels.data) };
        const fills = new Fills(data, drawing);
        setLoaded({ data, map, fills, sheet: new Sheet(data, map, fills) });
      },
      () => live && setLoaded('error'),
    );
    return () => { live = false; };
  }, [picture.id, drawing.id]);

  if (typeof loaded === 'string') {
    return (
      <div class="cv-root">
        <div class="pbn-status">
          <h2>{loaded === 'loading' ? 'Getting your picture ready' : 'This picture would not open'}</h2>
          {loaded === 'error' && <button type="button" class="primary" onClick={onLeave}>Go back</button>}
        </div>
      </div>
    );
  }
  return <Board {...props} {...loaded} />;
}

function Board({ picture, drawing, onLeave, startFinish, data, map, fills, sheet }: CanvasScreenProps & Loaded) {
  const [viewportRef, size] = useElementSize<HTMLDivElement>();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const view = useRef<View | null>(null);
  const raf = useRef(0);
  const lastFit = useRef(0);
  const pointers = useRef(new Map<number, Pt>());
  const tap = useRef<{ at: Pt; time: number } | null>(null);
  const pinch = useRef<{ start: View; from: [Pt, Pt] } | null>(null);
  const penBox = useRef<HTMLDivElement>(null);
  const penCanvas = useRef<HTMLCanvasElement>(null);
  const penRef = useRef<PenLayer | null>(null);
  const penSeen = useRef(false);
  const penDirty = useRef(false);
  const stroke = useRef<number | null>(null);
  const timers = useRef<{ notice?: ReturnType<typeof setTimeout> }>({});

  const colours = useMemo(() => [...new Set(data.regions.map((r) => r.colorIndex))].sort((a, b) => a - b), [data]);
  const remainingOf = (colour: number) => fills.remaining(colour);
  const [selected, setSelected] = useState<Selection>(() => colours.find((c) => remainingOf(c) > 0) ?? colours[0] ?? 0);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [mine, setMine] = useState(FIRST_OWN_COLOUR);
  const [picking, setPicking] = useState(false);
  const draft = useRef(mine);

  /** Free draw mode swaps the numbers for the pen, and puts them back when it ends. */
  const [drawMode, setDrawMode] = useState(false);
  const [penColour, setPenColour] = useState<PenColour>(DEFAULT_PEN_COLOUR);
  const [sizeIndex, setSizeIndex] = useState(DEFAULT_PEN_SIZE);
  const [erasing, setErasing] = useState(false);
  const [canUndoPen, setCanUndoPen] = useState(false);

  const [, setRevision] = useState(0);
  /** Whether the finished picture the AI drew covers the board, to compare against. */
  const [showingPicture, setShowingPicture] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [bursts, setBursts] = useState<Burst[]>([]);
  const [finishing, setFinishing] = useState(false);
  const [result, setResult] = useState<Score | null>(null);

  /** The fills, plus the pen layer once the player has drawn on it. */
  const savePatch = () => ({
    ...fills.toPatch(),
    ...(penDirty.current && { image: pngBytes(penRef.current!.toPictureCanvas()) }),
  });

  const autosave = useMemo(
    () => createAutosave(() => api.saveDrawing(drawing.id, savePatch()), SAVE_DELAY_MS),
    [drawing.id, fills],
  );

  const frame = (): Frame => ({ vw: size.w, vh: size.h, pw: map.width, ph: map.height });
  const dpr = Math.min(2, window.devicePixelRatio || 1);

  const redraw = () => {
    if (raf.current || !view.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      const canvas = canvasRef.current;
      if (!canvas || !view.current) return;
      const numbered = selectedRef.current === 'mine' ? -1 : selectedRef.current;
      sheet.draw(canvas.getContext('2d')!, view.current, { w: size.w, h: size.h }, dpr, numbered);
      const { x, y, scale } = view.current;
      if (penBox.current) penBox.current.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    });
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !size.w || !size.h) return;
    const f = frame();
    const wasFitted = !view.current || Math.abs(view.current.scale - lastFit.current) < 1e-6;
    view.current = wasFitted ? fitView(f) : clampView(view.current!, f);
    lastFit.current = fitScale(f);
    canvas.width = Math.round(size.w * dpr);
    canvas.height = Math.round(size.h * dpr);
    redraw();
  }, [size.w, size.h]);

  useEffect(redraw, [selected]);

  useEffect(() => {
    const pen = new PenLayer(penCanvas.current!, map.width, map.height, Math.min(2, Math.max(1, window.devicePixelRatio || 1)));
    penRef.current = pen;
    let live = true;
    loadImage(drawingImage(drawing.id), true).then((base) => live && base && pen.loadBase(base));
    return () => { live = false; };
  }, [drawing.id, map]);

  useEffect(() => {
    const flushNow = () => void autosave.flush();
    const onHidden = () => document.visibilityState === 'hidden' && flushNow();
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('pagehide', flushNow);
    return () => {
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('pagehide', flushNow);
      cancelAnimationFrame(raf.current);
      clearTimeout(timers.current.notice);
      flushNow();
    };
  }, [autosave]);

  const say = (text: string, tone: Notice['tone']) => {
    setNotice({ text, tone });
    clearTimeout(timers.current.notice);
    timers.current.notice = setTimeout(() => setNotice(null), NOTICE_MS);
  };

  const sparkle = (at: Pt, color: string) => {
    const key = performance.now();
    setBursts((list) => [...list, { key, x: at.x, y: at.y, color }]);
    setTimeout(() => setBursts((list) => list.filter((b) => b.key !== key)), BURST_MS);
  };

  const nextColour = () => colours.find((c) => c !== selected && remainingOf(c) > 0);

  const toolNow = (): Tool => {
    const size = PEN_SIZES[sizeIndex]!.size;
    return erasing
      ? { mode: 'eraser', color: '#000', size: size * ERASER_FACTOR }
      : { mode: 'pen', color: penHex(penColour, mine), size };
  };

  const pointOf = (e: PointerEvent, size: number): Point => {
    const at = local(e);
    const p = toPicture(view.current!, at.x, at.y);
    return { x: p.x, y: p.y, w: pressureWidth(e, size) };
  };

  const startStroke = (e: PreactPointerEvent<HTMLCanvasElement>) => {
    const t = toolNow();
    stroke.current = e.pointerId;
    penRef.current!.begin(t, pointOf(e, t.size));
  };

  const tapAt = (at: Pt) => {
    const v = view.current!;
    const p = toPicture(v, at.x, at.y);
    const id = regionNear(map, p.x, p.y, Math.min(6, Math.ceil(HIT_REACH_PX / v.scale)));
    const brush: Brush = selected === 'mine' ? { hex: mine } : { index: selected };
    const stroke = fills.apply(id, brush);
    if (stroke === 'ignored') return;
    const colour = fills.numberOf(id)!;
    sheet.repaint([id]);
    autosave.schedule();
    sparkle(at, fills.hexOf(id) ?? '#F2B33D');
    if (stroke === 'painted' && fills.filled.size === data.regions.length) say('Every area is painted!', 'good');
    else if (selected === colour && remainingOf(colour) === 0) {
      const next = nextColour();
      say(`Number ${colour + 1} is finished!`, 'good');
      if (next !== undefined) setSelected(next);
    }
    setRevision((n) => n + 1);
    redraw();
  };

  const local = (e: PointerEvent): Pt => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onDown = (e: PreactPointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    canvasRef.current!.setPointerCapture(e.pointerId);
    if (drawMode && e.pointerType === 'pen') {
      penSeen.current = true;
      if (stroke.current === null) startStroke(e);
      return;
    }
    const at = local(e);
    pointers.current.set(e.pointerId, at);
    if (pointers.current.size === 1) {
      if (!drawMode) tap.current = { at, time: e.timeStamp };
      else if (!(e.pointerType === 'touch' && penSeen.current)) startStroke(e);
    } else {
      tap.current = null;
      if (stroke.current !== null) {
        penRef.current!.cancel();
        stroke.current = null;
      }
      const [a, b] = [...pointers.current.values()];
      pinch.current = a && b ? { start: view.current!, from: [a, b] } : null;
    }
  };

  const onMove = (e: PreactPointerEvent<HTMLCanvasElement>) => {
    if (stroke.current === e.pointerId) {
      const size = toolNow().size;
      const samples = e.getCoalescedEvents?.() ?? [];
      for (const sample of samples.length ? samples : [e]) penRef.current!.extend(pointOf(sample, size));
      return;
    }
    if (!pointers.current.has(e.pointerId)) return;
    const at = local(e);
    pointers.current.set(e.pointerId, at);
    if (tap.current && Math.hypot(at.x - tap.current.at.x, at.y - tap.current.at.y) > TAP_SLOP_PX) tap.current = null;
    const [a, b] = [...pointers.current.values()];
    if (pinch.current && a && b) {
      view.current = pinchView(pinch.current.start, pinch.current.from, [a, b], frame());
      redraw();
    }
  };

  const onUp = (e: PreactPointerEvent<HTMLCanvasElement>) => {
    if (stroke.current === e.pointerId) {
      stroke.current = null;
      pointers.current.delete(e.pointerId);
      penRef.current!.end();
      penDirty.current = true;
      setCanUndoPen(true);
      autosave.schedule();
      return;
    }
    if (!pointers.current.delete(e.pointerId)) return;
    pinch.current = null;
    const candidate = tap.current;
    tap.current = null;
    if (candidate && e.type === 'pointerup' && e.timeStamp - candidate.time < TAP_MAX_MS) tapAt(candidate.at);
  };

  const undoColour = () => {
    const id = fills.undo();
    if (id === undefined) return;
    sheet.repaint([id]);
    autosave.schedule();
    setRevision((n) => n + 1);
    redraw();
  };

  const undoPen = () => {
    const pen = penRef.current!;
    pen.undo();
    penDirty.current = true;
    setCanUndoPen(pen.canUndo);
    autosave.schedule();
  };

  const zoom = (factor: number) => {
    view.current = zoomAbout(view.current!, factor, { x: size.w / 2, y: size.h / 2 }, frame());
    redraw();
  };

  const finish = async () => {
    setFinishing(true);
    try {
      const score = scorePbn({
        regionsTotal: data.regions.length,
        regionsFilled: fills.filled.size,
        regionsMatched: fills.matched,
      });
      autosave.cancel();
      await api.saveDrawing(drawing.id, { ...savePatch(), status: 'finished', score });
      setResult(score);
    } catch {
      say('That did not save. Try Finish again.', 'bad');
    }
    setFinishing(false);
  };

  const reopened = drawing.status === 'finished';
  const total = data.regions.length;
  const original = pictureFile(picture.id, 'original.jpg');
  const filled = fills.filled.size;

  useEffect(() => {
    if (startFinish && filled > 0) void finish();
  }, []);

  return (
    <div class="cv-root pbn-root">
      {drawMode ? (
        <PenRail
          colour={penColour}
          mine={mine}
          sizeIndex={sizeIndex}
          erasing={erasing}
          canUndo={canUndoPen}
          onColour={(i) => { setPenColour(i); setErasing(false); }}
          onPickMine={() => { draft.current = mine; setPicking(true); }}
          onSize={setSizeIndex}
          onEraser={() => setErasing(!erasing)}
          onUndo={undoPen}
        />
      ) : (
        <aside class="pbn-rail" aria-label="Colours in this picture">
          {colours.map((c) => {
            const done = remainingOf(c) === 0;
            const hex = data.palette[c] ?? '#ccc';
            return (
              <button
                type="button"
                class={`pbn-chip${done ? ' done' : ''}`}
                style={{ background: hex, color: readableOn(hex) }}
                aria-label={`Colour ${c + 1}${done ? ', finished' : ''}`}
                aria-pressed={c === selected}
                onClick={() => setSelected(c)}
              >
                {c + 1}
                {done && <span class="tick"><CheckIcon /></span>}
              </button>
            );
          })}
          <hr />
          <button
            type="button"
            class="pbn-chip"
            style={{ background: mine }}
            aria-label={`My colour, ${mine}. Opens the colour wheel`}
            aria-pressed={selected === 'mine'}
            onClick={() => { draft.current = mine; setPicking(true); }}
          >
            <span class="wheel" />
          </button>
        </aside>
      )}

      <section class="pbn-view" ref={viewportRef} aria-label={`${picture.title}, paint by numbers`}>
        <canvas
          ref={canvasRef}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        />
        <div class="pbn-pen" ref={penBox} style={{ width: map.width, height: map.height }}>
          <canvas ref={penCanvas} role="img" aria-label={`Your drawing on ${picture.title}`} />
        </div>
        {bursts.map((b) => (
          <span class="pbn-burst" style={{ left: b.x, top: b.y }}>
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <i style={{ '--c': i % 2 ? b.color : '#F2B33D', '--dx': `${Math.cos(i * 1.05) * 34}px`, '--dy': `${Math.sin(i * 1.05) * 34}px` }} />
            ))}
          </span>
        ))}
        <span class="pbn-hint">Pinch to zoom · drag with two fingers to move</span>
        {showingPicture && (
          <button type="button" class="pbn-cover" aria-label="Hide the finished picture" onClick={() => setShowingPicture(false)}>
            <BlobImage path={original} />
          </button>
        )}
        <div class="pbn-zoom">
          <button type="button" class="cv-btn" aria-label="Zoom out" onClick={() => zoom(1 / ZOOM_STEP)}>−</button>
          <button type="button" class="cv-btn" aria-label="Zoom in" onClick={() => zoom(ZOOM_STEP)}>+</button>
        </div>
      </section>

      <aside class="pbn-side" aria-label="The finished picture">
        <div>
          <div class="pbn-bar" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={filled}>
            <div style={{ width: `${total ? (100 * filled) / total : 0}%` }} />
          </div>
          <p class="pbn-progress">{filled} of {total} areas painted</p>
        </div>
        <button type="button" class="pbn-original" aria-pressed={showingPicture} aria-label="Show the finished picture on the board" onClick={() => setShowingPicture((on) => !on)}>
          <BlobImage path={original} />
        </button>
        <button type="button" class="plain" aria-pressed={showingPicture} onClick={() => setShowingPicture((on) => !on)}>
          {showingPicture ? 'Back to my painting' : 'Show the picture'}
        </button>
        <button type="button" class="plain" aria-pressed={drawMode} onClick={() => setDrawMode((on) => !on)}>
          <PencilIcon />{drawMode ? 'Back to the numbers' : 'Draw freely'}
        </button>
        {!drawMode && (
          <button type="button" class="plain" disabled={!fills.canUndo} onClick={undoColour}>
            <UndoIcon />Undo
          </button>
        )}
        <div class="grow-space" />
        <button type="button" class="cv-btn cv-finish" disabled={!reopened && (filled === 0 || finishing)} onClick={reopened ? onLeave : finish}>
          <CheckIcon size={24} />{finishing ? 'Saving' : reopened ? 'Done' : 'Finish'}
        </button>
      </aside>

      {picking && (
        <Dialog
          title="Pick your own colour"
          onClose={() => setPicking(false)}
          actions={
            <>
              <button type="button" class="plain" onClick={() => setPicking(false)}>Cancel</button>
              <button
                type="button"
                class="primary"
                onClick={() => {
                  setMine(draft.current);
                  if (drawMode) { setPenColour('mine'); setErasing(false); } else setSelected('mine');
                  setPicking(false);
                }}
              >
                {drawMode ? 'Draw with it' : 'Paint with it'}
              </button>
            </>
          }
        >
          {!drawMode && <p>Tap any area to paint it this colour, even one you have painted already.</p>}
          <ColourWheel initial={mine} onChange={(hex) => { draft.current = hex; }} />
        </Dialog>
      )}

      {notice && <div class={`cv-toast cv-${notice.tone}`} role="status">{notice.text}</div>}

      {result && (
        <FinishResult
          score={result}
          rows={[
            { label: 'Completeness', value: result.breakdown.completeness ?? 0, max: PBN_POINTS.completeness },
            { label: 'Right colours', value: result.breakdown.matching ?? 0, max: PBN_POINTS.matching },
          ]}
          onAgain={onLeave}
        />
      )}
    </div>
  );
}
