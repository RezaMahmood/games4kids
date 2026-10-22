import { isRecord, roundId, type AdminStore, type Round, type RoundId, type RoundState, type StoredRound } from '../../data/index.ts';
import { drawPicture, writeRound } from './draft.ts';
import { AiFailure, type FoundryDeps } from './foundry.ts';

/** Equal to extensions.queues.maxDequeueCount in host.json, so the last attempt settles the round instead of poisoning it. */
export const MAX_ATTEMPTS = 3;

export type DraftMessage = { roundId: RoundId };

export const parseDraftMessage = (raw: unknown): DraftMessage | undefined => {
	const id = isRecord(raw) ? roundId(raw['roundId']) : undefined;
	return id && { roundId: id };
};

type Drafting = Extract<RoundState, { kind: 'drafting' }>;
type Ctx = { store: AdminStore; foundry: () => FoundryDeps; now: Date; log: (line: string) => void; dequeueCount: number };

/**
 * Takes a drafting round as far as it can: the words, then the picture, then a draft for the admin to review. Each step
 * is saved as soon as it is done, so a retried message never pays for a finished step again. Anything but a drafting
 * round (deleted, or already finished by an earlier delivery) is left alone.
 */
export async function runDraft(ctx: Ctx, id: RoundId): Promise<void> {
	const found = await ctx.store.round(id);
	if (!found || found.round.state.kind !== 'drafting') return;
	let current: StoredRound = found;
	const state: Drafting = found.round.state;
	const updatedAt = ctx.now.toISOString();
	const save = async (round: Round) => {
		const saved = await ctx.store.replaceRound(round, current.etag);
		if (saved) current = saved;
		return saved;
	};

	let { content } = state;
	try {
		if (!content) {
			const topic = await ctx.store.topic(found.round.topicId);
			if (!topic) throw new AiFailure(false, 'The topic was deleted.');
			const written = await writeRound(ctx.foundry(), topic.topic, state.focus);
			content = written.content;
			if (!(await save({ ...current.round, state: { ...state, content }, picturePrompt: written.picturePrompt, updatedAt }))) return;
		}
		if (!current.round.hasPicture) {
			await ctx.store.putPicture(id, await drawPicture(ctx.foundry(), current.round.picturePrompt ?? content.pictureAlt), 'image/png');
		}
		const done = await save({ ...current.round, state: { kind: 'draft', content, source: state.source }, hasPicture: true, updatedAt });
		// The admin deleted the round while its picture was being drawn, so the picture just written has nothing to belong to.
		if (!done && !(await ctx.store.round(id))) await ctx.store.deleteRound(id);
	} catch (error) {
		const retryable = !(error instanceof AiFailure) || error.retryable;
		const reason = error instanceof Error ? error.message : String(error);
		ctx.log(`round ${id} attempt ${ctx.dequeueCount} of ${MAX_ATTEMPTS}: ${reason}`);
		if (retryable && ctx.dequeueCount < MAX_ATTEMPTS) throw error;
		const why = retryable ? `The AI did not answer after ${MAX_ATTEMPTS} tries. ${reason}` : reason;
		await save({ ...current.round, state: { kind: 'failed', focus: state.focus, source: state.source, reason: why, ...(content && { content }) }, updatedAt });
	}
}
