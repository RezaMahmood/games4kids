/**
 * Which font draws each letter style. Every font is open (SIL OFL) and committed in web/open-fonts/, so it ships
 * with the site. A style whose file fails to load falls back to a rounded print font the device already has.
 * Pre-cursive reuses the joined font with contextual alternates off, so its letters stay unjoined.
 *
 * @typedef {import('./activity.js').LetterStyle} LetterStyle
 * @typedef {{ family: string, custom: boolean }} ResolvedFont `family` is a CSS font-family list ending in the fallback.
 */

export const FALLBACK_FAMILY = '"Arial Rounded MT Bold", "Avenir Next", "Helvetica Neue", Arial, sans-serif';

/** @type {Record<LetterStyle, { label: string, family: string, file: string, features?: string }>} `file` is under open-fonts/. */
export const FONT_REGISTRY = {
  print: { label: 'Print', family: 'Letterjoin Print', file: 'Andika-Regular.ttf' },
  precursive: { label: 'Pre-cursive', family: 'Letterjoin Precursive', file: 'PlaywriteGBJ.ttf', features: '"calt" 0' },
  joined: { label: 'Joined', family: 'Letterjoin Joined', file: 'PlaywriteGBJ.ttf' },
};

/**
 * The style an attempt starts in: the one this device last picked, when the activity offers it, else joined when the
 * activity offers it, else the activity's own default.
 * @param {{ letterStyle: LetterStyle, allowedStyles: LetterStyle[] }} activity
 * @param {string | null} remembered
 * @returns {LetterStyle}
 */
export function startingStyle(activity, remembered) {
  const offered = (style) => activity.allowedStyles.find((s) => s === style);
  return offered(remembered) ?? offered('joined') ?? activity.letterStyle;
}

/**
 * @param {LetterStyle} style
 * @param {{ FontFace: typeof FontFace, fonts: FontFaceSet }} env
 * @returns {Promise<ResolvedFont>}
 */
export async function resolveFont(style, { FontFace, fonts }) {
  const { family, file, features } = FONT_REGISTRY[style];
  try {
    const face = new FontFace(family, `url(open-fonts/${file})`, features ? { featureSettings: features } : undefined);
    await face.load();
    fonts.add(face);
    return { family: `"${family}", ${FALLBACK_FAMILY}`, custom: true };
  } catch {
    return { family: FALLBACK_FAMILY, custom: false };
  }
}

/**
 * A loaded font plus its shape in em units, measured once. Layout scales these by the font size.
 * @typedef {ResolvedFont & { style: LetterStyle, xHeight: number, ascent: number, descent: number, measure: (text: string) => number }} Face
 */

const REFERENCE_SIZE = 100;
const faces = new Map();

/** @returns {Face} */
function measureFace(style, resolved) {
  const ctx = document.createElement('canvas').getContext('2d');
  ctx.font = `${REFERENCE_SIZE}px ${resolved.family}`;
  const em = (value) => value / REFERENCE_SIZE;
  return {
    ...resolved,
    style,
    xHeight: em(ctx.measureText('xvwz').actualBoundingBoxAscent),
    ascent: em(ctx.measureText('bdfhklt').actualBoundingBoxAscent),
    descent: em(ctx.measureText('gjpqy').actualBoundingBoxDescent),
    measure: (text) => em(ctx.measureText(text).width),
  };
}

/**
 * Loads and measures the font for a style once per page. Layout waits for this, so the outline and the scoring
 * mask are both drawn with the real font, never with a fallback that happened to render first.
 * @param {LetterStyle} style
 * @returns {Promise<Face>}
 */
export function loadFace(style) {
  if (!faces.has(style)) faces.set(style, resolveFont(style, { FontFace, fonts: document.fonts }).then((resolved) => measureFace(style, resolved)));
  return faces.get(style);
}
