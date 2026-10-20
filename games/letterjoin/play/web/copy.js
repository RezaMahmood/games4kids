import { INK } from './ink.js';

/**
 * The image of an unaided copy: the child's ink on white, nothing else, at the sheet's proportions. It is drawn
 * from the strokes (sheet units), not read off the screen, so scrolling and rotation do not matter.
 */

/** The device pixel width of an 11 inch iPad in portrait, so a whole sheet stays a small PNG. */
export const COPY_MAX_WIDTH = 1668;
/** Below the 16.7 million pixel canvas limit of iPad Safari, for very long sheets. */
export const COPY_MAX_PIXELS = 16_000_000;

/**
 * @param {{ width: number, height: number }} sheet the layout size in sheet units
 * @returns {{ width: number, height: number, scale: number }} the image size in pixels and pixels per sheet unit
 */
export function copyImageSize(sheet) {
  const scale = Math.min(COPY_MAX_WIDTH / sheet.width, Math.sqrt(COPY_MAX_PIXELS / (sheet.width * sheet.height)));
  return { width: Math.round(sheet.width * scale), height: Math.round(sheet.height * scale), scale };
}

/**
 * @param {{ x?: number, y?: number, width: number, height: number }} area the part of the sheet to draw, in sheet
 *   units; a layout is the whole sheet. Ink outside it is cut off.
 * @param {import('./ink.js').Stroke[]} strokes
 * @param {{ color?: string }} options
 * @returns {Promise<Blob>} an image/png blob
 */
export function renderCopyPng(area, strokes, { color = INK.stroke } = {}) {
  const { width, height, scale } = copyImageSize(area);
  const canvas = Object.assign(document.createElement('canvas'), { width, height });
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.setTransform(scale, 0, 0, scale, -(area.x ?? 0) * scale, -(area.y ?? 0) * scale);
  ctx.strokeStyle = color;
  ctx.lineWidth = INK['stroke-width'];
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const stroke of strokes) {
    ctx.beginPath();
    ctx.moveTo(stroke[0].x, stroke[0].y);
    for (const p of stroke.length > 1 ? stroke.slice(1) : stroke) ctx.lineTo(p.x, p.y);
    ctx.stroke();
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not make the picture of your writing.'))), 'image/png');
  });
}
