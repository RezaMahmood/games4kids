import { useEffect, useRef } from 'preact/hooks';
import { drawRaster } from '../stencil/browser';
import type { Raster } from '../stencil/types';

export function RasterView({ raster, label }: { raster: Raster; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current) drawRaster(ref.current, raster);
  }, [raster]);
  return <canvas ref={ref} class="raster" role="img" aria-label={label} />;
}
