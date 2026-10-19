import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const ENTRY = fileURLToPath(new URL('../../node_modules/azurite/dist/src/azurite.js', import.meta.url));
const ACCOUNT = 'devstoreaccount1';
const KEY = 'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==';

export const azuriteInstalled = existsSync(ENTRY);

/** Set when Azurite is missing, so the gated tests report why they did not run. */
export const AZURITE_SKIP = azuriteInstalled ? undefined : 'azurite is not installed, so the Azure storage tests did not run; run npm ci';

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address() as { port: number };
			server.close(() => resolve(port));
		});
	});
}

function accepting(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect(port, '127.0.0.1');
		socket.once('connect', () => (socket.destroy(), resolve(true)));
		socket.once('error', () => resolve(false));
	});
}

export type Azurite = { readonly connectionString: string; stop(): Promise<void> };

/** The npm azurite package on three free ports with in-memory persistence. */
export async function startAzurite(): Promise<Azurite> {
	const [blob, queue, table] = [await freePort(), await freePort(), await freePort()];
	const child = spawn(
		process.execPath,
		[ENTRY, '--silent', '--skipApiVersionCheck', '--inMemoryPersistence', '--blobPort', String(blob), '--queuePort', String(queue), '--tablePort', String(table)],
		{ stdio: 'ignore' },
	);
	const deadline = Date.now() + 20_000;
	while (!(await Promise.all([blob, queue, table].map(accepting))).every(Boolean)) {
		if (child.exitCode !== null || Date.now() > deadline) throw new Error('azurite did not start');
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	const endpoint = (kind: string, port: number) => `${kind}Endpoint=http://127.0.0.1:${port}/${ACCOUNT}`;
	return {
		connectionString: `DefaultEndpointsProtocol=http;AccountName=${ACCOUNT};AccountKey=${KEY};${endpoint('Blob', blob)};${endpoint('Queue', queue)};${endpoint('Table', table)};`,
		stop: () => new Promise((resolve) => (child.once('exit', () => resolve()), child.kill())),
	};
}
