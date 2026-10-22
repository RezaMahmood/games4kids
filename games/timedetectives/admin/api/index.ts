import { defineAdminApi, HttpError, type AdminPlatform, type AdminRoute } from '@g4k/sdk';
import {
	adminStore,
	imageReply,
	nothingHere,
	parseFocus,
	parseRoundContent,
	parseTopicInput,
	roundId,
	topicId,
	type BrokenRound,
	type Round,
	type RoundRows,
	type RoundState,
	type Settled,
	type StoredRound,
	type StoredTopic,
	type TopicId,
} from '../../data/index.ts';
import manifest from '../../manifest.ts';
import { AiFailure, type FoundryDeps } from './foundry.ts';
import { parseDraftMessage, runDraft, settleStale, type DraftMessage } from './worker.ts';

/** About ten minutes of AI work, so a stuck page cannot fill the queue. */
const MAX_DRAFTING = 10;
const CHANGED = 'Someone else changed this since you loaded it. Reload to see the latest version, then make your change again.';

const invalid = (problems: readonly string[]) => new HttpError(400, 'invalid', 'The request is not valid.', problems);
const changed = () => new HttpError(412, 'changed', CHANGED);
const busy = () => new HttpError(409, 'busy', 'The AI is still working on this round, or could not write it.');
/** The admin acted on the round, so a notice about the AI's last picture no longer applies. */
const acted = (state: Settled): Settled => (state.kind === 'draft' ? { kind: 'draft', content: state.content, source: state.source } : state);
const field = (body: unknown, name: string): unknown => (typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[name] : undefined);

function etagOf(body: unknown, what: string): string {
	const etag = field(body, 'etag');
	if (typeof etag !== 'string' || etag === '') throw invalid([`etag is required; load the ${what} before changing it`]);
	return etag;
}

const topicView = ({ topic, etag }: StoredTopic, { rounds, broken }: RoundRows) => {
	const mine = rounds.filter(({ round }) => round.topicId === topic.id);
	const damaged = broken.filter((round) => round.topicId === topic.id).length;
	return { ...topic, etag, rounds: mine.length + damaged, published: mine.filter(({ round }) => round.state.kind === 'published').length };
};

const roundView = ({ round: { picturePrompt: _prompt, ...round }, etag }: StoredRound) => ({ ...round, etag });
const brokenView = ({ id, topicId, problems }: BrokenRound) => ({ id, topicId, broken: problems });
const isBroken = (read: StoredRound | BrokenRound): read is BrokenRound => 'broken' in read;

function foundryFor(platform: AdminPlatform<typeof manifest>): FoundryDeps {
	const endpoint = platform.settings.FOUNDRY_ENDPOINT;
	if (!endpoint) throw new AiFailure(false, 'Drafting with AI is not set up.');
	return { endpoint, token: platform.tokens.cognitiveServices };
}

