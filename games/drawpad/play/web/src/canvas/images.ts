import { blobs } from '../blobs';

// Null when the file is missing or cannot be decoded, e.g. a drawing with no pen layer saved yet.
export async function loadImage(path: string, revalidate = false): Promise<HTMLImageElement | null> {
  const url = await blobs.url(path, revalidate).catch(() => null);
  if (!url) return null;
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

export async function fetchJson<T>(path: string): Promise<T> {
  return JSON.parse(await (await blobs.blob(path)).text()) as T;
}

// Region ids live in the colour channels, so the browser must not colour-manage the decode.
export async function fetchPixels(path: string): Promise<ImageData> {
  const bitmap = await createImageBitmap(await blobs.blob(path), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
}

export function pixelsOf(source: CanvasImageSource, width: number, height: number): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(source, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

export function pngBytes(canvas: HTMLCanvasElement): Uint8Array {
  const url = canvas.toDataURL('image/png');
  return Uint8Array.from(atob(url.slice(url.indexOf(',') + 1)), (char) => char.charCodeAt(0));
}
