import { HttpError, type Reply } from '@g4k/sdk';
import type { ImageRead } from './stores.ts';

export const nothingHere = () => new HttpError(404, 'not_found', 'There is nothing here.');

/** A stored image as a reply: its bytes and ETag, or a 304 when the page already holds this ETag. */
export function imageReply(found: ImageRead, contentType: string, cacheControl: string): Reply {
	if (found === undefined) throw nothingHere();
	if (found === 'not-modified') return { status: 304 };
	return { status: 200, bytes: found.bytes, contentType, cacheControl, etag: found.etag };
}

export const PICTURE_FILES: ReadonlyMap<string, string> = new Map([
	['outline.png', 'image/png'],
	['pbn-regions.png', 'image/png'],
	['pbn-preview.png', 'image/png'],
	['original.jpg', 'image/jpeg'],
	['pbn.json', 'application/json'],
]);

/** A library picture never changes under its URL. */
export const IMMUTABLE = 'private, max-age=31536000, immutable';

/** A job's picture or a drawing's pen layer can be made again under the same URL, so the page revalidates it with its ETag. */
export const REVALIDATE = 'private, no-cache';
