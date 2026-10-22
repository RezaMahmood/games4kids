/** Reading one child's data from your Mac: their rows in every tagged account, and the requests that touched them. */

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A portal user id, the key every table uses for a child. It is the only text spliced into a query, so it is parsed first. */
export type UserId = string & { readonly __userId: unique symbol };
export const parseUserId = (text: string): UserId | null => (GUID.test(text) ? (text.toLowerCase() as UserId) : null);

/** A row as `az storage entity query` prints it. */
export type Entity = Readonly<Record<string, unknown>>;

export type Player = { readonly userId: UserId; readonly name: string; readonly timeZone: string; readonly state: string; readonly games: string };

const text = (value: unknown) => (typeof value === 'string' ? value : '');

/** The children a name or id names: an id matches exactly, a name matches any display name that contains it, ignoring case. */
export function findPlayers(profiles: readonly Entity[], members: readonly Entity[], query: string): Player[] {
	const id = parseUserId(query.trim());
	const wanted = query.trim().toLowerCase();
	const member = new Map(members.map((row) => [text(row['RowKey']).toLowerCase(), row]));
	return profiles
		.filter((row) => (id ? text(row['RowKey']).toLowerCase() === id : text(row['displayName']).toLowerCase().includes(wanted)))
		.flatMap((row) => {
			const userId = parseUserId(text(row['RowKey']));
			if (!userId) return [];
			const grant = member.get(userId);
			return [{ userId, name: text(row['displayName']), timeZone: text(row['timeZone']), state: text(grant?.['state']) || 'no member row', games: text(grant?.['games']) }];
		});
}

export type Found = { readonly account: string; readonly table: string; readonly partitionKey: string; readonly rowKey: string; readonly fields: Readonly<Record<string, unknown>> };

/**
 * The rows that belong to a child. Games key a child's rows in different ways (letterjoin's `practice-<id>` partition, its
 * `board` partition with the id as row key, the portal's `emails` row that holds the id as a field), so any key or string
 * field that contains the id counts.
 */
export function mentioning(userId: UserId, account: string, table: string, rows: readonly Entity[]): Found[] {
	return rows.flatMap((row) => {
		const partitionKey = text(row['PartitionKey']);
		const rowKey = text(row['RowKey']);
		const fields = Object.fromEntries(Object.entries(row).filter(([name]) => !['PartitionKey', 'RowKey', 'etag'].includes(name) && !name.startsWith('odata.')));
		const hit = [partitionKey, rowKey, ...Object.values(fields).map(text)].some((value) => value.toLowerCase().includes(userId));
		return hit ? [{ account, table, partitionKey, rowKey, fields }] : [];
	});
}

const WRITES = ['TableClient.createEntity', 'TableClient.updateEntity', 'TableClient.upsertEntity', 'TableClient.deleteEntity', 'TableClient.submitTransaction'];

/**
 * Every request whose table calls name the child, with the writes it made and each table call. A request on a child's
 * behalf reads `profiles` and `members` by their id, so this finds the child's own requests and an admin's requests about them.
 */
export function timelineQuery(userId: UserId, from: Date, to: Date): string {
	return `let since = datetime(${from.toISOString()}); let until = datetime(${to.toISOString()});
let ops = dependencies | where timestamp between (since .. until) and data has '${userId}' | distinct operation_Id;
let calls = dependencies | where timestamp between (since .. until) and operation_Id in (ops) | order by timestamp asc
	| summarize writes = make_list_if(name, name in (${WRITES.map((name) => `'${name}'`).join(', ')})),
		tables = make_list_if(strcat(extract(@"https://([^.]+)\\.table", 1, data), '/', extract(@"\\.windows\\.net/(.*)$", 1, data), ' ', resultCode), type == 'Azure table') by operation_Id;
let errors = exceptions | where timestamp between (since .. until) and operation_Id in (ops) | summarize errors = make_list(outerMessage) by operation_Id;
requests | where timestamp between (since .. until) and operation_Id in (ops)
| join kind=leftouter calls on operation_Id | join kind=leftouter errors on operation_Id
| project timestamp, name, resultCode, role = cloud_RoleName, itemCount, writes, tables, errors
| order by timestamp asc`;
}

export type TimelineEntry = {
	readonly at: string;
	readonly request: string;
	readonly status: string;
	readonly role: string;
	/** More than one request stands behind this row, so sampling dropped some. */
	readonly sampled: boolean;
	readonly writes: readonly string[];
	readonly tables: readonly string[];
	readonly errors: readonly string[];
};

const strings = (value: unknown): string[] => {
	const list = typeof value === 'string' ? (JSON.parse(value || '[]') as unknown) : value;
	return Array.isArray(list) ? list.map(String) : [];
};

/** The rows of `az monitor app-insights query` for timelineQuery. */
export function parseTimeline(reply: unknown): TimelineEntry[] {
	const table = (reply as { tables?: { columns: { name: string }[]; rows: unknown[][] }[] }).tables?.[0];
	if (!table) return [];
	const at = (name: string) => table.columns.findIndex((column) => column.name === name);
	const [time, name, code, role, count, writes, tables, errors] = ['timestamp', 'name', 'resultCode', 'role', 'itemCount', 'writes', 'tables', 'errors'].map(at);
	return table.rows.map((row) => ({
		at: String(row[time ?? -1]),
		request: String(row[name ?? -1]),
		status: String(row[code ?? -1]),
		role: String(row[role ?? -1]),
		sampled: Number(row[count ?? -1]) > 1,
		writes: strings(row[writes ?? -1]).map((write) => write.replace('TableClient.', '').replace('Entity', '')),
		tables: strings(row[tables ?? -1]).map(decodeURIComponent),
		errors: strings(row[errors ?? -1]),
	}));
}

/** Admission reads the portal's identities, games, members and profiles on every request, so a successful one says nothing. */
const ADMISSION_READ = /^g4kportal[a-z0-9]*\/(identities|games|members|profiles)\(.* 2\d\d$/;

export function formatTimeline(entries: readonly TimelineEntry[], options: { readonly all?: boolean } = {}): string[] {
	return entries.flatMap((entry) => [
		`${entry.at}  ${entry.request}  ${entry.status}  ${entry.role}${entry.sampled ? '  (sampled: more requests stand behind this row)' : ''}${entry.writes.length ? `  writes: ${entry.writes.join(', ')}` : ''}`,
		...entry.tables.filter((call) => options.all || !ADMISSION_READ.test(call)).map((call) => `    ${call}`),
		...entry.errors.map((error) => `    error: ${error}`),
	]);
}
