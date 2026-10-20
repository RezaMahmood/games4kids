import type { PhotoStepKey, RedrawQuality } from '../../../../data/types';
import type { PbnResult } from '../stencil/pbn';
import type { Raster } from '../stencil/types';
import { describeScenesFailed } from './messages';

/** Classic traces edges in the browser for free. The others have an AI image model redraw the photo first. */
export type OutlineSource = 'classic' | RedrawQuality;
export type Tuning = { detail: number; outline: OutlineSource };
/** The stencil, with the tuning it was made with. */
export type Generated = { outline: Raster; tuning: Tuning };

/** One AI redraw of the photo, named like the upload job step that makes it. */
export type RedrawKey = Exclude<PhotoStepKey, 'titles'>;
export type Redraws = Partial<Record<RedrawKey, Raster>>;
/**
 * An AI redraw this item asked for: waiting on its upload job, with the queue wording to show and, when it is being
 * made again, the one it replaces; back and kept, so switching quality away and back never pays for it twice; or
 * failed, with why. Only an explicit request makes one.
 */
export type Redraw = { kind: 'waiting'; label: string; raster?: Raster } | { kind: 'ready'; raster: Raster } | { kind: 'failed'; message: string };

const rasterOf = (redraw: Redraw | undefined): Raster | undefined => (redraw?.kind === 'failed' ? undefined : redraw?.raster);

/** The AI redraws this tuning needs: none for the classic outline. */
export function redrawsNeeded(tuning: Tuning): RedrawKey[] {
  return tuning.outline === 'classic' ? [] : [`trace-${tuning.outline}`];
}

/** Whether the browser can draw this tuning's stencil now: always for classic, once it has its AI redraw otherwise. */
export const canDraw = (tuning: Tuning, redraws: Partial<Record<RedrawKey, Redraw>>): boolean =>
  redrawsNeeded(tuning).every((key) => rasterOf(redraws[key]));

/** The tuning switched to the free classic outline if its AI redraw failed. */
export function withoutRedraws(tuning: Tuning, failed: RedrawKey[]): Tuning {
  return redrawsNeeded(tuning).some((key) => failed.includes(key)) ? { ...tuning, outline: 'classic' } : tuning;
}

export function readyRedraws(redraws: Partial<Record<RedrawKey, Redraw>>): Redraws {
  return Object.fromEntries(Object.entries(redraws).flatMap(([key, r]) => {
    const raster = rasterOf(r);
    return raster ? [[key, raster]] : [];
  }));
}

export const DEFAULT_TUNING: Tuning = { detail: 0.5, outline: 'standard' };
export const DETAIL_STEPS = 4;
export const TITLE_MAX = 60;

/** The API's limits on a description, counted after trimming. */
export const DESCRIPTION_RANGE = { min: 3, max: 300 } as const;
export const COLOR_RANGE = { min: 4, max: 16 } as const;
export type PbnTuning = { colors: number; detail: number };
export const DEFAULT_PBN_TUNING: PbnTuning = { colors: 8, detail: 0.5 };

export type ReadyPhase = {
  kind: 'ready';
  photo: Raster;
  generated: Generated;
  redraws: Partial<Record<RedrawKey, Redraw>>;
  /** Bumped on every tuning change so a slow earlier result can never overwrite a newer one. */
  rev: number;
  regenerating: boolean;
  saving: boolean;
  error: string | null;
};

/** An item that could not be made, and why. One added to the library leaves the list instead. */
type Settled = { kind: 'failed'; message: string };

export type PhotoPhase =
  | { kind: 'waiting' }
  | { kind: 'working'; label: string; progress: number }
  | ReadyPhase
  | Settled;

export type SceneIndex = 0 | 1 | 2;
export const SCENE_INDEXES: readonly SceneIndex[] = [0, 1, 2];
/** One of the three pictures a description job draws, or the failed step's code. */
export type Scene = { kind: 'ready'; raster: Raster } | { kind: 'failed'; error: string };
export type Scenes = readonly [Scene, Scene, Scene];

