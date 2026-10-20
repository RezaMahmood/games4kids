import { describe, expect, it } from 'vitest';
import { createBlobCache } from './cache';

type Reply = { status: number; body?: string; etag?: string };

function setup(replies: Record<string, Reply[]>, maxEntries = 10) {
  const requests: { path: string; ifNoneMatch: string | null }[] = [];
  const created: string[] = [];
  const revoked: string[] = [];
  const fetchPath = async (path: string, init?: RequestInit) => {
    requests.push({ path, ifNoneMatch: new Headers(init?.headers).get('if-none-match') });
    const reply = replies[path]!.shift()!;
    return new Response(reply.status === 304 ? null : reply.body ?? '', { status: reply.status, headers: reply.etag ? { etag: reply.etag } : {} });
  };
  const cache = createBlobCache({
    fetchPath,
    createUrl: () => { const url = `blob:${created.length}`; created.push(url); return url; },
    revokeUrl: (url) => { revoked.push(url); },
    maxEntries,
  });
  return { cache, requests, created, revoked };
}

describe('blob cache', () => {
  it('fetches a file once and serves the same object URL after that', async () => {
    const { cache, requests, created } = setup({ '/a': [{ status: 200, body: 'A' }] });
    const first = await cache.url('/a');
    const second = await cache.url('/a');
    expect(second).toBe(first);
    expect(requests).toHaveLength(1);
    expect(created).toHaveLength(1);
    expect(await (await cache.blob('/a')).text()).toBe('A');
  });

  it('shares one request between concurrent callers', async () => {
    const { cache, requests } = setup({ '/a': [{ status: 200, body: 'A' }] });
    const [x, y] = await Promise.all([cache.url('/a'), cache.url('/a')]);
    expect(x).toBe(y);
    expect(requests).toHaveLength(1);
  });

  it('revalidates with the stored ETag and keeps the cached body on 304', async () => {
    const { cache, requests, revoked } = setup({ '/d': [{ status: 200, body: 'v1', etag: '"1"' }, { status: 304 }] });
    const first = await cache.url('/d', true);
    const again = await cache.url('/d', true);
    expect(again).toBe(first);
    expect(requests[1]!.ifNoneMatch).toBe('"1"');
    expect(revoked).toEqual([]);
  });

  it('replaces the body and revokes the old URL when the file changed', async () => {
    const { cache, revoked } = setup({ '/d': [{ status: 200, body: 'v1', etag: '"1"' }, { status: 200, body: 'v2', etag: '"2"' }, { status: 304 }] });
    const first = await cache.url('/d', true);
    const changed = await cache.url('/d', true);
    expect(changed).not.toBe(first);
    expect(revoked).toEqual([first]);
    expect(await (await cache.blob('/d')).text()).toBe('v2');
    expect(await cache.url('/d', true)).toBe(changed);
  });

  it('fetches in full again when the server sent no ETag', async () => {
    const { cache, requests } = setup({ '/d': [{ status: 200, body: 'v1' }, { status: 200, body: 'v2' }] });
    await cache.url('/d', true);
    await cache.url('/d', true);
    expect(requests.map((r) => r.ifNoneMatch)).toEqual([null, null]);
  });

  it('does not touch the network for a plain read of a cached file', async () => {
    const { cache, requests } = setup({ '/a': [{ status: 200, body: 'A' }] });
    await cache.url('/a');
    await cache.url('/a');
    await cache.blob('/a');
    expect(requests).toHaveLength(1);
  });

  it('evicts the least recently used file and revokes its URL', async () => {
    const { cache, revoked, requests } = setup({
      '/a': [{ status: 200, body: 'A' }],
      '/b': [{ status: 200, body: 'B' }, { status: 200, body: 'B again' }],
      '/c': [{ status: 200, body: 'C' }],
    }, 2);
    await cache.url('/a');
    const b = await cache.url('/b');
    await cache.url('/a');
    await cache.url('/c');
    expect(revoked).toEqual([b]);
    await cache.url('/b');
    expect(requests.filter((r) => r.path === '/b')).toHaveLength(2);
  });

  it('throws the status for a missing file and drops what it had cached', async () => {
    const { cache, revoked } = setup({ '/d': [{ status: 200, body: 'v1', etag: '"1"' }, { status: 404 }] });
    const url = await cache.url('/d', true);
    await expect(cache.url('/d', true)).rejects.toMatchObject({ status: 404 });
    expect(revoked).toEqual([url]);
  });
});
