import type { TokenCredential } from '@azure/identity';
import { odata, TableClient, type TableEntityResult } from '@azure/data-tables';
import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob';
import { QueueServiceClient } from '@azure/storage-queue';
import type { Blobs, Queue, Row, Stored, Table } from '@g4k/sdk';
import { accountName, type Account, type Accounts, type StorageOwner } from '../storage.ts';

export type AzureStorageConfig =
	/** One account per owner at g4k<owner><suffix>, reached with the app's managed identity. Bicep creates every name. */
	| { readonly kind: 'azure'; readonly suffix: string; readonly credential: TokenCredential }
	/** One emulator account for every owner, so each name carries its owner. Names are created on first use. */
	| { readonly kind: 'azurite'; readonly connectionString: string };

type Fields = Record<string, string | number | boolean | Date>;

type Handles = {
	table(name: string): TableClient;
	container(name: string): ContainerClient;
	queue(name: string): ReturnType<QueueServiceClient['getQueueClient']>;
};

const statusOf = (error: unknown): number | undefined =>
	typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : undefined;

async function unless<T>(statuses: readonly number[], run: () => Promise<T>, otherwise: T): Promise<T> {
	try {
		return await run();
	} catch (error) {
		const status = statusOf(error);
		if (status !== undefined && statuses.includes(status)) return otherwise;
		throw error;
	}
}

function fieldsOf(row: Row): Fields {
	const fields: Fields = {};
	for (const [name, value] of Object.entries(row)) {
		if (value === undefined) continue;
		if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean' && !(value instanceof Date)) {
			throw new TypeError(`table field ${name} must be a string, number, boolean or Date`);
		}
		fields[name] = value;
	}
	return fields;
}

function stored<R extends Row>(result: TableEntityResult<Record<string, unknown>>): Stored<R> {
	const { etag, ...rest } = result;
	if (etag === undefined) throw new Error('Azure Tables answered an entity with no etag');
	const row = Object.fromEntries(Object.entries(rest).filter(([name]) => name !== 'timestamp' && !name.startsWith('odata.')));
	return { ...row, etag } as unknown as Stored<R>;
}

function azureTable(client: TableClient, ready: () => Promise<void>): Table {
	const list = async <R extends Row>(filter?: string) => {
		await ready();
		const rows: Stored<R>[] = [];
		for await (const result of client.listEntities({ queryOptions: filter ? { filter } : {} })) rows.push(stored<R>(result));
		return rows;
	};
	return {
		async get<R extends Row>(partitionKey: string, rowKey: string) {
			await ready();
			return unless([404], async () => stored<R>(await client.getEntity(partitionKey, rowKey)), undefined);
		},
		inPartition: <R extends Row>(partitionKey: string) => list<R>(odata`PartitionKey eq ${partitionKey}`),
		list: <R extends Row>() => list<R>(),
		async put(row) {
			await ready();
			await client.upsertEntity(fieldsOf(row) as typeof row, 'Replace');
		},
		async insertIfAbsent(row) {
			await ready();
			return unless([409], async () => (await client.createEntity(fieldsOf(row) as typeof row), true), false);
		},
		async replaceIfMatch(row, etag) {
			await ready();
			return unless([404, 412], async () => (await client.updateEntity(fieldsOf(row) as typeof row, 'Replace', { etag }), true), false);
		},
		async remove(partitionKey, rowKey) {
			await ready();
			await unless([404], async () => void (await client.deleteEntity(partitionKey, rowKey)), undefined);
		},
	};
}

async function readAll(stream: NodeJS.ReadableStream | undefined): Promise<Uint8Array> {
	const chunks: Buffer[] = [];
	if (stream) for await (const chunk of stream) chunks.push(Buffer.from(chunk));
	return new Uint8Array(Buffer.concat(chunks));
}

function azureBlobs(client: ContainerClient, ready: () => Promise<void>): Blobs {
	return {
		async get(path, ifNoneMatch) {
			await ready();
			const blob = client.getBlockBlobClient(path);
			try {
				const response = await blob.download(0, undefined, ifNoneMatch ? { conditions: { ifNoneMatch } } : {});
				return { bytes: await readAll(response.readableStreamBody), contentType: response.contentType ?? 'application/octet-stream', etag: response.etag ?? '' };
			} catch (error) {
				const status = statusOf(error);
				if (status === 304) return 'not-modified';
				if (status === 404) return undefined;
				throw error;
			}
		},
		async list(prefix) {
			await ready();
			const names: string[] = [];
			for await (const item of client.listBlobsFlat({ prefix })) names.push(item.name);
			return names.sort();
		},
		async put(path, bytes, contentType) {
			await ready();
			await client.getBlockBlobClient(path).uploadData(bytes, { blobHTTPHeaders: { blobContentType: contentType } });
		},
		async remove(path) {
			await ready();
			await client.getBlockBlobClient(path).deleteIfExists();
		},
	};
}

/** Messages are base64 JSON, the encoding the Functions queue trigger expects by default. */
function azureQueue(client: ReturnType<Handles['queue']>, ready: () => Promise<void>): Queue {
	return {
		async send(message) {
			await ready();
			await client.sendMessage(Buffer.from(JSON.stringify(message)).toString('base64'));
		},
	};
}

function handlesFor(config: AzureStorageConfig, owner: StorageOwner): Handles {
	if (config.kind === 'azurite') {
		const prefixed = (name: string, separator: string) => `${owner}${separator}${name}`;
		const blobs = BlobServiceClient.fromConnectionString(config.connectionString);
		const queues = QueueServiceClient.fromConnectionString(config.connectionString);
		return {
			table: (name) => TableClient.fromConnectionString(config.connectionString, `${owner}${name[0]?.toUpperCase() ?? ''}${name.slice(1)}`, { allowInsecureConnection: true }),
			container: (name) => blobs.getContainerClient(prefixed(name, '-')),
			queue: (name) => queues.getQueueClient(prefixed(name, '-')),
		};
	}
	const account = accountName(owner, config.suffix);
	const blobs = new BlobServiceClient(`https://${account}.blob.core.windows.net`, config.credential);
	const queues = new QueueServiceClient(`https://${account}.queue.core.windows.net`, config.credential);
	return {
		table: (name) => new TableClient(`https://${account}.table.core.windows.net`, name, config.credential),
		container: (name) => blobs.getContainerClient(name),
		queue: (name) => queues.getQueueClient(name),
	};
}

function once(run: () => Promise<unknown>): () => Promise<void> {
	let started: Promise<void> | undefined;
	return () => (started ??= run().then(() => undefined));
}

export function azureAccounts(config: AzureStorageConfig): Accounts {
	return {
		open(owner): Account {
			const handles = handlesFor(config, owner);
			const emulated = config.kind === 'azurite';
			const noop = async () => {};
			return {
				table(name) {
					const client = handles.table(name);
					return azureTable(client, emulated ? once(() => client.createTable()) : noop);
				},
				container(name) {
					const client = handles.container(name);
					return azureBlobs(client, emulated ? once(() => client.createIfNotExists()) : noop);
				},
				queue(name) {
					const client = handles.queue(name);
					return azureQueue(client, emulated ? once(() => client.createIfNotExists()) : noop);
				},
			};
		},
	};
}