export type ChoosingPhase = {
  kind: 'choosing';
  scenes: Scenes;
  chosen: SceneIndex | null;
  /** The paint by number of the chosen scene, null until it is first made. Never one made from another scene. */
  generated: PbnResult | null;
  tuning: PbnTuning;
  /** Bumped on every pick and tuning change so a slow earlier result can never overwrite a newer one. */
  rev: number;
  regenerating: boolean;
  saving: boolean;
  error: string | null;
};

export type DescriptionPhase = { kind: 'waiting'; label: string } | ChoosingPhase | Settled;

/** Where the title came from. Only a title still derived from the file name or the description may be replaced by an AI suggestion. */
export type TitleSource = 'file' | 'description' | 'edited' | 'ai';

type ItemBase = {
  id: number;
  title: string;
  titleSource: TitleSource;
  /** AI title ideas, best first, offered next to the name field. Empty until they arrive, and for good if they never do. */
  suggestions: string[];
  /** Every upload job made for this item, so saving it can delete them and the Recent uploads list does not show them twice. */
  jobIds: string[];
};
/** An uploaded photo that becomes a tracing page. */
export type PhotoItem = ItemBase & { source: 'photo'; file: File; tuning: Tuning; phase: PhotoPhase };
/** A typed description that becomes a paint by number, from whichever of three AI pictures the admin picks. */
export type DescriptionItem = ItemBase & { source: 'description'; description: string; quality: RedrawQuality; phase: DescriptionPhase };
export type Item = PhotoItem | DescriptionItem;

export type Action =
  | { type: 'queued'; items: Item[] }
  | { type: 'progress'; id: number; label: string; progress: number }
  | { type: 'loaded'; id: number; photo: Raster; generated: Generated; redraws: Redraws; error?: string }
  | { type: 'failed'; id: number; message: string }
  | { type: 'retitle'; id: number; title: string }
  | { type: 'suggested'; id: number; titles: string[] }
  | { type: 'tune'; id: number; tuning: Tuning }
  | { type: 'redrawWaiting'; id: number; keys: RedrawKey[]; label: string }
  /** Redraws back from a job, and for each one that failed, the sentence that says why. */
  | { type: 'redrawn'; id: number; redraws: Redraws; failed: Partial<Record<RedrawKey, string>> }
  | { type: 'regenerated'; id: number; rev: number; generated: Generated }
  | { type: 'regenerateFailed'; id: number; rev: number; message: string }
  | { type: 'saving'; id: number }
  | { type: 'saveFailed'; id: number; message: string }
  /** Saved to the library: nothing more can be done with it, so it leaves the list. */
  | { type: 'added'; id: number }
  | { type: 'discard'; id: number }
  | { type: 'sceneWaiting'; id: number; label: string }
  | { type: 'jobStarted'; id: number; jobId: string }
  | { type: 'drawn'; id: number; scenes: Scenes }
  | { type: 'pick'; id: number; index: SceneIndex }
  | { type: 'pbnTune'; id: number; tuning: PbnTuning }
  | { type: 'pbnMade'; id: number; rev: number; generated: PbnResult }
  | { type: 'pbnFailed'; id: number; rev: number; message: string };

export function titleFromFile(name: string): string {
  const words = name.replace(/\.[^.]+$/, '').replace(/[_\-.]+/g, ' ').trim().slice(0, TITLE_MAX).trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : 'Untitled';
}

/** The description, capitalised and cut to a title's length, until the AI suggests better. */
export function titleFromDescription(description: string): string {
  const words = description.trim().slice(0, TITLE_MAX).trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : 'Untitled';
}

/** The trimmed description when the API will take it, or a short hint saying what to change. */
export function checkDescription(text: string): { ok: true; description: string } | { ok: false; hint: string } {
  const description = text.trim();
  if (!description) return { ok: false, hint: 'Describe the picture first.' };
  if (description.length < DESCRIPTION_RANGE.min) return { ok: false, hint: `Use at least ${DESCRIPTION_RANGE.min} characters.` };
  if (description.length > DESCRIPTION_RANGE.max) return { ok: false, hint: `Keep it to ${DESCRIPTION_RANGE.max} characters.` };
  return { ok: true, description };
}

