import { describe, expect, it } from 'vitest';
import type { PbnResult } from '../stencil/pbn';
import {
  checkDescription, chosenPicture, DEFAULT_PBN_TUNING, DEFAULT_TUNING, looksMeaningless, reduce, titleFromDescription, titleFromFile,
  type DescriptionItem, type Generated, type Item, type PhotoItem, type Scenes,
} from './uploadModel';

const photo = { data: new Uint8ClampedArray(4), width: 1, height: 1 };
const nothing: Generated = { outline: photo, tuning: DEFAULT_TUNING };
const item = (id: number, name = `p${id}.jpg`): PhotoItem => ({
  id, source: 'photo', file: new File([], name), title: titleFromFile(name), titleSource: 'file', suggestions: [], jobIds: [],
  tuning: DEFAULT_TUNING, phase: { kind: 'waiting' },
});
const ready = (id: number) => reduce([item(id)], { type: 'loaded', id, photo, generated: nothing, redraws: { 'trace-standard': photo } });
const phaseOf = (items: Item[]) => items[0]!.phase;
const tuningOf = (items: Item[]) => (items[0] as PhotoItem).tuning;

describe('upload queue', () => {
  it('moves an item from waiting through working to ready', () => {
    let items = reduce([], { type: 'queued', items: [item(1)] });
    expect(phaseOf(items).kind).toBe('waiting');
    items = reduce(items, { type: 'progress', id: 1, label: 'Finding colours', progress: 0.6 });
    expect(phaseOf(items)).toEqual({ kind: 'working', label: 'Finding colours', progress: 0.6 });
    items = reduce(items, { type: 'loaded', id: 1, photo, generated: nothing, redraws: {} });
    expect(phaseOf(items).kind).toBe('ready');
  });

  it('ignores a regeneration result that a newer slider move has superseded', () => {
    let items = ready(1);
    items = reduce(items, { type: 'tune', id: 1, tuning: { ...DEFAULT_TUNING, detail: 0.25 } });
    items = reduce(items, { type: 'tune', id: 1, tuning: { ...DEFAULT_TUNING, detail: 0.75 } });
    const fresh: Generated = { outline: photo, tuning: { ...DEFAULT_TUNING, detail: 0.75 } };
    items = reduce(items, { type: 'regenerated', id: 1, rev: 1, generated: fresh });
    expect(phaseOf(items)).toMatchObject({ regenerating: true, generated: nothing });
    items = reduce(items, { type: 'regenerated', id: 1, rev: 2, generated: fresh });
    expect(phaseOf(items)).toMatchObject({ regenerating: false, generated: fresh });
    expect(tuningOf(items).detail).toBe(0.75);
  });

  it('shows the outline it fell back to, and why, when the AI outline failed on load', () => {
    const classic: Generated = { outline: photo, tuning: { ...DEFAULT_TUNING, outline: 'classic' } };
    const items = reduce([item(1)], { type: 'loaded', id: 1, photo, generated: classic, redraws: {}, error: 'The AI service declined this photo.' });
    expect(tuningOf(items).outline).toBe('classic');
    expect(phaseOf(items)).toMatchObject({ kind: 'ready', generated: classic, redraws: {}, error: 'The AI service declined this photo.' });
  });

  it('waits for an AI outline the admin has not asked for, and draws only once it is back', () => {
    let items = reduce(ready(1), { type: 'tune', id: 1, tuning: { ...DEFAULT_TUNING, outline: 'best' } });
    expect(phaseOf(items)).toMatchObject({ regenerating: false, redraws: { 'trace-standard': { kind: 'ready' } } });
    expect(phaseOf(items)).not.toHaveProperty('redraws.trace-best');
    items = reduce(items, { type: 'redrawWaiting', id: 1, keys: ['trace-best'], label: 'Waiting for its turn, next up' });
    expect(phaseOf(items)).toMatchObject({ regenerating: false, redraws: { 'trace-best': { kind: 'waiting', label: 'Waiting for its turn, next up' } } });
    items = reduce(items, { type: 'redrawn', id: 1, redraws: { 'trace-best': photo }, failed: {} });
    expect(phaseOf(items)).toMatchObject({ regenerating: true, redraws: { 'trace-best': { kind: 'ready', raster: photo } }, error: null });
    expect(tuningOf(items).outline).toBe('best');
  });

  it('keeps the chosen AI outline and says why when making it failed', () => {
    let items = reduce(ready(1), { type: 'tune', id: 1, tuning: { ...DEFAULT_TUNING, outline: 'best' } });
    items = reduce(items, { type: 'redrawn', id: 1, redraws: {}, failed: { 'trace-best': 'The AI outline did not work.' } });
    expect(tuningOf(items).outline).toBe('best');
    expect(phaseOf(items)).toMatchObject({ regenerating: false, redraws: { 'trace-best': { kind: 'failed', message: 'The AI outline did not work.' } } });
  });

  it('shows the outline being made again until the new one is back, and keeps it if that fails', () => {
    const fresh = { data: new Uint8ClampedArray(4), width: 1, height: 1 };
    let items = reduce(ready(1), { type: 'redrawWaiting', id: 1, keys: ['trace-standard'], label: 'Redrawing with AI, about a minute' });
    expect(phaseOf(items)).toMatchObject({ redraws: { 'trace-standard': { kind: 'waiting', label: 'Redrawing with AI, about a minute', raster: photo } } });
    items = reduce(items, { type: 'redrawn', id: 1, redraws: {}, failed: { 'trace-standard': 'The AI outline did not work.' } });
    expect(phaseOf(items)).toMatchObject({ error: 'The AI outline did not work.', redraws: { 'trace-standard': { kind: 'ready', raster: photo } } });
    items = reduce(items, { type: 'redrawWaiting', id: 1, keys: ['trace-standard'], label: 'Redrawing with AI, about a minute' });
    items = reduce(items, { type: 'redrawn', id: 1, redraws: { 'trace-standard': fresh }, failed: {} });
    expect(phaseOf(items)).toMatchObject({ regenerating: true, redraws: { 'trace-standard': { kind: 'ready', raster: fresh } } });
  });

  it('keeps the tuning and says nothing when a redraw the admin has moved on from fails', () => {
    let items = reduce(ready(1), { type: 'redrawWaiting', id: 1, keys: ['trace-best'], label: 'Redrawing with AI, about a minute' });
    items = reduce(items, { type: 'redrawn', id: 1, redraws: {}, failed: { 'trace-best': 'The AI outline did not work.' } });
    expect(tuningOf(items)).toEqual(DEFAULT_TUNING);
    expect(phaseOf(items)).toMatchObject({ error: null, regenerating: false });
  });

  it('keeps the item and shows the problem when saving fails, then drops it from the list once added', () => {
    let items = reduce(ready(1), { type: 'saving', id: 1 });
    expect(phaseOf(items)).toMatchObject({ saving: true });
    items = reduce(items, { type: 'saveFailed', id: 1, message: 'Server said no' });
    expect(phaseOf(items)).toMatchObject({ saving: false, error: 'Server said no' });
    expect(reduce(items, { type: 'added', id: 1 })).toEqual([]);
  });

  it('does nothing to a discarded item when late results arrive', () => {
    const items = reduce(ready(1), { type: 'discard', id: 1 });
    expect(reduce(items, { type: 'regenerated', id: 1, rev: 0, generated: nothing })).toEqual([]);
  });
});

