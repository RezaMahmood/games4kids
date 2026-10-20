import { HttpError } from '@g4k/sdk';
import { isValidId, starsFor } from './ids.ts';
import { clampHeartbeatSeconds } from './usage.ts';
import type { NewJob, Photo } from './model.ts';
import type { DrawingMeta, PbnData, PhotoStepKey, PictureKind, RedrawQuality, Score } from './types.ts';

type Json = Record<string, unknown>;

export const TITLE_MAX = 60;
export const REDRAW_QUALITIES: readonly RedrawQuality[] = ['standard', 'best'];

const PICTURE_KINDS: readonly PictureKind[] = ['trace', 'pbn'];
const MAX_DIMENSION = 1024;
const MAX_REGION_ID = 65535;
// Keeps the stored JSON well inside a Table string property; pictures have at most a few hundred regions.
const MAX_CUSTOM_FILLS = 1000;
const MAX_LIMIT_MINUTES = 24 * 60;
const HEX_COLOUR = /^#[0-9a-f]{6}$/i;
const DESCRIPTION_MIN = 3;
const DESCRIPTION_MAX = 300;

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

const isInt = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

export const invalid = () => new HttpError(400, 'invalid', 'That request is not valid.');

function record(value: unknown): Json {
	if (!isRecord(value)) throw invalid();
	return value;
}

export function idParam(value: string | undefined): string {
	if (!value || !isValidId(value)) throw new HttpError(404, 'not_found', 'There is nothing here.');
	return value;
}

export function parseHeartbeat(body: unknown): number {
	const { seconds } = record(body);
	if (typeof seconds !== 'number' || !Number.isFinite(seconds)) throw invalid();
	return clampHeartbeatSeconds(seconds);
}

function pictureKind(value: unknown): PictureKind {
	if (!PICTURE_KINDS.includes(value as PictureKind)) throw invalid();
	return value as PictureKind;
}

export function parseNewDrawing(body: unknown): { pictureId: string; kind: PictureKind } {
	const { pictureId, kind } = record(body);
	if (typeof pictureId !== 'string' || !isValidId(pictureId)) throw invalid();
	return { pictureId, kind: pictureKind(kind) };
}

function parseScore(value: unknown): Score {
	const { total, breakdown } = record(value);
	if (typeof total !== 'number' || !Number.isFinite(total)) throw invalid();
	const parts = record(breakdown);
	if (!Object.values(parts).every((part) => typeof part === 'number' && Number.isFinite(part))) throw invalid();
	const clamped = Math.min(100, Math.max(0, total));
	return { total: clamped, stars: starsFor(clamped), breakdown: parts as Score['breakdown'] };
}

export type DrawingPatch = {
	filledRegions?: number[];
	customFills?: Record<number, string>;
	status?: DrawingMeta['status'];
	score?: Score;
};

/** Each key must be a region painted in the same patch, so a custom colour never names a region the drawing has not painted. */
function parseCustomFills(value: unknown, filledRegions: number[] | undefined): Record<number, string> {
	const entries = Object.entries(record(value));
	if (!filledRegions || entries.length > MAX_CUSTOM_FILLS) throw invalid();
	const painted = new Set(filledRegions);
	const fills: Record<number, string> = {};
	for (const [key, hex] of entries) {
		const id = Number(key);
		if (String(id) !== key || !painted.has(id) || typeof hex !== 'string' || !HEX_COLOUR.test(hex)) throw invalid();
		fills[id] = hex.toUpperCase();
	}
	return fills;
}

export function parseDrawingPatch(body: unknown): DrawingPatch {
	const fields = record(body);
	const patch: DrawingPatch = {};
	if (fields['filledRegions'] !== undefined) {
		const regions = fields['filledRegions'];
		if (!Array.isArray(regions) || !regions.every((id) => isInt(id, 1, MAX_REGION_ID))) throw invalid();
		patch.filledRegions = regions;
	}
	if (fields['customFills'] !== undefined) patch.customFills = parseCustomFills(fields['customFills'], patch.filledRegions);
	if (fields['status'] !== undefined) {
		if (fields['status'] !== 'in-progress' && fields['status'] !== 'finished') throw invalid();
		patch.status = fields['status'];
	}
	if (fields['score'] !== undefined) patch.score = parseScore(fields['score']);
	return patch;
}

/** The daily limit for one child in minutes, or null to fall back to the default. */
export function parseLimit(body: unknown): number | null {
	const { dailyLimitMinutes } = record(body);
	if (dailyLimitMinutes !== null && !isInt(dailyLimitMinutes, 0, MAX_LIMIT_MINUTES)) throw invalid();
	return dailyLimitMinutes as number | null;
}

