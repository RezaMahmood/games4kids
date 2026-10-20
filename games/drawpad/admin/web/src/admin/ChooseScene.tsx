import { api } from '../api';
import { Icon } from '../../../../play/web/src/components/Icon';
import { describeFailure, sceneFailure } from './messages';
import { buildPbnPicture } from './newPicture';
import { RasterView } from './RasterView';
import {
  chosenPicture, COLOR_RANGE, DETAIL_STEPS, SCENE_INDEXES, TITLE_MAX, type Action, type ChoosingPhase, type DescriptionItem,
} from './uploadModel';
import { discard, forgetJobs, pickScene, retunePbn } from './uploadStore';

const DETAIL_NAMES = ['Simplest', 'Simple', 'Medium', 'Detailed', 'Most detailed'];

type Props = { item: DescriptionItem; phase: ChoosingPhase; dispatch: (a: Action) => void; onBack: () => void; onAdded: (title: string) => void };

/** Review for a description: pick one of the three AI pictures, tune its paint by number, and save it. */
export function ChooseScene({ item, phase, dispatch, onBack, onAdded }: Props) {
  const { id } = item;
  const { tuning, generated } = phase;
  const title = item.title.trim();
  const ready = chosenPicture(phase);
  const palette = generated?.pbn.palette ?? [];

  const add = async () => {
    dispatch({ type: 'saving', id });
    try {
      await api.addPicture(await buildPbnPicture(item, phase));
      dispatch({ type: 'added', id });
      forgetJobs(item.jobIds);
      onAdded(title);
    } catch (e) {
      dispatch({ type: 'saveFailed', id, message: describeFailure('Could not add the picture.', e) });
    }
  };

  const tune = (change: Partial<typeof tuning>) => retunePbn(id, { ...tuning, ...change });

  return (
    <div class="review">
      <section class="review-main">
        <div class="review-head">
          <button type="button" class="plain" onClick={onBack}><Icon name="back" size={20} />Queue</button>
          <h1>{title || 'Untitled'}</h1>
        </div>
        <p class="field-hint">“{item.description}”</p>
        <div class="scene-picks" role="group" aria-label="Pictures to choose from">
          {SCENE_INDEXES.map((i) => {
            const scene = phase.scenes[i];
            if (scene.kind === 'failed') return <div key={i} class="scene-pick failed"><span>{sceneFailure(scene.error)}</span></div>;
            return (
              <button type="button" key={i} class="scene-pick" aria-pressed={phase.chosen === i} disabled={phase.saving} onClick={() => pickScene(id, i)}>
                <RasterView raster={scene.raster} label={`Picture ${i + 1}`} />
              </button>
            );
          })}
        </div>
        <div class="scene-stage">
          <div class={`figure-box${phase.regenerating ? ' updating' : ''}`}>
            {generated && <RasterView raster={generated.preview} label="Paint by number page" />}
            {phase.chosen === null && <span class="figure-empty">Pick the picture you like best</span>}
            {phase.regenerating && <span class="figure-badge">{generated ? 'Updating…' : 'Finding colours…'}</span>}
          </div>
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
          <label for="colour-count" class="field-label spread"><span>Number of colours</span><span>{tuning.colors}</span></label>
          <input id="colour-count" type="range" min={COLOR_RANGE.min} max={COLOR_RANGE.max} value={tuning.colors} onInput={(e) => tune({ colors: Number(e.currentTarget.value) })} />
          <div class="swatches">
            {palette.map((hex, i) => <span key={i} class="swatch" title={`${i + 1}  ${hex}`} style={{ background: hex }} />)}
          </div>
        </div>
        <div class="stack-sm">
          <label for="detail" class="field-label spread"><span>Detail</span><span>{DETAIL_NAMES[Math.round(tuning.detail * DETAIL_STEPS)]}</span></label>
          <input id="detail" type="range" min={0} max={DETAIL_STEPS} value={Math.round(tuning.detail * DETAIL_STEPS)} onInput={(e) => tune({ detail: Number(e.currentTarget.value) / DETAIL_STEPS })} />
        </div>
        {phase.error && <p class="alert" role="alert">{phase.error}</p>}
        <div class="grow-space" />
        <div class="stack-xs">
          <button type="button" class="primary big" disabled={!ready || phase.regenerating || phase.saving || !title} onClick={add}>
            {phase.saving ? 'Adding…' : 'Add to picture library'}
          </button>
          <button type="button" class="danger" disabled={phase.saving} onClick={() => { discard(id); onBack(); }}>Discard</button>
        </div>
      </aside>
    </div>
  );
}
