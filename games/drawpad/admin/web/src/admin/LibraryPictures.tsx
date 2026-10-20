import { useState } from 'preact/hooks';
import type { Picture } from '../../../../data/types';
import { api, pictureFile } from '../api';
import { BlobImage } from '../../../../play/web/src/blobs/BlobImage';
import { Dialog } from '../../../../play/web/src/components/Dialog';
import { choosingFile, kindLabel } from '../../../../play/web/src/screens/historyModel';
import { describeFailure } from './messages';
import { TITLE_MAX } from './uploadModel';

type Props = {
  pictures: Picture[];
  /** How many saved drawings were made from each picture, so deleting one can say what happens to them. */
  drawingsOf: (pictureId: string) => number;
  onRenamed: (picture: Picture) => void;
  onDeleted: (id: string) => void;
};

function Rename({ picture, onDone }: { picture: Picture; onDone: (renamed: Picture | null) => void }) {
  const [title, setTitle] = useState(picture.title);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const trimmed = title.trim();

  const save = async (e: Event) => {
    e.preventDefault();
    if (trimmed === picture.title) return onDone(null);
    setSaving(true);
    setProblem(null);
    try {
      onDone(await api.renamePicture(picture.id, trimmed));
    } catch (err) {
      setProblem(describeFailure('Could not rename the picture.', err));
      setSaving(false);
    }
  };

  return (
    <form class="stack-xs" onSubmit={save}>
      <input
        class="text-input" type="text" maxLength={TITLE_MAX} aria-label={`New name for ${picture.title}`} value={title}
        ref={(el) => el?.focus()} onInput={(e) => setTitle(e.currentTarget.value)}
      />
      {problem && <p class="alert" role="alert">{problem}</p>}
      <div class="row-gap">
        <button type="submit" class="primary" disabled={saving || !trimmed}>{saving ? 'Saving…' : 'Save'}</button>
        <button type="button" class="plain" disabled={saving} onClick={() => onDone(null)}>Cancel</button>
      </div>
    </form>
  );
}

function ConfirmDelete({ picture, drawings, onClose, onDeleted }: { picture: Picture; drawings: number; onClose: () => void; onDeleted: () => void }) {
  const [deleting, setDeleting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const remove = async () => {
    setDeleting(true);
    try {
      await api.deletePicture(picture.id);
      onDeleted();
    } catch (err) {
      setProblem(describeFailure('Could not delete the picture.', err));
      setDeleting(false);
    }
  };

  return (
    <Dialog
      title={`Delete “${picture.title}”?`}
      onClose={onClose}
      actions={(
        <>
          <button type="button" class="plain" disabled={deleting} onClick={onClose}>Keep it</button>
          <button type="button" class="danger-solid" disabled={deleting} onClick={remove}>{deleting ? 'Deleting…' : 'Delete'}</button>
        </>
      )}
    >
      <p>Players will no longer see it. This cannot be undone.</p>
      {drawings > 0 && (
        <p>{drawings === 1 ? '1 saved drawing was' : `${drawings} saved drawings were`} made from it. They stay in My drawings and the gallery, but can no longer be opened.</p>
      )}
      {problem && <p class="alert" role="alert">{problem}</p>}
    </Dialog>
  );
}

/** The pictures players choose from, each with a rename and a delete for the admin. */
export function LibraryPictures({ pictures, drawingsOf, onRenamed, onDeleted }: Props) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Picture | null>(null);

  if (pictures.length === 0) return <p class="empty">The library is empty. Add pictures on the Upload screen.</p>;
  return (
    <div class="gallery">
      {pictures.map((p) => {
        const kind = p.kinds.includes('pbn') ? 'pbn' : 'trace';
        return (
          <div class="gallery-card" key={p.id}>
            <span class="gallery-thumb"><BlobImage path={pictureFile(p.id, choosingFile(kind))} /></span>
            <div class="gallery-info">
              {renaming === p.id ? (
                <Rename picture={p} onDone={(renamed) => { setRenaming(null); if (renamed) onRenamed(renamed); }} />
              ) : (
                <>
                  <strong>{p.title}</strong>
                  <span class="hint">{p.kinds.map(kindLabel).join(' · ')}</span>
                  <div class="row-gap">
                    <button type="button" class="plain" aria-label={`Rename ${p.title}`} onClick={() => setRenaming(p.id)}>Rename</button>
                    <button type="button" class="danger" aria-label={`Delete ${p.title}`} onClick={() => setDeleting(p)}>Delete</button>
                  </div>
                </>
              )}
            </div>
          </div>
        );
      })}
      {deleting && (
        <ConfirmDelete
          picture={deleting} drawings={drawingsOf(deleting.id)} onClose={() => setDeleting(null)}
          onDeleted={() => { onDeleted(deleting.id); setDeleting(null); }}
        />
      )}
    </div>
  );
}
