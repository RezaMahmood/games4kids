import type { RedrawQuality } from '../../../../data/types';
import { useRef, useState } from 'preact/hooks';
import { ChooseScene } from '../admin/ChooseScene';
import { READY_TO_PICK, READY_TO_REVIEW } from '../admin/messages';
import { RasterView } from '../admin/RasterView';
import { RecentUploads } from '../admin/RecentUploads';
import { Review } from '../admin/Review';
import { checkDescription, DESCRIPTION_RANGE, type Item } from '../admin/uploadModel';
import { discard, dispatch, MAX_PHOTO_MB, queueDescription, queuePhotos, useUploadItems } from '../admin/uploadStore';
import { Segmented } from '../../../../play/web/src/components/Segmented';
import type { Raster } from '../stencil/types';
import '../admin/admin.css';

const QUALITIES: readonly { value: RedrawQuality; label: string; hint: string }[] = [
  { value: 'standard', label: 'Standard', hint: 'Good for most pictures.' },
  { value: 'best', label: 'Best', hint: 'A stronger AI model. Slower, and costs more.' },
];

/** The picture a row shows: the photo, or the picked AI picture of a description (the first one drawn until then). */
function thumbOf(item: Item): Raster | null {
  if (item.source === 'photo') return item.phase.kind === 'ready' ? item.phase.photo : null;
  if (item.phase.kind !== 'choosing') return null;
  const { scenes, chosen } = item.phase;
  const scene = (chosen === null ? null : scenes[chosen]) ?? scenes.find((s) => s.kind === 'ready');
  return scene?.kind === 'ready' ? scene.raster : null;
}

function QueueRow({ item, onReview }: { item: Item; onReview: () => void }) {
  const { phase } = item;
  const thumb = thumbOf(item);
  const reviewable = phase.kind === 'ready' || phase.kind === 'choosing';
  return (
    <li class="queue-row">
      <span class="queue-thumb">{thumb && <RasterView raster={thumb} label="" />}</span>
      <div class="queue-info">
        <span class="queue-title">{item.title}</span>
        {phase.kind === 'waiting' && <span class="hint">{'label' in phase ? phase.label : 'Waiting'}</span>}
        {phase.kind === 'working' && (
          <>
            <div class="bar" role="progressbar" aria-label={`Progress for ${item.title}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(phase.progress * 100)}>
              <div style={{ width: `${phase.progress * 100}%` }} />
            </div>
            <span class="hint">{phase.label}</span>
          </>
        )}
        {phase.kind === 'ready' && <span class="status ok">{READY_TO_REVIEW}</span>}
        {phase.kind === 'choosing' && <span class="status ok">{READY_TO_PICK}</span>}
        {phase.kind === 'failed' && <span class="status bad">{phase.message}</span>}
      </div>
      {reviewable && <button type="button" class="primary" onClick={onReview}>Review</button>}
      {(phase.kind === 'failed' || phase.kind === 'waiting' || phase.kind === 'working') && (
        <button type="button" class="plain" aria-label={`Remove ${item.title}`} onClick={() => discard(item.id)}>Remove</button>
      )}
    </li>
  );
}

export function AdminUpload() {
  const items = useUploadItems();
  const [reviewId, setReviewId] = useState<number | null>(null);
  /** The title of the picture just added, said once on return since its row has gone. */
  const [added, setAdded] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [description, setDescription] = useState('');
  const [quality, setQuality] = useState<RedrawQuality>('standard');
  const pick = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);

  const reviewing = items.find((i) => i.id === reviewId);
  const back = () => setReviewId(null);
  const addedOne = (title: string) => { setAdded(title); back(); };
  const review = (id: number) => { setAdded(null); setReviewId(id); };
  if (reviewing?.source === 'photo' && reviewing.phase.kind === 'ready') {
    return <Review item={reviewing} phase={reviewing.phase} dispatch={dispatch} onBack={back} onAdded={addedOne} />;
  }
  if (reviewing?.source === 'description' && reviewing.phase.kind === 'choosing') {
    return <ChooseScene item={reviewing} phase={reviewing.phase} dispatch={dispatch} onBack={back} onAdded={addedOne} />;
  }

  const take = (list: FileList | null) => {
    if (list?.length) queuePhotos(Array.from(list));
  };
  const liveJobIds = new Set(items.flatMap((i) => i.jobIds));
  const checked = checkDescription(description);
  const describe = (e: Event) => {
    e.preventDefault();
    if (!checked.ok) return;
    queueDescription(checked.description, quality);
    setDescription('');
  };

  return (
    <div class="upload">
      <div class="upload-make">
        <section class="stack-md">
          <h1>Turn photos into pictures</h1>
          <div
            class={`dropzone${dragging ? ' over' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => { e.preventDefault(); setDragging(false); take(e.dataTransfer?.files ?? null); }}
          >
            <span class="drop-icon">
              <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 16V4" /><path d="M7 9l5-5 5 5" /><path d="M4 16v4h16v-4" /></svg>
            </span>
            <span class="drop-title">Drop photos here</span>
            <span class="hint">JPG, PNG or HEIC, up to {MAX_PHOTO_MB} MB each</span>
            <div class="row-gap">
              <button type="button" class="primary big" onClick={() => pick.current?.click()}>Choose from Photos</button>
              <button type="button" class="plain big" onClick={() => camera.current?.click()}>Take a photo</button>
            </div>
            <input ref={pick} type="file" accept="image/*" multiple hidden onChange={(e) => { take(e.currentTarget.files); e.currentTarget.value = ''; }} />
            <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { take(e.currentTarget.files); e.currentTarget.value = ''; }} />
          </div>
        </section>

        <form class="panel" aria-labelledby="describe-title" onSubmit={describe}>
          <h2 id="describe-title">Paint by number from a description</h2>
          <div class="stack-sm">
            <label for="describe" class="field-label">What should the picture show?</label>
            <textarea
              id="describe" class="text-input text-area" rows={3} maxLength={DESCRIPTION_RANGE.max} value={description}
              placeholder="A fox asleep under an autumn tree" onInput={(e) => setDescription(e.currentTarget.value)}
            />
          </div>
          <div class="stack-sm">
            <span class="field-label">Quality</span>
            <Segmented label="Quality" value={quality} options={QUALITIES} onChange={setQuality} />
            <p class="field-hint">{QUALITIES.find((q) => q.value === quality)!.hint}</p>
          </div>
          <div class="spread">
            <p class="field-hint" aria-live="polite">{checked.ok ? 'The AI draws 3 pictures to choose from.' : checked.hint}</p>
            <button type="submit" class="primary big" disabled={!checked.ok}>Make 3 pictures</button>
          </div>
        </form>
      </div>

      <div class="upload-side">
        <section class="panel" aria-label="Processing">
          <h2>Processing</h2>
          {added && <p class="note-ok" role="status">Added “{added}” to the picture library.</p>}
          {items.length === 0 ? (
            <p class="hint">Photos and descriptions you add will appear here.</p>
          ) : (
            <ul class="queue">
              {items.map((item) => <QueueRow key={item.id} item={item} onReview={() => review(item.id)} />)}
            </ul>
          )}
        </section>
        <RecentUploads liveJobIds={liveJobIds} refreshKey={`${items.length}:${liveJobIds.size}`} onOpened={review} />
      </div>
    </div>
  );
}