describe('AI title suggestions', () => {
  const titles = ['Elephant Statue', 'Grey Elephant'];

  it('replaces a meaningless file name with the best suggestion and offers them all', () => {
    const [got] = reduce([item(1, 'IMG_4823.HEIC')], { type: 'suggested', id: 1, titles });
    expect(got).toMatchObject({ title: 'Elephant Statue', titleSource: 'ai', suggestions: titles });
  });

  it('keeps a name the admin chose for the file, but still offers the suggestions', () => {
    const [got] = reduce([item(1, 'Marina Bay.jpg')], { type: 'suggested', id: 1, titles });
    expect(got).toMatchObject({ title: 'Marina Bay', titleSource: 'file', suggestions: titles });
  });

  it('never overwrites a title typed before the suggestions arrive', () => {
    let items = reduce([item(1, 'C296D0CA-7562-476A-9AC3-D19EB3E6097D.jpeg')], { type: 'retitle', id: 1, title: 'Zoo trip' });
    items = reduce(items, { type: 'suggested', id: 1, titles });
    expect(items[0]).toMatchObject({ title: 'Zoo trip', titleSource: 'edited', suggestions: titles });
  });

  it('treats a chosen suggestion as the admin title', () => {
    let items = reduce([item(1, 'IMG_1.jpg')], { type: 'suggested', id: 1, titles });
    items = reduce(items, { type: 'retitle', id: 1, title: titles[1]! });
    items = reduce(items, { type: 'suggested', id: 1, titles: ['Something Else'] });
    expect(items[0]).toMatchObject({ title: 'Grey Elephant', titleSource: 'edited' });
  });

  it('does nothing when suggestions arrive for a discarded item', () => {
    expect(reduce(reduce([item(1)], { type: 'discard', id: 1 }), { type: 'suggested', id: 1, titles })).toEqual([]);
  });
});

