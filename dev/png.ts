import { crc32, deflateSync } from 'node:zlib';

export type Rgb = readonly [number, number, number];

/** A raster of flat colours, drawn with a few shapes, and encoded as an 8-bit RGB PNG. */
export type Canvas = {
	readonly width: number;
	readonly height: number;
	rect(x: number, y: number, w: number, h: number, colour: Rgb): void;
	disc(cx: number, cy: number, r: number, colour: Rgb): void;
	png(): Uint8Array;
};

function chunk(type: string, data: Uint8Array): Uint8Array {
	const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
	const out = Buffer.alloc(body.length + 8);
	out.writeUInt32BE(data.length, 0);
	body.copy(out, 4);
	out.writeUInt32BE(crc32(body), body.length + 4);
	return out;
}

export function canvas(width: number, height: number, background: Rgb): Canvas {
	const pixels = new Uint8Array(width * height * 3);
	const set = (x: number, y: number, colour: Rgb) => {
		if (x < 0 || y < 0 || x >= width || y >= height) return;
		pixels.set(colour, (y * width + x) * 3);
	};
	const self: Canvas = {
		width,
		height,
		rect(x, y, w, h, colour) {
			for (let row = y; row < y + h; row++) for (let column = x; column < x + w; column++) set(column, row, colour);
		},
		disc(cx, cy, r, colour) {
			for (let row = cy - r; row <= cy + r; row++) for (let column = cx - r; column <= cx + r; column++) if ((column - cx) ** 2 + (row - cy) ** 2 <= r * r) set(column, row, colour);
		},
		png() {
			const rows = Buffer.alloc((width * 3 + 1) * height);
			for (let row = 0; row < height; row++) Buffer.from(pixels.buffer, row * width * 3, width * 3).copy(rows, row * (width * 3 + 1) + 1);
			const header = Buffer.alloc(13);
			header.writeUInt32BE(width, 0);
			header.writeUInt32BE(height, 4);
			header.set([8, 2, 0, 0, 0], 8);
			return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', new Uint8Array())]));
		},
	};
	self.rect(0, 0, width, height, background);
	return self;
}
