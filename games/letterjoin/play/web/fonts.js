/**
 * Which font draws each letter style. The owner supplies the font files later and they are never committed:
 * put them in web/fonts/ (gitignored) named after the style, for example web/fonts/joined.woff2.
 * A style with no owner file uses its open font when it has one (joined: Playwrite GB J, SIL OFL, committed in
 * web/open-fonts/), and otherwise falls back to a rounded print font the device already has.
 *
 * @typedef {import('./activity.js').LetterStyle} LetterStyle
 * @typedef {{ family: string, custom: boolean }} ResolvedFont `family` is a CSS font-family list ending in the fallback.
 */

export const FALLBACK_FAMILY = '"Arial Rounded MT Bold", "Avenir Next", "Helvetica Neue", Arial, sans-serif';

/** @type {Record<LetterStyle, { label: string, family: string, file: string, open?: string }>} */
export const FONT_REGISTRY = {
  print: { label: 'Print', family: 'Letterjoin Print', file: 'print' },
  precursive: { label: 'Pre-cursive', family: 'Letterjoin Precursive', file: 'precursive' },
  joined: { label: 'Joined', family: 'Letterjoin Joined', file: 'joined', open: 'open-fonts/PlaywriteGBJ.ttf' },
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

const FORMATS = [['woff2', 'woff2'], ['woff', 'woff'], ['otf', 'opentype'], ['ttf', 'truetype']];

/**
 * Every file a style may load, best first: the owner's files, then the style's open font. They are tried one
 * at a time because WebKit never settles `FontFace.load()` for a source list in which every file is missing,
 * so on an iPad one list left the sheet blank. A single missing file rejects promptly.
 * @param {LetterStyle} style
 * @returns {string[]} CSS `src` values
 */
export function fontSources(style) {
  const { file, open } = FONT_REGISTRY[style];
  const owner = FORMATS.map(([ext, format]) => `url(fonts/${file}.${ext}) format("${format}")`);
  return open ? [...owner, `url(${open}) format("truetype")`] : owner;
}

/**
 * @param {LetterStyle} style
 * @param {{ FontFace: typeof FontFace, fonts: FontFaceSet }} env
 * @returns {Promise<ResolvedFont>}
 */
export async function resolveFont(style, { FontFace, fonts }) {
  const { family } = FONT_REGISTRY[style];
  for (const source of fontSources(style)) {
    try {
      const face = new FontFace(family, source);
      await face.load();
      fonts.add(face);
      return { family: `"${family}", ${FALLBACK_FAMILY}`, custom: true };
    } catch {
      continue;
    }
  }
  return { family: FALLBACK_FAMILY, custom: false };
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
