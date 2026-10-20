/** Hue in degrees [0, 360), saturation and value in [0, 1]. */
export type Hsv = { h: number; s: number; v: number };

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

const hex2 = (n: number) => Math.round(n * 255).toString(16).padStart(2, '0');

export function hsvToHex({ h, s, v }: Hsv): string {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return `#${hex2(f(5))}${hex2(f(3))}${hex2(f(1))}`.toUpperCase();
}

/** Expects a #RRGGBB string. Greys come back with hue 0. */
export function hexToHsv(hex: string): Hsv {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => c / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d + 6) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  return { h: h * 60, s: max === 0 ? 0 : d / max, v: max };
}

/** Reads what a person typed ("#3da5d9", "3DA5D9", "#fc0") as #RRGGBB, or null. */
export function parseHex(text: string): string | null {
  const m = HEX.exec(text.trim());
  if (!m) return null;
  const digits = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join('') : m[1]!;
  return `#${digits.toUpperCase()}`;
}
