import { describe, expect, it } from 'vitest';
import { HttpError } from '@g4k/sdk';
import {
  idParam,
  parseDescriptionJob,
  parseDrawingPatch,
  parseHeartbeat,
  parseLimit,
  parseNewDrawing,
  parseNewPicture,
  parsePhotoJob,
  parseRedraw,
  parseRename,
  requiredPictureFiles,
} from './parse.ts';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return (error as HttpError).code;
  }
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff]);

describe('parseHeartbeat', () => {
  it('clamps seconds to 0..90', () => {
    expect(parseHeartbeat({ seconds: 99 })).toBe(90);
    expect(parseHeartbeat({ seconds: -5 })).toBe(0);
    expect(parseHeartbeat({ seconds: 12 })).toBe(12);
  });

  it('rejects non-numeric seconds', () => {
    expect(codeOf(() => parseHeartbeat({ seconds: '5' }))).toBe('invalid');
    expect(codeOf(() => parseHeartbeat({}))).toBe('invalid');
    expect(codeOf(() => parseHeartbeat(null))).toBe('invalid');
  });
});

describe('parseNewDrawing', () => {
  it('needs a picture id that cannot escape a blob path and a known kind', () => {
    expect(parseNewDrawing({ pictureId: 'p-1', kind: 'pbn' })).toEqual({ pictureId: 'p-1', kind: 'pbn' });
    expect(codeOf(() => parseNewDrawing({ pictureId: '../x', kind: 'pbn' }))).toBe('invalid');
    expect(codeOf(() => parseNewDrawing({ pictureId: 'p-1', kind: 'free' }))).toBe('invalid');
  });
});

describe('idParam', () => {
  it('answers 404 for a missing or unsafe id, so a bad path and a missing row look alike', () => {
    expect(idParam('abc-1')).toBe('abc-1');
    expect(codeOf(() => idParam('a/b'))).toBe('not_found');
    expect(codeOf(() => idParam(undefined))).toBe('not_found');
  });
});

describe('parseDrawingPatch', () => {
  it('recomputes stars from the total and clamps it', () => {
    const { score } = parseDrawingPatch({ score: { total: 130, stars: 1, breakdown: { tracing: 35 } } });
    expect(score).toEqual({ total: 100, stars: 5, breakdown: { tracing: 35 } });
  });

  it('checks region ids and the status', () => {
    expect(parseDrawingPatch({ filledRegions: [1, 70] }).filledRegions).toEqual([1, 70]);
    expect(codeOf(() => parseDrawingPatch({ filledRegions: [0] }))).toBe('invalid');
    expect(codeOf(() => parseDrawingPatch({ status: 'done' }))).toBe('invalid');
  });

  it('accepts own colours for painted regions and normalises the hex', () => {
    const patch = parseDrawingPatch({ filledRegions: [1, 70], customFills: { 70: '#3da5d9' } });
    expect(patch.customFills).toEqual({ 70: '#3DA5D9' });
    expect(parseDrawingPatch({ filledRegions: [1], customFills: {} }).customFills).toEqual({});
  });

  it('leaves own colours out when the field is absent', () => {
    expect(parseDrawingPatch({ filledRegions: [1] })).not.toHaveProperty('customFills');
  });

  it.each([
    ['a region not painted in the patch', { filledRegions: [1], customFills: { 2: '#FFFFFF' } }],
    ['no filledRegions alongside', { customFills: { 1: '#FFFFFF' } }],
    ['a non-canonical region key', { filledRegions: [1], customFills: { '01': '#FFFFFF' } }],
    ['a short hex', { filledRegions: [1], customFills: { 1: '#FFF' } }],
    ['a named colour', { filledRegions: [1], customFills: { 1: 'red' } }],
    ['a non-string colour', { filledRegions: [1], customFills: { 1: 0xffffff } }],
    ['a list instead of a map', { filledRegions: [1], customFills: [[1, '#FFFFFF']] }],
  ])('rejects own colours with %s', (_, body) => {
    expect(codeOf(() => parseDrawingPatch(body))).toBe('invalid');
  });

  it('caps how many own colours one drawing can hold', () => {
    const ids = Array.from({ length: 1001 }, (_, i) => i + 1);
    const customFills: Record<number, string> = Object.fromEntries(ids.map((id) => [id, '#ABCDEF']));
    expect(codeOf(() => parseDrawingPatch({ filledRegions: ids, customFills }))).toBe('invalid');
    delete customFills[1001];
    expect(Object.keys(parseDrawingPatch({ filledRegions: ids, customFills }).customFills!)).toHaveLength(1000);
  });
});

