import { useEffect, useRef, useState } from 'preact/hooks';
import type { DrawingMeta, Picture } from '../../../../data/types';
import { api } from '../api';
import { DrawingArt } from '../admin/DrawingArt';
import { LibraryPictures } from '../admin/LibraryPictures';
import { Segmented } from '../../../../play/web/src/components/Segmented';
import { friendlyDate, kindLabel } from '../../../../play/web/src/screens/historyModel';
import '../admin/admin.css';

type Row = DrawingMeta & { userId: string; userName: string };
type Data = { kind: 'loading' } | { kind: 'failed' } | { kind: 'ready'; rows: Row[]; pictures: Picture[] };

const ALL = '\u0000all';

function Stars({ count }: { count: number }) {
  return <span class="stars-text" role="img" aria-label={`${count} of 5 stars`}>{'★'.repeat(count)}{'☆'.repeat(5 - count)}</span>;
}

function Enlarged({ row, picture, onClose }: { row: Row; picture: Picture | undefined; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (ref.current && !ref.current.open) ref.current.showModal();
  }, []);
  return (
    <dialog ref={ref} class="lightbox" aria-label={`${row.userName}: ${picture?.title ?? 'Drawing'}`} onCancel={(e) => { e.preventDefault(); onClose(); }} onClick={(e) => e.target === ref.current && onClose()}>
      <div class="lightbox-art"><DrawingArt drawing={row} picture={picture} /></div>
      <div class="lightbox-bar">
        <span><strong>{row.userName}</strong> · {picture?.title ?? 'Removed picture'} · {kindLabel(row.kind)}</span>
        <button type="button" class="primary" onClick={onClose}>Close</button>
      </div>
    </dialog>
  );
}

export function AdminGallery() {
  const [data, setData] = useState<Data>({ kind: 'loading' });
  const [who, setWho] = useState(ALL);
  const [open, setOpen] = useState<Row | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setData({ kind: 'loading' });
    Promise.all([api.drawings(), api.pictures()]).then(
      ([rows, pictures]) => live && setData({ kind: 'ready', rows, pictures }),
      () => live && setData({ kind: 'failed' }),
    );
    return () => { live = false; };
  }, [attempt]);

  if (data.kind === 'loading') return <p class="page hint">Loading…</p>;
  if (data.kind === 'failed') {
    return (
      <div class="page">
        <p class="alert" role="alert">Could not load the gallery. <button type="button" class="plain" onClick={() => setAttempt((n) => n + 1)}>Try again</button></p>
      </div>
    );
  }

  const ready = data;
  const pictures = new Map(data.pictures.map((p) => [p.id, p]));
  const names = [...new Set(data.rows.map((r) => r.userName))].sort((a, b) => a.localeCompare(b));
  const shown = data.rows.filter((r) => who === ALL || r.userName === who);
  const now = new Date();

  return (
    <div class="page stack-lg">
      <section class="stack-md" aria-labelledby="library-title">
        <h1 id="library-title">Picture library ({data.pictures.length})</h1>
        <LibraryPictures
          pictures={data.pictures}
          drawingsOf={(id) => data.rows.filter((r) => r.pictureId === id).length}
          onRenamed={(renamed) => setData({ ...ready, pictures: ready.pictures.map((p) => (p.id === renamed.id ? renamed : p)) })}
          onDeleted={(id) => setData({ ...ready, pictures: ready.pictures.filter((p) => p.id !== id) })}
        />
      </section>
      <section class="stack-md">
      <div class="page-head">
        <h1>Saved drawings</h1>
        {names.length > 1 && (
          <Segmented label="Person" value={who} options={[{ value: ALL, label: 'Everyone' }, ...names.map((n) => ({ value: n, label: n }))]} onChange={setWho} />
        )}
      </div>
      {shown.length === 0 ? (
        <p class="empty">No saved drawings yet.</p>
      ) : (
        <div class="gallery">
          {shown.map((row) => {
            const picture = pictures.get(row.pictureId);
            return (
              <button type="button" class="gallery-card" key={row.id} aria-label={`Enlarge ${row.userName}: ${picture?.title ?? 'drawing'}`} onClick={() => setOpen(row)}>
                <span class="gallery-thumb"><DrawingArt drawing={row} picture={picture} /></span>
                <span class="gallery-info">
                  <span class="spread"><strong>{row.userName}</strong><span class={`chip ${row.status === 'finished' ? 'done' : 'open'}`}>{row.status === 'finished' ? 'Finished' : 'In progress'}</span></span>
                  <span>{picture?.title ?? 'Removed picture'}</span>
                  <span class="hint">{kindLabel(row.kind)} · {friendlyDate(row.updatedAt, now)}</span>
                  {row.score && <Stars count={row.score.stars} />}
                </span>
              </button>
            );
          })}
        </div>
      )}
      </section>
      {open && <Enlarged row={open} picture={pictures.get(open.pictureId)} onClose={() => setOpen(null)} />}
    </div>
  );
}
