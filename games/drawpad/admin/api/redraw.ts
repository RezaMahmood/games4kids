import { imageUse, type BilledAs, type ImageTokens } from '@g4k/sdk';
import type { Photo } from '../../data/model.ts';
import type { RedrawQuality } from '../../data/types.ts';
import { failure, postFoundry, type FoundryDeps } from './foundry.ts';

export const REDRAWS: Record<RedrawQuality, { deployment: BilledAs<ImageTokens>; quality: 'medium' }> = {
	standard: { deployment: 'gpt-image-1-mini', quality: 'medium' },
	best: { deployment: 'gpt-image-2', quality: 'medium' },
};

export const PROMPT =
	'Turn this photo into a clean colouring book page. Dark navy outline only on a plain white background. Draw each real object as one bold closed shape with a smooth continuous line. Skip texture, reflections, windows and shading, simplify busy areas into a few large shapes, and leave no stray marks.';

export const REDRAW_CODES = { failed: 'redraw_failed', refused: 'redraw_refused' } as const;

/** The image models draw only at these sizes, so pick the one nearest the photo's shape. */
export function pickSize(width: number, height: number): '1536x1024' | '1024x1536' | '1024x1024' {
	if (width > 1.15 * height) return '1536x1024';
	if (height > 1.15 * width) return '1024x1536';
	return '1024x1024';
}

/** Redraws the photo with a Foundry image model, as colouring-book line art, returning PNG bytes. */
export async function redraw(deps: FoundryDeps, photo: Photo, quality: RedrawQuality): Promise<Uint8Array> {
	const { deployment, quality: level } = REDRAWS[quality];
	const form = new FormData();
	form.set('model', deployment);
	form.set('prompt', PROMPT);
	form.set('size', pickSize(photo.width, photo.height));
	form.set('quality', level);
	form.set('n', '1');
	form.set('image', new Blob([new Uint8Array(photo.jpeg)], { type: 'image/jpeg' }), 'photo.jpg');
	return pngOf(await postFoundry(deps, 'images/edits', { body: form }, REDRAW_CODES, (raw) => imageUse('redraw', deployment, raw)));
}

/** The PNG bytes of an image model reply. */
export function pngOf(reply: unknown): Uint8Array {
	const png = (reply as { data?: { b64_json?: unknown }[] } | null)?.data?.[0]?.b64_json;
	if (typeof png !== 'string') throw failure(REDRAW_CODES.failed, 'the reply had no image');
	return Uint8Array.from(atob(png), (char) => char.charCodeAt(0));
}