function parsePbn(value: unknown, width: number, height: number): PbnData {
	const pbn = record(value);
	const { palette, regions } = pbn;
	if (pbn['width'] !== width || pbn['height'] !== height) throw invalid();
	if (!Array.isArray(palette) || !palette.every((color) => typeof color === 'string')) throw invalid();
	if (!Array.isArray(regions)) throw invalid();
	for (const region of regions) {
		const { id, colorIndex, labelX, labelY } = record(region);
		if (!isInt(id, 1, MAX_REGION_ID) || !isInt(colorIndex, 0, palette.length - 1)) throw invalid();
		if (typeof labelX !== 'number' || typeof labelY !== 'number') throw invalid();
	}
	return pbn as PbnData;
}

/** What the page says about a picture once its image files are up. The files are sent first, one request each, under the picture's id. */
export type NewPicture = { title: string; kinds: PictureKind[]; width: number; height: number; pbn?: PbnData };

function pictureTitle(value: unknown): string {
	const title = typeof value === 'string' ? value.trim() : '';
	if (title.length < 1 || title.length > TITLE_MAX) throw invalid();
	return title;
}

/** The new name for a library picture. */
export function parseRename(body: unknown): string {
	return pictureTitle(record(body)['title']);
}

export function parseNewPicture(body: unknown): NewPicture {
	const fields = record(body);
	const title = pictureTitle(fields['title']);
	const kindList = fields['kinds'];
	if (!Array.isArray(kindList) || kindList.length === 0) throw invalid();
	const kinds = [...new Set(kindList.map(pictureKind))];
	const { width, height } = fields;
	if (!isInt(width, 1, MAX_DIMENSION) || !isInt(height, 1, MAX_DIMENSION)) throw invalid();
	const picture: NewPicture = { title, kinds, width, height };
	if (kinds.includes('pbn') || fields['pbn'] !== undefined) picture.pbn = parsePbn(fields['pbn'], width, height);
	return picture;
}

/** The image files a picture of these kinds must already have in the library. */
export function requiredPictureFiles(picture: Pick<NewPicture, 'kinds'>): string[] {
	return ['original.jpg', ...(picture.kinds.includes('trace') ? ['outline.png'] : []), ...(picture.kinds.includes('pbn') ? ['pbn-regions.png', 'pbn-preview.png'] : [])];
}

export const PICTURE_PNG_FILES = ['outline.png', 'pbn-regions.png', 'pbn-preview.png'] as const;

export const isPicturePng = (file: string | undefined): file is (typeof PICTURE_PNG_FILES)[number] => PICTURE_PNG_FILES.some((name) => name === file);

function redrawQuality(value: unknown): RedrawQuality {
	if (typeof value !== 'string' || !REDRAW_QUALITIES.some((quality) => quality === value)) throw invalid();
	return value as RedrawQuality;
}

/** The steps a photo job runs, in the order the worker runs them: titles first, then each redraw as requested. */
export function parsePhotoJob(query: URLSearchParams, jpeg: Uint8Array): NewJob {
	const width = Number(query.get('width'));
	const height = Number(query.get('height'));
	if (!isInt(width, 1, MAX_DIMENSION) || !isInt(height, 1, MAX_DIMENSION)) throw invalid();
	const wants = (query.get('wants') ?? '').split(',').filter(Boolean).map(redrawQuality);
	// Unique wants also caps the list at every quality.
	if (new Set(wants).size !== wants.length) throw invalid();
	const redraws = wants.map((quality): PhotoStepKey => `trace-${quality}`);
	const steps: PhotoStepKey[] = query.get('titles') === '1' ? ['titles', ...redraws] : redraws;
	if (!steps.length) throw invalid();
	const photo: Photo = { jpeg, width, height };
	return { source: 'photo', photo, steps };
}

export function parseDescriptionJob(body: unknown): NewJob {
	const { description: raw, quality } = record(body);
	const description = typeof raw === 'string' ? raw.trim() : '';
	if (description.length < DESCRIPTION_MIN || description.length > DESCRIPTION_MAX) throw invalid();
	return { source: 'description', description, quality: redrawQuality(quality) };
}

/** The outline a redraw request asks a photo job to make, or make again. */
export function parseRedraw(body: unknown): PhotoStepKey {
	return `trace-${redrawQuality(record(body)['quality'])}`;
}
