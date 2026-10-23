import test from 'node:test';
import assert from 'node:assert/strict';
import { ReaderUnavailable, createVisionReader } from '../../games/letterjoin/play/api/reader.ts';
import { makePng } from './png.mjs';

const ENDPOINT = 'https://vision.example.cognitiveservices.azure.com/';
const ANALYZE_URL = 'https://vision.example.cognitiveservices.azure.com/computervision/imageanalysis:analyze?api-version=2024-02-01&features=read';

/** The shape Image Analysis 4.0 returns for `features=read`, cut down by hand to two lines. */
const ANALYSIS = {
  modelVersion: '2023-10-01',
  metadata: { width: 1668, height: 288 },
  readResult: {
    blocks: [{
      lines: [
        {
          text: 'The cat sot',
          boundingPolygon: [{ x: 40, y: 60 }, { x: 610, y: 58 }, { x: 612, y: 190 }, { x: 41, y: 192 }],
          words: [
            { text: 'The', boundingPolygon: [{ x: 40, y: 60 }, { x: 180, y: 62 }, { x: 181, y: 190 }, { x: 41, y: 188 }], confidence: 0.993 },
            { text: 'cat', boundingPolygon: [{ x: 230, y: 100 }, { x: 380, y: 98 }, { x: 382, y: 192 }, { x: 229, y: 190 }], confidence: 0.98 },
            { text: 'sot', boundingPolygon: [{ x: 430, y: 101 }, { x: 610, y: 99 }, { x: 612, y: 190 }, { x: 431, y: 192 }], confidence: 0.71 },
          ],
        },
        {
          text: 'on',
          boundingPolygon: [{ x: 700, y: 100 }, { x: 800, y: 100 }, { x: 800, y: 190 }, { x: 700, y: 190 }],
          words: [{ text: 'on', boundingPolygon: [{ x: 700, y: 100 }, { x: 800, y: 100 }, { x: 800, y: 190 }, { x: 700, y: 190 }], confidence: 0.95 }],
        },
      ],
    }],
  },
};

function fakeFetch(respond: () => Response | Promise<Response>) {
  const sent: Record<string, unknown>[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, ...init });
    return respond();
  }) as unknown as typeof globalThis.fetch;
  return { sent, fetch };
}
const noBill = async () => {};
const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('the reader posts the PNG with a bearer token and returns the words with boxes', async () => {
  const { sent, fetch } = fakeFetch(json(200, ANALYSIS));
  const png = makePng();
  const reader = createVisionReader({ endpoint: ENDPOINT, token: async () => 'mi-token', fetch });
  const result = await reader.read(png, noBill);
  assert.deepEqual(result.words.map((w) => w.text), ['The', 'cat', 'sot', 'on'], 'every word of every line, in reading order');
  assert.deepEqual(result.words[0], { text: 'The', confidence: 0.993, box: { x: 40, y: 60, w: 141, h: 130 } });
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.['url'], ANALYZE_URL);
  assert.equal(sent[0]?.['method'], 'POST');
  assert.deepEqual(sent[0]?.['headers'], { authorization: 'Bearer mi-token', 'content-type': 'application/octet-stream' });
  assert.equal(sent[0]?.['body'], png);
});

test('an image with no writing reads as no words', async () => {
  for (const body of [{ modelVersion: 'x', metadata: {}, readResult: { blocks: [] } }, { modelVersion: 'x', metadata: {} }]) {
    const { fetch } = fakeFetch(json(200, body));
    assert.deepEqual(await createVisionReader({ endpoint: ENDPOINT, token: async () => 'k', fetch }).read(makePng(), noBill), { words: [] });
  }
});

test('an outage, a busy service or an answer that is not a reading is ReaderUnavailable', async () => {
  const cases: Record<string, () => Response | Promise<Response>> = {
    network: () => { throw new TypeError('fetch failed'); },
    500: json(500, { error: { code: 'InternalServerError' } }),
    503: json(503, {}),
    429: json(429, { error: { code: '429' } }),
    'not json': () => new Response('<html>', { status: 200 }),
    'words without boxes': json(200, { readResult: { blocks: [{ lines: [{ words: [{ text: 'cat', confidence: 1 }] }] }] } }),
    'blocks not a list': json(200, { readResult: { blocks: 'none' } }),
  };
  const billedFor: string[] = [];
  for (const [name, respond] of Object.entries(cases)) {
    const { fetch } = fakeFetch(respond);
    await assert.rejects(createVisionReader({ endpoint: ENDPOINT, token: async () => 'k', fetch }).read(makePng(), async () => void billedFor.push(name)), ReaderUnavailable, name);
  }
  assert.deepEqual(billedFor, ['not json', 'words without boxes', 'blocks not a list'], 'Azure bills a 2xx whatever its body, and nothing else');
});

test('a read the service answered is billed once, and the reading waits for the bill', async () => {
  const { fetch } = fakeFetch(json(200, ANALYSIS));
  const order: string[] = [];
  const result = await createVisionReader({ endpoint: ENDPOINT, token: async () => 'k', fetch }).read(makePng(), async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    order.push('billed');
  });
  order.push('read');
  assert.equal(result.words.length, 4);
  assert.deepEqual(order, ['billed', 'read']);
});

test('a request the service refuses as wrong is a plain error, not an outage', async () => {
  const { fetch } = fakeFetch(json(401, { error: { code: '401' } }));
  const err: unknown = await createVisionReader({ endpoint: ENDPOINT, token: async () => 'k', fetch }).read(makePng(), noBill).catch((e: unknown) => e);
  assert.ok(err instanceof Error && !(err instanceof ReaderUnavailable));
});
