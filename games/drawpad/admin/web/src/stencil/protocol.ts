import type { PbnResult } from './pbn';
import type { Raster } from './types';

export type StencilJob =
  | { kind: 'outline'; raster: Raster; detail: number }
  | { kind: 'pbn'; raster: Raster; colors: number; detail: number };

export type StencilRequest = { id: number; job: StencilJob };

export type StencilResponse =
  | { id: number; ok: true; kind: 'outline'; outline: Raster }
  | { id: number; ok: true; kind: 'pbn'; result: PbnResult }
  | { id: number; ok: false; message: string };
