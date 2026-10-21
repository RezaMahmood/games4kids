import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { PointerEvent as PreactPointerEvent } from 'preact/compat';
import type { Score } from '../../../../data/types';
import { api, drawingImage, pictureFile, whileLoading } from '../api';
import type { CanvasScreenProps } from '../contracts';
import { createAutosave } from '../canvas/autosave';
import { FinishResult } from '../canvas/FinishResult';
import { loadImage, pixelsOf, pngBytes } from '../canvas/images';
import { DEFAULT_PEN_COLOUR, DEFAULT_PEN_SIZE, ERASER_FACTOR, PEN_SIZES, PenRail, penHex, type PenColour } from '../canvas/PenRail';
import { PenLayer, pressureWidth, type Point, type Tool } from '../canvas/pen';
import { useElementSize } from '../canvas/useElementSize';
import { clampView, fitScale, fitView, pinchView, zoomAbout, type Frame, type Pt, type View } from '../canvas/view';
import { alphaOf, scoreTrace, TRACE_POINTS, usedColours } from '../scoring';
import { ColourWheel } from '../components/ColourWheel';
import { Dialog } from '../components/Dialog';
import '../canvas/canvas.css';

const SAVE_DELAY_MS = 800;
const FIRST_OWN_COLOUR = '#3DA5D9';
const ZOOM_STEP = 1.5;

