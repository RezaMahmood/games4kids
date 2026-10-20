import type { TokenCredential } from '@azure/identity';
import { TableClient } from '@azure/data-tables';
import { BlobServiceClient } from '@azure/storage-blob';
import type { Accounts } from '@g4k/host';
import { parseGameId, type Row } from '@g4k/sdk';
import { plainRow, rowId, type Game, type OldAccount, type OldContainer, type OldTable, type SourceBlob, type TargetWriter } from './model.ts';
import type { PortalRows } from './player-data.ts';

export const DEFAULT_ACCOUNTS = { drawpad: 'stdp2qnzjgj6a3qtq', letterjoin: 'stletterjoinul5nga' } as const;

function toRow(entity: Record<string, unknown>): Row {
	const { partitionKey, rowKey } = entity;
	if (typeof partitionKey !== 'string' || typeof rowKey !== 'string') throw new TypeError('a table entity came back with no keys');
	return plainRow({ ...entity, partitionKey, rowKey });
}

const notFound = (error: unknown) => typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === 404;

export function openOldAccount(account: string, credential: TokenCredential): OldAccount {
	const blobs = new BlobServiceClient(`https://${account}.blob.core.windows.net`, credential);
	return {
		table(name): OldTable {
			const client = new TableClient(`https://${account}.table.core.windows.net`, name, credential);
			return {
				async *list() {
					try {
						for await (const entity of client.listEntities()) yield toRow(entity);
					} catch (error) {
						if (!notFound(error)) throw error;
					}
				},
			};
		},
		container(name): OldContainer {
			const client = blobs.getContainerClient(name);
			return {
				async *list(prefix) {
					try {
						for await (const item of client.listBlobsFlat({ prefix })) yield item.name;
					} catch (error) {
						if (!notFound(error)) throw error;
					}
				},
				async get(path): Promise<SourceBlob | undefined> {
					const blob = client.getBlockBlobClient(path);
					try {
						const [bytes, properties] = await Promise.all([blob.downloadToBuffer(), blob.getProperties()]);
						return { bytes: new Uint8Array(bytes), contentType: properties.contentType ?? 'application/octet-stream' };
					} catch (error) {
						if (notFound(error)) return undefined;
						throw error;
					}
				},
			};
		},
	};
}

const keysOf = (rows: readonly Row[]) => new Set(rows.map((row) => rowId(row.partitionKey, row.rowKey)));

function ownerOf(game: Game) {
	const id = parseGameId(game);
	if (typeof id !== 'string') throw new TypeError(id.problem);
	return id;
}

export function newAccounts(accounts: Accounts): TargetWriter {
	return {
		async tableKeys(game, table) {
			return keysOf(await accounts.open(ownerOf(game)).table(table).list());
		},
		async blobNames(game, container) {
			return new Set(await accounts.open(ownerOf(game)).container(container).list(''));
		},
		insertIfAbsent: (game, table, row) => accounts.open(ownerOf(game)).table(table).insertIfAbsent(row),
		async putIfAbsent(game, container, path, blob) {
			const blobs = accounts.open(ownerOf(game)).container(container);
			if (await blobs.get(path)) return false;
			await blobs.put(path, blob.bytes, blob.contentType);
			return true;
		},
	};
}

export const EMPTY_TARGET: Pick<TargetWriter, 'tableKeys' | 'blobNames'> = {
	tableKeys: async () => new Set(),
	blobNames: async () => new Set(),
};

export async function readPortal(accounts: Accounts): Promise<PortalRows> {
	const portal = accounts.open('portal');
	return { identities: await portal.table('identities').list(), emails: await portal.table('emails').list() };
}
