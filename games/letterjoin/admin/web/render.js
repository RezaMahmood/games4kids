import { GRID_SCALE, maskSize, paperGuides } from './sheet.js';

/**
 * Draws a sheet layout. The paper and outline are SVG in sheet units, so the browser scales and tiles a tall
 * sheet itself. The scoring mask fills the same lines with the same font in canvas, a band at a time.
 * @typedef {import('./sheet.js').Layout} Layout
 */

const NS = 'http://www.w3.org/2000/svg';

export function svgNode(tag, attrs = {}) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

const RULE = {
  baseline: { stroke: '#8fa6c6', 'stroke-width': 2 },
  xLine: { stroke: '#b8c8de', 'stroke-width': 1.5, 'stroke-dasharray': '10 8' },
  ascender: { stroke: '#d3deec', 'stroke-width': 1.5 },
  descender: { stroke: '#d3deec', 'stroke-width': 1.5 },
};
const BAND = { fill: '#fdf1c4' };
const OUTLINE = { fill: 'none', stroke: '#7f95b2', 'stroke-width': 3, 'stroke-linejoin': 'round' };

/** Scales with its container's width and keeps the layout's proportions. */
export function sizeSheet(svg, layout) {
  svg.setAttribute('viewBox', `0 0 ${layout.width} ${layout.height}`);
  svg.style.aspectRatio = `${layout.width} / ${layout.height}`;
}

/**
 * The guide lines alone, as the unaided copy step shows them.
 * @param {Layout} layout
 * @param {import('./activity.js').Paper} paper
 */
export function drawPaper(layout, paper) {
  const group = svgNode('g', { 'data-guide': '' });
  const { rules, bands } = paperGuides(layout, paper);
  const x1 = layout.padX / 2;
  const x2 = layout.width - layout.padX / 2;
  for (const band of bands) group.append(svgNode('rect', { x: x1, y: band.y, width: x2 - x1, height: band.height, ...BAND }));
  for (const rule of rules) group.append(svgNode('line', { x1, x2, y1: rule.y, y2: rule.y, 'data-rule': rule.kind, ...RULE[rule.kind] }));
  return group;
}

/**
 * The paper and the text outline. Each line is one text run, never letter by letter, so a joined font's
 * contextual shaping applies exactly as it does in the mask.
 * @param {Layout} layout
 * @param {import('./activity.js').Paper} paper
 */
export function drawTarget(layout, paper) {
  const group = drawPaper(layout, paper);
  for (const line of layout.lines) {
    const text = svgNode('text', { x: layout.padX, y: line.baseline, ...OUTLINE });
    text.style.font = layout.font;
    text.textContent = line.text;
    group.append(text);
  }
  return group;
}

const BAND_ROWS = 1024;

/** One byte per grid cell, 1 where the text is. A fixed-size canvas band keeps canvas memory flat however tall the sheet. */
export function buildMask(layout) {
  const { width, height } = maskSize(layout);
  const data = new Uint8Array(width * height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = Math.min(BAND_ROWS, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  for (let top = 0; top < height; top += BAND_ROWS) {
    const rows = Math.min(BAND_ROWS, height - top);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, canvas.height);
    ctx.setTransform(GRID_SCALE, 0, 0, GRID_SCALE, 0, -top);
    ctx.font = layout.font;
    ctx.fillStyle = '#000';
    for (const line of layout.lines) ctx.fillText(line.text, layout.padX, line.baseline);
    const pixels = ctx.getImageData(0, 0, width, rows).data;
    const offset = top * width;
    for (let i = 0; i < width * rows; i++) data[offset + i] = pixels[i * 4 + 3] > 127 ? 1 : 0;
  }
  return { data, width, height };
}
