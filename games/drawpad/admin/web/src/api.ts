import { ApiFailure, type ApiClient } from '/shell/v1/index.js';
import type { DrawingMeta, Job, JobStepKey, Limits, PbnData, Picture, PictureKind, RedrawQuality } from '../../../data/types';

export { ApiFailure };

let client: ApiClient | null = null;

/** The shell's client for this game's admin API. Every path below is relative to /api/admin/g/drawpad/. */
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
export const galleryImage = (userId: string, id: string) => `drawings/${userId}/${id}/image`;

/** The image files go up one request each under the picture's new id, then the details commit the picture to the library. */
export type NewPicture = {
  title: string;
  kinds: PictureKind[];
  width: number;
  height: number;
  original: Uint8Array;
  outline?: Uint8Array;
  pbn?: PbnData;
  pbnRegions?: Uint8Array;
  pbnPreview?: Uint8Array;
};

/** A photo (JPEG bytes) for the AI upload queue, with the redraws and whether title ideas are wanted. */
export type NewPhotoJob = {
  source: 'photo';
  photo: Uint8Array;
  width: number;
  height: number;
  wants: RedrawQuality[];
  titles: boolean;
};

/** A typed description the AI turns into three pictures to choose from. */
export type NewDescriptionJob = { source: 'description'; description: string; quality: RedrawQuality };

export type NewJob = NewPhotoJob | NewDescriptionJob;

/** The job steps that leave a PNG to download. */
export type JobImageKey = Exclude<JobStepKey, 'titles' | 'prompts'>;

async function failureOf(response: Response): Promise<ApiFailure> {
  const body = (await response.json().catch(() => null)) as { error?: unknown; message?: unknown } | null;
  return new ApiFailure(response.status, typeof body?.error === 'string' ? body.error : `http_${response.status}`, typeof body?.message === 'string' ? body.message : '');
}

async function fileBlob(path: string): Promise<Blob> {
  const response = await request(path);
  if (!response.ok) throw await failureOf(response);
  return response.blob();
}

export const api = {
  limits: () => current().get<Limits>('limits'),
  setChildLimit: (userId: string, dailyLimitMinutes: number | null) => current().put<void>(`limits/${userId}`, { dailyLimitMinutes }),
  pictures: () => current().get<Picture[]>('pictures'),
  drawings: () => current().get<(DrawingMeta & { userId: string; userName: string })[]>('drawings'),
  async addPicture(picture: NewPicture) {
    const id = crypto.randomUUID();
    const files = current();
    await files.sendJpeg(`pictures/${id}/original`, picture.original);
    if (picture.outline) await files.sendPng(`pictures/${id}/png/outline.png`, picture.outline);
    if (picture.pbnRegions) await files.sendPng(`pictures/${id}/png/pbn-regions.png`, picture.pbnRegions);
    if (picture.pbnPreview) await files.sendPng(`pictures/${id}/png/pbn-preview.png`, picture.pbnPreview);
    const { title, kinds, width, height, pbn } = picture;
    return files.post<Picture>(`pictures/${id}`, { title, kinds, width, height, ...(pbn ? { pbn } : {}) });
  },
  renamePicture: (id: string, title: string) => current().put<Picture>(`pictures/${id}`, { title }),
  deletePicture: (id: string) => current().delete(`pictures/${id}`),
  createJob(job: NewJob) {
    if (job.source === 'description') return current().post<Job>('jobs', job);
    const query = new URLSearchParams({ width: String(job.width), height: String(job.height), wants: job.wants.join(','), titles: job.titles ? '1' : '0' });
    return current().sendJpeg<Job>(`jobs/photo?${query}`, job.photo);
  },
  jobs: () => current().get<Job[]>('jobs'),
  job: (id: string) => current().get<Job>(`jobs/${id}`),
  /** Has a finished photo job make one AI outline, or make it again, from the photo it already holds. */
  redrawJob: (id: string, quality: RedrawQuality) => current().post<Job>(`jobs/${id}/redraw`, { quality }),
  deleteJob: (id: string) => current().delete(`jobs/${id}`),
  jobImage: (id: string, key: JobImageKey) => fileBlob(`jobs/${id}/${key}.png`),
  /** The photo a photo job was made from, so a finished job can be reopened. */
  jobPhoto: (id: string) => fileBlob(`jobs/${id}/photo.jpg`),
};
