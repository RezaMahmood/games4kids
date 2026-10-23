import type { UsageSubject } from '@g4k/sdk';
import { atWork, isRecord, roundId, type AdminStore, type PictureId, type Round, type RoundId, type RoundState, type StoredRound, type AtWork } from '../../data/index.ts';
import { drawPicture, writeRound, type Written } from './draft.ts';
import type { TypeSafeDeps } from './check.ts';
import { AiFailure, Refusal, type FoundryDeps } from './foundry.ts';

/** Equal to extensions.queues.maxDequeueCount in host.json, so the last attempt settles the round instead of poisoning it. */
export const MAX_ATTEMPTS = 3;

export type DraftMessage = { roundId: RoundId };

export const parseDraftMessage = (raw: unknown): DraftMessage | undefined => {
	const id = isRecord(raw) ? roundId(raw['roundId']) : undefined;
	return id && { roundId: id };
};

/** Why a round the AI refused to write is failed. Asking about the same thing gets the same answer, so it asks for a new focus. */
export const WORDS_REFUSED = 'The AI safety filter turned this round down. Change what it should be about and try again, or delete it.';
/** What a round whose new picture never came says. The words and any picture it had are still there. */
const pictureNotice = (why: string) => `The AI could not draw a picture. ${why} Upload a picture, or change the picture description and redraw.`;
export const PICTURE_REFUSED = pictureNotice('The AI safety filter turned it down.');
/** What a round says when its redraft never came. Its words and findings are as they were before. */
export const redraftNotice = (why: string) => `The AI could not redraft this round. ${why} Your round is unchanged.`;

/**
 * How long a drafting round goes unsaved before the admin may act on it. One message's attempts are over in 32 minutes:
 * an attempt makes at most six Foundry requests (two asks for the words and one picture, each sent again after a 429)
 * of REQUEST_TIMEOUT_MS and three waits of RETRY_MAX_SECONDS, ten minutes, and the queue makes MAX_ATTEMPTS of them a
 * minute apart (host.json's visibilityTimeout). A message can still start later than this, since drafts run one at a
 * time behind up to nine others, so a worker may finish a round the admin has already acted on. Its save then loses
 * the etag race, and the picture it drew, stored under a name of its own, is removed.
 */
export const STALE_AFTER_MS = 60 * 60_000;
export const STOPPED = 'The AI stopped without finishing.';

/**
 * A round left at work by a message that will never run again, because it was poisoned or never sent, reads as
 * settled: failed when it has no words, a draft that says no picture came, or the draft a redraft started from. It then stops counting toward the cap and
 * can be tried again, edited or deleted. Nothing is saved here: a late worker that finds the row still drafting finishes
 * it, and one that finds the admin acted first leaves the row and its picture alone.
 */
export function settleStale({ round, etag }: StoredRound, now: Date): StoredRound {
	const { state } = round;
	if (!atWork(state) || now.getTime() - Date.parse(round.updatedAt) < STALE_AFTER_MS) return { round, etag };
	return { round: { ...round, state: stopped(state) }, etag };
}

function stopped(state: AtWork): RoundState {
	if (state.kind === 'revising') return unchanged(state, STOPPED);
	return state.content
		? { kind: 'draft', content: state.content, source: state.source, notice: pictureNotice(STOPPED), ...(state.checks && { checks: state.checks }) }
		: { kind: 'failed', focus: state.focus, source: state.source, reason: `${STOPPED} Try again, or delete it.` };
}

/** The draft a redraft started from, saying why no new words came. */
function unchanged(state: Extract<AtWork, { kind: 'revising' }>, why: string): RoundState {
	return { kind: 'draft', content: state.content, source: state.source, notice: redraftNotice(why), checks: state.findings };
}

/** The AI clients for one round. Each bills what it uses to `subject`, so every ask, check, retry and redraw sums into the round and its topic. */
type Ctx = { store: AdminStore; foundry: (subject: UsageSubject) => FoundryDeps; typesafe: (subject: UsageSubject) => TypeSafeDeps | undefined; newPicture: () => PictureId; now: Date; log: (line: string) => void; dequeueCount: number };

