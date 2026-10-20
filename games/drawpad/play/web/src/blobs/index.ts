import { createBlobCache } from './cache';

const MAX_ENTRIES = 300;

type Fetch = (path: string, init?: RequestInit) => Promise<Response>;

let fetchPath: Fetch | null = null;

/** The authenticated fetch of this page's API, set once at boot. The cache lives in one bundle, so each page has its own. */
export function configureBlobs(send: Fetch): void {
  fetchPath = send;
}

export const blobs = createBlobCache({
  fetchPath: (path, init) => {
    if (!fetchPath) throw new Error('The blob cache is not configured yet.');
    return fetchPath(path, init);
  },
  createUrl: (blob) => URL.createObjectURL(blob),
  revokeUrl: (url) => URL.revokeObjectURL(url),
  maxEntries: MAX_ENTRIES,
});
