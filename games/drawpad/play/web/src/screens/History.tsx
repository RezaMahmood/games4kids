import { useEffect, useState } from 'preact/hooks';
import type { DrawingMeta, Picture, PictureKind } from '../../../../data/types';
import { api, drawingImage, pictureFile } from '../api';
import { BlobImage } from '../blobs/BlobImage';
import { savesSettled } from '../canvas/autosave';
import { Dialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { Segmented } from '../components/Segmented';
import { friendlyDate, kindLabel, thumbnailFile, visibleDrawings, type Filter } from './historyModel';
import { PaintedThumb } from './PaintedThumb';

type Props = {
  timeUp: boolean;
  busy: boolean;
  onEdit: (picture: Picture, drawing: DrawingMeta, finish: boolean) => void;
  onAgain: (picture: Picture, kind: PictureKind) => void;
};

type Loaded = { drawings: DrawingMeta[]; pictures: Map<string, Picture> };
type Data = { kind: 'loading' } | { kind: 'failed' } | ({ kind: 'ready' } & Loaded);

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'open', label: 'In progress' },
  { value: 'done', label: 'Finished' },
] as const;

function Stars({ count }: { count: number }) {
  return (
    <span class="stars" role="img" aria-label={`${count} of 5 stars`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <svg key={n} width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" class={n <= count ? 'on' : ''}>
          <path d="M12 3l2.7 5.6 6.1.8-4.5 4.3 1.1 6.1L12 16.8 6.6 19.8l1.1-6.1L3.2 9.4l6.1-.8z" stroke-width="1.6" stroke-linejoin="round" />
        </svg>
      ))}
    </span>
  );
}

function Thumb({ drawing, picture }: { drawing: DrawingMeta; picture: Picture | undefined }) {
  if (!picture) return <div class="thumb" aria-hidden="true" />;
  if (drawing.kind === 'pbn') {
    return (
      <div class="thumb">
        <div class="thumb-art" style={{ aspectRatio: `${picture.width} / ${picture.height}` }}>
          <PaintedThumb drawing={drawing} picture={picture} />
        </div>
      </div>
    );
  }
  return (
    <div class="thumb">
      <div class="thumb-art" style={{ aspectRatio: `${picture.width} / ${picture.height}` }}>
        <BlobImage class={drawing.status === 'in-progress' ? 'faint' : ''} path={pictureFile(picture.id, thumbnailFile(drawing.kind))} />
        <BlobImage path={drawingImage(drawing.id)} revalidate />
      </div>
    </div>
  );
}

export function History({ timeUp, busy, onEdit, onAgain }: Props) {
  const [data, setData] = useState<Data>({ kind: 'loading' });
  const [filter, setFilter] = useState<Filter>('all');
  const [confirming, setConfirming] = useState<DrawingMeta | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setData({ kind: 'loading' });
    savesSettled().then(() => Promise.all([api.drawings(), api.pictures()])).then(
      ([drawings, pictures]) => live && setData({ kind: 'ready', drawings, pictures: new Map(pictures.map((p) => [p.id, p])) }),
      () => live && setData({ kind: 'failed' }),
    );
    return () => { live = false; };
  }, [attempt]);

  const change = (fn: (drawings: DrawingMeta[]) => DrawingMeta[]) =>
    setData((d) => (d.kind === 'ready' ? { ...d, drawings: fn(d.drawings) } : d));

  const attemptChange = async (work: () => Promise<void>, failure: string) => {
    setProblem(null);
    try {
      await work();
    } catch {
      setProblem(failure);
    }
  };

  const remove = (d: DrawingMeta) => {
    setConfirming(null);
    return attemptChange(async () => {
      await api.deleteDrawing(d.id);
      change((all) => all.filter((x) => x.id !== d.id));
    }, 'Couldn’t delete that drawing. Try again.');
  };

  const shown = data.kind === 'ready' ? visibleDrawings(data.drawings, filter) : [];
  const now = new Date();

  return (
    <main class="page history">
      <div class="page-head">
        <h1>My drawings</h1>
        <Segmented label="Filter" value={filter} options={FILTERS} onChange={setFilter} />
      </div>
      {problem && <div class="alert" role="alert"><Icon name="warning" size={24} /><span>{problem}</span></div>}
      {data.kind === 'loading' && <p class="empty" role="status">Finding your drawings…</p>}
      {data.kind === 'failed' && (
        <div class="empty">
          <p>Couldn’t load your drawings.</p>
          <button type="button" class="primary" onClick={() => setAttempt(attempt + 1)}>Try again</button>
        </div>
      )}
      {data.kind === 'ready' && shown.length === 0 && (
        <p class="empty">{data.drawings.length === 0 ? 'Nothing here yet. Pick a picture to start your first drawing!' : 'No drawings in this list.'}</p>
      )}
      <div class="history-grid">
        {data.kind === 'ready' && shown.map((d) => {
          const picture = data.pictures.get(d.pictureId);
          const title = picture?.title ?? 'Picture removed';
          const done = d.status === 'finished';
          const locked = busy || timeUp || !picture;
          return (
            <article class="history-card" key={d.id}>
              <Thumb drawing={d} picture={picture} />
              <div class="history-info">
                <div class="history-title">
                  <span>{title}</span>
                  <span class={done ? 'chip done' : 'chip open'}>{done ? 'Finished' : 'In progress'}</span>
                </div>
                <span class="history-meta">{kindLabel(d.kind)} · {friendlyDate(d.updatedAt, now)}</span>
                {done && d.score && <Stars count={d.score.stars} />}
              </div>
              <div class="history-actions">
                {done ? (
                  <>
                    <button type="button" class="primary grow" disabled={locked} onClick={() => picture && onEdit(picture, d, false)}>
                      <Icon name="edit" size={20} />Edit
                    </button>
                    <button type="button" class="plain" disabled={locked} onClick={() => picture && onAgain(picture, d.kind)}>
                      Do it again
                    </button>
                  </>
                ) : (
                  <>
                    <button type="button" class="primary grow" disabled={locked} onClick={() => picture && onEdit(picture, d, false)}>
                      <Icon name="edit" size={20} />Edit
                    </button>
                    <button type="button" class="plain" disabled={locked} onClick={() => picture && onEdit(picture, d, true)}>
                      <Icon name="check" size={20} width={2.4} />Finish
                    </button>
                  </>
                )}
                <button type="button" class="danger icon-only" aria-label={`Delete ${title}`} onClick={() => setConfirming(d)}>
                  <Icon name="delete" size={20} />
                </button>
              </div>
            </article>
          );
        })}
      </div>
      {confirming && (
        <Dialog
          title="Delete this drawing?"
          onClose={() => setConfirming(null)}
          actions={
            <>
              <button type="button" class="plain" onClick={() => setConfirming(null)}>Keep it</button>
              <button type="button" class="danger-solid" onClick={() => remove(confirming)}>Delete</button>
            </>
          }
        >
          <p>It will be gone for good. This can’t be undone.</p>
        </Dialog>
      )}
    </main>
  );
}