export const createAdminApi = defineAdminApi(manifest, (platform) => {
	const store = adminStore(platform);

	const newId = <T>(parse: (raw: unknown) => T | undefined): T => {
		const id = parse(platform.newId());
		if (!id) throw new Error('newId must make a GUID');
		return id;
	};

	async function existingTopic(raw: string | undefined): Promise<StoredTopic> {
		const id = topicId(raw);
		const found = id && (await store.topic(id));
		if (!found) throw nothingHere();
		return found;
	}

	async function readRound(raw: string | undefined, now: Date): Promise<StoredRound | BrokenRound> {
		const id = roundId(raw);
		const found = id && (await store.round(id));
		if (!found) throw nothingHere();
		return isBroken(found) ? found : settleStale(found, now);
	}

	async function allRounds(now: Date): Promise<RoundRows> {
		const { rounds, broken } = await store.rounds();
		return { rounds: rounds.map((round) => settleStale(round, now)), broken };
	}

	/** A round that can be changed. A stored row that no longer parses can only be deleted. */
	/** Two topics with one name would look the same to a child, so a title another topic has, in any case, is refused. */
	async function refuseTakenTitle(title: string, self: TopicId | null): Promise<void> {
		const taken = (await store.topics()).find(({ topic }) => topic.id !== self && topic.title.toLowerCase() === title.toLowerCase());
		if (taken) throw new HttpError(409, 'duplicate_title', 'That title is taken.', [`There is already a topic called "${taken.topic.title}". Choose another title.`]);
	}

	async function existingRound(raw: string | undefined, now: Date): Promise<StoredRound> {
		const found = await readRound(raw, now);
		if (isBroken(found)) throw new HttpError(409, 'broken', 'This round\'s stored data is damaged. Delete it and make it again.');
		return found;
	}

	async function replaced(next: Round, etag: string): Promise<StoredRound> {
		const saved = await store.replaceRound(next, etag);
		if (!saved) throw changed();
		return saved;
	}

	/** Refuses AI work when there is no Foundry account, or when the worker already has plenty queued. */
	async function guardDrafting(now: Date): Promise<void> {
		if (!platform.settings.FOUNDRY_ENDPOINT) throw new HttpError(503, 'ai_unavailable', 'Drafting with AI is not set up yet.');
		const drafting = (await allRounds(now)).rounds.filter(({ round }) => round.state.kind === 'drafting').length;
		if (drafting >= MAX_DRAFTING) throw new HttpError(429, 'too_many_drafts', `The AI already has ${drafting} rounds to draft. Try again when some are done.`);
	}

	/**
	 * Puts a drafting round on the queue, and puts it back as it was if the queue refuses, so the admin can act on it at
	 * once. A put back that loses to another change leaves the row to that change; one that fails leaves a drafting row
	 * nobody runs, which settleStale settles.
	 */
	async function queue(saved: StoredRound, before: Round | null): Promise<StoredRound> {
		try {
			await platform.queues.drafts.send({ roundId: saved.round.id } satisfies DraftMessage);
			return saved;
		} catch (error) {
			if (before) await store.replaceRound(before, saved.etag);
			else await store.deleteRound(saved.round.id);
			throw error;
		}
	}

	function settled({ round }: StoredRound): Settled {
		if (round.state.kind !== 'draft' && round.state.kind !== 'published') throw busy();
		return round.state;
	}

	function pictureRoute(kind: 'png' | 'jpeg'): AdminRoute {
		return {
			name: `upload${kind === 'png' ? 'Png' : 'Jpeg'}`,
			method: 'POST',
			path: `rounds/{id}/picture/${kind}`,
			body: kind,
			async run({ params, body, now }) {
				const found = await existingRound(params['id'], now);
				const state = acted(settled(found));
				await store.putPicture(found.round.id, body, `image/${kind}`);
				return { status: 200, json: roundView(await replaced({ ...found.round, state, hasPicture: true, updatedAt: now.toISOString() }, found.etag)) };
			},
		};
	}

	return {
		routes: [
			{
				name: 'topics',
				method: 'GET',
				path: 'topics',
				body: 'none',
				async run() {
					const [topics, rounds] = await Promise.all([store.topics(), store.rounds()]);
					return { status: 200, json: { topics: topics.map((topic) => topicView(topic, rounds)) } };
				},
			},
			{
				name: 'createTopic',
				method: 'POST',
				path: 'topics',
				body: 'json',
				async run({ body }) {
					const input = parseTopicInput(body);
					if (!input.ok) throw invalid(input.problems);
					await refuseTakenTitle(input.value.title, null);
					const order = Math.max(-1, ...(await store.topics()).map(({ topic }) => topic.order)) + 1;
					return { status: 201, json: topicView(await store.createTopic({ id: newId(topicId), ...input.value, order }), { rounds: [], broken: [] }) };
				},
			},
			{
				name: 'updateTopic',
				method: 'PUT',
				path: 'topics/{id}',
				body: 'json',
				async run({ params, body }) {
					const current = await existingTopic(params['id']);
					const input = parseTopicInput(body);
					if (!input.ok) throw invalid(input.problems);
					await refuseTakenTitle(input.value.title, current.topic.id);
					const saved = await store.replaceTopic({ ...current.topic, ...input.value }, etagOf(body, 'topic'));
					if (!saved) throw changed();
					return { status: 200, json: topicView(saved, await store.rounds()) };
				},
			},
			{
				name: 'deleteTopic',
				method: 'DELETE',
				path: 'topics/{id}',
				body: 'none',
				async run({ params }) {
					const id = topicId(params['id']);
					if (!id) return { status: 204 };
					const { rounds, broken } = await store.rounds();
					if (rounds.some(({ round }) => round.topicId === id) || broken.some((round) => round.topicId === id)) throw new HttpError(409, 'has_rounds', 'Delete the topic\'s rounds first.');
					await store.deleteTopic(id);
					return { status: 204 };
				},
			},
			{
				name: 'rounds',
				method: 'GET',
				path: 'topics/{id}/rounds',
				body: 'none',
				async run({ params, now }) {
					const { topic } = await existingTopic(params['id']);
					const { rounds, broken } = await allRounds(now);
					const mine = rounds.filter(({ round }) => round.topicId === topic.id).sort((a, b) => b.round.updatedAt.localeCompare(a.round.updatedAt));
					return { status: 200, json: { rounds: [...broken.filter((round) => round.topicId === topic.id).map(brokenView), ...mine.map(roundView)] } };
				},
			},
			{
				name: 'draftRound',
				method: 'POST',
				path: 'topics/{id}/rounds/draft',
				body: 'json',
				async run({ params, body, now }) {
					const { topic } = await existingTopic(params['id']);
					const focus = parseFocus(body);
					if (!focus.ok) throw invalid(focus.problems);
					await guardDrafting(now);
					const state: RoundState = { kind: 'drafting', focus: focus.value, source: 'ai' };
					const created = await store.createRound({ id: newId(roundId), topicId: topic.id, state, hasPicture: false, updatedAt: now.toISOString() });
					return { status: 202, json: roundView(await queue(created, null)) };
				},
			},
			{
				name: 'writeRound',
				method: 'POST',
				path: 'topics/{id}/rounds',
				body: 'json',
				async run({ params, body, now }) {
					const { topic } = await existingTopic(params['id']);
					const content = parseRoundContent(field(body, 'content'));
					if (!content.ok) throw invalid(content.problems);
					const state: RoundState = { kind: 'draft', content: content.value, source: 'human' };
					return { status: 201, json: roundView(await store.createRound({ id: newId(roundId), topicId: topic.id, state, hasPicture: false, updatedAt: now.toISOString() })) };
				},
			},
			{
				name: 'round',
				method: 'GET',
				path: 'rounds/{id}',
				body: 'none',
				async run({ params, now }) {
					const found = await readRound(params['id'], now);
					return { status: 200, json: isBroken(found) ? brokenView(found) : roundView(found) };
				},
			},
			{
				name: 'editRound',
				method: 'PUT',
				path: 'rounds/{id}',
				body: 'json',
				/** An edit keeps a published round published, so a typo fix never takes it away from the children. */
				async run({ params, body, now }) {
					const found = await existingRound(params['id'], now);
					const state = settled(found);
					const content = parseRoundContent(field(body, 'content'));
					if (!content.ok) throw invalid(content.problems);
					const next: RoundState = { ...acted(state), content: content.value, source: 'human' };
					// Once the admin rewrites the picture description, the next redraw draws from it instead of the AI's own prompt.
					const { picturePrompt: _prompt, ...rest } = found.round;
					const kept = content.value.pictureAlt === state.content.pictureAlt ? found.round : rest;
					return { status: 200, json: roundView(await replaced({ ...kept, state: next, updatedAt: now.toISOString() }, etagOf(body, 'round'))) };
				},
			},
			{
				name: 'publishRound',
				method: 'POST',
				path: 'rounds/{id}/publish',
				body: 'none',
				async run({ params, now }) {
					const found = await existingRound(params['id'], now);
					const state = settled(found);
					if (!found.round.hasPicture) throw new HttpError(409, 'not_ready', 'Add a picture before publishing.');
					if (state.kind === 'published') return { status: 200, json: roundView(found) };
					const next: RoundState = { kind: 'published', content: state.content, source: state.source, publishedAt: now.toISOString() };
					return { status: 200, json: roundView(await replaced({ ...found.round, state: next, updatedAt: now.toISOString() }, found.etag)) };
				},
			},
			{
				name: 'unpublishRound',
				method: 'POST',
				path: 'rounds/{id}/unpublish',
				body: 'none',
				async run({ params, now }) {
					const found = await existingRound(params['id'], now);
					const state = settled(found);
					if (state.kind === 'draft') return { status: 200, json: roundView(found) };
					const next: RoundState = { kind: 'draft', content: state.content, source: state.source };
					return { status: 200, json: roundView(await replaced({ ...found.round, state: next, updatedAt: now.toISOString() }, found.etag)) };
				},
			},
			{
				name: 'redrawRound',
				method: 'POST',
				path: 'rounds/{id}/redraw',
				body: 'none',
				/**
				 * The words stay and the worker only draws a new picture, which replaces the old one only once it is drawn. Only a
				 * draft is redrawn, so children never see a picture the admin has not checked.
				 */
				async run({ params, now }) {
					const found = await existingRound(params['id'], now);
					const state = settled(found);
					if (state.kind === 'published') throw new HttpError(409, 'published', 'Unpublish the round before redrawing its picture, so children only see a picture you have checked.');
					await guardDrafting(now);
					const next: RoundState = { kind: 'drafting', focus: '', source: state.source, content: state.content };
					const saved = await replaced({ ...found.round, state: next, updatedAt: now.toISOString() }, found.etag);
					return { status: 202, json: roundView(await queue(saved, found.round)) };
				},
			},
			{
				name: 'retryRound',
				method: 'POST',
				path: 'rounds/{id}/retry',
				body: 'none',
				async run({ params, now }) {
					const found = await existingRound(params['id'], now);
					const { state } = found.round;
					if (state.kind !== 'failed') throw new HttpError(409, 'not_failed', 'Only a round the AI gave up on can be tried again.');
					await guardDrafting(now);
					const next: RoundState = { kind: 'drafting', focus: state.focus, source: state.source };
					const saved = await replaced({ ...found.round, state: next, updatedAt: now.toISOString() }, found.etag);
					return { status: 202, json: roundView(await queue(saved, found.round)) };
				},
			},
			pictureRoute('png'),
			pictureRoute('jpeg'),
			{
				name: 'roundPicture',
				method: 'GET',
				path: 'rounds/{id}/picture',
				body: 'none',
				async run({ params, ifNoneMatch, now }) {
					const { round } = await existingRound(params['id'], now);
					if (!round.hasPicture) throw nothingHere();
					return imageReply(await store.picture(round.id, ifNoneMatch));
				},
			},
			{
				name: 'deleteRound',
				method: 'DELETE',
				path: 'rounds/{id}',
				body: 'none',
				async run({ params }) {
					const id = roundId(params['id']);
					if (id) await store.deleteRound(id);
					return { status: 204 };
				},
			},
		],
		workers: [
			{
				queue: 'drafts',
				async run(message, { now, log, dequeueCount }) {
					const draft = parseDraftMessage(message);
					if (!draft) return log('ignored a queue message that names no round');
					await runDraft({ store, foundry: () => foundryFor(platform), now, log, dequeueCount }, draft.roundId);
				},
			},
		],
	};
});