const ICON = { width: 26, height: 26, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2.2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': true } as const;
const EyeIcon = () => <svg {...ICON}><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>;
const CheckIcon = () => <svg {...ICON}><path d="M5 12l5 5 9-10" /></svg>;
const FitIcon = () => <svg {...ICON}><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg>;

/**
 * Who the pointers on the page belong to. One finger, a mouse or a pencil draws. Two fingers move and zoom the page,
 * and a second finger landing mid-stroke drops that stroke, so zooming never leaves a mark. Once a pencil has been
 * used, fingers only ever move and zoom.
 */
type Gesture = { kind: 'idle' } | { kind: 'drawing'; pointer: number } | { kind: 'pinching'; start: View; from: [Pt, Pt] } | { kind: 'panning'; start: View; from: Pt };

export function Freestyle({ picture, drawing, onLeave, startFinish }: CanvasScreenProps) {
  const { width: W, height: H } = picture;
  const reopened = drawing.status === 'finished';
  const [areaRef, area] = useElementSize<HTMLDivElement>();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const penRef = useRef<PenLayer | null>(null);
  const penSeen = useRef(false);
  const touches = useRef(new Map<number, Pt>());
  const gesture = useRef<Gesture>({ kind: 'idle' });
  const [view, setView] = useState<View | null>(null);
  const fitted = useRef(true);

  const [colour, setColour] = useState<PenColour>(DEFAULT_PEN_COLOUR);
  const [mine, setMine] = useState(FIRST_OWN_COLOUR);
  const [picking, setPicking] = useState(false);
  const draft = useRef(mine);
  /** The photo the outline was traced from, to look at for colours. Starter pictures have none. */
  const [photo, setPhoto] = useState<HTMLImageElement | null>(null);
  const [photoOpen, setPhotoOpen] = useState(false);
  const [sizeIndex, setSizeIndex] = useState(DEFAULT_PEN_SIZE);
  const [erasing, setErasing] = useState(false);
  const [trace, setTrace] = useState(true);
  const [canUndo, setCanUndo] = useState(false);
  const [outline, setOutline] = useState<HTMLImageElement | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [notice, setNotice] = useState('');
  const [result, setResult] = useState<Score | null>(null);

  const autosave = useMemo(
    () => createAutosave(() => api.saveDrawing(drawing.id, { image: pngBytes(penRef.current!.toPictureCanvas()) }), SAVE_DELAY_MS),
    [drawing.id],
  );

  useEffect(() => {
    const pen = new PenLayer(canvasRef.current!, W, H, Math.min(2, Math.max(1, window.devicePixelRatio || 1)));
    penRef.current = pen;
    let live = true;
    whileLoading(Promise.all([loadImage(drawingImage(drawing.id), true), loadImage(pictureFile(picture.id, 'outline.png'))])).then(([base, line]) => {
      if (!live) return;
      if (base) pen.loadBase(base);
      setOutline(line);
      setLoaded(true);
    });
    loadImage(pictureFile(picture.id, 'original.jpg')).then((original) => live && setPhoto(original));

    const flushNow = () => void autosave.flush();
    const onHidden = () => document.visibilityState === 'hidden' && flushNow();
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('pagehide', flushNow);
    return () => {
      live = false;
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('pagehide', flushNow);
      flushNow();
    };
  }, [autosave, drawing.id, picture.id, W, H]);

  const tool = (): Tool => {
    const size = PEN_SIZES[sizeIndex]!.size;
    return erasing
      ? { mode: 'eraser', color: '#000', size: size * ERASER_FACTOR }
      : { mode: 'pen', color: hex, size };
  };

  const pointOf = (e: PointerEvent, size: number): Point => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: ((e.clientX - rect.left) * W) / rect.width, y: ((e.clientY - rect.top) * H) / rect.height, w: pressureWidth(e, size) };
  };

  const frame = (): Frame => ({ vw: area.w, vh: area.h, pw: W, ph: H });

  useEffect(() => {
    if (!area.w || !area.h) return;
    setView((v) => (!v || fitted.current ? fitView(frame()) : clampView(v, frame())));
  }, [area.w, area.h]);

  const showView = (next: View) => {
    fitted.current = Math.abs(next.scale - fitScale(frame())) < 1e-6;
    setView(next);
  };

  const local = (e: PointerEvent): Pt => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const startPinch = () => {
    const [a, b] = [...touches.current.values()];
    if (view && a && b) gesture.current = { kind: 'pinching', start: view, from: [a, b] };
  };

  const onDown = (e: PreactPointerEvent<HTMLDivElement>) => {
    // The zoom buttons sit on the page; pressing one must neither draw nor be captured away from its click.
    if ((e.target as Element).closest('button')) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (e.pointerType === 'pen') penSeen.current = true;
    if (e.pointerType === 'touch') {
      touches.current.set(e.pointerId, local(e));
      const now = gesture.current;
      if (touches.current.size === 2) {
        if (now.kind === 'drawing') penRef.current!.cancel();
        return startPinch();
      }
      if (penSeen.current) {
        if (view) gesture.current = { kind: 'panning', start: view, from: local(e) };
        return;
      }
    }
    if (gesture.current.kind !== 'idle') return;
    gesture.current = { kind: 'drawing', pointer: e.pointerId };
    const t = tool();
    penRef.current!.begin(t, pointOf(e, t.size));
  };

  const onMove = (e: PreactPointerEvent<HTMLDivElement>) => {
    const now = gesture.current;
    if (e.pointerType === 'touch' && touches.current.has(e.pointerId)) touches.current.set(e.pointerId, local(e));
    if (now.kind === 'pinching') {
      const [a, b] = [...touches.current.values()];
      if (a && b) showView(pinchView(now.start, now.from, [a, b], frame()));
    } else if (now.kind === 'panning') {
      const at = local(e);
      showView(clampView({ ...now.start, x: now.start.x + at.x - now.from.x, y: now.start.y + at.y - now.from.y }, frame()));
    } else if (now.kind === 'drawing' && now.pointer === e.pointerId) {
      const size = tool().size;
      const samples = e.getCoalescedEvents?.() ?? [];
      for (const sample of samples.length ? samples : [e]) penRef.current!.extend(pointOf(sample, size));
    }
  };

  const onUp = (e: PreactPointerEvent<HTMLDivElement>) => {
    touches.current.delete(e.pointerId);
    const now = gesture.current;
    if (now.kind === 'drawing' && now.pointer === e.pointerId) {
      gesture.current = { kind: 'idle' };
      penRef.current!.end();
      setCanUndo(true);
      autosave.schedule();
    } else if ((now.kind === 'pinching' || now.kind === 'panning') && touches.current.size === 0) {
      gesture.current = { kind: 'idle' };
    }
  };

  const zoom = (factor: number) => view && showView(zoomAbout(view, factor, { x: area.w / 2, y: area.h / 2 }, frame()));

  const undo = () => {
    const pen = penRef.current!;
    pen.undo();
    setCanUndo(pen.canUndo);
    autosave.schedule();
  };

  const finish = useCallback(async () => {
    const pen = penRef.current!;
    setFinishing(true);
    setNotice('');
    try {
      const picturePixels = pen.toPictureCanvas();
      const ink = pixelsOf(picturePixels, W, H).data;
      const outlinePixels = outline ? pixelsOf(outline, W, H).data : new Uint8ClampedArray(W * H * 4);
      const score = scoreTrace({
        outlineAlpha: alphaOf(outlinePixels),
        penAlpha: alphaOf(ink),
        penColors: usedColours(ink),
        width: W,
        height: H,
        strokeCount: pen.strokeCount,
      });
      autosave.cancel();
      await api.saveDrawing(drawing.id, { image: pngBytes(picturePixels), status: 'finished', score });
      setResult(score);
    } catch {
      setNotice('That did not save. Try Finish again.');
    }
    setFinishing(false);
  }, [autosave, drawing.id, outline, W, H]);

  useEffect(() => {
    if (startFinish && loaded) void finish();
  }, [loaded]);

  const hex = penHex(colour, mine);

  return (
    <div class="cv-root pbn-root fs-root">
      <PenRail
        colour={colour}
        mine={mine}
        sizeIndex={sizeIndex}
        erasing={erasing}
        canUndo={canUndo}
        onColour={(i) => { setColour(i); setErasing(false); }}
        onPickMine={() => { draft.current = mine; setPicking(true); }}
        onSize={setSizeIndex}
        onEraser={() => setErasing(!erasing)}
        onUndo={undo}
      />

      <section
        class="pbn-view fs-view"
        ref={areaRef}
        aria-label={`${picture.title}, drawing`}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        <div
          class="fs-stage cv-sheet-surface"
          style={{ width: W, height: H, transform: view ? `translate(${view.x}px, ${view.y}px) scale(${view.scale})` : 'scale(0)' }}
        >
          {trace && outline && <img src={outline.src} alt="" draggable={false} />}
          <canvas ref={canvasRef} role="img" aria-label={`Your drawing of ${picture.title}`} />
        </div>
        <span class="pbn-hint">Two fingers to zoom and move</span>
        <div class="pbn-zoom">
          <button type="button" class="cv-btn" aria-label="Fit the whole picture" onClick={() => showView(fitView(frame()))}><FitIcon /></button>
          <button type="button" class="cv-btn" aria-label="Zoom out" onClick={() => zoom(1 / ZOOM_STEP)}>−</button>
          <button type="button" class="cv-btn" aria-label="Zoom in" onClick={() => zoom(ZOOM_STEP)}>+</button>
        </div>
      </section>

      <aside class="pbn-side" aria-label="Picture and finish">
        {photo && (
          <button type="button" class="fs-photo" aria-label="Look at the photo" onClick={() => setPhotoOpen(true)}>
            <img src={photo.src} alt="" draggable={false} />
          </button>
        )}
        <button type="button" class="plain" aria-pressed={trace} onClick={() => setTrace(!trace)}>
          <EyeIcon />{trace ? 'Hide the outline' : 'Show the outline'}
        </button>
        <div class="grow-space" />
        <button type="button" class="cv-btn cv-finish" disabled={finishing} onClick={reopened ? onLeave : finish}>
          <CheckIcon />{finishing ? 'Saving' : reopened ? 'Done' : 'Finish'}
        </button>
      </aside>

      {notice && <div class="cv-toast cv-bad" role="status">{notice}</div>}

      {picking && (
        <Dialog
          title="Pick your own colour"
          onClose={() => setPicking(false)}
          actions={
            <>
              <button type="button" class="plain" onClick={() => setPicking(false)}>Cancel</button>
              <button type="button" class="primary" onClick={() => { setMine(draft.current); setColour('mine'); setErasing(false); setPicking(false); }}>Draw with it</button>
            </>
          }
        >
          <ColourWheel initial={mine} onChange={(picked) => { draft.current = picked; }} />
        </Dialog>
      )}

      {photo && photoOpen && (
        <Dialog title="The photo" onClose={() => setPhotoOpen(false)} actions={<button type="button" class="primary" onClick={() => setPhotoOpen(false)}>Back to drawing</button>}>
          <img class="fs-photo-big" src={photo.src} alt={`The photo of ${picture.title}`} draggable={false} />
        </Dialog>
      )}

      {result && (
        <FinishResult
          score={result}
          rows={[
            { label: 'Tracing', value: result.breakdown.tracing ?? 0, max: TRACE_POINTS.tracing },
            { label: 'Colour', value: result.breakdown.colour ?? 0, max: TRACE_POINTS.colour },
            { label: 'Coverage', value: result.breakdown.coverage ?? 0, max: TRACE_POINTS.coverage },
            { label: 'Effort', value: result.breakdown.effort ?? 0, max: TRACE_POINTS.effort },
          ]}
          onAgain={onLeave}
        />
      )}
    </div>
  );
}
