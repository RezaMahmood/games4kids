import { useEffect, useRef } from 'preact/hooks';
import type { DrawingMeta, PbnData, Picture } from '../../../../data/types';
import { drawingImage, pictureFile } from '../api';
import { Fills } from '../canvas/fills';
import { fetchJson, fetchPixels, loadImage } from '../canvas/images';
import { PaintedBitmap } from '../canvas/paintedBitmap';
import { decodeRegionIds } from '../canvas/regionMap';

type Props = { drawing: DrawingMeta; picture: Picture };

/** A paint by numbers drawing as the player left it: their colours, then anything they drew freely over them. */
export function PaintedThumb({ drawing, picture }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let live = true;
    Promise.all([
      fetchJson<PbnData>(pictureFile(picture.id, 'pbn.json')),
      fetchPixels(pictureFile(picture.id, 'pbn-regions.png')),
      loadImage(drawingImage(drawing.id), true),
    ]).then(([data, pixels, pen]) => {
      const canvas = ref.current;
      if (!live || !canvas) return;
      const map = { width: pixels.width, height: pixels.height, ids: decodeRegionIds(pixels.data) };
      const sheet = new PaintedBitmap(map, new Fills(data, drawing));
      canvas.width = map.width;
      canvas.height = map.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(sheet.canvas, 0, 0);
      if (pen) ctx.drawImage(pen, 0, 0, map.width, map.height);
    }, () => {});
    return () => { live = false; };
  }, [drawing.id, drawing.updatedAt, picture.id]);

  return <canvas ref={ref} role="img" aria-label={`Your painting of ${picture.title}`} />;
}
