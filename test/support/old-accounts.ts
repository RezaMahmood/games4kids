import { createHash } from 'node:crypto';
import type { Row } from '@g4k/sdk';
import type { OldAccount, OldAccounts, SourceBlob } from '../../tools/migrate/model.ts';

export const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
export const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

export type OldData = {
	readonly tables?: Readonly<Record<string, readonly Row[]>>;
	readonly containers?: Readonly<Record<string, Readonly<Record<string, SourceBlob>>>>;
};

export type Touched = { readonly touched: Set<string> };

export function oldAccount(data: OldData, touched: Set<string>): OldAccount {
	const watch = <T extends object>(handle: T): T =>
		new Proxy(handle, {
			get(target, property, receiver) {
				if (typeof property === 'string') touched.add(property);
				return Reflect.get(target, property, receiver) as unknown;
			},
		});
	return watch({
		table: (name) =>
			watch({
				async *list() {
					yield* data.tables?.[name] ?? [];
				},
			}),
		container: (name) => {
			const files = data.containers?.[name] ?? {};
			return watch({
				async *list(prefix) {
					yield* Object.keys(files).filter((path) => path.startsWith(prefix)).sort();
				},
				async get(path) {
					return files[path];
				},
			});
		},
	});
}

export function oldAccounts(drawpad: OldData, letterjoin: OldData): OldAccounts & Touched {
	const touched = new Set<string>();
	return { drawpad: oldAccount(drawpad, touched), letterjoin: oldAccount(letterjoin, touched), touched };
}

export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

export const blob = (bytes: Uint8Array, contentType: string): SourceBlob => ({ bytes, contentType });