describe('looksMeaningless', () => {
  it.each([
    ['C296D0CA-7562-476A-9AC3-D19EB3E6097D.jpeg', true],
    ['IMG_4823.HEIC', true],
    ['17CD5D5C_1_105_c.jpeg', true],
    ['IMG_E4823.JPG', true],
    ['DSC01234.JPG', true],
    ['DSCN0042.jpg', true],
    ['PXL_20231005_142233123.MP.jpg', true],
    ['MVIMG_20190101_120000.jpg', true],
    ['Screenshot 2024-01-05 at 10.22.33.png', true],
    ['WhatsApp Image 2024-01-05 at 10.22.33.jpeg', true],
    ['photo-1520975954732.jpg', true],
    ['20231005_142233.jpg', true],
    ['image (1).png', true],
    ['DEADBEEF.png', false],
    ['Marina Bay.jpg', false],
    ['Lotus.png', false],
    ['Grandma 80th.jpg', false],
    ['Mum 2019.jpg', false],
    ['our-garden.jpg', false],
    ['Photo of Grandma.jpg', false],
    ['facade.jpg', false],
    ['Images of Rome.png', false],
  ])('%s is %s', (name, meaningless) => expect(looksMeaningless(name)).toBe(meaningless));
});

describe('titleFromFile', () => {
  it.each([
    ['our-garden.jpg', 'Our garden'],
    ['IMG_1234.HEIC', 'IMG 1234'],
    ['.png', 'Untitled'],
    ['x'.repeat(90) + '.jpg', 'X' + 'x'.repeat(59)],
  ])('%s becomes %s', (name, title) => expect(titleFromFile(name)).toBe(title));
});

