/** Colours a six year old can name. Each ink is drawn on WORD_BACKGROUND, and test/colourmatch/palette.test.ts holds every one to a 3:1 contrast. */
export const COLOURS = [
	{ id: 'red', name: 'Red', hex: '#FF5A5A' },
	{ id: 'orange', name: 'Orange', hex: '#FF9630' },
	{ id: 'yellow', name: 'Yellow', hex: '#FFD93B' },
	{ id: 'green', name: 'Green', hex: '#4FD36B' },
	{ id: 'blue', name: 'Blue', hex: '#5AA0FF' },
	{ id: 'purple', name: 'Purple', hex: '#B07CF0' },
	{ id: 'pink', name: 'Pink', hex: '#FF8AD0' },
	{ id: 'brown', name: 'Brown', hex: '#C08A5A' },
] as const;

export type ColourId = (typeof COLOURS)[number]['id'];
export const COLOUR_IDS = COLOURS.map((colour) => colour.id);

export const WORD_BACKGROUND = '#1F2430';

export const isColourId = (value: unknown): value is ColourId => COLOUR_IDS.some((id) => id === value);
