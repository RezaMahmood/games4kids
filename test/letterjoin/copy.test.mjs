import test from 'node:test';
import assert from 'node:assert/strict';
import { COPY_MAX_PIXELS, COPY_MAX_WIDTH, copyImageSize } from '../../games/letterjoin/play/web/copy.js';
import { IPAD_STAGE_WIDTH, SHEET_MAX_HEIGHT, SHEET_MAX_WIDTH, SHEET_MIN_WIDTH } from '../../games/letterjoin/play/web/sheet.js';

test('a copy image is 1668 px wide and keeps the sheet proportions', () => {
  for (const sheet of [{ width: IPAD_STAGE_WIDTH.landscape, height: 900 }, { width: IPAD_STAGE_WIDTH.portrait, height: 2913 }, { width: SHEET_MIN_WIDTH, height: 400 }]) {
    const size = copyImageSize(sheet);
    assert.equal(size.width, COPY_MAX_WIDTH, `width for a ${sheet.width} unit sheet`);
    assert.ok(Math.abs(size.height / size.width - sheet.height / sheet.width) < 0.002, 'aspect ratio');
    assert.equal(size.scale, COPY_MAX_WIDTH / sheet.width);
  }
});

test('the tallest sheet is scaled down to stay under the iPad canvas pixel limit', () => {
  const size = copyImageSize({ width: SHEET_MAX_WIDTH, height: SHEET_MAX_HEIGHT });
  assert.ok(size.width * size.height <= COPY_MAX_PIXELS * 1.001, `${size.width} x ${size.height}`);
  assert.ok(size.width < COPY_MAX_WIDTH);
  assert.ok(Math.abs(size.height / size.width - SHEET_MAX_HEIGHT / SHEET_MAX_WIDTH) < 0.002, 'aspect ratio');
});