/** The chosen scene and its paint by number, once both are there to save. */
export function chosenPicture(phase: ChoosingPhase): { scene: Raster; pbn: PbnResult } | null {
  const scene = phase.chosen === null ? null : phase.scenes[phase.chosen];
  return scene?.kind === 'ready' && phase.generated ? { scene: scene.raster, pbn: phase.generated } : null;
}

const CAMERA_PREFIX = /^(?:whatsapp image|screen ?shot|mvimg|dscn|dscf|dsc|img|pxl|vid|photo|image)(?![a-z])/i;

/** True for a file name nobody chose: a UUID or hex id, a run of numbers, or a camera or phone default such as IMG_4823. */
export function looksMeaningless(name: string): boolean {
  const base = name.replace(/\.[^.]+$/, '').trim();
  if (/^(?=.*\d)[0-9a-f]{8,}$/i.test(base.replace(/[\s_\-.]+/g, ''))) return true;
  return !base.replace(CAMERA_PREFIX, '').split(/[^a-z0-9]+/i).some((token) => /^[a-z]{3,}$/i.test(token));
}

const onReady = (items: Item[], id: number, change: (item: PhotoItem, phase: ReadyPhase) => PhotoItem): Item[] =>
  items.map((item) => (item.id === id && item.source === 'photo' && item.phase.kind === 'ready' ? change(item, item.phase) : item));

const onChoosing = (items: Item[], id: number, change: (phase: ChoosingPhase) => ChoosingPhase): Item[] =>
  items.map((item) => (item.id === id && item.source === 'description' && item.phase.kind === 'choosing' ? { ...item, phase: change(item.phase) } : item));

const onPhoto = (items: Item[], id: number, change: (item: PhotoItem) => PhotoItem): Item[] =>
  items.map((item) => (item.id === id && item.source === 'photo' ? change(item) : item));

const onWaitingDescription = (items: Item[], id: number, phase: DescriptionPhase): Item[] =>
  items.map((item) => (item.id === id && item.source === 'description' && item.phase.kind === 'waiting' ? { ...item, phase } : item));

/** Saving works the same on a photo under review and a description being chosen. */
function withSaving(items: Item[], id: number, saving: boolean, error: string | null): Item[] {
  return onChoosing(onReady(items, id, (item, phase) => ({ ...item, phase: { ...phase, saving, error } })), id, (phase) => ({ ...phase, saving, error }));
}

/** A rerun of the paint by number for the chosen scene, after a pick or a tuning change. */
const remake = (phase: ChoosingPhase, change: Partial<ChoosingPhase>): ChoosingPhase =>
  ({ ...phase, ...change, rev: phase.rev + 1, regenerating: true, error: null });

const replaceableTitle = (item: Item): boolean =>
  item.source === 'photo' ? item.titleSource === 'file' && looksMeaningless(item.file.name) : item.titleSource === 'description';

const asReady = (redraws: Redraws): Partial<Record<RedrawKey, Redraw>> =>
  Object.fromEntries(Object.entries(redraws).map(([key, raster]) => [key, { kind: 'ready', raster }]));

const settle = (items: Item[], id: number, phase: Settled): Item[] => items.map((item) => (item.id === id ? { ...item, phase } : item));

