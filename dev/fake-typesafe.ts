import { createServer } from 'node:http';

export type TypeSafeCall = {
	/** What the caller sent after "Bearer ". */
	readonly key: string | null;
	readonly ids: readonly string[];
};

export type FakeTypeSafe = {
	readonly origin: string;
	readonly calls: readonly TypeSafeCall[];
	/** For the next `count` calls, the named questions are this likely to be bad: an answer is unsupported, a decoy supported, or a brief or hint a giveaway. */
	setBad(bad: Readonly<Record<string, number>>, count?: number): void;
	/** The next `count` calls answer with this HTTP status. */
	failNext(count: number, status?: number): void;
	/** The next `count` calls answer 200 with good answers and no `usage`. */
	omitUsageNext(count: number): void;
	close(): Promise<void>;
};

const PASSING_SUPPORT = { answer: 0.95, decoy: 0.02 };
const PASSING_NOUL = 0.05;

type Question = { answer?: string; hint?: string };

/** A hint that names its answer gives it away, as Jev would see it, unless a test set the odds itself. */
function giveaway(id: string, questions: Readonly<Record<string, Question>>): number | undefined {
	const { answer, hint } = questions[/^(\w+)_hint$/.exec(id)?.[1] ?? ''] ?? {};
	return answer && hint?.toLowerCase().includes(answer.toLowerCase()) ? 0.9 : undefined;
}

/** How Jev answers one question of a round check, by the id the check gave it. */
function answerOf(id: string, bad: number | undefined): object {
	if (id.endsWith('_answer') || /_decoy_\d$/.test(id)) {
		const supports = id.endsWith('_answer') ? (bad === undefined ? PASSING_SUPPORT.answer : 1 - bad) : (bad ?? PASSING_SUPPORT.decoy);
		const rest = (1 - supports) / 2;
		const probabilities = { supports, contradicts: rest, says_nothing: rest };
		return { type: 'choice', choice: 'supports', confidence: supports, probabilities };
	}
	return { type: 'noul', noul: bad ?? PASSING_NOUL };
}

/** The TypeSafe systemone API as the round check calls it. No network and no real key: it only wants a bearer token. */
export async function startFakeTypeSafe(options: { readonly port?: number } = {}): Promise<FakeTypeSafe> {
	const calls: TypeSafeCall[] = [];
	let bad: { values: Readonly<Record<string, number>>; count: number } = { values: {}, count: 0 };
	const failing = { count: 0, status: 500 };
	let omitting = 0;

	const server = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(Buffer.from(chunk));
		const json = (status: number, value: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
		if (req.method !== 'POST' || new URL(req.url ?? '/', 'http://localhost').pathname !== '/v1/systemone') return json(404, { detail: 'not found' });
		const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { questions?: Record<string, unknown>; state?: { questions?: Record<string, Question> } };
		const ids = Object.keys(body.questions ?? {});
		calls.push({ key: /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? null, ids });
		if (failing.count > 0) {
			failing.count -= 1;
			return json(failing.status, { detail: 'the fake TypeSafe was told to fail' });
		}
		const values = bad.count > 0 ? bad.values : {};
		if (bad.count > 0) bad.count -= 1;
		const answers = Object.fromEntries(ids.map((id) => [id, answerOf(id, values[id] ?? giveaway(id, body.state?.questions ?? {}))]));
		if (omitting > 0) {
			omitting -= 1;
			return json(200, { model: 'jev-latest', answers });
		}
		return json(200, { model: 'jev-latest', answers, usage: { input_tokens: 2000, output_tokens: 40 } });
	});
	await new Promise<void>((resolve, reject) => (server.once('error', reject), server.listen(options.port ?? 0, 'localhost', resolve)));
	const { port } = server.address() as { port: number };
	return {
		origin: `http://localhost:${port}`,
		calls,
		setBad(values, count = 1) {
			bad = { values, count };
		},
		failNext(count, status = 500) {
			failing.count = count;
			failing.status = status;
		},
		omitUsageNext(count) {
			omitting = count;
		},
		close: () => new Promise<void>((resolve) => (server.close(() => resolve()), server.closeAllConnections())),
	};
}
