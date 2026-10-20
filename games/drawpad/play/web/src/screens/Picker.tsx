import { useEffect, useState } from 'preact/hooks';
import type { Picture, PictureKind } from '../../../../data/types';
import { api, pictureFile } from '../api';
import { BlobImage } from '../blobs/BlobImage';
import { Segmented } from '../components/Segmented';
import { choosingFile } from './historyModel';

type Props = {
  mode: PictureKind;
  busy: boolean;
  onMode: (mode: PictureKind) => void;
  onPick: (picture: Picture) => void;
};

type Library = { kind: 'loading' } | { kind: 'failed' } | { kind: 'ready'; pictures: Picture[] };

const MODES = [{ value: 'trace', label: 'Freestyle' }, { value: 'pbn', label: 'Paint by numbers' }] as const;

export function Picker({ mode, busy, onMode, onPick }: Props) {
  const [library, setLibrary] = useState<Library>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setLibrary({ kind: 'loading' });
    api.pictures().then(
      (pictures) => live && setLibrary({ kind: 'ready', pictures }),
      () => live && setLibrary({ kind: 'failed' }),
    );
    return () => { live = false; };
  }, [attempt]);

  const shown = library.kind === 'ready' ? library.pictures.filter((p) => p.kinds.includes(mode)) : [];

  return (
    <main class="page picker">
      <div class="page-head">
        <h1>Pick a picture</h1>
        <Segmented label="Mode" value={mode} options={MODES} onChange={onMode} />
      </div>
      {library.kind === 'loading' && <p class="empty" role="status">Getting pictures ready…</p>}
      {library.kind === 'failed' && (
        <div class="empty">
          <p>Couldn’t load the pictures.</p>
          <button type="button" class="primary" onClick={() => setAttempt(attempt + 1)}>Try again</button>
        </div>
      )}
      {library.kind === 'ready' && shown.length === 0 && (
        <p class="empty">No {mode === 'pbn' ? 'paint by numbers' : 'freestyle'} pictures yet. Ask an admin to add some.</p>
      )}
      <div class="picture-grid">
        {shown.map((p) => (
          <button type="button" key={p.id} class="picture-card" disabled={busy} onClick={() => onPick(p)}>
            <span class="picture-thumb"><BlobImage path={pictureFile(p.id, choosingFile(mode))} /></span>
            <span class="picture-title">{p.title}</span>
          </button>
        ))}
      </div>
    </main>
  );
}