export function reduce(items: Item[], action: Action): Item[] {
  switch (action.type) {
    case 'queued':
      return [...items, ...action.items];
    case 'progress':
      return onPhoto(items, action.id, (item) => ({ ...item, phase: { kind: 'working', label: action.label, progress: action.progress } }));
    case 'loaded':
      return onPhoto(items, action.id, (item) => ({
        ...item,
        tuning: action.generated.tuning,
        phase: {
          kind: 'ready', photo: action.photo, generated: action.generated, redraws: asReady(action.redraws),
          rev: 0, regenerating: false, saving: false, error: action.error ?? null,
        },
      }));
    case 'failed':
      return settle(items, action.id, { kind: 'failed', message: action.message });
    case 'retitle':
      return items.map((item) => (item.id === action.id ? { ...item, title: action.title, titleSource: 'edited' } : item));
    case 'suggested':
      return items.map((item) => {
        if (item.id !== action.id) return item;
        const replace = action.titles.length > 0 && replaceableTitle(item);
        return { ...item, suggestions: action.titles, ...(replace && { title: action.titles[0]!, titleSource: 'ai' as const }) };
      });
    case 'tune':
      return onReady(items, action.id, (item, phase) => ({
        ...item, tuning: action.tuning, phase: { ...phase, rev: phase.rev + 1, regenerating: canDraw(action.tuning, phase.redraws), error: null },
      }));
    case 'redrawWaiting':
      return onReady(items, action.id, (item, phase) => {
        const waiting = action.keys.map((key): [RedrawKey, Redraw] => {
          const raster = rasterOf(phase.redraws[key]);
          return [key, { kind: 'waiting', label: action.label, ...(raster && { raster }) }];
        });
        return { ...item, phase: { ...phase, redraws: { ...phase.redraws, ...Object.fromEntries(waiting) } } };
      });
    case 'redrawn':
      return onReady(items, action.id, (item, phase) => {
        // A redraw made again that fails keeps the one it would have replaced, and says why.
        const failed = Object.entries(action.failed).map(([key, message]): [string, Redraw] => {
          const raster = rasterOf(phase.redraws[key as RedrawKey]);
          return [key, raster ? { kind: 'ready', raster } : { kind: 'failed', message }];
        });
        const kept = (Object.keys(action.failed) as RedrawKey[]).filter((key) => rasterOf(phase.redraws[key]));
        const redraws = { ...phase.redraws, ...asReady(action.redraws), ...Object.fromEntries(failed) };
        const shown = redrawsNeeded(item.tuning).some((key) => action.redraws[key]);
        return {
          ...item,
          phase: {
            ...phase, redraws,
            ...(shown && { rev: phase.rev + 1, regenerating: true }),
            ...(kept.length && { error: kept.map((key) => action.failed[key]).join(' ') }),
          },
        };
      });
    case 'regenerated':
      return onReady(items, action.id, (item, phase) =>
        phase.rev === action.rev ? { ...item, phase: { ...phase, generated: action.generated, regenerating: false } } : item);
    case 'regenerateFailed':
      return onReady(items, action.id, (item, phase) =>
        phase.rev === action.rev ? { ...item, phase: { ...phase, regenerating: false, error: action.message } } : item);
    case 'saving':
      return withSaving(items, action.id, true, null);
    case 'saveFailed':
      return withSaving(items, action.id, false, action.message);
    case 'added':
    case 'discard':
      return items.filter((item) => item.id !== action.id);
    case 'jobStarted':
      return items.map((item) => (item.id === action.id && !item.jobIds.includes(action.jobId) ? { ...item, jobIds: [...item.jobIds, action.jobId] } : item));
    case 'sceneWaiting':
      return onWaitingDescription(items, action.id, { kind: 'waiting', label: action.label });
    case 'drawn':
      return onWaitingDescription(items, action.id, action.scenes.some((scene) => scene.kind === 'ready')
        ? {
          kind: 'choosing', scenes: action.scenes, chosen: null, generated: null,
          tuning: DEFAULT_PBN_TUNING, rev: 0, regenerating: false, saving: false, error: null,
        }
        : { kind: 'failed', message: describeScenesFailed(action.scenes.flatMap((scene) => (scene.kind === 'failed' ? [scene.error] : []))) });
    case 'pick':
      return onChoosing(items, action.id, (phase) =>
        phase.chosen === action.index || phase.scenes[action.index].kind !== 'ready' ? phase : remake(phase, { chosen: action.index, generated: null }));
    case 'pbnTune':
      return onChoosing(items, action.id, (phase) => (phase.chosen === null ? { ...phase, tuning: action.tuning } : remake(phase, { tuning: action.tuning })));
    case 'pbnMade':
      return onChoosing(items, action.id, (phase) => (phase.rev === action.rev ? { ...phase, generated: action.generated, regenerating: false } : phase));
    case 'pbnFailed':
      return onChoosing(items, action.id, (phase) => (phase.rev === action.rev ? { ...phase, regenerating: false, error: action.message } : phase));
  }
}
