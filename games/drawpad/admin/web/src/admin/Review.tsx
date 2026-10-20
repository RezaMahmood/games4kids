import { api } from '../api';
import { Icon } from '../../../../play/web/src/components/Icon';
import { Segmented } from '../../../../play/web/src/components/Segmented';
import { describeFailure } from './messages';
import { buildNewPicture } from './newPicture';
import { RasterView } from './RasterView';
import { canDraw, DETAIL_STEPS, redrawsNeeded, TITLE_MAX, type Action, type OutlineSource, type PhotoItem, type ReadyPhase, type Redraw } from './uploadModel';
import { discard, forgetJobs, makeOutline, retune } from './uploadStore';

const OUTLINES: readonly { value: OutlineSource; label: string; hint: string; cost?: string }[] = [
  { value: 'classic', label: 'Classic', hint: 'Traced from the photo edges. Free.' },
  { value: 'standard', label: 'AI standard', hint: 'Redrawn by AI. About 1.5 cents a photo.', cost: 'about 1.5 cents' },
  { value: 'best', label: 'AI best', hint: 'Redrawn by a stronger AI model. About 5 cents a photo.', cost: 'about 5 cents' },
];

type Props = { item: PhotoItem; phase: ReadyPhase; dispatch: (a: Action) => void; onBack: () => void; onAdded: (title: string) => void };

/** Stands in for an AI outline that is not there to show: why, and the one button that asks the AI for it. */
function NoOutline({ redraw, outline, onMake }: { redraw: Redraw | undefined; outline: (typeof OUTLINES)[number]; onMake: () => void }) {
  if (redraw?.kind === 'waiting') return <div class="figure-empty"><p>{redraw.label}</p></div>;
  return (
    <div class="figure-empty">
      <p>{redraw?.kind === 'failed' ? redraw.message : `This photo has no ${outline.label} outline yet.`}</p>
      <button type="button" class="primary" onClick={onMake}>
        {redraw?.kind === 'failed' ? 'Try again' : `Make it, ${outline.cost}`}
      </button>
    </div>
  );
}

export function Review({ item, phase, dispatch, onBack, onAdded }: Props) {
  const { tuning, id } = item;
  const { photo } = phase;

  const title = item.title.trim();
  const busy = phase.regenerating || phase.saving;
  const outline = OUTLINES.find((o) => o.value === tuning.outline)!;
  const [key] = redrawsNeeded(tuning);
  const redraw = key && phase.redraws[key];
  const drawable = canDraw(tuning, phase.redraws);
  const ratio = { aspectRatio: `${photo.width} / ${photo.height}` };

  const add = async () => {
    dispatch({ type: 'saving', id });
    try {
      await api.addPicture(await buildNewPicture(item, phase));
      dispatch({ type: 'added', id });
      forgetJobs(item.jobIds);
      onAdded(title);
    } catch (e) {
      dispatch({ type: 'saveFailed', id, message: describeFailure('Could not add the picture.', e) });
    }
  };

  const tune = (change: Partial<typeof tuning>) => retune(id, { ...tuning, ...change });

  return (
    <div class="review">
      <section class="review-main">
        <div class="review-head">
          <button type="button" class="plain" onClick={onBack}><Icon name="back" size={20} />Queue</button>
          <h1>{title || 'Untitled'}</h1>
        </div>
        <div class="review-figures">
          <figure>
            <div class="figure-box" style={ratio}><RasterView raster={phase.photo} label="Original photo" /></div>
            <figcaption>Original photo</figcaption>
          </figure>
          <figure>
            <div class={`figure-box${phase.regenerating ? ' updating' : ''}`} style={ratio}>
              {drawable ? (
                <>
                  <RasterView raster={phase.generated.outline} label="Generated stencil" />
                  {phase.regenerating && <span class="figure-badge">Updating…</span>}
                  {redraw?.kind === 'waiting' && <span class="figure-badge">{redraw.label}</span>}
                </>
              ) : (
                <NoOutline redraw={redraw || undefined} outline={outline} onMake={() => makeOutline(id)} />
              )}
            </div>
            <figcaption>Generated stencil</figcaption>
          </figure>
        </div>
      </section>

      <aside class="panel review-side" aria-label="Settings">
        <div class="stack-sm">
          <label for="pic-name" class="field-label">Picture name</label>
          <input id="pic-name" class="text-input" type="text" maxLength={TITLE_MAX} value={item.title} onInput={(e) => dispatch({ type: 'retitle', id, title: e.currentTarget.value })} />
          {item.suggestions.length > 0 && (
            <div class="title-ideas" role="group" aria-label="Suggested names">
              {item.suggestions.map((idea) => (
                <button type="button" key={idea} aria-pressed={idea === item.title} onClick={() => dispatch({ type: 'retitle', id, title: idea })}>{idea}</button>
              ))}
            </div>
          )}
        </div>
        <div class="stack-sm">
          <span class="field-label">Outline</span>
          <Segmented label="Outline" value={tuning.outline} options={OUTLINES} onChange={(outline) => tune({ outline })} />
          <p class="field-hint">{outline.hint}</p>
          {drawable && outline.cost && (
            <button type="button" class="plain" disabled={busy || redraw?.kind === 'waiting'} onClick={() => makeOutline(id)}>
              Make a new {outline.label} outline, {outline.cost}
            </button>
          )}
        </div>
        {tuning.outline === 'classic' && (
          <div class="stack-sm">
            <label for="detail" class="field-label spread"><span>Detail</span><span>{['Simplest', 'Simple', 'Medium', 'Detailed', 'Most detailed'][Math.round(tuning.detail * DETAIL_STEPS)]}</span></label>
            <input id="detail" type="range" min={0} max={DETAIL_STEPS} value={Math.round(tuning.detail * DETAIL_STEPS)} onInput={(e) => tune({ detail: Number(e.currentTarget.value) / DETAIL_STEPS })} />
          </div>
        )}
        {phase.error && <p class="alert" role="alert">{phase.error}</p>}
        <div class="grow-space" />
        <div class="stack-xs">
          <button type="button" class="primary big" disabled={busy || !title || !drawable || redraw?.kind === 'waiting'} onClick={add}>{phase.saving ? 'Adding…' : 'Add to picture library'}</button>
          <button type="button" class="danger" disabled={phase.saving} onClick={() => { discard(id); onBack(); }}>Discard</button>
        </div>
      </aside>
    </div>
  );
}
