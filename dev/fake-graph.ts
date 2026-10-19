import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { createDirectory, type Directory } from './directory.ts';

export const FAKE_GRAPH_TOKEN_PREFIX = 'fake-graph-token:';

type Assignment = { readonly id: string; readonly principalId: string; readonly principalType: 'User'; readonly appRoleId: string };

export type FakeGraphOptions = {
	readonly gamesPrincipalId: string;
	readonly adminPrincipalId: string;
	readonly directory?: Directory;
	/** Graph pages with @odata.nextLink; a small size makes the client prove it follows them. */
	readonly pageSize?: number;
};

export type FakeGraphControls = {
	/** The next assignment POSTs for a person invited this long ago answer 404, as Entra does while a new guest replicates. */
	replicationMisses: number;
	/** Answer every write with this status, for example 403 when the admin lacks the role. */
	refuseWrites: 403 | null;
};

export type RecordedCall = { readonly method: string; readonly path: string; readonly oid: string };

const error = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status });

/** The Graph REST subset the admin app uses, over an in-memory directory. `handle` is the fetch the app is given. */
export function createFakeGraph(options: FakeGraphOptions) {
	const directory = options.directory ?? createDirectory();
	const assignments = new Map<string, Assignment>();
	const grants: { resourceDisplayName: string; appRoleId: string }[] = [];
	const calls: RecordedCall[] = [];
	const controls: FakeGraphControls = { replicationMisses: 0, refuseWrites: null };
	const pageSize = options.pageSize ?? 100;
	const games = `/v1.0/servicePrincipals/${options.gamesPrincipalId}/appRoleAssignedTo`;

	function page(request: Request, rows: readonly unknown[]): Response {
		const url = new URL(request.url);
		const start = Number(url.searchParams.get('$skip') ?? 0);
		const slice = rows.slice(start, start + pageSize);
		const next = new URL(url);
		next.searchParams.set('$skip', String(start + pageSize));
		return Response.json({ value: slice, ...(start + pageSize < rows.length ? { '@odata.nextLink': next.href } : {}) });
	}

	async function handle(input: string | URL | Request, init?: RequestInit): Promise<Response> {
		const request = new Request(input, init);
		const url = new URL(request.url);
		const bearer = request.headers.get('authorization') ?? '';
		if (!bearer.startsWith(`Bearer ${FAKE_GRAPH_TOKEN_PREFIX}`)) return error(401, 'InvalidAuthenticationToken', 'Access token is empty or invalid.');
		calls.push({ method: request.method, path: `${url.pathname}${url.search}`, oid: bearer.slice(`Bearer ${FAKE_GRAPH_TOKEN_PREFIX}`.length) });
		const write = request.method !== 'GET';
		if (write && controls.refuseWrites) return error(controls.refuseWrites, 'Authorization_RequestDenied', 'Insufficient privileges to complete the operation.');

		if (request.method === 'GET' && url.pathname === '/v1.0/users') {
			const filter = url.searchParams.get('$filter') ?? '';
			if (filter.includes('otherMails') && (request.headers.get('consistencylevel') !== 'eventual' || url.searchParams.get('$count') !== 'true')) {
				return error(400, 'Request_UnsupportedQuery', 'Advanced query capabilities need ConsistencyLevel eventual and $count=true.');
			}
			const wanted = /'((?:[^']|'')*)'/.exec(filter)?.[1]?.replaceAll("''", "'") ?? '';
			const user = wanted ? directory.byEmail(wanted) : undefined;
			return Response.json({ value: user ? [{ id: user.id }] : [] });
		}

		if (request.method === 'POST' && url.pathname === '/v1.0/invitations') {
			const body = (await request.json()) as { invitedUserEmailAddress?: string };
			if (!body.invitedUserEmailAddress) return error(400, 'Request_BadRequest', 'invitedUserEmailAddress is required.');
			const user = directory.byEmail(body.invitedUserEmailAddress) ?? directory.add({ mail: body.invitedUserEmailAddress, guest: true });
			return Response.json({ invitedUser: { id: user.id } }, { status: 201 });
		}

		if (request.method === 'GET' && url.pathname === games) {
			return page(request, [...assignments.values()]);
		}

		if (request.method === 'POST' && url.pathname === games) {
			const body = (await request.json()) as { principalId?: string; appRoleId?: string };
			const person = body.principalId ? directory.byId(body.principalId) : undefined;
			if (!person || controls.replicationMisses > 0) {
				if (person) controls.replicationMisses--;
				return error(404, 'Request_ResourceNotFound', `Resource '${body.principalId}' does not exist or one of its queried reference-property objects are not present.`);
			}
			if ([...assignments.values()].some((existing) => existing.principalId === person.id)) {
				return error(400, 'Request_BadRequest', 'Permission being assigned already exists on the object.');
			}
			const created: Assignment = { id: randomUUID(), principalId: person.id, principalType: 'User', appRoleId: body.appRoleId ?? '' };
			assignments.set(created.id, created);
			return Response.json(created, { status: 201 });
		}

		const target = request.method === 'DELETE' && url.pathname.startsWith(`${games}/`) ? url.pathname.slice(games.length + 1) : undefined;
		if (target !== undefined) {
			if (!assignments.delete(target)) return error(404, 'Request_ResourceNotFound', 'The assignment does not exist.');
			return new Response(null, { status: 204 });
		}

		if (request.method === 'GET' && url.pathname === `/v1.0/servicePrincipals/${options.adminPrincipalId}/appRoleAssignments`) {
			return page(request, grants);
		}
		return error(404, 'Request_ResourceNotFound', `${request.method} ${url.pathname} is not part of the fake.`);
	}

	return { handle, directory, assignments, grants, calls, controls };
}

export type FakeGraph = ReturnType<typeof createFakeGraph>;

async function toRequest(req: IncomingMessage, origin: string): Promise<Request> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(Buffer.from(chunk));
	const body = Buffer.concat(chunks);
	const headers = new Headers();
	for (const [name, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(name, value);
	return new Request(new URL(req.url ?? '/', origin), { method: req.method ?? 'GET', headers, ...(body.byteLength > 0 ? { body } : {}) });
}

/** The same fake over HTTP, for the dev stack: the real graphAs points its graphOrigin at it. */
export async function startFakeGraph(options: FakeGraphOptions & { readonly port: number }) {
	const fake = createFakeGraph(options);
	const origin = `http://localhost:${options.port}`;
	const server = createServer(async (req, res) => {
		const reply = await fake.handle(await toRequest(req, origin));
		res.writeHead(reply.status, Object.fromEntries(reply.headers));
		res.end(Buffer.from(await reply.arrayBuffer()));
	});
	await new Promise<void>((resolve) => server.listen(options.port, 'localhost', resolve));
	return { ...fake, origin, close: () => new Promise<void>((resolve) => (server.close(() => resolve()), server.closeAllConnections())) };
}
