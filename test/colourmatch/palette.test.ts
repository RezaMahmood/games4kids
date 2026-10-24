import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COLOURS, WORD_BACKGROUND } from '../../games/colourmatch/data/index.ts';

/** WCAG relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
	const channel = (at: number) => {
		const c = parseInt(hex.slice(at, at + 2), 16) / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

const contrast = (a: string, b: string) => {
	const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
	return (light + 0.05) / (dark + 0.05);
};

test('every ink reads on the word panel at 3:1 or better, so no colour word is hard to see', () => {
	for (const { name, hex } of COLOURS) {
		const ratio = contrast(hex, WORD_BACKGROUND);
		assert.ok(ratio >= 3, `${name} ${hex} on ${WORD_BACKGROUND} is ${ratio.toFixed(2)}:1`);
	}
});

test('the palette has about eight colours a child can name, each with its own id and hex', () => {
	assert.ok(COLOURS.length >= 6 && COLOURS.length <= 10);
	assert.equal(new Set(COLOURS.map((c) => c.id)).size, COLOURS.length);
	assert.equal(new Set(COLOURS.map((c) => c.hex)).size, COLOURS.length);
	for (const { hex } of COLOURS) assert.match(hex, /^#[0-9A-F]{6}$/);
});
