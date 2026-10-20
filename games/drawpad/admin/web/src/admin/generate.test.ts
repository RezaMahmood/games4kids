import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generate } from './generate';
import { DEFAULT_TUNING, redrawsNeeded, withoutRedraws, type Redraws } from './uploadModel';

const mocks = vi.hoisted(() => ({ outline: vi.fn() }));

vi.mock('../stencil/browser', () => ({ outlineInWorker: mocks.outline }));

const photo = { data: new Uint8ClampedArray(30 * 20 * 4).fill(120), width: 30, height: 20 };
const white = (width: number) => ({ data: new Uint8ClampedArray(width * width * 4).fill(255), width, height: width });
const redraws: Redraws = { 'trace-standard': white(64), 'trace-best': white(64) };

beforeEach(() => {
  mocks.outline.mockReset().mockResolvedValue(photo);
});

describe('generate', () => {
  it('fits the AI redraw to the photo instead of tracing the photo', async () => {
    const made = await generate(photo, { ...DEFAULT_TUNING, outline: 'best' }, redraws);
    expect(mocks.outline).not.toHaveBeenCalled();
    expect([made.outline.width, made.outline.height]).toEqual([30, 20]);
    expect(made.tuning.outline).toBe('best');
  });

  it('traces the photo itself at the chosen detail for the classic outline', async () => {
    const made = await generate(photo, { outline: 'classic', detail: 1 }, {});
    expect(mocks.outline).toHaveBeenCalledWith(photo, 1);
    expect(made.outline).toBe(photo);
  });

  it('refuses to make an AI outline whose redraw it was not given', async () => {
    await expect(generate(photo, { ...DEFAULT_TUNING, outline: 'best' }, { 'trace-standard': white(8) })).rejects.toThrow('missing');
  });
});

describe('redrawsNeeded', () => {
  it('is the AI redraw of the chosen quality, and nothing for the free classic outline', () => {
    expect(redrawsNeeded(DEFAULT_TUNING)).toEqual(['trace-standard']);
    expect(redrawsNeeded({ ...DEFAULT_TUNING, outline: 'best' })).toEqual(['trace-best']);
    expect(redrawsNeeded({ ...DEFAULT_TUNING, outline: 'classic' })).toEqual([]);
  });
});

describe('withoutRedraws', () => {
  it('switches to the classic outline when its AI redraw failed, and ignores other failures', () => {
    const best = { ...DEFAULT_TUNING, outline: 'best' } as const;
    expect(withoutRedraws(best, ['trace-best'])).toEqual({ ...best, outline: 'classic' });
    expect(withoutRedraws(best, ['trace-standard'])).toEqual(best);
  });
});
