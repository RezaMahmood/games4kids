/// <reference lib="webworker" />
import { makeOutline } from './outline';
import { makePbn } from './pbn';
import type { StencilRequest, StencilResponse } from './protocol';

self.onmessage = ({ data }: MessageEvent<StencilRequest>) => {
  try {
    const { id, job } = data;
    const reply: StencilResponse =
      job.kind === 'outline'
        ? { id, ok: true, kind: 'outline', outline: makeOutline(job.raster, { detail: job.detail }) }
        : { id, ok: true, kind: 'pbn', result: makePbn(job.raster, { colors: job.colors, detail: job.detail }) };
    self.postMessage(reply);
  } catch (e) {
    self.postMessage({ id: data.id, ok: false, message: e instanceof Error ? e.message : String(e) } satisfies StencilResponse);
  }
};