/**
 * Takes a drafting round as far as it can: the words, then the picture, then a draft for the admin to review. Each step
 * is saved as soon as it is done, so a retried message never pays for the words again. A revising round is one step:
 * new words that keep the picture, or the old draft back with a notice. Anything not at work (deleted, or already
 * finished by an earlier delivery) is left alone.
 */
export async function runDraft(ctx: Ctx, id: RoundId): Promise<void> {
	const found = await ctx.store.round(id);
	if (found && 'broken' in found) return ctx.log(`round ${id} does not parse, so it is left alone: ${found.problems.join('; ')}`);
	if (!found || !atWork(found.round.state)) return;
	let current: StoredRound = found;
	const state = found.round.state;
	const subject: UsageSubject = { item: id, group: found.round.topicId };
	const updatedAt = ctx.now.toISOString();
	const save = async (round: Round) => {
		const saved = await ctx.store.replaceRound(round, current.etag);
		if (saved) current = saved;
		return saved;
	};
	/** Rethrows for the queue to try again, until the last attempt or an error no attempt fixes, which settle the round. */
	const settle = (error: unknown): { refused: boolean; why: string } => {
		const retryable = !(error instanceof AiFailure) || error.retryable;
		const reason = error instanceof Error ? error.message : String(error);
		ctx.log(`round ${id} attempt ${ctx.dequeueCount} of ${MAX_ATTEMPTS}: ${reason}`);
		if (retryable && ctx.dequeueCount < MAX_ATTEMPTS) throw error;
		return { refused: error instanceof Refusal, why: retryable ? `The AI did not answer after ${MAX_ATTEMPTS} tries. ${reason}` : reason };
	};
	const onCheckError = (error: unknown) => ctx.log(`round ${id} could not be checked: ${error instanceof Error ? error.message : String(error)}`);

	if (state.kind === 'revising') {
		let written: Written;
		try {
			written = await writeRound(ctx.foundry(subject), { kind: 'redraft', content: state.content, findings: state.findings }, ctx.typesafe(subject), onCheckError);
		} catch (error) {
			await save({ ...current.round, state: unchanged(state, settle(error).why), updatedAt });
			return;
		}
		await save({ ...current.round, state: { kind: 'draft', content: written.content, source: 'ai', ...(written.checks && { checks: written.checks }) }, updatedAt });
		return;
	}

	let { content, checks } = state;
	if (!content) {
		let written: Written;
		try {
			const topic = await ctx.store.topic(found.round.topicId);
			if (!topic) throw new AiFailure(false, 'The topic was deleted.');
			written = await writeRound(ctx.foundry(subject), { kind: 'new', topic: topic.topic, focus: state.focus }, ctx.typesafe(subject), onCheckError);
		} catch (error) {
			const { refused, why } = settle(error);
			await save({ ...current.round, state: { kind: 'failed', focus: state.focus, source: state.source, reason: refused ? WORDS_REFUSED : why }, updatedAt });
			return;
		}
		content = written.content;
		checks = written.checks;
		if (!(await save({ ...current.round, state: { ...state, content, ...(checks && { checks }) }, ...(written.picturePrompt && { picturePrompt: written.picturePrompt }), updatedAt }))) return;
	}
	let picture: Uint8Array;
	try {
		picture = await drawPicture(ctx.foundry(subject), current.round.picturePrompt ?? content.pictureAlt);
	} catch (error) {
		const { refused, why } = settle(error);
		await save({ ...current.round, state: { kind: 'draft', content, source: state.source, notice: refused ? PICTURE_REFUSED : pictureNotice(why), ...(checks && { checks }) }, updatedAt });
		return;
	}
	const next: Round = { ...current.round, state: { kind: 'draft', content, source: state.source, ...(checks && { checks }) }, updatedAt };
	await ctx.store.replaceWithPicture(next, current.etag, { id: ctx.newPicture(), bytes: picture, contentType: 'image/png' });
}
