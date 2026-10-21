import { ApiFailure, whileLoading, type ApiClient } from '/shell/v1/index.js';
import type { DrawingMeta, Picture, PictureKind, UsageToday } from '../../../data/types';

export { ApiFailure, whileLoading };

let client: ApiClient | null = null;

/** The shell's client for this game's API. Every path below is relative to /api/g/drawpad/. */
export function configureApi(next: ApiClient): void {
  client = next;
}

function current(): ApiClient {
  if (!client) throw new Error('The API is not configured yet.');
  return client;
}

/** An authenticated request that hands back the Response as it is, for the blob cache. */
export function request(path: string, init?: RequestInit): Promise<Response> {
  return current().request(path, init);
}

export const pictureFile = (id: string, file: 'outline.png' | 'pbn-regions.png' | 'pbn-preview.png' | 'original.jpg' | 'pbn.json') =>
  `pictures/${id}/${file}`;
export const drawingImage = (id: string) => `drawings/${id}/image`;

export type DrawingPatch = {
  /** The pen layer as PNG bytes. It goes up first, then the rest of the patch. */
  image?: Uint8Array;
  filledRegions?: number[];
  customFills?: Record<number, string>;
  status?: DrawingMeta['status'];
  score?: DrawingMeta['score'];
};

export const api = {
  usage: () => current().get<UsageToday>('usage'),
  heartbeat: (seconds: number) => current().post<UsageToday>('usage/heartbeat', { seconds }, { keepalive: true }),
  pictures: () => current().get<Picture[]>('pictures'),
  drawings: () => current().get<DrawingMeta[]>('drawings'),
  createDrawing: (pictureId: string, kind: PictureKind) => current().post<DrawingMeta>('drawings', { pictureId, kind }),
  async saveDrawing(id: string, { image, ...patch }: DrawingPatch) {
    if (image) await current().sendPng(drawingImage(id), image);
    return current().put<DrawingMeta>(`drawings/${id}`, patch);
  },
  deleteDrawing: (id: string) => current().delete(`drawings/${id}`),
};
