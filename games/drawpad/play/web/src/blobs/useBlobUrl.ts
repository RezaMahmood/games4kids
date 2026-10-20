import { useEffect, useRef, useState } from 'preact/hooks';
import type { RefObject } from 'preact';
import { blobs } from '.';

/**
 * The object URL for an API file, fetched with the bearer token once the element scrolls near the viewport.
 * Null while loading and when the file cannot be loaded, so callers draw nothing in both cases.
 */
export function useBlobUrl<E extends Element>(path: string, revalidate = false): [string | null, RefObject<E>] {
  const ref = useRef<E>(null);
  const [state, setState] = useState<{ path: string; url: string } | null>(null);
  const [near, setNear] = useState(typeof IntersectionObserver === 'undefined');

  useEffect(() => {
    const el = ref.current;
    if (near || !el) return;
    const observer = new IntersectionObserver((seen) => seen.some((s) => s.isIntersecting) && setNear(true), { rootMargin: '300px' });
    observer.observe(el);
    return () => observer.disconnect();
  }, [near]);

  useEffect(() => {
    if (!near) return;
    let live = true;
    blobs.url(path, revalidate).then(
      (url) => live && setState({ path, url }),
      () => live && setState(null),
    );
    return () => { live = false; };
  }, [near, path, revalidate]);

  return [state?.path === path ? state.url : null, ref];
}
