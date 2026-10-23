import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { checkRound, MODEL } from '../../../games/timedetectives/admin/api/check.ts';
import { parseRoundContent, type FieldRef, type Finding, type RoundContent } from '../../../games/timedetectives/data/index.ts';

/**
 * Runs the shipped round check over hand-labelled rounds against the live TypeSafe API and prints how often it catches
 * each kind of fault and how often it flags a good round. Run it with `with-typesafe npm run eval:jev`.
 */

type DefectType = 'brief_leak' | 'decoy_supported' | 'answer_missing' | 'hint_leak';
type Edit = { path: string; find: string; replace: string } | { path: string; set: string };
type Defect = { id: string; base: string; type: DefectType; subtle: boolean; expect: string[]; edits: Edit[] };
type Round = { id: string; type: 'good' | DefectType; subtle: boolean; expect: FieldRef[]; content: RoundContent };

const HERE = new URL('.', import.meta.url);
const CACHE = new URL('.cache/', HERE);
const ENDPOINT = process.env['TYPESAFE_ENDPOINT'] ?? 'https://api.typesafe.ai/';

/** rounds.json labels checks as `<kind>_<part>`; findings name the form field. */
function fieldOf(id: string): FieldRef {
	const [kind, part, n] = id.split('_');
	if (part === 'brief') return 'brief';
	if (part === 'decoy') return `${kind}-decoy-${Number(n) - 1}` as FieldRef;
	return `${kind}-${part}` as FieldRef;
}

function parse(id: string, raw: unknown): RoundContent {
	const parsed = parseRoundContent(raw);
	if (!parsed.ok) throw new Error(`${id} does not parse: ${parsed.problems.join('; ')}`);
	return parsed.value;
}

type Raw = Record<string, unknown> & { questions: (Record<string, unknown> & { kind: string; decoys: string[] })[] };

function applyEdit(raw: Raw, edit: Edit, id: string): void {
	const m = /^questions\.(who|where|when)\.(hint|answer|decoys\[(\d)\])$/.exec(edit.path);
	const change = (old: unknown) => {
		if (typeof old !== 'string') throw new Error(`${id}: no text at ${edit.path}`);
		if ('set' in edit) return edit.set;
		if (old.split(edit.find).length !== 2) throw new Error(`${id}: "${edit.find}" must occur once in ${edit.path}`);
		return old.replace(edit.find, edit.replace);
	};
	if (!m) {
		raw[edit.path] = change(raw[edit.path]);
		return;
	}
	const question = raw.questions.find((q) => q.kind === m[1]);
	if (!question) throw new Error(`${id}: no ${m[1]} question`);
	if (m[3] !== undefined) question.decoys[Number(m[3])] = change(question.decoys[Number(m[3])]);
	else question[m[2]!] = change(question[m[2]!]);
}

function loadRounds(): Round[] {
	const data = JSON.parse(readFileSync(new URL('rounds.json', HERE), 'utf8')) as { good: Record<string, unknown>; defects: Defect[] };
	const good = Object.entries(data.good).map(([id, raw]): Round => ({ id, type: 'good', subtle: false, expect: [], content: parse(id, raw) }));
	const defects = data.defects.map((d): Round => {
		const base = data.good[d.base];
		if (!base) throw new Error(`${d.id}: no base round ${d.base}`);
		const raw = structuredClone(base) as Raw;
		for (const edit of d.edits) applyEdit(raw, edit, d.id);
		return { id: d.id, type: d.type, subtle: d.subtle, expect: d.expect.map(fieldOf), content: parse(d.id, raw) };
	});
	return [...good, ...defects];
}

/** Replies are kept by request body, so a rerun of unchanged questions costs nothing and a changed one is asked afresh. */
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
	const key = createHash('sha256').update(String(init?.body)).digest('hex');
	const file = new URL(`${key}.json`, CACHE);
	if (existsSync(file)) return new Response(readFileSync(file), { status: 200 });
	const res = await realFetch(input, init);
	const text = await res.text();
	if (res.ok) writeFileSync(file, text);
	return new Response(text, { status: res.status });
};

const apiKey = process.env['TYPESAFE_API_KEY'];
if (!apiKey) throw new Error('TYPESAFE_API_KEY is not set. Run this as `with-typesafe npm run eval:jev`.');
mkdirSync(CACHE, { recursive: true });

const rounds = loadRounds();
const results: { round: Round; findings: Finding[] }[] = [];
for (let at = 0; at < rounds.length; at += 4) {
	const batch = rounds.slice(at, at + 4);
	results.push(...(await Promise.all(batch.map(async (round) => ({ round, findings: await checkRound({ endpoint: ENDPOINT, apiKey }, round.content) })))));
}

const pct = (n: number, of: number) => `${of ? Math.round((100 * n) / of) : 0}% (${n}/${of})`;
const lines = [`model ${MODEL}, ${rounds.length} rounds`, '', '| fault | rounds | rewrite (sure) | flagged (sure or unsure) |', '| --- | --- | --- | --- |'];
for (const type of ['brief_leak', 'decoy_supported', 'answer_missing', 'hint_leak'] as const) {
	for (const subtle of [false, true]) {
		const these = results.filter(({ round }) => round.type === type && round.subtle === subtle);
		if (!these.length) continue;
		const hit = (sure: boolean) => these.filter(({ round, findings }) => findings.some((f) => round.expect.includes(f.field) && (f.sure || !sure))).length;
		lines.push(`| ${type}${subtle ? ' (subtle)' : ''} | ${these.length} | ${pct(hit(true), these.length)} | ${pct(hit(false), these.length)} |`);
	}
}
const good = results.filter(({ round }) => round.type === 'good');
const flaggedGood = good.flatMap(({ round, findings }) => findings.map((f) => `${round.id} ${f.field} ${f.sure ? 'sure' : 'unsure'}`));
lines.push('', `good rounds sent back for a rewrite: ${pct(good.filter(({ findings }) => findings.some((f) => f.sure)).length, good.length)}`);
lines.push(`good rounds flagged at all: ${pct(good.filter(({ findings }) => findings.length > 0).length, good.length)}`);
if (flaggedGood.length) lines.push('', 'false alarms:', ...flaggedGood.map((line) => `- ${line}`));
console.log(lines.join('\n'));
