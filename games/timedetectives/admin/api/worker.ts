import { isRecord, roundId, type AdminStore, type Round, type RoundId, type StoredRound } from '../../data/index.ts';
import { drawPicture, writeRound, type Written } from './draft.ts';
import { AiFailure, Refusal, type FoundryDeps } from './foundry.ts';

/** Equal to extensions.queues.maxDequeueCount in host.json, so the last attempt settles the round instead of poisoning it. */
export const MAX_ATTEMPTS = 3;

export type DraftMessage = { roundId: RoundId };

export const parseDraftMessage = (raw: unknown): DraftMessage | undefined => {
	const id = isRecord(raw) ? roundId(raw['roundId']) : undefined;
	return id && { roundId: id };
};

/** Why a round the AI could not write is failed. Trying again asks with the same focus, so a refusal needs a new one. */
export const WORDS_REFUSED = 'The AI safety filter turned this round down. Delete it and draft another with a different focus.';
/** What a round whose new picture never came says. The words and any picture it had are still there. */
const pictureNotice = (why: string) => `The AI could not draw a picture. ${why} Upload a picture, or change the picture description and redraw.`;
export const PICTURE_REFUSED = pictureNotice('The AI safety filter turned it down.');

type Ctx = { store: AdminStore; foundry: () => FoundryDeps; now: Date; log: (line: string) => void; dequeueCount: number };

/**
 * Takes a drafting round as far as it can: the words, then the picture, then a draft for the admin to review. Each step
 * is saved as soon as it is done, so a retried message never pays for the words again. Anything but a drafting round
 * (deleted, or already finished by an earlier delivery) is left alone.
 */
export async function runDraft(ctx: Ctx, id: RoundId): Promise<void> {
	const found = await ctx.store.round(id);
	if (found && 'broken' in found) return ctx.log(`round ${id} does not parse, so it is left alone: ${found.problems.join('; ')}`);
	if (!found || found.round.state.kind !== 'drafting') return;
	let current: StoredRound = found;
	const state = found.round.state;
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

	let { content } = state;
	if (!content) {
		let written: Written;
		try {
			const topic = await ctx.store.topic(found.round.topicId);
			if (!topic) throw new AiFailure(false, 'The topic was deleted.');
			written = await writeRound(ctx.foundry(), topic.topic, state.focus);
		} catch (error) {
			const { refused, why } = settle(error);
			await save({ ...current.round, state: { kind: 'failed', focus: state.focus, source: state.source, reason: refused ? WORDS_REFUSED : why }, updatedAt });
			return;
		}
		content = written.content;
		if (!(await save({ ...current.round, state: { ...state, content }, picturePrompt: written.picturePrompt, updatedAt }))) return;
	}
	let picture: Uint8Array;
	try {
		picture = await drawPicture(ctx.foundry(), current.round.picturePrompt ?? content.pictureAlt);
	} catch (error) {
		const { refused, why } = settle(error);
		await save({ ...current.round, state: { kind: 'draft', content, source: state.source, notice: refused ? PICTURE_REFUSED : pictureNotice(why) }, updatedAt });
		return;
	}
	await ctx.store.putPicture(id, picture, 'image/png');
	const done = await save({ ...current.round, state: { kind: 'draft', content, source: state.source }, hasPicture: true, updatedAt });
	// The admin deleted the round while its picture was being drawn, so the picture just written has nothing to belong to.
	if (!done && !(await ctx.store.round(id))) await ctx.store.deleteRound(id);
}