describe('a description becoming a paint by number', () => {
  const raster = (width: number) => ({ data: new Uint8ClampedArray(width * width * 4), width, height: width });
  const third = raster(3);
  const scenes: Scenes = [{ kind: 'ready', raster: raster(1) }, { kind: 'failed', error: 'redraw_refused' }, { kind: 'ready', raster: third }];
  const pbn = (colors: number): PbnResult => ({ pbn: { width: 3, height: 3, palette: Array(colors).fill('#FFFFFF'), regions: [] }, regions: raster(3), preview: raster(3) });
  const described = (id: number): DescriptionItem => ({
    id, source: 'description', description: 'a fox asleep under an autumn tree', quality: 'standard',
    title: titleFromDescription('a fox asleep under an autumn tree'), titleSource: 'description', suggestions: [], jobIds: [],
    phase: { kind: 'waiting', label: 'Waiting for its turn, next up' },
  });
  const choosing = (items: Item[]) => {
    const { phase } = items[0]!;
    if (phase.kind !== 'choosing') throw new Error(`expected choosing, got ${phase.kind}`);
    return phase;
  };
  const drawn = () => reduce([described(1)], { type: 'drawn', id: 1, scenes });

  it('waits with the queue wording, then offers the pictures with nothing picked yet', () => {
    let items = reduce([described(1)], { type: 'sceneWaiting', id: 1, label: 'Drawing 3 pictures with AI, about 2 minutes' });
    expect(phaseOf(items)).toEqual({ kind: 'waiting', label: 'Drawing 3 pictures with AI, about 2 minutes' });
    items = reduce(items, { type: 'drawn', id: 1, scenes });
    expect(choosing(items)).toMatchObject({ scenes, chosen: null, generated: null, tuning: DEFAULT_PBN_TUNING, regenerating: false });
  });

  it('fails with the reason when none of the three pictures came back', () => {
    const none: Scenes = [{ kind: 'failed', error: 'redraw_refused' }, { kind: 'failed', error: 'redraw_failed' }, { kind: 'failed', error: 'redraw_failed' }];
    const items = reduce([described(1)], { type: 'drawn', id: 1, scenes: none });
    expect(phaseOf(items)).toEqual({ kind: 'failed', message: "None of the 3 pictures could be drawn. The AI's safety check refused this picture." });
  });

  it('makes the paint by number for a picked picture, and ignores a pick of one that failed', () => {
    let items = reduce(drawn(), { type: 'pick', id: 1, index: 1 });
    expect(choosing(items)).toMatchObject({ chosen: null, regenerating: false });
    items = reduce(items, { type: 'pick', id: 1, index: 2 });
    expect(choosing(items)).toMatchObject({ chosen: 2, regenerating: true });
    expect(chosenPicture(choosing(items))).toBeNull();
    const made = pbn(8);
    items = reduce(items, { type: 'pbnMade', id: 1, rev: choosing(items).rev, generated: made });
    expect(choosing(items)).toMatchObject({ chosen: 2, generated: made, regenerating: false });
    expect(chosenPicture(choosing(items))).toEqual({ scene: third, pbn: made });
  });

  it('never shows the paint by number of the previous pick after picking another', () => {
    let items = reduce(drawn(), { type: 'pick', id: 1, index: 0 });
    const first = choosing(items).rev;
    items = reduce(items, { type: 'pick', id: 1, index: 2 });
    items = reduce(items, { type: 'pbnMade', id: 1, rev: first, generated: pbn(8) });
    expect(choosing(items)).toMatchObject({ chosen: 2, generated: null, regenerating: true });
  });

  it('keeps only the result for the latest colour and detail change', () => {
    let items = reduce(drawn(), { type: 'pick', id: 1, index: 0 });
    items = reduce(items, { type: 'pbnTune', id: 1, tuning: { colors: 6, detail: 0.5 } });
    const stale = choosing(items).rev;
    items = reduce(items, { type: 'pbnTune', id: 1, tuning: { colors: 12, detail: 0.75 } });
    items = reduce(items, { type: 'pbnMade', id: 1, rev: stale, generated: pbn(6) });
    expect(choosing(items)).toMatchObject({ generated: null, regenerating: true, tuning: { colors: 12, detail: 0.75 } });
    const fresh = pbn(12);
    items = reduce(items, { type: 'pbnMade', id: 1, rev: choosing(items).rev, generated: fresh });
    expect(choosing(items)).toMatchObject({ generated: fresh, regenerating: false });
    items = reduce(items, { type: 'pbnFailed', id: 1, rev: stale, message: 'old' });
    expect(choosing(items).error).toBeNull();
  });

  it('remembers a tuning set before any pick, then uses it for the pick', () => {
    let items = reduce(drawn(), { type: 'pbnTune', id: 1, tuning: { colors: 5, detail: 0 } });
    expect(choosing(items)).toMatchObject({ regenerating: false, tuning: { colors: 5, detail: 0 } });
    items = reduce(items, { type: 'pick', id: 1, index: 0 });
    expect(choosing(items)).toMatchObject({ chosen: 0, regenerating: true, tuning: { colors: 5, detail: 0 } });
  });

  it('takes the first AI title over the description, but never over a typed one', () => {
    const titles = ['Sleepy Fox', 'Autumn Nap'];
    expect(reduce([described(1)], { type: 'suggested', id: 1, titles })[0]).toMatchObject({ title: 'Sleepy Fox', titleSource: 'ai', suggestions: titles });
    let items = reduce([described(1)], { type: 'retitle', id: 1, title: 'Foxy' });
    items = reduce(items, { type: 'suggested', id: 1, titles });
    expect(items[0]).toMatchObject({ title: 'Foxy', suggestions: titles });
  });

  it('saves like a photo: shows a failure, then leaves the list once added', () => {
    let items = reduce(reduce(drawn(), { type: 'pick', id: 1, index: 0 }), { type: 'saving', id: 1 });
    expect(choosing(items)).toMatchObject({ saving: true });
    items = reduce(items, { type: 'saveFailed', id: 1, message: 'Server said no' });
    expect(choosing(items)).toMatchObject({ saving: false, error: 'Server said no' });
    expect(reduce(items, { type: 'added', id: 1 })).toEqual([]);
  });

  it('leaves a photo alone when description actions name it', () => {
    const photos = [item(1)];
    expect(reduce(photos, { type: 'drawn', id: 1, scenes })).toEqual(photos);
    expect(reduce(ready(1), { type: 'pick', id: 1, index: 0 })).toEqual(ready(1));
  });
});

describe('checkDescription', () => {
  it.each([
    ['', false, 'Describe the picture first.'],
    ['  ab  ', false, 'Use at least 3 characters.'],
    ['x'.repeat(301), false, 'Keep it to 300 characters.'],
  ])('refuses %j', (text, ok, hint) => expect(checkDescription(text)).toEqual({ ok, hint }));

  it('takes 3 to 300 characters, trimmed', () => {
    expect(checkDescription('  fox  ')).toEqual({ ok: true, description: 'fox' });
    expect(checkDescription(` ${'x'.repeat(300)} `)).toEqual({ ok: true, description: 'x'.repeat(300) });
  });
});
