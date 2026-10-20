export class BlobFailure extends Error {
  constructor(readonly status: number) {
    super(`${status}`);
  }
}

type Entry = { blob: Blob; etag: string | null; url: string | null };

type Options = {
  fetchPath: (path: string, init?: RequestInit) => Promise<Response>;
  createUrl: (blob: Blob) => string;
  revokeUrl: (url: string) => void;
  maxEntries: number;
};

export type BlobCache = {
  blob(path: string, revalidate?: boolean): Promise<Blob>;
  url(path: string, revalidate?: boolean): Promise<string>;
};

/**
 * Authenticated stand-in for `<img src>`: bodies are kept in memory by path, least recently used out.
 * With `revalidate` a cached body is confirmed with If-None-Match, so picture files (immutable) cost
 * nothing after the first load and drawing images cost a 304 when unchanged.
 */
export function createBlobCache({ fetchPath, createUrl, revokeUrl, maxEntries }: Options): BlobCache {
  const entries = new Map<string, Entry>();
  const pending = new Map<string, Promise<Entry>>();

  const forget = (path: string) => {
    const old = entries.get(path);
    entries.delete(path);
    if (old?.url) revokeUrl(old.url);
  };

  const store = (path: string, entry: Entry) => {
    forget(path);
    entries.set(path, entry);
    for (const [oldest] of entries) {
      if (entries.size <= maxEntries) break;
      if (oldest !== path) forget(oldest);
    }
  };

  const touch = (path: string, entry: Entry) => {
    if (entries.get(path) !== entry) return;
    entries.delete(path);
    entries.set(path, entry);
  };

  async function load(path: string, cached: Entry | undefined, revalidate: boolean): Promise<Entry> {
    if (cached && !revalidate) return cached;
    const conditional = cached?.etag ? { headers: { 'if-none-match': cached.etag } } : undefined;
    const res = await fetchPath(path, conditional);
    if (res.status === 304 && cached) return cached;
    if (!res.ok) {
      forget(path);
      throw new BlobFailure(res.status);
    }
    const fresh: Entry = { blob: await res.blob(), etag: res.headers.get('etag'), url: null };
    store(path, fresh);
    return fresh;
  }

  async function entry(path: string, revalidate: boolean): Promise<Entry> {
    const cached = entries.get(path);
    if (cached && !revalidate) {
      touch(path, cached);
      return cached;
    }
    const key = `${revalidate ? 'r' : 'g'}${path}`;
    const inflight = pending.get(key);
    if (inflight) return inflight;
    const started = load(path, cached, revalidate).finally(() => pending.delete(key));
    pending.set(key, started);
    const loaded = await started;
    touch(path, loaded);
    return loaded;
  }

  return {
    async blob(path, revalidate = false) {
      return (await entry(path, revalidate)).blob;
    },
    async url(path, revalidate = false) {
      const loaded = await entry(path, revalidate);
      loaded.url ??= createUrl(loaded.blob);
      return loaded.url;
    },
  };
}
