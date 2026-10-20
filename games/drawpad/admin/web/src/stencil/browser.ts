import { downscale } from './downscale';
import type { PbnResult } from './pbn';
import type { StencilJob, StencilRequest, StencilResponse } from './protocol';
import type { Raster } from './types';

const DECODE_EDGE = 4096;

function pixels(bitmap: ImageBitmap, width: number, height: number): Raster {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return { data: ctx.getImageData(0, 0, width, height).data, width, height };
}

/** Decodes a photo (honouring EXIF rotation) to a picture-sized raster, long edge at most 1024. */
export async function decodeImage(file: Blob): Promise<Raster> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('This browser cannot open that photo. Try a JPG or PNG.');
  }
  const fit = Math.min(1, DECODE_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * fit));
  const height = Math.max(1, Math.round(bitmap.height * fit));
  return downscale(pixels(bitmap, width, height));
}

/** Decodes a PNG to a raster at the image's own size. */
export async function decodePng(png: Blob): Promise<Raster> {
  const bitmap = await createImageBitmap(png);
  return pixels(bitmap, bitmap.width, bitmap.height);
}

export function drawRaster(canvas: HTMLCanvasElement, raster: Raster) {
  canvas.width = raster.width;
  canvas.height = raster.height;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(raster.width, raster.height);
  image.data.set(raster.data);
  ctx.putImageData(image, 0, 0);
}

/** The raster as PNG bytes, or JPEG bytes for the original photo. */
export async function encodeBytes(raster: Raster, type: 'image/png' | 'image/jpeg'): Promise<Uint8Array> {
  const canvas = document.createElement('canvas');
  drawRaster(canvas, raster);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.88));
  if (!blob) throw new Error('This browser could not save the image.');
  return new Uint8Array(await blob.arrayBuffer());
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (r: StencilResponse & { ok: true }) => void; reject: (e: Error) => void }>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }: MessageEvent<StencilResponse>) => {
    const waiter = pending.get(data.id);
    pending.delete(data.id);
    if (!waiter) return;
    if (data.ok) waiter.resolve(data);
    else waiter.reject(new Error(data.message));
  };
  worker.onerror = () => {
    for (const waiter of pending.values()) waiter.reject(new Error('Picture processing stopped unexpectedly.'));
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

function run(job: StencilJob): Promise<StencilResponse & { ok: true }> {
  const id = nextId++;
  const request: StencilRequest = { id, job };
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage(request);
  });
}

export async function outlineInWorker(raster: Raster, detail: number): Promise<Raster> {
  const reply = await run({ kind: 'outline', raster, detail });
  if (reply.kind !== 'outline') throw new Error('Unexpected reply from the stencil worker.');
  return reply.outline;
}

export async function pbnInWorker(raster: Raster, colors: number, detail: number): Promise<PbnResult> {
  const reply = await run({ kind: 'pbn', raster, colors, detail });
  if (reply.kind !== 'pbn') throw new Error('Unexpected reply from the stencil worker.');
  return reply.result;
}
