import type { Blob, Blobs, GameId, GameManifest, Ownership, Queue, ReadBlobs, ReadTable, Row, Side, StorageDeclaration, StorageFor, Stored, Table } from '@g4k/sdk';

export type StorageOwner = GameId | 'portal';

/** drawpad -> g4kdrawpad<suffix>. The suffix is five characters of uniqueString(resourceGroup().id). */
export function accountName(owner: StorageOwner, suffix: string): string {
	return `g4k${owner}${suffix}`;
}

/** Full handles over one account. Only the host holds these; a game gets the StorageFor view of its own account. */
export type Account = {
	table(name: string): Table;
	container(name: string): Blobs;
	queue(name: string): Queue;
};

export type Accounts = { open(owner: StorageOwner): Account };

/** The runtime twin of the Access type in @g4k/sdk. null means no handle at all. */
const ACCESS: { readonly [S in Side]: { readonly [O in Ownership]: 'write' | 'read' | null } } = {
	play: { play: 'write', admin: 'read', 'admin-private': null },
	admin: { play: 'read', admin: 'write', 'admin-private': 'write' },
};

/** A table handle with no write method at all, so a reader cannot write even past the types. */
export function readTable(table: Table): ReadTable {
	return {
		get: <R extends Row>(partitionKey: string, rowKey: string) => table.get<R>(partitionKey, rowKey),
		inPartition: <R extends Row>(partitionKey: string) => table.inPartition<R>(partitionKey),
		list: <R extends Row>() => table.list<R>(),
	};
}

function readBlobs(blobs: Blobs): ReadBlobs {
	return { get: (path, ifNoneMatch) => blobs.get(path, ifNoneMatch), list: (prefix) => blobs.list(prefix) };
}

function handles<W, R>(declared: StorageDeclaration, side: Side, open: (name: string) => W, narrow: ((handle: W) => R) | null): Record<string, W | R> {
	const entries = Object.entries(declared).flatMap(([name, ownership]): [string, W | R][] => {
		const access = ACCESS[side][ownership];
		if (access === 'write') return [[name, open(name)]];
		if (access === 'read' && narrow) return [[name, narrow(open(name))]];
		return [];
	});
	return Object.fromEntries(entries);
}

/**
 * The handles one side of one game gets. A read name's handle is an object with no write method at all, so the
 * ownership the type promises also holds for code that casts its way past the type.
 */
export function storageFor<M extends GameManifest, S extends Side>(manifest: M, side: S, account: Account): StorageFor<M, S> {
	const view = {
		tables: handles(manifest.storage.tables, side, (name) => account.table(name), readTable),
		blobs: handles(manifest.storage.containers, side, (name) => account.container(name), readBlobs),
		queues: handles(manifest.storage.queues, side, (name) => account.queue(name), null),
	};
	return view as unknown as StorageFor<M, S>;
}

export type StorageOp = {
	readonly account: StorageOwner;
	readonly kind: 'table' | 'container' | 'queue';
	readonly name: string;
	readonly write: boolean;
};

export type MemoryAccounts = Accounts & {
	/** Every operation in order, so a test can prove which account and name each side touched. */
	readonly ops: readonly StorageOp[];
	messages(owner: StorageOwner, queue: string): readonly unknown[];
};

type Entry = { readonly row: Row; readonly etag: string };

function memo<K, V>(map: Map<K, V>, key: K, make: () => V): V {
	const existing = map.get(key);
	if (existing !== undefined) return existing;
	const made = make();
	map.set(key, made);
	return made;
}

function memoryTable(record: (write: boolean) => void, nextEtag: () => string): Table {
	const partitions = new Map<string, Map<string, Entry>>();
	const partition = (key: string) => memo(partitions, key, () => new Map<string, Entry>());
	const stored = <R extends Row>(entry: Entry) => ({ ...entry.row, etag: entry.etag }) as Stored<R>;
	const sorted = (rows: Map<string, Entry>) => [...rows.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, entry]) => entry);
	const write = (row: Row) => partition(row.partitionKey).set(row.rowKey, { row: { ...row }, etag: nextEtag() });
	return {
		async get<R extends Row>(partitionKey: string, rowKey: string) {
			record(false);
			const entry = partitions.get(partitionKey)?.get(rowKey);
			return entry ? stored<R>(entry) : undefined;
		},
		async inPartition<R extends Row>(partitionKey: string) {
			record(false);
			return sorted(partitions.get(partitionKey) ?? new Map()).map((entry) => stored<R>(entry));
		},
		async list<R extends Row>() {
			record(false);
			const keys = [...partitions.keys()].sort();
			return keys.flatMap((key) => sorted(partition(key)).map((entry) => stored<R>(entry)));
		},
		async put(row) {
			record(true);
			write(row);
		},
		async insertIfAbsent(row) {
			record(true);
			if (partition(row.partitionKey).has(row.rowKey)) return false;
			write(row);
			return true;
		},
		async replaceIfMatch(row, etag) {
			record(true);
			if (partition(row.partitionKey).get(row.rowKey)?.etag !== etag) return false;
			write(row);
			return true;
		},
		async remove(partitionKey, rowKey) {
			record(true);
			partitions.get(partitionKey)?.delete(rowKey);
		},
	};
}

function memoryBlobs(record: (write: boolean) => void, nextEtag: () => string): Blobs {
	const blobs = new Map<string, Blob>();
	return {
		async get(path, ifNoneMatch) {
			record(false);
			const blob = blobs.get(path);
			if (blob && ifNoneMatch === blob.etag) return 'not-modified';
			return blob && { ...blob, bytes: blob.bytes.slice() };
		},
		async list(prefix) {
			record(false);
			return [...blobs.keys()].filter((path) => path.startsWith(prefix)).sort();
		},
		async put(path, bytes, contentType) {
			record(true);
			blobs.set(path, { bytes: bytes.slice(), contentType, etag: nextEtag() });
		},
		async remove(path) {
			record(true);
			blobs.delete(path);
		},
	};
}

/** Every account in one process. Each handle is created once per name, so two opens see the same data. */
export function memoryAccounts(): MemoryAccounts {
	const ops: StorageOp[] = [];
	const queues = new Map<string, unknown[]>();
	const accounts = new Map<StorageOwner, Account>();
	let etag = 0;
	const nextEtag = () => `W/"${++etag}"`;

	function open(owner: StorageOwner): Account {
		const existing = accounts.get(owner);
		if (existing) return existing;
		const tables = new Map<string, Table>();
		const containers = new Map<string, Blobs>();
		const recorder = (kind: StorageOp['kind'], name: string) => (write: boolean) => void ops.push({ account: owner, kind, name, write });
		const account: Account = {
			table: (name) => memo(tables, name, () => memoryTable(recorder('table', name), nextEtag)),
			container: (name) => memo(containers, name, () => memoryBlobs(recorder('container', name), nextEtag)),
			queue: (name) => ({
				async send(message) {
					recorder('queue', name)(true);
					const key = `${owner}/${name}`;
					queues.set(key, [...(queues.get(key) ?? []), JSON.parse(JSON.stringify(message))]);
				},
			}),
		};
		accounts.set(owner, account);
		return account;
	}

	return { open, ops, messages: (owner, queue) => queues.get(`${owner}/${queue}`) ?? [] };
}
