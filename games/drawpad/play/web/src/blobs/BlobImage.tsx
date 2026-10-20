import type { JSX } from 'preact';
import { useBlobUrl } from './useBlobUrl';

type Props = Omit<JSX.HTMLAttributes<HTMLImageElement>, 'src' | 'ref'> & { path: string; revalidate?: boolean };

export function BlobImage({ path, revalidate, ...rest }: Props) {
  const [url, ref] = useBlobUrl<HTMLImageElement>(path, revalidate);
  return <img {...rest} ref={ref} src={url ?? undefined} alt="" />;
}