describe('parseLimit', () => {
  it('accepts whole minutes in a day, or null to fall back to the default', () => {
    expect(parseLimit({ dailyLimitMinutes: 45 })).toBe(45);
    expect(parseLimit({ dailyLimitMinutes: 0 })).toBe(0);
    expect(parseLimit({ dailyLimitMinutes: null })).toBeNull();
    for (const bad of [-1, 1441, 1.5, '30', undefined]) expect(codeOf(() => parseLimit({ dailyLimitMinutes: bad }))).toBe('invalid');
  });
});

describe('parseNewPicture', () => {
  const pbn = { width: 4, height: 3, palette: ['#fff'], regions: [{ id: 1, colorIndex: 0, labelX: 1, labelY: 1 }] };
  const base = { title: ' House ', width: 4, height: 3 };

  it('trims the title, keeps each kind once, and needs the pbn data for a paint by numbers picture', () => {
    expect(parseNewPicture({ ...base, kinds: ['trace', 'trace'] })).toEqual({ title: 'House', kinds: ['trace'], width: 4, height: 3 });
    expect(codeOf(() => parseNewPicture({ ...base, kinds: ['pbn'] }))).toBe('invalid');
    expect(parseNewPicture({ ...base, kinds: ['trace', 'pbn'], pbn })).toMatchObject({ kinds: ['trace', 'pbn'], pbn });
  });

  it('rejects oversized pictures, empty kinds, a long title and pbn data that disagrees with the picture', () => {
    expect(codeOf(() => parseNewPicture({ ...base, width: 2000, kinds: ['trace'] }))).toBe('invalid');
    expect(codeOf(() => parseNewPicture({ ...base, kinds: [] }))).toBe('invalid');
    expect(codeOf(() => parseNewPicture({ ...base, title: 'x'.repeat(61), kinds: ['trace'] }))).toBe('invalid');
    expect(codeOf(() => parseNewPicture({ ...base, kinds: ['pbn'], pbn: { ...pbn, width: 9 } }))).toBe('invalid');
    expect(codeOf(() => parseNewPicture({ ...base, kinds: ['pbn'], pbn: { ...pbn, regions: [{ id: 1, colorIndex: 5, labelX: 0, labelY: 0 }] } }))).toBe('invalid');
  });

  it('names the image files each kind needs before it can join the library', () => {
    expect(requiredPictureFiles({ kinds: ['trace'] })).toEqual(['original.jpg', 'outline.png']);
    expect(requiredPictureFiles({ kinds: ['pbn'] })).toEqual(['original.jpg', 'pbn-regions.png', 'pbn-preview.png']);
  });

  it('trims a new name and refuses an empty one', () => {
    expect(parseRename({ title: '  Fox ' })).toBe('Fox');
    expect(codeOf(() => parseRename({ title: '  ' }))).toBe('invalid');
  });
});

describe('the AI job requests', () => {
  const query = (fields: Record<string, string>) => new URLSearchParams(fields);

  it('puts titles first and then each redraw as asked, for a photo of at most 1024 pixels', () => {
    expect(parsePhotoJob(query({ width: '30', height: '20', wants: 'best,standard', titles: '1' }), JPEG)).toEqual({
      source: 'photo',
      photo: { jpeg: JPEG, width: 30, height: 20 },
      steps: ['titles', 'trace-best', 'trace-standard'],
    });
    expect(parsePhotoJob(query({ width: '30', height: '20', wants: 'standard', titles: '0' }), JPEG)).toMatchObject({ steps: ['trace-standard'] });
  });

  it.each([
    ['a job that asks for nothing', { width: '30', height: '20', wants: '', titles: '0' }],
    ['the same quality twice', { width: '30', height: '20', wants: 'best,best', titles: '1' }],
    ['an unknown quality', { width: '30', height: '20', wants: 'ultra', titles: '1' }],
    ['a photo past 1024 pixels', { width: '2000', height: '20', wants: 'best', titles: '1' }],
    ['no size', { wants: 'best', titles: '1' }],
  ])('rejects %s', (_, fields) => {
    expect(codeOf(() => parsePhotoJob(query(fields), JPEG))).toBe('invalid');
  });

  it('accepts a description of 3 to 300 characters once trimmed', () => {
    expect(parseDescriptionJob({ description: '  a fox  ', quality: 'best' })).toEqual({ source: 'description', description: 'a fox', quality: 'best' });
    for (const description of ['  ab  ', 'x'.repeat(301), 7]) expect(codeOf(() => parseDescriptionJob({ description, quality: 'best' }))).toBe('invalid');
    expect(codeOf(() => parseDescriptionJob({ description: 'a fox', quality: 'ultra' }))).toBe('invalid');
  });

  it('turns a redraw request into the step it asks for', () => {
    expect(parseRedraw({ quality: 'best' })).toBe('trace-best');
    expect(codeOf(() => parseRedraw({ quality: 'ultra' }))).toBe('invalid');
  });
});
