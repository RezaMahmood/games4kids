import { HttpError, type Reply } from '@g4k/sdk';
import type { ImageRead } from './stores.ts';

export const nothingHere = () => new HttpError(404, 'not_found', 'There is nothing here.');

/** A redraw or an upload replaces a round's picture under the same URL, so the page revalidates it with its ETag. */
export const REVALIDATE = 'private, no-cache';

/** A stored picture as a reply: its bytes and ETag, or a 304 when the page already holds this ETag. */
export function imageReply(found: ImageRead): Reply {
	if (found === undefined) throw nothingHere();
	if (found === 'not-modified') return { status: 304 };
	return { status: 200, bytes: found.bytes, contentType: found.contentType, cacheControl: REVALIDATE, etag: found.etag };
}
